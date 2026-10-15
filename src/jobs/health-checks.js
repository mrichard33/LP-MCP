/**
 * health-checks.js — the System Health job: one pass every 5 minutes that
 * evaluates the registry checks owned by `health-checks` and writes one
 * health_results row each (System Health Phase 0, 2026-10-15).
 *
 * WHAT IT IS. A recording layer. It posts nothing to Slack and changes no
 * watchdog: the incident notifier (Phase 1) is the only thing that turns a
 * result into a card, and only for a check whose row says mode='live'.
 *
 * RULES (Mark's ground rules for the platform):
 *   - every check is capped at 5s and runs in its own try/catch; a timeout or
 *     an error is status 'unknown' with the reason, never 'pass';
 *   - thresholds come from health_checks.config (the recorder resolves them),
 *     so a threshold change is a row update;
 *   - outside a check's active_window the result is 'skipped';
 *   - read-only against LP, Five9, GHL, n8n and Railway. Writes go only to
 *     health_results;
 *   - Five9 is the only source of truth for calls (five9_events_raw).
 *
 * Checks run on their own cadence inside the 5-minute tick (`everyMin`), so
 * an hourly check is not re-asked every 5 minutes. A check whose owner job
 * does not exist yet (synthetic-canary, n8n-execution-poller: Phases 2-3) gets
 * an hourly 'unknown' naming why, so the board shows a reason, not silence.
 *
 * HEALTH_CHECKS_MODE off | shadow | live (default shadow). Shadow and live both
 * write results; the per-check `mode` column decides what the notifier acts on.
 */

import { runJob } from '../job-runner.js';
import { loadHealthChecks } from '../health/registry.js';
import { recordHealthResults } from '../health/record.js';
import { inActiveWindow, cadenceMinutes, cadenceWindow, etParts } from '../health/window.js';
import { RAILWAY_SERVICES, serviceIdFor, serviceState, restartsResult } from '../health/railway-state.js';
import { count, duration, windowWords } from '../health/plain.js';

export const JOB_ID = 'health-checks';
export const TICK_MS = 5 * 60_000;
export const CHECK_TIMEOUT_MS = 5_000;

/** Owner jobs that are not built yet. Their checks read 'unknown' with this reason. */
export const NOT_BUILT_OWNERS = Object.freeze({
  'synthetic-canary': 'Coming later: test runs are not built yet.',
  'n8n-execution-poller': 'Coming later: n8n monitoring is not built yet.',
});

export function healthChecksMode(env = process.env) {
  const raw = String(env.HEALTH_CHECKS_MODE ?? '').trim().toLowerCase();
  return ['off', 'shadow', 'live'].includes(raw) ? raw : 'shadow';
}

const n = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const first = (rows) => (Array.isArray(rows) && rows.length ? rows[0] : {});
const minutesSince = (iso, nowMs) => (iso ? Math.round((nowMs - Date.parse(iso)) / 60_000) : null);

/** Thresholds from config, inclusive, higher is worse. Pure. */
function band(value, warn, fail) {
  if (!Number.isFinite(value)) return 'unknown';
  if (fail !== undefined && fail !== null && value >= Number(fail)) return 'fail';
  if (warn !== undefined && warn !== null && value >= Number(warn)) return 'warn';
  return 'pass';
}

/** Consecutive misses per probe, in memory. A restart forgets them, which only delays a fail by one probe. */
const misses = new Map();
function missRule(checkId, ok, c, { latencyMs, warnLatencyMs } = {}) {
  const count = ok ? 0 : (misses.get(checkId) || 0) + 1;
  misses.set(checkId, count);
  if (ok) return warnLatencyMs && latencyMs > warnLatencyMs ? 'warn' : 'pass';
  return count >= Number(c.fail_consecutive ?? 2) ? 'fail' : 'warn';
}

