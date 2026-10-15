/**
 * test-health-checks.js — the System Health job (src/jobs/health-checks.js),
 * the watchdog result builders (src/health/watchdog-results.js) and the ET
 * window helpers (src/health/window.js).
 *
 * What it guards (System Health Phase 0, 2026-10-15):
 *   - a check that throws or times out is 'unknown' with its reason, and the
 *     other checks still run (each is isolated);
 *   - outside a check's active window the result is 'skipped', never 'pass';
 *   - checks owned by jobs not built yet read 'unknown' with a reason;
 *   - a watchdog's tri-state maps to fail / pass / unknown, and the warn band
 *     comes from the check's config;
 *   - jobs.silent does not call a windowed job silent overnight.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runHealthChecks, resetHealthChecksState, CHECKS, NOT_BUILT_OWNERS, n8nBaseUrl } from '../src/jobs/health-checks.js';
import { resolveStatus } from '../src/health/record.js';
import { inActiveWindow, cadenceMinutes, cadenceWindow, etParts } from '../src/health/window.js';
import {
  uncalledLiveResults, leadLeakResults, five9SilenceResults, lpReportResult, linkLeakResults,
  intakeSweepResult, afterAsapResult, ruleTargetResult, replySlaResult, executorHeartbeatResult,
  queueDepthResult, rateLimiterResult, configDriftResult, staleSetLeadsResult, recordThrottled, resetThrottle,
} from '../src/health/watchdog-results.js';

const SNAPSHOT = JSON.parse(readFileSync(new URL('../src/health/registry.snapshot.json', import.meta.url)));
const REGISTRY = new Map(SNAPSHOT.checks.map((r) => [r.check_id, r]));
const status = (entry) => resolveStatus(entry, REGISTRY.get(entry.check_id));

// 2026-10-15 14:00 ET (a Wednesday, inside 08:00-20:00) and 23:30 ET (outside).
const DAY = Date.parse('2026-10-15T18:00:00Z');
const NIGHT = Date.parse('2026-10-16T03:30:00Z');

function stubDeps(over = {}) {
  return {
    registry: REGISTRY,
    supabase: { from: () => ({ select: () => ({ limit: async () => ({ error: null }) }) }) },
    runSQL: async () => [{}],
    hlRunSQL: async () => [],
    fetch: async () => ({ ok: true, status: 200 }),
    uptimeSec: 600,
    five9: { getCampaigns: async () => ({ campaigns: [] }) },
    probes: {
      lp: async () => ({ state: 'connected', name: 'LP', detail: 'ok', latency_ms: 10 }),
      five9: async () => ({ state: 'connected', name: 'Five9', detail: 'ok', latency_ms: 10 }),
      slack: async () => ({ state: 'connected', name: 'Slack', detail: 'ok', latency_ms: 10 }),
    },
    railway: {
      deployments: async () => [{ status: 'SUCCESS', createdAt: '2026-10-01T00:00:00Z' }],
      state: async () => ({ state: 'running', deploysLastHour: 0 }),
    },
    lastDetail: async () => null,
    ...over,
  };
}

test('window helpers: ET parts, active window, cadence parsing', () => {
  assert.equal(etParts(DAY).hour, 14);
  assert.equal(inActiveWindow('08:00-20:00 ET', DAY), true);
  assert.equal(inActiveWindow('08:00-20:00 ET', NIGHT), false);
  assert.equal(inActiveWindow(null, NIGHT), true);
  assert.equal(cadenceMinutes('every 5 min'), 5);
  assert.equal(cadenceMinutes('every min'), 1);
  assert.equal(cadenceMinutes('hourly 08:00–20:00 ET'), 60);
  assert.equal(cadenceMinutes('daily 02:10 ET'), 1440);
  assert.equal(cadenceMinutes('weekly Mon 07:00 ET'), 7 * 1440);
  assert.equal(cadenceMinutes('monthly, 1st 08:00 ET'), 31 * 1440);
  assert.equal(cadenceMinutes('existing'), null);
  assert.deepEqual(cadenceWindow('hourly 08:00–20:00 ET'), { from: '08:00', to: '20:00' });
  assert.equal(cadenceWindow('every 5 min'), null);
});

test('n8n base url: explicit, else derived from an n8n URL already configured', () => {
  assert.equal(n8nBaseUrl({ N8N_BASE_URL: 'https://n8n.example.com/' }), 'https://n8n.example.com');
  assert.equal(n8nBaseUrl({ SLACK_INTERACTIONS_FORWARD_URL: 'https://n8n.example.com/webhook/abc' }), 'https://n8n.example.com');
  assert.equal(n8nBaseUrl({}), null);
});

test('every check the job implements exists in the registry and is owned by health-checks', () => {
  for (const id of Object.keys(CHECKS)) {
    assert.ok(REGISTRY.has(id), `${id} missing from health_checks`);
    assert.equal(REGISTRY.get(id).owner_job_id, 'health-checks', `${id} is owned by ${REGISTRY.get(id).owner_job_id}`);
  }
});

test('a pass writes one result per due check, isolates a throwing check as unknown', async () => {
  resetHealthChecksState();
  const out = await runHealthChecks({
    nowMs: DAY,
    env: { HEALTH_CHECKS_MODE: 'shadow', N8N_BASE_URL: 'https://n8n.example.com' },
    force: true,
    deps: stubDeps({ runSQL: async (q) => { if (/agent_approval_queue/.test(q)) throw new Error('boom'); return [{}]; } }),
  });
  assert.equal(out.ok, true);
  const byId = new Map(out.health.map((h) => [h.check_id, h]));
  assert.equal(byId.get('agent.approval_backlog').status, 'unknown');
  assert.match(byId.get('agent.approval_backlog').summary, /boom/);
  assert.equal(status(byId.get('svc.supabase_lp')), 'pass');
  assert.equal(status(byId.get('svc.lp_api')), 'pass');
  for (const h of out.health) assert.ok(h.check_id && (h.status || h.rule || 'active' in h), `${h.check_id} has no way to a status`);
});

test('a check slower than 5s is unknown, never pass', async () => {
  resetHealthChecksState();
  const slow = () => new Promise((r) => setTimeout(() => r([{}]), 6_000).unref());
  const out = await runHealthChecks({
    nowMs: DAY, env: {}, force: true, only: ['sync.lp_errors'],
    deps: stubDeps({ runSQL: slow }),
  });
  assert.equal(out.health.length, 1);
  assert.equal(out.health[0].status, 'unknown');
  assert.match(out.health[0].summary, /did not finish within 5000 ms/);
});

test('outside the active window a check is skipped, not passed', async () => {
  resetHealthChecksState();
  const out = await runHealthChecks({ nowMs: NIGHT, env: {}, force: true, only: ['dialer.campaign_running', 'sync.lp_leads_fresh'], deps: stubDeps() });
  for (const h of out.health) assert.equal(h.status, 'skipped', h.check_id);
});

test('checks of jobs not built yet read unknown with the reason', async () => {
  resetHealthChecksState();
  const out = await runHealthChecks({ nowMs: DAY, env: {}, force: true, deps: stubDeps() });
  const syn = out.health.filter((h) => h.check_id.startsWith('syn.'));
  assert.equal(syn.length, 7);
  for (const h of syn) {
    assert.equal(h.status, 'unknown');
    assert.equal(h.summary, NOT_BUILT_OWNERS['synthetic-canary']);
  }
});

test('cadence: an hourly check is not re-asked on the next 5-minute tick', async () => {
  resetHealthChecksState();
  const deps = stubDeps();
  const a = await runHealthChecks({ nowMs: DAY, env: {}, deps, only: ['agent.approval_backlog'] });
  const b = await runHealthChecks({ nowMs: DAY + 5 * 60_000, env: {}, deps, only: ['agent.approval_backlog'] });
  const c = await runHealthChecks({ nowMs: DAY + 61 * 60_000, env: {}, deps, only: ['agent.approval_backlog'] });
  assert.equal(a.health.length, 1);
  assert.equal(b.health.length, 0);
  assert.equal(c.health.length, 1);
});

test('mode off writes nothing', async () => {
  assert.equal((await runHealthChecks({ env: { HEALTH_CHECKS_MODE: 'off' }, deps: stubDeps() })).skipped, true);
});

test('dialer.campaign_running: one result per expected campaign, not running is fail, missing is unknown', async () => {
  resetHealthChecksState();
  const campaigns = [{ name: 'DIAL ASAP', state: 'RUNNING' }, { name: 'Callback Request', state: 'NOT_RUNNING' }];
  const out = await runHealthChecks({
    nowMs: DAY, env: {}, force: true, only: ['dialer.campaign_running'],
    deps: stubDeps({ five9: { getCampaigns: async () => ({ campaigns }) } }),
  });
  const expected = REGISTRY.get('dialer.campaign_running').config.expected;
  assert.equal(out.health.length, expected.length);
  const by = new Map(out.health.map((h) => [h.fingerprint, h.status]));
  assert.equal(by.get('dialer.campaign_running:DIAL ASAP'), 'pass');
  assert.equal(by.get('dialer.campaign_running:Callback Request'), 'fail');
  assert.equal(by.get('dialer.campaign_running:Rehash'), 'unknown');
});

test('jobs.silent: a windowed hourly job is not silent overnight', async () => {
  resetHealthChecksState();
  const rows = [
    { job_id: 'lead-uncalled-check', cadence: 'hourly 08:00–20:00 ET', last_started_at: new Date(NIGHT - 4.5 * 3_600_000).toISOString() },
    { job_id: 'health-checks', cadence: 'every 5 min', last_started_at: new Date(NIGHT - 30 * 60_000).toISOString() },
  ];
  const out = await runHealthChecks({ nowMs: NIGHT, env: {}, force: true, only: ['jobs.silent'], deps: stubDeps({ runSQL: async () => rows }) });
  const h = out.health[0];
  assert.equal(h.status, 'fail');
  assert.deepEqual(h.detail.silent.map((s) => s.job_id), ['health-checks']);
});

/* ── watchdog builders ───────────────────────────────────────────────── */

