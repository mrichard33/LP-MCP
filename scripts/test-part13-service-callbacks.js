/**
 * Part 13 (2026-10-03, Mark): "I want to make sure only sales related
 * callbacks go [to the Five9 callback list and #contact-center]. Anything
 * related to service should let the lead know a team member will reach out
 * and send to the Slack service channel."
 */
process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { planNepqTurn, isServiceCallback, LINES } = await import('../src/agentic/nepq-planner.js');
const { fileBotCallback } = await import('../src/agentic/bot-callback.js');
const { routeNepqHandoff } = await import('../src/agentic/nepq-handoff.js');

const T = (...pairs) => pairs.map(([d, t]) => ({ direction: d, text: t }));
const OPEN_MS = Date.parse('2026-10-05T15:00:00Z');
const plan = (a) => planNepqTurn({ channel: 'sms', nowMs: OPEN_MS, ...a });

test('what counts as a service call', () => {
  assert.equal(isServiceCallback({ trigger: 'can someone call me about my install date?' }), true);
  assert.equal(isServiceCallback({ trigger: 'call me, one of the windows you installed is leaking' }), true);
  assert.equal(isServiceCallback({ trigger: 'can someone call me about the warranty?' }), true);
  assert.equal(isServiceCallback({ trigger: 'when are the installers coming? call me' }), true);
  assert.equal(isServiceCallback({ trigger: 'can someone call me?' }), false, 'a prospect');
  assert.equal(isServiceCallback({ trigger: 'can someone call me?', conversation: T(['inbound', 'my windows are drafty']) }), false);
  assert.equal(isServiceCallback({ trigger: 'can someone call me?', isCustomer: true }), true, 'a customer, no new work named');
  assert.equal(isServiceCallback({ trigger: 'can someone call me? I want a quote on more windows', isCustomer: true }), false, 'a customer buying more is sales');
});

test('planner: a service call request tells the lead a team member will reach out, and is a service hand-off', () => {
  const p = plan({ trigger: 'can someone call me about my install date?' });
  assert.equal(p.handoff.reason, 'service');
  assert.equal(p.fixed_line, LINES.handoff.service_callback);
  assert.match(p.fixed_line, /a team member will reach out/);
  assert.ok(!/call you/.test(p.fixed_line));
  // A customer saying yes to our call offer: service too.
  const offered = T(['outbound', 'Want someone to give you a call and go over it?']);
  assert.equal(plan({ trigger: 'yes please', conversation: offered, isCustomer: true }).handoff.reason, 'service');
  // A prospect: still the sales callback.
  assert.equal(plan({ trigger: 'can someone call me?' }).handoff.reason, 'callback_request');
  // The install-problem hand-off says the same.
  assert.match(plan({ trigger: 'You installed my windows last month and one is leaking' }).fixed_line, /a team member will reach out/);
});

test('a service callback never reaches Five9: it is the service hand-off', async () => {
  const calls = { requeue: 0, handoff: [] };
  const deps = {
    log: () => {}, alreadyFiled: async () => false, claim: async () => {},
    queueRequeue: async () => { calls.requeue++; return { status: 'completed', result: { action: 'requeued' } }; },
    routeHandoff: async (a) => { calls.handoff.push(a); },
  };
  const r = await fileBotCallback({ contactId: 'C1', inbound: 'call me about my install', kind: 'service' }, deps);
  assert.equal(r.kind, 'service');
  assert.equal(calls.requeue, 0);
  assert.equal(calls.handoff[0].reason, 'service');
  // Sales still goes to Five9.
  await fileBotCallback({ contactId: 'C2', inbound: 'call me', kind: 'sales' }, deps);
  assert.equal(calls.requeue, 1);
  assert.equal(calls.handoff[1].reason, 'callback_request');
});

test('the service card goes to the market #service channel with the service tag', async () => {
  const posted = []; const tags = [];
  const deps = {
    applyTags: async (_id, t) => { tags.push(...t); }, addNote: async () => {}, emitEvent: async () => {},
    post: async (_text, id) => { posted.push(id); return { ok: true }; },
    opsAlert: async () => {},
    serviceChannels: async () => ['C_SERVICE_ORLANDO'],
    env: { SLACK_CHANNEL_SERVICE: 'C_CONTACT_CENTER' },
  };
  await routeNepqHandoff({ contactId: 'C1', reason: 'service', channel: 'sms', inbound: 'my install date?' }, deps);
  assert.deepEqual(posted, ['C_SERVICE_ORLANDO']);
  assert.ok(tags.includes('hdl:callback-service'));
  assert.ok(!tags.includes('hdl:callback-sales'));
  // No market channel: the service rollup (#contact-center), never nowhere.
  posted.length = 0;
  await routeNepqHandoff({ contactId: 'C1', reason: 'service', channel: 'sms', inbound: 'x' }, { ...deps, serviceChannels: async () => [] });
  assert.deepEqual(posted, ['C_CONTACT_CENTER']);
  // A sales callback still goes to #contact-center with the sales tag.
  posted.length = 0; tags.length = 0;
  await routeNepqHandoff({ contactId: 'C1', reason: 'callback_request', channel: 'sms', inbound: 'call me' }, deps);
  assert.deepEqual(posted, ['C_CONTACT_CENTER']);
  assert.ok(tags.includes('hdl:callback-sales'));
});
