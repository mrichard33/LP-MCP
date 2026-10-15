/**
 * health-retention.js — keep the health tables small without losing the trend
 * (System Health Phase 1.7, 2026-10-15). Daily at 03:30 ET.
 *
 *   health_results older than 30 days → one health_results_daily row per day
 *     and check (passes / warns / fails / unknowns, minutes red / yellow from
 *     consecutive statuses, first / last fail), THEN deleted, a day at a time;
 *   n8n_execution_log older than 14 days → deleted;
 *   synthetic_runs older than 30 days → deleted;
 *   lead_leak_daily → every run_date's per-reason totals materialized into
 *     lead_leak_daily_summary (the v_lead_leak_summary aggregates) first; rows
 *     older than 90 days deleted only for a run_date that is summarized.
 *
 * HEALTH_RETENTION_MODE off | dry_run | live (default dry_run): dry_run counts
 * what it would roll up and delete and writes nothing (the first run on any box
 * proves the numbers, like LEAD_LEAK_CLEANUP_MODE).
 */

import { runJob } from '../job-runner.js';
import { etParts } from '../health/window.js';

export const JOB_ID = 'health-retention';
export const RESULTS_DAYS = 30;
export const N8N_DAYS = 14;
export const SYNTHETIC_DAYS = 30;
export const LEAD_LEAK_DAYS = 90;
const MAX_DAYS_PER_RUN = 7;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export function retentionMode(env = process.env) {
  const raw = String(env.HEALTH_RETENTION_MODE ?? '').trim().toLowerCase();
  return ['off', 'dry_run', 'live'].includes(raw) ? raw : 'dry_run';
}

const colorOf = (status, severity) => {
  if (status === 'fail') return severity === 'P1' || severity === 'P2' ? 'red' : 'yellow';
  if (status === 'warn' || status === 'unknown') return 'yellow';
  return 'green';
};

/**
 * One check's results for one day → its health_results_daily row. Each result
 * holds its color until the next result, capped at stale_after_min (silence
 * past that is not time spent red), and never past the day's end. Pure.
 */
export function rollupDay(results, { day, severity = 'P3', staleAfterMin = 60, nextObservedAt = null } = {}) {
  const sorted = [...results].sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
  const dayEnd = Date.parse(`${day}T00:00:00Z`) + DAY;
  const out = { passes: 0, warns: 0, fails: 0, unknowns: 0, minutes_red: 0, minutes_yellow: 0, first_fail_at: null, last_fail_at: null };
  sorted.forEach((r, i) => {
    if (r.status === 'pass') out.passes += 1;
    else if (r.status === 'warn') out.warns += 1;
    else if (r.status === 'fail') out.fails += 1;
    else if (r.status === 'unknown') out.unknowns += 1;
    if (r.status === 'fail') {
      out.first_fail_at = out.first_fail_at || r.observed_at;
      out.last_fail_at = r.observed_at;
    }
    const start = Date.parse(r.observed_at);
    const next = sorted[i + 1] ? Date.parse(sorted[i + 1].observed_at) : (nextObservedAt ? Date.parse(nextObservedAt) : start + staleAfterMin * MIN);
    const end = Math.min(next, start + staleAfterMin * MIN, dayEnd);
    const minutes = Math.max(0, Math.round((end - start) / MIN));
    const color = colorOf(r.status, severity);
    if (color === 'red') out.minutes_red += minutes;
    if (color === 'yellow') out.minutes_yellow += minutes;
  });
  return out;
}