test('lead.uncalled_live: bands from config; could-not-tell is unknown', () => {
  const now = DAY;
  const lead = (min) => ({ lp_lead_id: '581000', first_name: 'Pat', last_name: 'Quinn', phone10: '3525550188', lead_source: 'Google PPC', waitingMs: min * 60_000 });
  assert.equal(status(uncalledLiveResults({ decision: { verdict: 'insufficient_evidence' }, offenders: null, nowMs: now })[0]), 'unknown');
  assert.equal(status(uncalledLiveResults({ decision: { verdict: 'healthy' }, offenders: [], nowMs: now })[0]), 'pass');
  assert.equal(status(uncalledLiveResults({ decision: { verdict: 'alert' }, offenders: [lead(40)], nowMs: now })[0]), 'warn');
  assert.equal(status(uncalledLiveResults({ decision: { verdict: 'alert' }, offenders: [lead(65)], nowMs: now })[0]), 'fail');
  assert.equal(status(uncalledLiveResults({ decision: { verdict: 'alert' }, offenders: [lead(31), lead(32), lead(33)], nowMs: now })[0]), 'fail');
  const e = uncalledLiveResults({ decision: { verdict: 'alert' }, offenders: [lead(40)], nowMs: now })[0];
  assert.deepEqual(e.detail.leads[0], { lp_lead_id: '581000', name: 'Pat Q.', phone10: '3525550188', source: 'Google PPC', reason: null, waiting_min: 40, est_value: null });
  assert.equal(e.fingerprint, 'lead.uncalled_live');
});

