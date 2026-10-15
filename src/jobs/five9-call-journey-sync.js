// ─── Five9 "Call Journey" report → five9_call_journey: the job ───
//      src/jobs/five9-call-journey-sync.js
//
// Every 15 minutes: pull the saved Five9 report "Shared Reports / Call
// Journey" for the time since the last good pull (10 minutes of overlap, 2
// minutes of lag, chunks of at most 6 hours) and store one row per call leg.
// Every pull is a five9_call_journey_runs row. Why, and the row rules:
// src/five9/call-journey.js. Read-only against Five9.
//
// MODE — FIVE9_JOURNEY_SYNC_MODE: off | shadow (default) | live. Shadow pulls,
// parses and logs the run's counts, and stores no rows. Each mode keeps its
// own cursor (the last ok run of that mode), so going live starts fresh and
// the backfill fills the past.
//
// ALERTS — Slack #ops-alerts only, edge-triggered (reportAlertCondition): a
// failed pull, timestamps that would not parse, or rows returned with nothing
// stored. A read of our own run log that fails touches nothing.

import { runJob } from '../job-runner.js';
import { checkRequestSecret } from '../security/request-auth.js';
import {
  parseJourneyReport, planJourneyWindows, toEasternCriteriaString, REPORT_ROW_CAP,
} from '../five9/call-journey.js';

export const JOB_ID = 'five9-call-journey-sync';
export const ALERT_KEY = 'five9_call_journey_sync';
const MODES = ['off', 'shadow', 'live'];
const RUNS_TABLE = 'five9_call_journey_runs';
const UPSERT_FN = 'five9_call_journey_upsert';
const BATCH = 1000;
const MIN = 60_000;
const MAX_SPLIT_DEPTH = 6;

export function journeyMode(env = process.env) {
  const raw = String(env.FIVE9_JOURNEY_SYNC_MODE ?? '').trim().toLowerCase();
  if (!raw) return 'shadow';
  return MODES.includes(raw) ? raw : 'shadow'; // a typo never starts writing
}

export function journeyConfig(env = process.env) {
  const num = (v, d, min = 1) => { const n = Number(v); return Number.isFinite(n) && n >= min ? n : d; };
  return {
    folder: String(env.FIVE9_JOURNEY_REPORT_FOLDER || 'Shared Reports').trim(),
    name: String(env.FIVE9_JOURNEY_REPORT_NAME || 'Call Journey').trim(),
    intervalMs: num(env.FIVE9_JOURNEY_INTERVAL_MS, 900_000, 60_000),
    backfillDays: num(env.FIVE9_JOURNEY_BACKFILL_DAYS, 7),
    maxWaitMs: num(env.FIVE9_JOURNEY_REPORT_MAX_WAIT_MS, 180_000, 10_000),
  };
}

async function defaultDeps() {
  const [five9, supabaseMod, alertState] = await Promise.all([
    import('../five9-admin.js'),
    import('../supabase.js'),
    import('../alert-state.js'),
  ]);
  return {
    runReportAndWait: five9.runReportAndWait,
    supabase: supabaseMod.default,
    reportAlertCondition: alertState.reportAlertCondition,
  };
}

/**
 * Pull one window. A result at the row cap is halved and pulled again (the
 * report truncates silently past it). A report that did not finish throws.
 */
async function pullWindow(d, cfg, startMs, endMs, depth = 0) {
  const res = await d.runReportAndWait({
    folder: cfg.folder, name: cfg.name,
    startIso: toEasternCriteriaString(new Date(startMs)), endIso: toEasternCriteriaString(new Date(endMs)),
    maxWaitMs: cfg.maxWaitMs,
  });
  if (!res?.done) {
    const err = new Error(`report did not finish in ${Math.round(cfg.maxWaitMs / 1000)}s`);
    err.timeout = true;
    throw err;
  }
  const rows = res.rows || [];
  if (rows.length >= REPORT_ROW_CAP && depth < MAX_SPLIT_DEPTH && endMs - startMs > MIN) {
    const mid = startMs + Math.floor((endMs - startMs) / 2);
    const a = await pullWindow(d, cfg, startMs, mid, depth + 1);
    const b = await pullWindow(d, cfg, mid, endMs, depth + 1);
    return [...a, ...b];
  }
  return [{ columns: res.columns || [], rows }];
}

async function lastOkEnd(supabase, mode) {
  const { data, error } = await supabase.from(RUNS_TABLE).select('window_end')
    .eq('status', 'ok').eq('mode', mode).order('window_end', { ascending: false }).limit(1);
  if (error) throw new Error(`run log read: ${error.message}`);
  return data?.[0]?.window_end ? Date.parse(data[0].window_end) : null;
}

