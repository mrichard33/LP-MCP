/**
 * test-incident-notifier.js — src/jobs/incident-notifier.js and the card
 * (src/health/incident-card.js).
 *
 * The handoff's four scenarios (System Health 1.3, 2026-10-15):
 *   - 50 fails for one fingerprint → 1 post, 0 repeats;
 *   - fail → pass → fail inside 24h → the incident reopens (same row);
 *   - two passes → resolved, one thread reply, the same card edited;
 *   - a check in shadow never opens an incident.
 * Plus: the 10-minute sustain, shadow mode sends nothing, P1 lead cards also
 * go to #contact-center, could-not-tell sustained 30 min opens a P2.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeSupabase } from './lib/fake-supabase.js';
import { runIncidentNotifier, resetNotifierState, incidentTitle } from '../src/jobs/incident-notifier.js';
import { buildIncidentCard, resolvedReply } from '../src/health/incident-card.js';

const T0 = Date.parse('2026-10-15T15:00:00Z');
const MIN = 60_000;

const LIVE = { check_id: 'lead.uncalled_live', family: 'lead', system: 'five9', label: 'Leads waiting with no Five9 call', severity: 'P1', cadence: 'hourly 08-20 ET', mode: 'live', enabled: true, config: {}, business_impact: 'A lead nobody called is a lead a competitor calls' };
const SHADOW = { ...LIVE, check_id: 'jobs.failed', family: 'workflow', system: 'railway', label: 'LP-MCP jobs failing', severity: 'P2', mode: 'shadow' };
const P2 = { ...LIVE, check_id: 'sync.lp_errors', family: 'sync', system: 'lead_perfection', label: 'Unresolved LP sync errors', severity: 'P2', cadence: 'every 15 min' };
const REGISTRY = new Map([LIVE, SHADOW, P2].map((r) => [r.check_id, r]));

function harness() {
  const client = fakeSupabase({ health_results: [], incidents: [], incident_events: [], health_checks: [...REGISTRY.values()], claude_known_issues: [], escalation_policy: [] });
  let nextId = 1;
  const posts = [];
  const updates = [];
  const deps = {
    client,
    registry: REGISTRY,
    opsChannel: 'C0BVDPL84LF',
    loadCursor: async () => null,
    policies: async () => ({ P1: { severity: 'P1', ack_within_min: 30, remind_every_min: 30, escalate_to: [{ to: null, after_min: 30 }] } }),
    postToSlack: async (text, channel, opts = {}) => { posts.push({ text, channel, ...opts }); return { ok: true, ts: `ts${posts.length}`, channel }; },
    updateSlackMessage: async (channel, ts, text) => { updates.push({ channel, ts, text }); return { ok: true }; },
  };
  const result = (check, status, at, extra = {}) => {
    client.tables.health_results.push({ id: nextId++, check_id: check, status, observed_at: new Date(at).toISOString(), fingerprint: check, detail: {}, summary: `${check} ${status}`, ...extra });
  };
  const run = (at, env = { INCIDENT_NOTIFIER_MODE: 'live' }) => runIncidentNotifier({ env, nowMs: at, deps });
  return { client, deps, posts, updates, result, run };
}

test('50 fails for one fingerprint → one incident, one post, no repeats', async () => {
  resetNotifierState();
  const h = harness();
  for (let i = 0; i < 25; i += 1) h.result('lead.uncalled_live', 'fail', T0 + i * 1000);
  await h.run(T0 + 30_000);
  assert.equal(h.posts.length, 0, 'not posted inside the 10-minute sustain');
  for (let i = 0; i < 25; i += 1) h.result('lead.uncalled_live', 'fail', T0 + 11 * MIN + i * 1000);
  await h.run(T0 + 12 * MIN);
  await h.run(T0 + 13 * MIN);
  await h.run(T0 + 14 * MIN);
  assert.equal(h.client.tables.incidents.length, 1);
  const ops = h.posts.filter((p) => p.channel === 'C0BVDPL84LF' && !p.threadTs);
  assert.equal(ops.length, 1, 'one card in #ops-alerts');
  const cc = h.posts.filter((p) => p.channel === 'C0C6BNY30TB');
  assert.equal(cc.length, 1, 'a P1 lead card also goes to #contact-center');
  assert.equal(h.updates.length, 0, 'no edits while nothing changed');
  assert.ok(ops[0].blocks.some((b) => b.type === 'actions' && b.elements.some((e) => e.action_id === 'incident_ack')));
});

test('fail → pass → fail inside 24h reopens the same incident', async () => {
  resetNotifierState();
  const h = harness();
  h.result('lead.uncalled_live', 'fail', T0);
  await h.run(T0 + MIN);
  h.result('lead.uncalled_live', 'pass', T0 + 2 * MIN);
  await h.run(T0 + 3 * MIN);
  assert.equal(h.client.tables.incidents[0].status, 'verifying');
  h.result('lead.uncalled_live', 'fail', T0 + 4 * MIN);
  await h.run(T0 + 5 * MIN);
  assert.equal(h.client.tables.incidents.length, 1);
  const inc = h.client.tables.incidents[0];
  assert.equal(inc.status, 'investigating');
  assert.equal(inc.occurrence_count, 2);
  assert.ok(h.client.tables.incident_events.some((e) => e.kind === 'reopened'));
});

test('two passes resolve it: the card is edited and one thread reply says so', async () => {
  resetNotifierState();
  const h = harness();
  h.result('lead.uncalled_live', 'fail', T0);
  await h.run(T0 + MIN);
  h.result('lead.uncalled_live', 'fail', T0 + 11 * MIN);
  await h.run(T0 + 11 * MIN);
  assert.equal(h.posts.filter((p) => !p.threadTs).length, 2);
  h.result('lead.uncalled_live', 'pass', T0 + 20 * MIN);
  await h.run(T0 + 20 * MIN);
  h.result('lead.uncalled_live', 'pass', T0 + 25 * MIN);
  await h.run(T0 + 25 * MIN);
  await h.run(T0 + 26 * MIN);
  const inc = h.client.tables.incidents[0];
  assert.equal(inc.status, 'resolved');
  assert.equal(inc.verified_by, 'system');
  const replies = h.posts.filter((p) => p.threadTs);
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /✅ resolved after/);
  assert.ok(h.updates.length >= 1, 'the same card was edited');
  assert.equal(h.posts.filter((p) => !p.threadTs).length, 2, 'never a second card');
});

test('a check in shadow never opens an incident', async () => {
  resetNotifierState();
  const h = harness();
  for (let i = 0; i < 10; i += 1) h.result('jobs.failed', 'fail', T0 + i * MIN);
  await h.run(T0 + 20 * MIN);
  assert.equal(h.client.tables.incidents.length, 0);
  assert.equal(h.posts.length, 0);
});

test('notifier shadow mode writes incidents but sends nothing', async () => {
  resetNotifierState();
  const h = harness();
  h.result('lead.uncalled_live', 'fail', T0);
  await h.run(T0 + MIN, { INCIDENT_NOTIFIER_MODE: 'shadow' });
  h.result('lead.uncalled_live', 'fail', T0 + 12 * MIN);
  await h.run(T0 + 12 * MIN, { INCIDENT_NOTIFIER_MODE: 'shadow' });
  assert.equal(h.client.tables.incidents.length, 1);
  assert.equal(h.posts.length, 0);
  assert.equal(h.updates.length, 0);
  assert.equal((await runIncidentNotifier({ env: { INCIDENT_NOTIFIER_MODE: 'off' }, deps: h.deps })).skipped, true);
});

test('a recovery inside the sustain posts nothing at all', async () => {
  resetNotifierState();
  const h = harness();
  h.result('sync.lp_errors', 'fail', T0);
  await h.run(T0 + MIN);
  h.result('sync.lp_errors', 'pass', T0 + 2 * MIN);
  h.result('sync.lp_errors', 'pass', T0 + 3 * MIN);
  await h.run(T0 + 4 * MIN);
  await h.run(T0 + 20 * MIN);
  assert.equal(h.client.tables.incidents[0].status, 'resolved');
  assert.equal(h.posts.length, 0);
});

test('unknown on a P1 live check for 30 min opens a P2 could-not-read incident; a real answer ends it', async () => {
  resetNotifierState();
  const h = harness();
  h.result('lead.uncalled_live', 'unknown', T0);
  await h.run(T0 + MIN);
  assert.equal(h.client.tables.incidents.length, 0, 'not yet');
  h.result('lead.uncalled_live', 'unknown', T0 + 31 * MIN);
  await h.run(T0 + 31 * MIN);
  const inc = h.client.tables.incidents[0];
  assert.equal(inc.fingerprint, 'unknown:lead.uncalled_live');
  assert.equal(inc.severity, 'P2');
  h.result('lead.uncalled_live', 'pass', T0 + 35 * MIN);
  h.result('lead.uncalled_live', 'pass', T0 + 40 * MIN);
  await h.run(T0 + 41 * MIN);
  assert.equal(h.client.tables.incidents[0].status, 'resolved');
});

test('an unacknowledged P1 card gets one thread reminder past ack_within_min', async () => {
  resetNotifierState();
  const h = harness();
  h.result('lead.uncalled_live', 'fail', T0);
  await h.run(T0 + 11 * MIN);
  await h.run(T0 + 31 * MIN);
  await h.run(T0 + 32 * MIN);
  const reminders = h.posts.filter((p) => p.threadTs && /not acknowledged/.test(p.text));
  assert.equal(reminders.length, 1);
});

test('the card: plain words, the full 10-digit phone, the dashboard link', () => {
  const card = buildIncidentCard({
    id: 7, check_id: 'lead.uncalled_live', severity: 'P1', status: 'open', title: 'Leads waiting with no Five9 call',
    summary: '2 lead(s) waiting', business_impact: 'A lead nobody called is a lead a competitor calls', est_value_at_risk: 4200,
    opened_at: new Date(T0).toISOString(), occurrence_count: 1,
    data: { detail: { leads: [{ name: 'Pat Q.', phone10: '+1 (352) 555-0188', source: 'Google PPC', waiting_min: 42, est_value: 2100 }] } },
  }, { dashboardBaseUrl: 'https://dashboard.getreecewindows.com', nowMs: T0 + 15 * MIN });
  assert.match(card.text, /Pat Q\. · 3525550188 · Google PPC · waiting 42m · est \$2,100/);
  assert.match(card.text, /https:\/\/dashboard\.getreecewindows\.com\/incidents\/7/);
  assert.match(card.text, /est \$4,200 at risk/);
  assert.equal(resolvedReply({ opened_at: new Date(T0).toISOString(), resolved_at: new Date(T0 + 95 * MIN).toISOString() }), '✅ resolved after 1h 35m');
  assert.equal(incidentTitle({ label: 'Expected campaigns are RUNNING' }, 'dialer.campaign_running:DIAL ASAP'), 'Expected campaigns are RUNNING — DIAL ASAP');
});