async function timedFetch(fetchImpl, url, opts = {}, timeoutMs = 4_500) {
  const started = Date.now();
  const res = await fetchImpl(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  return { res, latencyMs: Date.now() - started };
}

/* ── the checks ──────────────────────────────────────────────────────────
 * Each: { everyMin, run(ctx, row) → entry without check_id }. `ctx` carries
 * the deps; `row` is the check's registry row (config, active_window).
 */
export const CHECKS = {
  'agent.action_failures': {
    everyMin: 15,
    async run({ runSQL }, row) {
      const types = (row.config?.fail_any_types || []).map((t) => `'${String(t).replace(/'/g, "''")}'`).join(',') || "''";
      const r = first(await runSQL(`
        SELECT count(*) AS failed_1h,
               count(*) FILTER (WHERE action_type IN (${types})) AS critical_1h
        FROM agent_actions WHERE status = 'failed' AND updated_at >= now() - interval '1 hour'`));
      const failed = n(r.failed_1h) ?? 0;
      const critical = n(r.critical_1h) ?? 0;
      return {
        value: failed,
        rule: (_v, c) => (critical > 0 ? 'fail' : band(failed, c.warn, c.fail)),
        summary: failed ? `${count(failed, 'automatic action')} failed in the last hour${critical ? ` (${critical} of them were writing leads to Five9 or Lead Perfection)` : ''}.` : 'No automatic actions failed in the last hour.',
        detail: { failed_1h: failed, critical_1h: critical },
      };
    },
  },

  'agent.approval_backlog': {
    everyMin: 60,
    async run({ runSQL }) {
      const r = first(await runSQL('SELECT count(*) AS waiting, min(created_at) AS oldest FROM agent_approval_queue'));
      const waiting = n(r.waiting) ?? 0;
      const ageH = r.oldest ? (Date.now() - Date.parse(r.oldest)) / 3_600_000 : 0;
      return {
        value: Math.round(ageH * 10) / 10,
        rule: (_v, c) => (waiting ? band(ageH, c.warn_h, c.fail_h) : 'pass'),
        summary: waiting ? `${count(waiting, 'approval')} waiting for someone to decide; the oldest has waited ${duration(ageH * 60)}.` : 'Nothing is waiting for approval.',
        detail: { waiting, oldest_at: r.oldest ?? null },
      };
    },
  },

  'agent.guardrail_blocks': {
    everyMin: 60,
    async run({ runSQL }) {
      // This hour's blocks vs the median of the same hour over the prior 7 days.
      const r = first(await runSQL(`
        WITH h AS (
          SELECT date_trunc('hour', decided_at) AS hr, count(*) AS n FROM guardrail_decisions
          WHERE verdict <> 'clean' AND decided_at >= now() - interval '8 days' GROUP BY 1
          UNION ALL
          SELECT date_trunc('hour', created_at), count(*) FROM validation_log
          WHERE blocked AND created_at >= now() - interval '8 days' GROUP BY 1
        ), per AS (SELECT hr, sum(n) AS n FROM h GROUP BY hr)
        SELECT
          coalesce((SELECT n FROM per WHERE hr = date_trunc('hour', now() - interval '1 hour')), 0) AS last_hour,
          (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY coalesce(p.n, 0))
             FROM generate_series(1, 7) d
             LEFT JOIN per p ON p.hr = date_trunc('hour', now() - interval '1 hour') - make_interval(days => d)) AS median`));
      const last = n(r.last_hour) ?? 0;
      const median = n(r.median) ?? 0;
      const ratio = median > 0 ? last / median : (last > 0 ? last : 0);
      return {
        value: Math.round(ratio * 100) / 100,
        // With a zero baseline, a handful of blocks is not a spike: need 3+.
        rule: (_v, c) => (median === 0 && last < 3 ? 'pass' : band(ratio, c.warn_x, c.fail_x)),
        summary: `The safety filter blocked ${count(last, 'message')} in the last hour (a normal hour: ${median}).`,
        detail: { last_hour: last, median_same_hour_7d: median },
      };
    },
  },

  'agent.llm_cost': {
    everyMin: 60,
    async run({ runSQL, env, nowMs }) {
      const budget = Number(env.LLM_DAILY_BUDGET_USD || 25);
      const day = etParts(nowMs).day;
      const r = first(await runSQL(`SELECT coalesce(sum(cost_usd), 0) AS cost FROM v_llm_usage_daily WHERE day_et = '${day}'`));
      const cost = n(r.cost) ?? 0;
      const pct = budget > 0 ? (cost / budget) * 100 : 0;
      return {
        value: Math.round(pct),
        eval: { suffix: 'pct' },
        active: false,
        summary: `$${cost.toFixed(2)} spent on AI today, of a $${budget} daily budget.`,
        detail: { cost_usd: cost, budget_usd: budget, day_et: day },
      };
    },
  },

  'dialer.campaign_running': {
    everyMin: 5,
    multi: true,
    async run({ five9 }, row) {
      const expected = row.config?.expected || [];
      const inv = await five9.getCampaigns();
      const byName = new Map((inv?.campaigns || []).map((c) => [String(c.name).toLowerCase(), c]));
      // One result per campaign; the worst is written last so the board's
      // "latest result" for the check is its worst member.
      return expected.map((name) => {
        const c = byName.get(String(name).toLowerCase());
        const fp = `dialer.campaign_running:${name}`;
        if (!c) return { status: 'unknown', summary: `${name}: Five9 has no campaign by this name (was it renamed?).`, fingerprint: fp, detail: { campaign: name } };
        const running = String(c.state || '').toUpperCase() === 'RUNNING';
        return {
          status: running ? 'pass' : 'fail',
          summary: running ? `${name} is running.` : `${name} is not running (Five9 says ${String(c.state || 'no state').toLowerCase()}).`,
          detail: { campaign: name, state: c.state || null, mode: c.mode || null },
          fingerprint: fp,
        };
      });
    },
  },

  'ghl.dead_triggers': {
    everyMin: 24 * 60,
    needsLast: true,
    async run({ hlRunSQL, lastDetail }) {
      // Active triggers on DRAFT workflows, and the same trigger (type +
      // conditions) on two or more published workflows. A trigger that only
      // adds its own workflow is the normal shape and is ignored (noise).
      const drafts = await hlRunSQL(`
        SELECT w.id, w.name, t.raw_json->>'name' AS trigger_name
        FROM workflow_triggers t JOIN workflows w ON w.id::text = t.workflow_id::text
        WHERE w.status = 'draft' AND coalesce((t.raw_json->>'active')::boolean, false)
          AND NOT coalesce((t.raw_json->>'deleted')::boolean, false)`);
      const dupes = await hlRunSQL(`
        SELECT t.trigger_event, md5(coalesce(t.raw_json->'conditions', '[]'::jsonb)::text) AS cond,
               min(t.raw_json->>'name') AS trigger_name,
               array_agg(DISTINCT w.name ORDER BY w.name) AS workflows
        FROM workflow_triggers t JOIN workflows w ON w.id::text = t.workflow_id::text
        WHERE w.status = 'published' AND coalesce((t.raw_json->>'active')::boolean, false)
          AND NOT coalesce((t.raw_json->>'deleted')::boolean, false)
        GROUP BY 1, 2 HAVING count(DISTINCT t.workflow_id) > 1`);
      const keys = [
        ...drafts.map((d) => `draft:${d.id}:${d.trigger_name}`),
        ...dupes.map((d) => `dupe:${d.trigger_event}:${d.cond}`),
      ];
      const seen = new Set(lastDetail?.keys || []);
      const fresh = keys.filter((k) => !seen.has(k));
      return {
        value: fresh.length,
        status: fresh.length ? 'warn' : 'pass',
        summary: drafts.length || dupes.length
          ? `${count(drafts.length, 'unpublished GHL workflow')} can still be started, and ${count(dupes.length, 'trigger')} start${dupes.length === 1 ? 's' : ''} more than one workflow${fresh.length ? ` (${fresh.length} new since yesterday)` : ''}.`
          : 'No GHL workflow is set to start twice or from an unpublished draft.',
        detail: {
          keys,
          new: fresh.slice(0, 30),
          drafts: drafts.slice(0, 30).map((d) => ({ workflow: d.name, trigger: d.trigger_name })),
          duplicates: dupes.slice(0, 30).map((d) => ({ trigger: d.trigger_name, event: d.trigger_event, workflows: d.workflows })),
        },
      };
    },
  },

  'ghl.webhook_liveness': {
    everyMin: 60,
    async run({ runSQL }) {
      // GHL → LP-MCP webhooks land in intake_journal. Last 2h vs the median of
      // the same 2h window on the same weekday over the prior 4 weeks.
      const r = first(await runSQL(`
        WITH w AS (SELECT generate_series(0, 4) AS k)
        SELECT
          (SELECT count(*) FROM intake_journal WHERE route ILIKE '%ghl%' AND received_at >= now() - interval '2 hours') AS last_2h,
          (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY c) FROM (
             SELECT (SELECT count(*) FROM intake_journal
                     WHERE route ILIKE '%ghl%'
                       AND received_at >= now() - interval '2 hours' - make_interval(weeks => k)
                       AND received_at <  now() - make_interval(weeks => k)) AS c
             FROM w WHERE k > 0) b) AS median`));
      const last = n(r.last_2h) ?? 0;
      const median = n(r.median) ?? 0;
      const pct = median > 0 ? (last / median) * 100 : null;
      return {
        value: last,
        rule: (_v, c) => {
          if (last === 0 && median > 0) return 'fail';
          if (pct !== null && pct < Number(c.warn_pct ?? 50)) return 'warn';
          return 'pass';
        },
        summary: `GHL sent us ${count(last, 'update')} in the last 2 hours (a normal ${median}).`,
        detail: { last_2h: last, median_same_window_4w: median, pct_of_normal: pct === null ? null : Math.round(pct) },
      };
    },
  },

  'jobs.failed': {
    everyMin: 5,
    async run({ runSQL }, row) {
      const rows = await runSQL(`
        SELECT r.job_id, array_agg(r.status ORDER BY r.started_at DESC) AS statuses,
               (array_agg(r.summary ORDER BY r.started_at DESC))[1] AS last_summary
        FROM (SELECT job_id, status, summary, started_at,
                     row_number() OVER (PARTITION BY job_id ORDER BY started_at DESC) AS rn
              FROM job_runs
              WHERE started_at >= now() - interval '7 days'
                AND status IN ('ok', 'failed', 'unknown')) r
        JOIN job_registry g ON g.job_id = r.job_id AND g.enabled
        WHERE r.rn <= 3
        GROUP BY r.job_id`);
      const exclude = new Set(row.config?.exclude || []);
      const failing = [];
      const flaky = [];
      for (const j of rows) {
        if (exclude.has(j.job_id)) continue;
        const s = j.statuses || [];
        if (s.length >= 3 && s.slice(0, 3).every((x) => x === 'failed')) failing.push({ job_id: j.job_id, last_summary: j.last_summary });
        else if (s.includes('failed')) flaky.push({ job_id: j.job_id, last_summary: j.last_summary });
      }
      return {
        value: failing.length,
        status: failing.length ? 'fail' : flaky.length ? 'warn' : 'pass',
        summary: failing.length
          ? `${count(failing.length, 'background job')} failed 3 times in a row: ${failing.map((f) => f.job_id).join(', ')}.`.slice(0, 300)
          : flaky.length ? `${count(flaky.length, 'background job')} failed once recently and then recovered: ${flaky.map((f) => f.job_id).join(', ')}.`.slice(0, 300) : 'Every background job ran without errors.',
        detail: { failing, flaky: flaky.slice(0, 30) },
      };
    },
  },

  'jobs.silent': {
    everyMin: 5,
    async run({ runSQL, nowMs }, row) {
      const rows = await runSQL(`
        SELECT job_id, cadence, last_started_at FROM v_job_status WHERE enabled`);
      const warnX = Number(row.config?.warn_x ?? 2);
      const failX = Number(row.config?.fail_x ?? 4);
      const silent = [];
      let worst = 'pass';
      for (const j of rows) {
        const every = cadenceMinutes(j.cadence);
        if (!every || !j.last_started_at) continue; // no interval in the text, or never run (jobs.failed / the registry show those)
        // "hourly 08:00–20:00 ET" is quiet overnight by design: judged only
        // inside its window, after it has had time to run twice.
        const win = cadenceWindow(j.cadence);
        if (win && !inActiveWindow(`${win.from}-${win.to} ET`, nowMs)) continue;
        if (win && inActiveWindow(`${win.from}-${win.to} ET`, nowMs - every * warnX * 60_000) === false) continue;
        const age = minutesSince(j.last_started_at, nowMs);
        const s = age >= every * failX ? 'fail' : age >= every * warnX ? 'warn' : 'pass';
        if (s !== 'pass') silent.push({ job_id: j.job_id, cadence: j.cadence, silent_min: age, status: s });
        if (s === 'fail' || (s === 'warn' && worst === 'pass')) worst = s;
      }
      return {
        value: silent.length,
        status: worst,
        summary: silent.length ? `${count(silent.length, 'background job')} didn't run when expected: ${silent.map((s) => `${s.job_id} (quiet ${duration(s.silent_min)})`).join(', ')}.`.slice(0, 300) : 'Every background job ran on time.',
        detail: { silent: silent.slice(0, 40) },
      };
    },
  },

  'lead.booked_without_lp': {
    everyMin: 60,
    async run({ runSQL }) {
      // get_identity_health's appt_set_without_lp_record, on a 24h window and
      // without the 30-day view (too slow for the 5s cap): the same filters,
      // calls first, then the lp_leads phone10 index.
      const rows = await runSQL(`
        WITH calls AS (
          SELECT right(regexp_replace(coalesce(ani, ''), '\\D', '', 'g'), 10) AS caller,
                 campaign, max(received_at) AS last_call_at
          FROM five9_events_raw
          WHERE received_at >= now() - interval '24 hours'
            AND disposition_name = 'Appointment Set'
            AND coalesce(lp_rec_key, '') = ''
            AND campaign NOT ILIKE ALL (ARRAY['%dispatch%', '%confirmation%', '%reset%', '%rehash%'])
          GROUP BY 1, 2)
        SELECT c.caller, c.campaign, c.last_call_at FROM calls c
        WHERE length(c.caller) = 10
          AND NOT EXISTS (SELECT 1 FROM lp_leads l
                          WHERE right(regexp_replace(coalesce(l.phone, ''), '[^0-9]', '', 'g'), 10) = c.caller)
          AND NOT EXISTS (SELECT 1 FROM lp_leads l WHERE l.phone_alt LIKE '%' || c.caller)
        ORDER BY c.last_call_at DESC LIMIT 50`);
      return {
        value: rows.length,
        active: false,
        eval: {},
        summary: rows.length ? `${count(rows.length, 'appointment')} booked on a phone call in the last day with no lead in Lead Perfection for that caller.` : 'Every appointment booked on a call in the last day has a lead in Lead Perfection.',
        detail: { calls: rows.map((r) => ({ phone10: String(r.caller || '').replace(/\D/g, '').slice(-10), campaign: r.campaign, at: r.last_call_at })) },
      };
    },
  },

  'n8n.reachable': {
    everyMin: 5,
    async run({ fetch: fetchImpl, env }) {
      const base = n8nBaseUrl(env);
      if (!base) return { status: 'unknown', summary: "Can't check n8n: its web address isn't set up (N8N_BASE_URL)." };
      let ok = false;
      let detail = {};
      try {
        const { res, latencyMs } = await timedFetch(fetchImpl, `${base}/healthz`);
        ok = res.ok;
        detail = { http: res.status, latency_ms: latencyMs };
      } catch (err) {
        detail = { error: err.message };
      }
      return {
        rule: (_v, c) => missRule('n8n.reachable', ok, c),
        summary: ok ? 'n8n is up.' : `n8n is not answering (${detail.error || `error ${detail.http}`}).`,
        detail: { url: `${base}/healthz`, ...detail },
      };
    },
  },

  'svc.dashboard': {
    everyMin: 5,
    async run({ fetch: fetchImpl, env }, row) {
      const url = row.config?.url || (env.DASHBOARD_BASE_URL ? `${env.DASHBOARD_BASE_URL.replace(/\/$/, '')}/overview` : null);
      if (!url) return { status: 'unknown', summary: "Can't check the dashboard: its web address isn't set up (DASHBOARD_BASE_URL)." };
      let ok = false;
      let detail = {};
      try {
        // A login redirect is the dashboard serving; follow nothing.
        const { res, latencyMs } = await timedFetch(fetchImpl, url, { redirect: 'manual' });
        ok = res.status < 400;
        detail = { http: res.status, latency_ms: latencyMs };
      } catch (err) {
        detail = { error: err.message };
      }
      return {
        value: detail.latency_ms ?? null,
        rule: (_v, c) => missRule('svc.dashboard', ok, c, { latencyMs: detail.latency_ms, warnLatencyMs: 3000 }),
        summary: ok ? (detail.latency_ms > 3000 ? `The dashboard is up but slow (${(detail.latency_ms / 1000).toFixed(1)} seconds to load).` : 'The dashboard is up.') : `The dashboard is not answering (${detail.error || `error ${detail.http}`}).`,
        detail: { url, ...detail },
      };
    },
  },

  'svc.five9_api': {
    everyMin: 5,
    async run({ probes }) { return probeEntry('svc.five9_api', await probes.five9()); },
  },
  'svc.lp_api': {
    everyMin: 5,
    async run({ probes }) { return probeEntry('svc.lp_api', await probes.lp()); },
  },
  'svc.slack': {
    everyMin: 5,
    async run({ probes }) { return probeEntry('svc.slack', await probes.slack()); },
  },

  'svc.hl_mcp': {
    everyMin: 5,
    async run({ fetch: fetchImpl, env, railway }, row) {
      if (!env.HL_MCP_URL) return { status: 'unknown', summary: "Can't check HL-MCP: its web address isn't set up (HL_MCP_URL)." };
      const url = `${new URL(env.HL_MCP_URL).origin}/health`;
      let ok = false;
      let detail = {};
      try {
        const { res, latencyMs } = await timedFetch(fetchImpl, url);
        ok = res.ok;
        detail = { http: res.status, latency_ms: latencyMs };
      } catch (err) {
        detail = { error: err.message };
      }
      const deploy = await railway.state('HL-MCP').catch((err) => ({ error: err.message }));
      const down = deploy?.state === 'crashed';
      return {
        value: detail.latency_ms ?? null,
        rule: (_v, c) => (down ? 'fail' : missRule('svc.hl_mcp', ok, c, { latencyMs: detail.latency_ms, warnLatencyMs: Number(c.warn_latency_ms ?? 3000) })),
        summary: ok
          ? `HL-MCP is up.${deploy?.state === 'failed_update' ? ' Its latest update failed to deploy; the previous version is still running.' : ''}`
          : `HL-MCP is not answering (${detail.error || `error ${detail.http}`})${down ? ' and Railway shows it crashed' : ''}.`,
        detail: { url, ...detail, deploy },
      };
    },
  },

  'svc.lp_mcp': {
    everyMin: 5,
    async run({ railway, uptimeSec }) {
      // This process answering IS the probe; the deploy status says whether a
      // newer build is failing behind it.
      const deploy = await railway.state('LP-MCP').catch((err) => ({ error: err.message }));
      const failedUpdate = deploy?.state === 'failed_update';
      return {
        value: Math.round(uptimeSec),
        status: failedUpdate ? 'warn' : 'pass',
        summary: `LP-MCP is up (running for ${duration(uptimeSec / 60)}).${failedUpdate ? ' Its latest update failed to deploy; the previous version is still running.' : ''}`,
        detail: { uptime_sec: Math.round(uptimeSec), deploy },
      };
    },
  },

  'svc.railway_restarts': {
    everyMin: 15,
    async run({ railway, nowMs }) {
      // Every watched service by its Railway ID (src/health/railway-state.js).
      const entries = [];
      for (const s of RAILWAY_SERVICES) {
        try {
          entries.push({ name: s.name, deployments: await railway.deployments(s.name) });
        } catch (err) {
          entries.push({ name: s.name, error: err.message });
        }
      }
      return restartsResult(entries, { nowMs });
    },
  },

  'svc.supabase_lp': {
    everyMin: 5,
    async run({ supabase }) {
      const started = Date.now();
      const { error } = await supabase.from('health_checks').select('check_id').limit(1);
      if (error) return { status: 'fail', summary: `The main database is not answering (${error.message}).`.slice(0, 300) };
      return { status: 'pass', value: Date.now() - started, summary: 'The main database is answering normally.', detail: { read_ms: Date.now() - started, cpu_disk: 'not read (no Supabase management key)' } };
    },
  },

  'svc.supabase_hl': {
    everyMin: 5,
    async run({ hlRunSQL }) {
      const started = Date.now();
      await hlRunSQL('SELECT 1 AS ok');
      return { status: 'pass', value: Date.now() - started, summary: 'The GHL copy database is answering normally.', detail: { read_ms: Date.now() - started, cpu_disk: 'not read (no Supabase management key)' } };
    },
  },

  'sync.appt_parity': {
    everyMin: 30,
    async run({ runSQL }, row) {
      const minAge = Number(row.config?.min_age_min ?? 15);
      const r = first(await runSQL(`
        SELECT count(*) AS gaps FROM alert_conditions
        WHERE state = 'firing' AND alert_key LIKE 'appt_parity:gap:%'
          AND first_seen_at <= now() - make_interval(mins => ${minAge})`));
      const gaps = n(r.gaps) ?? 0;
      return { value: gaps, active: false, eval: {}, summary: gaps ? `${count(gaps, 'appointment')} ${gaps === 1 ? 'is' : 'are'} different in Lead Perfection and GHL.` : 'Appointments match in Lead Perfection and GHL.', detail: { source: "alert_conditions 'appt_parity:gap:*'" } };
    },
  },

  'sync.five9_key_pct': {
    everyMin: 24 * 60,
    async run({ runSQL }) {
      const r = first(await runSQL(`
        SELECT count(*) AS events, count(*) FILTER (WHERE coalesce(lp_rec_key, '') <> '') AS keyed
        FROM five9_events_raw WHERE received_at >= now() - interval '24 hours'`));
      const events = n(r.events) ?? 0;
      const keyed = n(r.keyed) ?? 0;
      if (!events) return { status: 'unknown', summary: 'No Five9 calls in the last day to measure.' };
      const pct = Math.round((keyed / events) * 1000) / 10;
      return { value: pct, active: false, eval: { suffix: 'pct', lowerIsWorse: true, strict: true }, summary: `${pct}% of ${events.toLocaleString('en-US')} Five9 call records in the last day are tied to a Lead Perfection lead.`, detail: { events, keyed } };
    },
  },

  'sync.hl_cache_fresh': {
    everyMin: 5,
    async run({ hlRunSQL, nowMs }) {
      const rows = await hlRunSQL(`
        SELECT entity_type,
               max(completed_at) FILTER (WHERE status = 'completed') AS last_done,
               count(*) FILTER (WHERE status = 'failed' AND started_at >= now() - interval '24 hours') AS failed_24h,
               count(*) FILTER (WHERE started_at >= now() - interval '24 hours') AS total_24h
        FROM sync_log WHERE started_at >= now() - interval '7 days' GROUP BY entity_type`);
      // Each entity is judged against its OWN rhythm (runs in the last 24h):
      // contacts sync every 15 min, tags every 6h, the nightly refresh daily.
      const per = rows.map((r) => {
        const runs = n(r.total_24h) || 0;
        return {
          entity: r.entity_type,
          age_min: minutesSince(r.last_done, nowMs),
          expected_every_min: runs > 0 ? Math.round(1440 / runs) : 1440,
          failed_24h: n(r.failed_24h),
          total_24h: runs,
        };
      });
      const total = per.reduce((s, p) => s + (p.total_24h || 0), 0);
      const failed = per.reduce((s, p) => s + (p.failed_24h || 0), 0);
      const failRate = total ? (failed / total) * 100 : 0;
      const key = per.filter((p) => ['contacts', 'opportunities'].includes(p.entity));
      const maxAge = Math.max(0, ...per.map((p) => p.age_min ?? 0));
      return {
        value: maxAge,
        rule: (_v, c) => {
          if (key.some((p) => p.age_min === null || p.age_min > Number(c.fail_min ?? 120)) || failRate > Number(c.fail_rate_pct ?? 5)) return 'fail';
          if (per.some((p) => p.age_min === null || p.age_min > Math.max(Number(c.warn_min ?? 30), 2 * p.expected_every_min))) return 'warn';
          return 'pass';
        },
        summary: `The GHL copy was last fully refreshed ${duration(maxAge)} ago${failed ? `; ${failed} of ${total} refreshes failed in the last day` : ''}.`,
        detail: { entities: per, failure_rate_24h_pct: Math.round(failRate * 10) / 10 },
      };
    },
  },

  'sync.lp_errors': {
    everyMin: 15,
    async run({ runSQL }) {
      // 2026-10-15: red only for NEW errors. 134 errors up to 97 days old with
      // none new kept this red forever, which teaches people to ignore red.
      const r = first(await runSQL(`
        SELECT count(*) AS open_total,
               count(*) FILTER (WHERE created_at >= now() - interval '1 hour') AS new_1h,
               count(*) FILTER (WHERE created_at >= now() - interval '24 hours') AS new_24h,
               min(created_at) AS oldest
        FROM lp_sync_errors WHERE resolved = false`));
      const total = n(r.open_total) ?? 0;
      const new1h = n(r.new_1h) ?? 0;
      const new24h = n(r.new_24h) ?? 0;
      const ageH = r.oldest ? (Date.now() - Date.parse(r.oldest)) / 3_600_000 : 0;
      const old = total - new24h;
      return {
        value: new24h,
        rule: (_v, c) => {
          if (new24h >= Number(c.fail_new_24h ?? 10) || new1h > Number(c.warn_new_1h ?? 5)) return 'fail';
          if (new24h > 0 || old > 0) return 'warn';
          return 'pass';
        },
        summary: !total
          ? 'No Lead Perfection sync errors.'
          : `${new24h ? `${count(new24h, 'new Lead Perfection sync error')} today${new1h ? ` (${new1h} in the last hour)` : ''}` : 'No new Lead Perfection sync errors today'}${old ? `; ${count(old, 'older error')} still open, the oldest ${duration(ageH * 60)} old` : ''}.`,
        detail: { open_total: total, new_1h: new1h, new_24h: new24h, oldest_at: r.oldest ?? null },
      };
    },
  },

  'sync.lp_leads_fresh': {
    everyMin: 5,
    async run({ runSQL, nowMs }) {
      const rows = await runSQL(`
        SELECT status, completed_at, started_at FROM lp_sync_log
        WHERE entity_type = 'leads' ORDER BY started_at DESC LIMIT 5`);
      const lastDone = rows.find((r) => r.status === 'completed' || r.status === 'success');
      const age = minutesSince(lastDone?.completed_at, nowMs);
      const recent = rows.slice(0, 2).map((r) => r.status);
      const twoFailed = recent.length === 2 && recent.every((s) => s === 'failed');
      return {
        value: age,
        rule: (_v, c) => (twoFailed ? 'fail' : age === null ? 'unknown' : band(age, c.warn_min, c.fail_min)),
        summary: age === null ? "Can't find a completed lead copy from Lead Perfection." : `Leads were last copied from Lead Perfection ${duration(age)} ago${twoFailed ? '; the last two tries failed' : ''}.`,
        detail: { last_completed_at: lastDone?.completed_at ?? null, recent_statuses: rows.map((r) => r.status) },
      };
    },
  },

  'lead.intake_gap': {
    everyMin: 60,
    async run() {
      return {
        status: 'unknown',
        summary: 'Coming later: this needs an hourly count, but the numbers it uses are only made once a day (8:10 AM).',
      };
    },
  },
};

function probeEntry(checkId, row) {
  const state = row?.state;
  if (state === 'not_configured' || state === 'unknown') {
    return { status: 'unknown', summary: `Can't check ${row?.name || checkId} right now${row?.detail ? ` (${row.detail})` : ''}.`.slice(0, 300), detail: row || {} };
  }
  const ok = state === 'connected';
  return {
    value: row?.latency_ms ?? null,
    rule: (_v, c) => missRule(checkId, ok, c),
    summary: (ok ? `${row?.name || checkId} is connected.` : `${row?.name || checkId} is not connecting${row?.detail ? ` (${row.detail})` : ''}.`).slice(0, 300),
    detail: row || {},
  };
}

/** n8n's base URL: N8N_BASE_URL, else the origin of a URL that already points at n8n. */
export function n8nBaseUrl(env = process.env) {
  if (env.N8N_BASE_URL) return env.N8N_BASE_URL.replace(/\/$/, '');
  for (const k of ['SLACK_INTERACTIONS_FORWARD_URL', 'SLACK_DNC_LIFT_FORWARD_URL', 'N8N_DNC_LIFT_REVIEW_WEBHOOK']) {
    if (env[k]) {
      try { return new URL(env[k]).origin; } catch { /* next */ }
    }
  }
  return null;
}

/* ── the pass ──────────────────────────────────────────────────────────── */

const lastRunAt = new Map();

/** Run `fn` with a hard cap; a timeout rejects with a readable message. */
export function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * One pass. Returns { ok, mode, ran, skipped, unknown, health } — runJob
 * writes `health`. Never throws: every check is isolated.
 */
export async function runHealthChecks({ env = process.env, nowMs = Date.now(), deps = {}, force = false, only = null } = {}) {
  const mode = healthChecksMode(env);
  if (mode === 'off') return { skipped: true, reason: 'HEALTH_CHECKS_MODE=off' };
  const d = { ...(await defaultDeps(deps)), ...deps };
  const registry = d.registry || (await loadHealthChecks({ client: d.supabase, nowMs }));
  if (!registry.size) return { checked: false, readFailed: true, reason: 'health_checks registry unreadable' };

  const health = [];
  const ran = [];
  const skipped = [];
  const ctxBase = { ...d, env, nowMs };

  for (const [checkId, spec] of Object.entries(CHECKS)) {
    if (only && !only.includes(checkId)) continue;
    const row = registry.get(checkId);
    if (!row || row.enabled === false || row.mode === 'off') continue;
    const every = (spec.everyMin ?? 5) * 60_000;
    if (!force && nowMs - (lastRunAt.get(checkId) || 0) < every - 30_000) continue;
    lastRunAt.set(checkId, nowMs);
    if (!inActiveWindow(row.active_window, nowMs)) {
      health.push({ check_id: checkId, status: 'skipped', summary: `Only checked ${windowWords(row.active_window)}.`, fingerprint: checkId });
      skipped.push(checkId);
      continue;
    }
    const started = Date.now();
    try {
      const lastDetail = spec.needsLast ? await d.lastDetail(checkId) : null;
      const out = await withTimeout(Promise.resolve().then(() => spec.run({ ...ctxBase, lastDetail }, row)), CHECK_TIMEOUT_MS, checkId);
      const list = spec.multi ? out : [out];
      const elapsed = Date.now() - started;
      for (const e of list) health.push({ fingerprint: checkId, ...e, check_id: checkId, elapsed_ms: elapsed });
      ran.push(checkId);
    } catch (err) {
      health.push({ check_id: checkId, status: 'unknown', summary: `Can't tell right now: ${err.message}`.slice(0, 300), fingerprint: checkId, elapsed_ms: Date.now() - started });
      ran.push(checkId);
    }
  }

  // Checks whose owner job is not built yet: an hourly 'unknown' with the reason.
  for (const row of registry.values()) {
    if (only && !only.includes(row.check_id)) continue;
    const why = NOT_BUILT_OWNERS[row.owner_job_id];
    if (!why || row.enabled === false || row.mode === 'off') continue;
    if (!force && nowMs - (lastRunAt.get(row.check_id) || 0) < 60 * 60_000 - 30_000) continue;
    lastRunAt.set(row.check_id, nowMs);
    health.push({ check_id: row.check_id, status: 'unknown', summary: why, fingerprint: row.check_id });
  }

  const unknown = health.filter((h) => h.status === 'unknown').length;
  return {
    ok: true,
    mode,
    ran: ran.length,
    skipped: skipped.length,
    unknown,
    summary: `${health.length} result(s): ${ran.length} checked, ${skipped.length} outside window, ${unknown} unknown`,
    health,
  };
}

/** Test seam: forget per-check cadence and miss counters. */
export function resetHealthChecksState() {
  lastRunAt.clear();
  misses.clear();
}

async function defaultDeps(given) {
  const need = (k) => given[k] === undefined;
  const out = {};
  if (need('supabase')) out.supabase = (await import('../supabase.js')).default;
  if (need('runSQL')) out.runSQL = (await import('../admin/supabase-admin.js')).runSQL;
  if (need('hlRunSQL')) out.hlRunSQL = (await import('../admin/hl-client.js')).hlRunSQL;
  if (need('fetch')) out.fetch = globalThis.fetch;
  if (need('uptimeSec')) out.uptimeSec = process.uptime();
  if (need('five9')) {
    const f9 = await import('../five9-admin.js');
    out.five9 = { getCampaigns: f9.getCampaigns };
  }
  if (need('probes')) out.probes = await defaultProbes();
  if (need('railway')) out.railway = await defaultRailway();
  if (need('lastDetail')) {
    const supabase = out.supabase || given.supabase;
    out.lastDetail = async (checkId) => {
      const { data } = await supabase.from('health_results').select('detail')
        .eq('check_id', checkId).neq('status', 'unknown').order('observed_at', { ascending: false }).limit(1).maybeSingle();
      return data?.detail || null;
    };
  }
  return out;
}

async function defaultProbes() {
  const ih = await import('../integrations-health.js');
  const { getToken, getTokenStatus } = await import('../token-manager.js');
  const f9 = await import('../five9-admin.js');
  const base = { env: process.env, fetch: globalThis.fetch, lp: { getToken, getTokenStatus }, five9: { breakerStatus: f9.five9AuthBreakerStatus, getSkills: f9.getSkills } };
  const opts = { timeoutMs: 4_500 };
  return {
    lp: () => ih.probe('lp_api', 'Lead Perfection API', 'services', () => ih.lpApiProbe(base), opts),
    five9: () => ih.probe('five9', 'Five9', 'dialer', () => ih.five9Probe(base), opts),
    // Alerts post through postToSlack, which ignores SLACK_MIRROR_ENABLED, so
    // the token is what matters here, mirror switch or not.
    slack: () => ih.probe('slack', 'Slack', 'messaging', () => ih.slackProbe({ ...base, env: { ...process.env, SLACK_MIRROR_ENABLED: 'true' } }), opts),
  };
}

async function defaultRailway() {
  const { railwayQuery } = await import('../admin/railway-client.js');
  // 2026-10-15: ask Railway for each service by its ID (any project the
  // token can see). The old lookup searched LP-MCP's own project by name and
  // never found HL-MCP, n8n or the Dashboard (src/health/railway-state.js).
  const cache = new Map();
  const deployments = async (name) => {
    const id = serviceIdFor(name);
    if (!id) throw new Error(`no Railway service ID for "${name}"`);
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < 60_000) return hit.deps;
    const data = await railwayQuery(`query($id: String!) { service(id: $id) { name
      deployments(first: 10) { edges { node { id status createdAt } } } } }`, { id });
    const deps = (data?.service?.deployments?.edges || []).map((e) => e.node);
    cache.set(id, { at: Date.now(), deps });
    return deps;
  };
  return {
    deployments,
    async state(name) {
      return serviceState(await deployments(name));
    },
  };
}

/* ── scheduler ─────────────────────────────────────────────────────────── */

let timer = null;
let running = false;

export function startHealthChecksScheduler(env = process.env) {
  if (timer) return timer;
  if (healthChecksMode(env) === 'off') {
    console.log('[HealthChecks] scheduler not started (HEALTH_CHECKS_MODE=off)');
    return null;
  }
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { value } = await runJob(JOB_ID, () => runHealthChecks());
      if (value?.summary) console.log(`[HealthChecks] ${value.mode}: ${value.summary}`);
    } catch (err) {
      console.error(`[HealthChecks] pass threw: ${err.message}`);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 60_000).unref?.();
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  console.log(`[HealthChecks] scheduler started — every ${TICK_MS / 60000} min, mode=${healthChecksMode(env)}`);
  return timer;
}

export function stopHealthChecksScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