/**
 * Pull, parse and (live) store one window, logging one run row. Never throws;
 * returns the counts and any error.
 */
export async function syncWindow(d, cfg, { startMs, endMs, mode }) {
  const counts = { returned: 0, inserted: 0, updated: 0, unchanged: 0, rejected: 0, rejects: {} };
  let runId = null;
  try {
    const ins = await d.supabase.from(RUNS_TABLE).insert({
      window_start: new Date(startMs).toISOString(), window_end: new Date(endMs).toISOString(), mode, status: 'running',
    }).select('id').single();
    if (ins.error) throw new Error(`run log insert: ${ins.error.message}`);
    runId = ins.data?.id ?? null;

    const parts = await pullWindow(d, cfg, startMs, endMs);
    const legs = [];
    for (const part of parts) {
      const parsed = parseJourneyReport(part); // throws on a missing header
      counts.returned += parsed.returned;
      legs.push(...parsed.rows);
      for (const [k, n] of Object.entries(parsed.rejects)) {
        counts.rejects[k] = (counts.rejects[k] || 0) + n;
        counts.rejected += n;
      }
    }
    if (mode !== 'shadow') {
      for (let i = 0; i < legs.length; i += BATCH) {
        const { data, error } = await d.supabase.rpc(UPSERT_FN, { p_rows: legs.slice(i, i + BATCH) });
        if (error) throw new Error(`upsert: ${error.message}`);
        counts.inserted += Number(data?.inserted) || 0;
        counts.updated += Number(data?.updated) || 0;
        counts.unchanged += Number(data?.unchanged) || 0;
      }
    }
    await finishRun(d, runId, { status: 'ok', counts });
    return { ok: true, ...counts };
  } catch (err) {
    await finishRun(d, runId, { status: err.timeout ? 'timeout' : 'failed', counts, error: err.message });
    return { ok: false, error: err.message, ...counts };
  }
}

async function finishRun(d, runId, { status, counts, error = null }) {
  if (runId == null) return;
  try {
    await d.supabase.from(RUNS_TABLE).update({
      status,
      rows_returned: counts.returned,
      rows_upserted: counts.inserted,
      rows_updated: counts.updated,
      rows_unchanged: counts.unchanged,
      rows_rejected: counts.rejected,
      reject_reasons: counts.rejects,
      error: error ? String(error).slice(0, 1000) : null,
      finished_at: new Date().toISOString(),
    }).eq('id', runId);
  } catch { /* the run row stays "running"; the next pass is unaffected */ }
}

/**
 * Alert state for one pass. true = page, false = clear, null = touch nothing.
 * Pure.
 */
export function journeyAlertState({ results, mode }) {
  if (!results.length) return null;
  const failed = results.filter((r) => !r.ok);
  const rejected = results.reduce((s, r) => s + (r.rejected || 0), 0);
  const returned = results.reduce((s, r) => s + (r.returned || 0), 0);
  const stored = results.reduce((s, r) => s + (r.inserted || 0) + (r.updated || 0) + (r.unchanged || 0), 0);
  const reasons = [];
  if (failed.length) reasons.push(`${failed.length} pull(s) failed: ${failed[0].error}`);
  if (rejected) reasons.push(`${rejected} row(s) rejected (${JSON.stringify(results.find((r) => r.rejected)?.rejects || {})})`);
  if (mode !== 'shadow' && returned > 0 && stored === 0 && !failed.length) reasons.push(`${returned} row(s) returned and none stored`);
  return { active: reasons.length > 0, text: reasons.join('; ') };
}

export async function runFive9CallJourneySync({ env = process.env, nowMs = Date.now(), deps: depsIn = {} } = {}) {
  const mode = journeyMode(env);
  if (mode === 'off') return { skipped: true, reason: 'FIVE9_JOURNEY_SYNC_MODE=off', mode };
  const d = { ...(depsIn.runReportAndWait && depsIn.supabase ? {} : await defaultDeps()), ...depsIn };
  const cfg = journeyConfig(env);
  let lastEndMs;
  try {
    lastEndMs = await lastOkEnd(d.supabase, mode);
  } catch (err) {
    return { checked: false, readFailed: true, mode, reason: err.message };
  }
  const windows = planJourneyWindows({ lastEndMs, nowMs });
  const results = [];
  for (const w of windows) {
    const r = await syncWindow(d, cfg, { ...w, mode });
    results.push(r);
    if (!r.ok) break; // keep the cursor here; the next pass retries from it
  }
  const alert = journeyAlertState({ results, mode });
  if (alert && d.reportAlertCondition) {
    try {
      await d.reportAlertCondition({
        key: ALERT_KEY, active: alert.active, label: 'Five9 Call Journey sync', channel: 'ops',
        text: `⚠️ Five9 Call Journey sync (${mode}): ${alert.text}`,
        recoveredText: '✅ Five9 Call Journey sync is pulling and storing again.',
      });
    } catch { /* an alert that fails to send never fails the pass */ }
  }
  const sum = (k) => results.reduce((s, r) => s + (r[k] || 0), 0);
  return {
    ok: results.every((r) => r.ok), mode, windows: results.length,
    returned: sum('returned'), inserted: sum('inserted'), updated: sum('updated'), unchanged: sum('unchanged'), rejected: sum('rejected'),
    errors: results.filter((r) => !r.ok).map((r) => r.error),
  };
}