test('lead-leak daily: per-reason counts against config; inbound queue unknown until split', () => {
  const m = {
    verdict: 'leaks_found',
    summary: { by_reason: { not_in_five9: { leads: 12, est_value: 30000 }, routing_or_automation_failure: { leads: 1, est_value: 900 }, on_list_not_dialed: { leads: 1, est_value: 100 } } },
    rows: [{ reason: 'not_in_five9', lp_lead_id: '1', lead_source: 'x', est_value: 2500, detail: { first_name: 'A', last_name: 'B' } }],
    retiredFresh: [],
  };
  const speedRow = { created_day: '2026-10-14', p90_min: 130, never_called: 2, expected: 100 };
  const out = new Map(leadLeakResults({ m, nowMs: DAY, retiredDecision: { verdict: 'healthy' }, speedRow }).map((e) => [e.check_id, e]));
  assert.equal(status(out.get('lead.not_in_five9')), 'fail');
  assert.equal(status(out.get('lead.routing_failure')), 'warn');
  assert.equal(status(out.get('lead.in_inbound_queue')), 'unknown');
  assert.equal(status(out.get('sync.retired_code')), 'pass');
  assert.equal(status(out.get('lead.first_call_p90')), 'warn');
  const unread = leadLeakResults({ m: { verdict: 'insufficient_evidence', errors: ['five9 down'] }, nowMs: DAY });
  assert.ok(unread.every((e) => e.status === 'unknown'));
});

test('dialer.silence: outside hours skipped; null unknown; true fail', () => {
  assert.equal(status(five9SilenceResults({ active: null, reason: 'outside_business_hours', nowMs: DAY })[0]), 'skipped');
  assert.equal(status(five9SilenceResults({ active: null, reason: 'query_error', nowMs: DAY })[0]), 'unknown');
  assert.equal(status(five9SilenceResults({ active: true, reason: 'silent', latest: { received_at: new Date(DAY - 3 * 3_600_000).toISOString() }, nowMs: DAY })[0]), 'fail');
  assert.equal(status(five9SilenceResults({ active: false, reason: 'delivering', latest: { received_at: new Date(DAY - 60_000).toISOString() }, nowMs: DAY })[0]), 'pass');
});

