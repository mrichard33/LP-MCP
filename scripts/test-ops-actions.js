/**
 * test-ops-actions.js — the command center's actions (System Health 1.6):
 * src/health/ops-actions.js, the /ops routes (src/routes/ops.js) and the
 * Slack incident buttons (src/slack-approvals.js).
 *
 * Guards: the actor is required and written to incident_events; snooze and
 * close need a reason; an illegal move answers 409, not 500; incident_* clicks
 * are NEVER forwarded to the onboarding workflow (it would read them as a
 * member approval), on or off, malformed included; the clicker's email is the
 * actor, with the team_members row and then the Slack id as fallbacks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fakeSupabase } from './lib/fake-supabase.js';

process.env.SLACK_SIGNING_SECRET = 'ops_test_secret';
const { registerSlackApprovalRoutes, handleIncidentInteraction } = await import('../src/slack-approvals.js');
const { parseIncidentInteraction, isIncidentAction } = await import('../src/slack-approvals-core.js');
const { ackIncident, snoozeIncident, closeIncident, runCheckNow, runAllChecks, incidentAction } = await import('../src/health/ops-actions.js');
const { registerOpsRoutes } = await import('../src/routes/ops.js');

const NOW = Date.parse('2026-10-15T15:00:00Z');
const PERSON = 'mark@reecewindows.com';

function db() {
  return fakeSupabase({
    incidents: [{ id: 5, fingerprint: 'lead.uncalled_live', check_id: 'lead.uncalled_live', status: 'open', severity: 'P1', system: 'five9', title: 't', opened_at: new Date(NOW).toISOString(), data: {} }],
    incident_events: [],
    health_checks: [{ check_id: 'lead.uncalled_live', config: {} }],
    health_results: [],
  });
}

test('ack needs an actor and writes it to the timeline', async () => {
  const client = db();
  assert.equal((await ackIncident(5, {}, { client })).status, 400);
  const out = await ackIncident(5, { actor: PERSON, nowMs: NOW }, { client });
  assert.equal(out.ok, true);
  assert.equal(client.tables.incidents[0].acknowledged_by, PERSON);
  assert.equal(client.tables.incident_events[0].actor, PERSON);
  assert.equal(client.tables.incident_events[0].kind, 'acknowledged');
  const again = await ackIncident(5, { actor: PERSON }, { client });
  assert.equal(again.status, 409, 'a second ack is an illegal move, answered 409');
});

test('snooze and close need a reason; snooze defaults to 2 hours', async () => {
  const client = db();
  assert.equal((await snoozeIncident(5, { actor: PERSON }, { client })).status, 400);
  const s = await snoozeIncident(5, { actor: PERSON, reason: 'vendor outage', nowMs: NOW }, { client });
  assert.equal(s.ok, true);
  assert.equal(client.tables.incidents[0].snooze_until, new Date(NOW + 2 * 3_600_000).toISOString());
  assert.equal((await closeIncident(5, { actor: PERSON }, { client })).status, 400);
  const c = await closeIncident(5, { actor: PERSON, reason: 'expected', nowMs: NOW }, { client });
  assert.equal(c.ok, true);
  assert.equal(client.tables.incidents[0].status, 'closed_no_action');
});

test('run a check now: its owner job runs that check only, results recorded', async () => {
  const client = db();
  const registry = new Map([
    ['lead.uncalled_live', { check_id: 'lead.uncalled_live', owner_job_id: 'health-checks' }],
    ['dialer.silence', { check_id: 'dialer.silence', owner_job_id: 'five9-silence-watchdog' }],
  ]);
  const asked = [];
  const runners = { 'health-checks': async (id) => { asked.push(id); return { health: [{ check_id: 'lead.uncalled_live', status: 'pass' }, { check_id: 'other', status: 'pass' }] }; } };
  const out = await runCheckNow('lead.uncalled_live', { client, actor: PERSON }, { registry, runners });
  assert.equal(out.ok, true);
  assert.deepEqual(asked, ['lead.uncalled_live']);
  assert.equal(out.results, 1);
  assert.equal((await runCheckNow('dialer.silence', { client }, { registry, runners })).status, 409);
  assert.equal((await runCheckNow('nope', { client }, { registry, runners })).status, 404);
  const all = await runAllChecks({ client }, { runners });
  assert.equal(all.ok, true);
  assert.equal(await incidentAction('nope', 5, {}).then((r) => r.status), 400);
});

test('/ops routes: answer with the action\'s status code', async () => {
  const client = db();
  const routes = {};
  const app = { post: (path, ...handlers) => { routes[path] = handlers[handlers.length - 1]; } };
  registerOpsRoutes(app, (_q, _s, next) => next(), { client });
  assert.ok(routes['/ops/incidents/:id/ack'] && routes['/ops/checks/run-all'] && routes['/ops/checks/:check_id/run']);
  const call = async (path, params, body) => {
    const res = { code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await routes[path]({ params, body, method: 'POST', path }, res);
    return res;
  };
  assert.equal((await call('/ops/incidents/:id/ack', { id: '5' }, {})).code, 400);
  assert.equal((await call('/ops/incidents/:id/ack', { id: '5' }, { actor: PERSON })).code, 200);
  assert.equal((await call('/ops/incidents/:id/close', { id: '5' }, { actor: PERSON })).code, 400);
});

/* ── Slack ─────────────────────────────────────────────────────────────── */

