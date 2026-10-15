/**
 * The 2026-10-15 plain-English pass over the health checks:
 *  - the Railway check reads every service by its ID (it showed "?" for three
 *    of four because it searched LP-MCP's own project by name);
 *  - "Run all checks now" in the morning no longer judges tomorrow's
 *    appointments against tonight's 8:45 PM deadline (31 false reds);
 *  - the appointment time rules say which rule, in words;
 *  - no result a person reads carries a 24-hour clock time.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceState, restartsResult, RAILWAY_SERVICES, serviceIdFor } from '../src/health/railway-state.js';
import { runAppointmentPipelineCheck, resetAppointmentPipelineState, dueSlot, CHECKS, timeRulesSummary, apptWhen } from '../src/health/appointment-pipeline.js';
import { uncalledLiveResults, lpReportResult, staleSetLeadsResult, five9SilenceResults, leadLeakResults } from '../src/health/watchdog-results.js';
import { buildIncidentCard } from '../src/health/incident-card.js';
import { TWENTY_FOUR_HOUR_TIME } from '../src/health/plain.js';

const NOW = Date.parse('2026-10-15T14:35:00Z'); // 10:35 AM EDT
const dep = (status, minAgo) => ({ status, createdAt: new Date(NOW - minAgo * 60_000).toISOString() });

test('Railway: every watched service has an ID, including the three outside LP-MCP\'s project', () => {
  for (const name of ['LP-MCP', 'HL-MCP', 'n8n', 'Reece Dashboard']) assert.ok(serviceIdFor(name), name);
  assert.equal(new Set(RAILWAY_SERVICES.map((s) => s.id)).size, RAILWAY_SERVICES.length);
});

test('Railway: the running version decides, not old failed builds', () => {
  assert.equal(serviceState([dep('SUCCESS', 60), dep('FAILED', 9000), dep('FAILED', 20000)], NOW).state, 'running');
  assert.equal(serviceState([dep('BUILDING', 1), dep('SUCCESS', 60)], NOW).state, 'running');
  assert.equal(serviceState([dep('CRASHED', 5), dep('REMOVED', 900)], NOW).state, 'crashed');
  assert.equal(serviceState([dep('FAILED', 5), dep('SUCCESS', 900)], NOW).state, 'failed_update');
  assert.equal(serviceState([dep('FAILED', 5)], NOW).state, 'crashed');
  assert.equal(serviceState([], NOW).state, 'unknown');
});

test('Railway: plain summaries, red only when a service is down', () => {
  const ok = restartsResult(RAILWAY_SERVICES.map((s) => ({ name: s.name, deployments: [dep('SUCCESS', 120)] })), { nowMs: NOW });
  assert.equal(ok.status, 'pass');
  assert.equal(ok.summary, `All ${RAILWAY_SERVICES.length} services are running normally.`);

  const down = restartsResult([{ name: 'LP-MCP', deployments: [dep('SUCCESS', 60)] }, { name: 'n8n', deployments: [dep('CRASHED', 23)] }], { nowMs: NOW });
  assert.equal(down.status, 'fail');
  assert.match(down.summary, /^n8n is down \(since 10:12 AM\)\.$/);

  const unseen = restartsResult([{ name: 'LP-MCP', deployments: [dep('SUCCESS', 60)] }, { name: 'HL-MCP', error: 'Not Authorized' }], { nowMs: NOW });
  assert.equal(unseen.status, 'warn');
  assert.match(unseen.summary, /Can't see HL-MCP on Railway/);
  assert.doesNotMatch(unseen.summary, /\?/);

  const none = restartsResult([{ name: 'LP-MCP', error: 'Railway API 401' }], { nowMs: NOW });
  assert.equal(none.status, 'unknown');

  const loop = restartsResult([{ name: 'HL-MCP', deployments: [dep('SUCCESS', 5), dep('REMOVED', 15), dep('REMOVED', 25), dep('REMOVED', 35)] }], { nowMs: NOW });
  assert.equal(loop.status, 'warn');
  assert.match(loop.summary, /restarted 4 times in the last hour/);

  const busy = restartsResult([{ name: 'LP-MCP', deployments: [dep('SUCCESS', 5), dep('REMOVED', 30)] }], { nowMs: NOW });
  assert.equal(busy.status, 'pass', 'two deploys in an hour is a normal merge day');
});

test('a morning "run now" of an evening appointment check writes nothing and says when it runs', async () => {
  resetAppointmentPipelineState();
  const spec = CHECKS['appt.issue_by_2000'];
  const slot = dueSlot('appt.issue_by_2000', spec, NOW, true);
  assert.equal(slot.notDue, true);
  const registry = new Map(['appt.issue_by_2000', 'appt.unassigned_next_day', 'appt.set_not_confirmed', 'appt.capacity_over', 'appt.required_fields']
    .map((id) => [id, { check_id: id, enabled: true, mode: 'shadow', config: {} }]));
  let sqlCalls = 0;
  const out = await runAppointmentPipelineCheck({
    env: {}, nowMs: NOW, force: true,
    only: ['appt.issue_by_2000', 'appt.unassigned_next_day', 'appt.set_not_confirmed', 'appt.capacity_over'],
    deps: { registry, supabase: null, runSQL: async () => { sqlCalls += 1; return []; } },
  });
  assert.equal(out.health.length, 0, 'no result written before the deadline');
  assert.equal(sqlCalls, 0);
  assert.deepEqual(out.notDue.find((x) => x.check_id === 'appt.issue_by_2000'), { check_id: 'appt.issue_by_2000', message: 'Not due yet: runs at 8:15 PM and 8:45 PM.' });
  assert.equal(out.notDue.find((x) => x.check_id === 'appt.unassigned_next_day').message, 'Not due yet: runs at 7:30 PM and 8:15 PM.');

  // A morning check forced at 10:35 AM uses its 7:00 AM slot and runs.
  resetAppointmentPipelineState();
  const morning = await runAppointmentPipelineCheck({
    env: {}, nowMs: NOW, force: true, only: ['appt.required_fields'],
    deps: { registry, supabase: null, runSQL: async () => [] },
  });
  assert.equal(morning.health.length, 1);
});

test('time rules say which rule, in words, and stay yellow until dispatch confirms', () => {
  const bad = [
    { kind: 'never', hour: 12 }, { kind: 'never', hour: 12 }, { kind: 'never', hour: 16 },
    { kind: 'meeting', hour: 10 },
  ];
  const s = timeRulesSummary(bad, { pending: true });
  assert.equal(s, "4 appointments this week are at a time we don't book: 2 at 12:00 PM, 1 at 4:00 PM, 1 on a morning when that office has its sales meeting. Dispatch still needs to confirm these time rules.");
  assert.doesNotMatch(s, /confirm_with_dispatch/);
  assert.equal(timeRulesSummary([]), 'Every appointment this week is at a time we book.');
  assert.equal(apptWhen('2026-10-16 14:00'), 'Fri, Oct 16, 2:00 PM');
});

test('no summary a person reads carries a 24-hour clock time', () => {
  const texts = [
    timeRulesSummary([{ kind: 'outside', hour: 20 }], { byBot: 1 }),
    uncalledLiveResults({ decision: { verdict: 'alert' }, offenders: [], nowMs: NOW })[0].summary,
    lpReportResult({ type: 'r', label: 'Report 133 Sales', state: 'missing', lastEtDay: '2026-10-14', nowMs: NOW }).summary,
    lpReportResult({ type: 'r', label: 'Report 133 Sales', state: 'ok', lastEtDay: '2026-10-15', nowMs: NOW }).summary,
    staleSetLeadsResult({ count: 12 }).summary,
    five9SilenceResults({ reason: 'outside_business_hours', nowMs: NOW })[0].summary,
    five9SilenceResults({ active: false, latest: { received_at: new Date(NOW - 3 * 60_000).toISOString() }, nowMs: NOW })[0].summary,
    buildIncidentCard({ id: 1, check_id: 'x', severity: 'P2', status: 'snoozed', title: 'T', opened_at: new Date(NOW - 7200_000).toISOString(), snooze_until: '2026-10-16T00:45:00Z', occurrence_count: 1 }, { nowMs: NOW }).text,
  ];
  for (const t of texts) assert.doesNotMatch(t, TWENTY_FOUR_HOUR_TIME, t);
  assert.match(texts[texts.length - 1], /Snoozed until Thu, Oct 15, 8:45 PM ET/);
  assert.match(texts[texts.length - 1], /High: T/);
});

test('lead leak results read as sentences with dollars', () => {
  const out = leadLeakResults({
    m: { summary: { by_reason: { not_in_five9: { leads: 13, est_value: 9141 } } }, rows: [], retiredFresh: [] },
    nowMs: NOW, retiredDecision: { verdict: 'healthy' }, inboundQueueSplit: true,
  });
  const nf = out.find((x) => x.check_id === 'lead.not_in_five9');
  assert.equal(nf.summary, '13 leads never reached Five9 (worth about $9,141).');
});