test('sync.lp_reports: missing before 08:30 is not late; after 10:00 fails; names the report number', () => {
  const label = 'Report 134 "Jobs by Milestone Date" (Net Sales)';
  const at = (h, m) => Date.parse(`2026-10-15T${String(h + 4).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
  assert.equal(status(lpReportResult({ type: 'jobs_by_milestone', label, state: 'missing', nowMs: at(8, 0) })), 'pass');
  assert.equal(status(lpReportResult({ type: 'jobs_by_milestone', label, state: 'missing', nowMs: at(9, 0) })), 'warn');
  assert.equal(status(lpReportResult({ type: 'jobs_by_milestone', label, state: 'missing', nowMs: at(10, 5) })), 'fail');
  const ok = lpReportResult({ type: 'jobs_by_milestone', label, state: 'ok', lastEtDay: '2026-10-15', nowMs: at(9, 0) });
  assert.equal(ok.detail.report_number, '134');
  assert.equal(ok.fingerprint, 'sync.lp_reports:jobs_by_milestone');
  assert.equal(lpReportResult({ type: 'x', label, state: 'read_failed', nowMs: DAY }).status, 'unknown');
  assert.equal(lpReportResult({ type: 'x', label, state: 'never_scheduled', nowMs: DAY }).status, 'skipped');
});

test('the other watchdog builders map their verdicts', () => {
  assert.equal(status(linkLeakResults({ decision: { verdict: 'insufficient_evidence' }, sample: { errors: ['hl'] } })[0]), 'unknown');
  assert.equal(status(linkLeakResults({ decision: { verdict: 'alert', offenders: [] }, sample: { tables: { lp_leads: 4 } } })[0]), 'fail');
  assert.equal(status(intakeSweepResult('lead.chat_to_lp', { mode: 'shadow', would_send: 2 }, { readFailed: false })), 'warn');
  assert.equal(status(intakeSweepResult('lead.chat_to_lp', { mode: 'live', failed: 1 }, { readFailed: false })), 'fail');
  assert.equal(status(intakeSweepResult('lead.canvass_to_lp', { mode: 'live', errors: ['x'] }, { readFailed: true })), 'unknown');
  assert.equal(status(afterAsapResult({ checked: false, readFailed: true, reason: 'x' })), 'unknown');
  assert.equal(status(afterAsapResult({ ok: true, counts: { would_push: 4 } })), 'warn');
  assert.equal(status(ruleTargetResult({ checked: false, summary: 'mirror stale' })), 'unknown');
  assert.equal(status(ruleTargetResult({ checked: true, high: 1, low: 0 })), 'fail');
  assert.equal(replySlaResult({ skipped: true }), null);
  assert.equal(status(replySlaResult({ error: 'read failed' })), 'unknown');
  assert.equal(status(replySlaResult({ unanswered: 2, sla_minutes: 3, flagged: [] })), 'fail');
  assert.equal(status(executorHeartbeatResult({ has_pending: true, age_ms: 4 * 60_000 })), 'warn');
  assert.equal(status(executorHeartbeatResult({ has_pending: true, age_ms: 7 * 60_000 })), 'fail');
  assert.equal(status(executorHeartbeatResult({ has_pending: false })), 'pass');
  assert.equal(status(queueDepthResult({ pendingCount: 60, oldestAgeMs: 0 })), 'warn');
  assert.equal(queueDepthResult({ stale: true }), null);
  assert.equal(status(rateLimiterResult({ alert: true, reasons: ['429'] })), 'fail');
  assert.equal(status(rateLimiterResult({ error: 'x' })), 'unknown');
  assert.equal(status(configDriftResult({ summary: { entities_captured: 10, changes_detected: 1, errors: [] }, changes: [{ entity_name: 'DIAL ASAP V2' }] })), 'fail');
  assert.equal(status(configDriftResult({ summary: { entities_captured: 10, changes_detected: 1, errors: [] }, changes: [{ entity_name: 'Other' }] })), 'warn');
  assert.equal(status(configDriftResult({ summary: { entities_captured: 0, errors: [] } })), 'unknown');
  assert.equal(status(staleSetLeadsResult({ count: 12 })), 'warn');
  assert.equal(status(staleSetLeadsResult({ error: 'x' })), 'unknown');
});

test('recordThrottled writes at most once per interval per check', async () => {
  resetThrottle();
  const writes = [];
  const record = async (e) => { writes.push(e); return { ok: true }; };
  const e = { check_id: 'agent.bot_reply_sla', status: 'pass' };
  assert.equal(recordThrottled(e, { nowMs: 0, intervalMs: 300_000, record }), true);
  assert.equal(recordThrottled(e, { nowMs: 60_000, intervalMs: 300_000, record }), false);
  assert.equal(recordThrottled(e, { nowMs: 301_000, intervalMs: 300_000, record }), true);
  assert.equal(recordThrottled(null, { record }), false);
  await new Promise((r) => setImmediate(r));
  assert.equal(writes.length, 2);
});