const form = (payload) => `payload=${encodeURIComponent(JSON.stringify(payload))}`;
const click = (action_id, value = '5') => form({
  type: 'block_actions', user: { id: 'U_MARK', username: 'mark' }, response_url: 'https://hooks.slack.com/actions/x',
  actions: [{ action_id, value }],
});
function signed(body) {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = 'v0=' + crypto.createHmac('sha256', process.env.SLACK_SIGNING_SECRET).update(`v0:${ts}:${body}`).digest('hex');
  return { 'x-slack-request-timestamp': ts, 'x-slack-signature': sig };
}

test('parse: ack / snooze with an id; the URL button is "open"; junk is null', () => {
  assert.deepEqual(parseIncidentInteraction(Buffer.from(click('incident_ack'))), { action: 'ack', incidentId: 5, userId: 'U_MARK', userName: 'mark', responseUrl: 'https://hooks.slack.com/actions/x' });
  assert.equal(parseIncidentInteraction(Buffer.from(click('incident_snooze'))).action, 'snooze');
  assert.equal(parseIncidentInteraction(Buffer.from(click('incident_open', ''))).action, 'open');
  assert.equal(parseIncidentInteraction(Buffer.from(click('incident_ack', 'x'))), null);
  assert.equal(isIncidentAction(Buffer.from(click('incident_ack', 'x'))), true);
  assert.equal(isIncidentAction(Buffer.from(click('approve_member'))), false);
});

test('the route NEVER forwards an incident click to onboarding, live or not, malformed included', async () => {
  for (const live of [true, false]) {
    let handler;
    const forwarded = [];
    const handled = [];
    registerSlackApprovalRoutes({ post: (_p, h) => { handler = h; } }, {
      forwardUrl: 'https://n8n.example.com/webhook/onboarding',
      forward: async (_b, _h, { url }) => { forwarded.push(url); return { forwarded: true }; },
      payrollLive: () => false,
      mktInvoiceOn: () => false,
      incidentLive: () => live,
      incidentHandler: async (p) => { handled.push(p.action); return { handled: true }; },
    });
    const post = async (body) => {
      const res = { code: null, status(c) { this.code = c; return this; }, send() { return this; } };
      handler({ body: Buffer.from(body), headers: signed(body) }, res);
      await new Promise((r) => setImmediate(r));
      return res;
    };
    for (const body of [click('incident_ack'), click('incident_snooze'), click('incident_open', ''), click('incident_ack', 'bad')]) {
      assert.equal((await post(body)).code, 200);
    }
    assert.equal(forwarded.length, 0, `live=${live}: incident clicks must never reach onboarding`);
    assert.deepEqual(handled, live ? ['ack', 'snooze'] : []);
    await post(click('approve_member'));
    assert.equal(forwarded.length, 1, 'an onboarding click still forwards');
  }
});

test('the button handler: email first, then team_members, then the Slack id', async () => {
  const calls = [];
  const replies = [];
  const act = async (a, id, args) => { calls.push({ a, id, ...args }); return { ok: true }; };
  const reply = async (_u, body) => { replies.push(body.text); };
  await handleIncidentInteraction({ action: 'ack', incidentId: 5, userId: 'U1', responseUrl: 'u' }, { act, reply, lookupEmail: async () => ({ email: PERSON }), teamEmail: async () => 'x@y' });
  await handleIncidentInteraction({ action: 'snooze', incidentId: 5, userId: 'U2', responseUrl: 'u' }, { act, reply, lookupEmail: async () => ({ email: null }), teamEmail: async () => 'team@reecewindows.com' });
  await handleIncidentInteraction({ action: 'ack', incidentId: 5, userId: 'U3', responseUrl: 'u' }, { act, reply, lookupEmail: async () => { throw new Error('no scope'); }, teamEmail: async () => null });
  assert.deepEqual(calls.map((c) => c.actor), [PERSON, 'team@reecewindows.com', 'U3']);
  assert.equal(calls[1].a, 'snooze');
  assert.equal(calls[1].minutes, 120);
  assert.ok(calls[1].reason);
  assert.match(replies[0], /Acknowledged/);
});