/**
 * Pull the last `days` days, in chunks of at most 6 hours, one after another,
 * each logged as a "backfill" run. Live only: a shadow backfill would store nothing.
 */
export async function runFive9CallJourneyBackfill({ days, env = process.env, nowMs = Date.now(), deps: depsIn = {} } = {}) {
  if (journeyMode(env) !== 'live') return { ok: false, refused: true, reason: 'backfill runs only when FIVE9_JOURNEY_SYNC_MODE=live' };
  const d = { ...(depsIn.runReportAndWait && depsIn.supabase ? {} : await defaultDeps()), ...depsIn };
  const cfg = journeyConfig(env);
  const n = Math.min(Math.max(Number(days) || cfg.backfillDays, 1), 31);
  const windows = planJourneyWindows({ lastEndMs: nowMs - n * 24 * 60 * MIN, nowMs, overlapMin: 0 });
  const results = [];
  for (const w of windows) results.push(await syncWindow(d, cfg, { ...w, mode: 'backfill' }));
  const sum = (k) => results.reduce((s, r) => s + (r[k] || 0), 0);
  return {
    ok: results.every((r) => r.ok), days: n, windows: results.length,
    returned: sum('returned'), inserted: sum('inserted'), updated: sum('updated'), unchanged: sum('unchanged'), rejected: sum('rejected'),
    errors: results.filter((r) => !r.ok).map((r) => r.error),
  };
}

/** POST /admin/five9-journey/backfill?days=N — x-admin-token against ADMIN_API_TOKEN; answers 202 and runs in the background. */
export function registerFive9JourneyRoutes(app, { backfill = runFive9CallJourneyBackfill } = {}) {
  let busy = false;
  app.post('/admin/five9-journey/backfill', async (req, res) => {
    const a = checkRequestSecret(req, { route: req.path || 'admin-five9-journey-backfill', secret: process.env.ADMIN_API_TOKEN, headers: ['x-admin-token'] });
    if (!a.allow) {
      return res.status(a.status).json(a.status === 503 ? { error: 'ADMIN_API_TOKEN is not set; this endpoint is closed' } : { error: 'x-admin-token required' });
    }
    if (journeyMode() !== 'live') return res.status(409).json({ error: 'backfill runs only when FIVE9_JOURNEY_SYNC_MODE=live' });
    if (busy) return res.status(409).json({ error: 'a backfill is already running' });
    const days = Number(req.query?.days) || journeyConfig().backfillDays;
    busy = true;
    res.status(202).json({ status: 'started', days, runs_table: RUNS_TABLE });
    Promise.resolve()
      .then(() => runJob(`${JOB_ID}-backfill`, () => backfill({ days })))
      .then(({ value }) => console.log(`[Five9Journey] backfill ${days}d: ${JSON.stringify(value)}`))
      .catch((err) => console.error(`[Five9Journey] backfill threw: ${err.message}`))
      .finally(() => { busy = false; });
  });
}

/* --- scheduler -------------------------------------------------------------- */

let timer = null;
let running = false;

export function startFive9CallJourneyScheduler(env = process.env) {
  if (timer) return timer;
  if (journeyMode(env) === 'off') {
    console.log('[Five9Journey] scheduler not started (FIVE9_JOURNEY_SYNC_MODE=off)');
    return null;
  }
  const cfg = journeyConfig(env);
  const tick = async () => {
    if (running) return; // an overlapping tick never runs twice
    running = true;
    try {
      const { value: res } = await runJob(JOB_ID, () => runFive9CallJourneySync());
      if (res && !res.skipped) console.log(`[Five9Journey] ${res.mode}: ${res.windows} window(s), ${res.returned} returned, ${res.inserted} new, ${res.rejected} rejected`);
    } catch (err) {
      console.error(`[Five9Journey] pass threw: ${err.message}`);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, cfg.intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[Five9Journey] scheduler started — mode ${journeyMode(env)}, every ${Math.round(cfg.intervalMs / 60000)}m`);
  return timer;
}

export function stopFive9CallJourneyScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