export async function runHealthRetention({ env = process.env, nowMs = Date.now(), deps = {} } = {}) {
  const mode = retentionMode(env);
  if (mode === 'off') return { skipped: true, reason: 'HEALTH_RETENTION_MODE=off' };
  const c = deps.client !== undefined ? deps.client : (await import('../supabase.js')).default;
  const live = mode === 'live';
  const out = { mode, days_rolled: [], results_rolled: 0, daily_rows: 0, n8n_deleted: 0, synthetic_deleted: 0, lead_leak_summarized: 0, lead_leak_deleted: 0, errors: [] };
  const err = (where, e) => out.errors.push(`${where}: ${e.message || e}`);

  // 1. health_results → health_results_daily, oldest day first.
  try {
    const cutoff = new Date(nowMs - RESULTS_DAYS * DAY).toISOString();
    const { data: checks } = await c.from('health_checks').select('check_id, severity, stale_after_min');
    const meta = new Map((checks || []).map((x) => [x.check_id, x]));
    for (let i = 0; i < MAX_DAYS_PER_RUN; i += 1) {
      const { data: oldest, error } = await c.from('health_results').select('observed_at').lt('observed_at', cutoff)
        .order('observed_at', { ascending: true }).limit(1);
      if (error) throw new Error(error.message);
      if (!oldest?.length) break;
      const day = String(oldest[0].observed_at).slice(0, 10);
      const from = `${day}T00:00:00Z`;
      const to = new Date(Date.parse(from) + DAY).toISOString();
      const { data: rows, error: e2 } = await c.from('health_results').select('id, check_id, status, observed_at')
        .gte('observed_at', from).lt('observed_at', to < cutoff ? to : cutoff);
      if (e2) throw new Error(e2.message);
      const byCheck = new Map();
      for (const r of rows || []) {
        if (!byCheck.has(r.check_id)) byCheck.set(r.check_id, []);
        byCheck.get(r.check_id).push(r);
      }
      const daily = [...byCheck.entries()].map(([checkId, list]) => ({
        day, check_id: checkId,
        ...rollupDay(list, { day, severity: meta.get(checkId)?.severity, staleAfterMin: meta.get(checkId)?.stale_after_min ?? 60 }),
      }));
      out.days_rolled.push(day);
      out.results_rolled += (rows || []).length;
      out.daily_rows += daily.length;
      if (!live) break; // dry run: the oldest day is enough to prove the shape
      if (daily.length) {
        const up = await c.from('health_results_daily').upsert(daily, { onConflict: 'day,check_id' });
        if (up.error) throw new Error(`daily upsert: ${up.error.message}`);
      }
      const ids = (rows || []).map((r) => r.id);
      for (let j = 0; j < ids.length; j += 500) {
        const del = await c.from('health_results').delete().in('id', ids.slice(j, j + 500));
        if (del.error) throw new Error(`results delete: ${del.error.message}`);
      }
    }
  } catch (e) {
    err('health_results rollup', e);
  }

  // 2 + 3. Plain age-outs.
  for (const [table, column, days, key] of [['n8n_execution_log', 'polled_at', N8N_DAYS, 'n8n_deleted'], ['synthetic_runs', 'started_at', SYNTHETIC_DAYS, 'synthetic_deleted']]) {
    try {
      const cutoff = new Date(nowMs - days * DAY).toISOString();
      const q = live
        ? c.from(table).delete({ count: 'exact' }).lt(column, cutoff)
        : c.from(table).select(column, { count: 'exact', head: true }).lt(column, cutoff);
      const { error, count } = await q;
      if (error) throw new Error(error.message);
      out[key] = count ?? 0;
    } catch (e) {
      err(table, e);
    }
  }

  // 4. lead_leak_daily: summarize every run_date, then delete what is old AND summarized.
  try {
    const { data: agg, error } = await c.from('v_lead_leak_summary').select('run_date, reason, leads, est_value_at_risk');
    if (error) throw new Error(error.message);
    const rows = (agg || []).map((r) => ({ run_date: r.run_date, reason: r.reason, leads: Number(r.leads), est_value_at_risk: r.est_value_at_risk, summarized_at: new Date(nowMs).toISOString() }));
    out.lead_leak_summarized = rows.length;
    if (live && rows.length) {
      for (let j = 0; j < rows.length; j += 500) {
        const up = await c.from('lead_leak_daily_summary').upsert(rows.slice(j, j + 500), { onConflict: 'run_date,reason' });
        if (up.error) throw new Error(`summary upsert: ${up.error.message}`);
      }
    }
    const cutoffDay = etParts(nowMs - LEAD_LEAK_DAYS * DAY).day;
    const summarizedDays = new Set(rows.map((r) => String(r.run_date).slice(0, 10)));
    const oldDays = [...summarizedDays].filter((d) => d < cutoffDay);
    if (oldDays.length) {
      const q = live
        ? c.from('lead_leak_daily').delete({ count: 'exact' }).in('run_date', oldDays)
        : c.from('lead_leak_daily').select('run_date', { count: 'exact', head: true }).in('run_date', oldDays);
      const { error: e3, count } = await q;
      if (e3) throw new Error(e3.message);
      out.lead_leak_deleted = count ?? 0;
    }
  } catch (e) {
    err('lead_leak_daily', e);
  }

  out.summary = `${mode}: ${out.results_rolled} result(s) over ${out.days_rolled.length} day(s) → ${out.daily_rows} daily row(s); `
    + `n8n ${out.n8n_deleted}, synthetic ${out.synthetic_deleted}, lead_leak summarized ${out.lead_leak_summarized} / deleted ${out.lead_leak_deleted}`
    + (live ? '' : ' (dry run: nothing written)');
  return { ok: out.errors.length === 0, ...out };
}

/* ── scheduler: daily 03:30 ET ─────────────────────────────────────────── */

let timer = null;
let lastDay = null;

export function startHealthRetentionScheduler(env = process.env) {
  if (timer) return timer;
  if (retentionMode(env) === 'off') {
    console.log('[HealthRetention] scheduler not started (HEALTH_RETENTION_MODE=off)');
    return null;
  }
  const tick = async () => {
    const { day, minuteOfDay } = etParts(Date.now());
    if (minuteOfDay < 3 * 60 + 30 || minuteOfDay >= 5 * 60 || lastDay === day) return;
    lastDay = day;
    try {
      const { value } = await runJob(JOB_ID, () => runHealthRetention(), { occurrence: day });
      if (value?.summary) console.log(`[HealthRetention] ${value.summary}`);
    } catch (err) {
      console.error(`[HealthRetention] pass threw: ${err.message}`);
    }
  };
  timer = setInterval(tick, 5 * 60_000);
  timer.unref?.();
  console.log(`[HealthRetention] scheduler started — daily 03:30 ET, mode=${retentionMode(env)}`);
  return timer;
}
