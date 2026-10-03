/**
 * Part 12 (2026-10-03, Mark): "When someone needs a callback, our system
 * should be pushing it to the Five9 callback list, along with a notification
 * in the contact center Slack group." And: no phone call the lead did not ask
 * for (the shutters thread's "Want someone to give you a call?", the drafty
 * chat's "A quick call would…" beside the visit ask).
 */
process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { fileBotCallback, readRequeueResult, five9ResultLine, callbackDecision } = await import('../src/agentic/bot-callback.js');
const { planNepqTurn, enforceNepqPlan, dropUnaskedCallOffer, leadWantsCall } = await import('../src/agentic/nepq-planner.js');
const { promisedCallback } = await import('../src/agentic/team-hours.js');
const { coverageOwnsReply } = await import('../src/agentic/service-area-turn.js');
const { renderPlanBlock } = await import('../src/prompts/response-generator/nepq-backbone.js');
const { formatNepqHandoff } = await import('../src/agentic/nepq-handoff.js');

const T = (...pairs) => pairs.map(([d, t]) => ({ direction: d, text: t }));
const OPEN_MS = Date.parse('2026-10-05T15:00:00Z');
const plan = (a) => planNepqTurn({ channel: 'sms', nowMs: OPEN_MS, ...a });

function fakeDeps({ filed = false, requeue = { status: 'completed', result: { action: 'requeued' } }, throwRequeue = null } = {}) {
  const calls = { requeue: [], handoff: [], claims: [] };
  return {
    calls,
    deps: {
      log: () => {},
      alreadyFiled: async () => filed,
      claim: async (id, key) => { calls.claims.push(key); },
      queueRequeue: async (id, notes) => { calls.requeue.push({ id, notes }); if (throwRequeue) throw new Error(throwRequeue); return requeue; },
      routeHandoff: async (args) => { calls.handoff.push(args); },
    },
  };
}

// ── filing ────────────────────────────────────────────────────────────────
test('a callback goes to Five9 AND the #contact-center card, which names the Five9 result', async () => {
  const { deps, calls } = fakeDeps();
  const r = await fileBotCallback({ contactId: 'C1', channel: 'sms', inbound: 'Yeah sure', nowMs: OPEN_MS }, deps);
  assert.equal(r.filed, true);
  assert.equal(calls.requeue.length, 1);
  assert.equal(calls.handoff.length, 1);
  assert.equal(calls.handoff[0].reason, 'callback_request');
  assert.match(calls.handoff[0].extra, /added to the Callback Request list/);
  assert.equal(calls.claims[0], 'bot_callback_C1_2026-10-05');
});

test('once per contact per day: a second filing is skipped', async () => {
  const { deps, calls } = fakeDeps({ filed: true });
  const r = await fileBotCallback({ contactId: 'C1', nowMs: OPEN_MS }, deps);
  assert.equal(r.filed, false);
  assert.equal(r.reason, 'already_today');
  assert.equal(calls.requeue.length + calls.handoff.length, 0);
});

test('a Five9 failure still posts the card, telling the team to call manually', async () => {
  const { deps, calls } = fakeDeps({ throwRequeue: 'GHL contact fetch failed' });
  const r = await fileBotCallback({ contactId: 'C1', nowMs: OPEN_MS }, deps);
  assert.equal(r.five9.status, 'failed');
  assert.match(calls.handoff[0].extra, /NOT added .*Call them manually/);
});

test('no phone yet (live chat): nothing is filed; the number is asked for first', async () => {
  const { deps, calls } = fakeDeps();
  const r = await fileBotCallback({ contactId: 'C1', hasPhone: false }, deps);
  assert.equal(r.reason, 'no_phone');
  assert.equal(calls.requeue.length + calls.handoff.length, 0);
});

test('Five9 results read plainly', () => {
  assert.equal(readRequeueResult({ status: 'completed', result: { action: 'requeued' } }).status, 'pushed');
  assert.equal(readRequeueResult({ status: 'completed', result: { action: 'requeue_lead_created' } }).status, 'new_lead');
  assert.equal(readRequeueResult({ status: 'completed', result: { action: 'requeue_suppressed_other_list' } }).status, 'already_dialing');
  assert.equal(readRequeueResult({ status: 'completed', result: { action: 'requeue_deduped' } }).status, 'deduped');
  assert.equal(readRequeueResult({ status: 'failed', error: 'boom' }).status, 'failed');
  assert.match(five9ResultLine({ status: 'already_dialing' }), /already being dialed/);
  assert.match(formatNepqHandoff({ reason: 'callback_request', channel: 'sms', inbound: 'x', contactId: 'C1', extra: 'Five9: added.' }).card, /\nFive9: added\.\n/);
});

// ── when a callback is due ───────────────────────────────────────────────
test('a planned callback, or a promise the planner did not choose, is filed; nothing else', () => {
  assert.equal(callbackDecision({ handoffReason: 'callback_request', text: 'x' }), 'planned');
  assert.equal(callbackDecision({ text: 'Got it, someone from our team will call you shortly.' }), 'promise_backed');
  assert.equal(callbackDecision({ handoffReason: 'complaint', text: 'Someone from our team will call you.' }), null, 'a hand-off already covers it');
  assert.equal(callbackDecision({ text: "You're all set for Wed at 10 AM. Our team will reach out to confirm the details." }), null);
  assert.equal(callbackDecision({ text: 'Want someone to give you a call and go over it?' }), null, 'an offer is not a promise');
  assert.equal(promisedCallback('What made you reach out today?'), false);
  assert.equal(promisedCallback('A team member will call to set up a free measure.'), true);
});

test('planner: asking for a call, or a yes to our call offer, is a callback request', () => {
  assert.equal(plan({ trigger: 'can someone call me?' }).handoff?.reason, 'callback_request');
  assert.equal(plan({ trigger: "I'd rather talk on the phone" }).handoff?.reason, 'callback_request');
  const offered = T(['inbound', 'Well we have hurricane shutters now.'], ['outbound', 'No problem. Want someone to give you a call and go over it?']);
  const p = plan({ trigger: 'Yeah sure', conversation: offered });
  assert.equal(p.handoff?.reason, 'callback_request');
  assert.match(p.fixed_line, /call you/);
  // Not every "yes" after any message.
  assert.equal(plan({ trigger: 'Yeah sure', conversation: T(['outbound', 'Is it the bedrooms?']) }).handoff, null);
});

// ── no unasked call offers ───────────────────────────────────────────────
test('a call nobody asked for is dropped; a call they asked for stays', () => {
  const draft = "That makes sense. A quick call would let us figure out what's happening. What's bothering you most?";
  assert.equal(dropUnaskedCallOffer(draft).text, "That makes sense. What's bothering you most?");
  assert.equal(dropUnaskedCallOffer(draft, { leadWantsCall: true }).changed, false);
  assert.equal(leadWantsCall(T(['inbound', 'just call me instead']), 'ok'), true);
  assert.equal(leadWantsCall(T(['inbound', 'they leak']), 'ok'), false);
  // In the plan guard: the probe keeps its question.
  const p = plan({ trigger: 'they leak when it rains', conversation: T(['outbound', 'What got you looking?']) });
  const out = enforceNepqPlan('Leaks are no fun. Want someone to give you a call and go over it?', p);
  assert.ok(out.changes.includes('unasked_call_offer_dropped'));
  assert.ok(!/call/i.test(out.text), out.text);
  assert.match(out.text, /\?$/);
  // A callback hand-off line keeps its promise.
  const cb = plan({ trigger: 'can someone call me?' });
  assert.match(enforceNepqPlan(cb.fixed_line, cb).text, /call you/);
});

test('the prompt says no call offer, unless the lead wants a call', () => {
  const p = plan({ trigger: 'they leak' });
  assert.ok(renderPlanBlock(p).join('\n').includes('Never offer or suggest a phone call'));
  const q = plan({ trigger: 'they leak', conversation: T(['inbound', 'just call me instead']) });
  assert.ok(!renderPlanBlock(q).join('\n').includes('Never offer or suggest a phone call'));
});

test('after the bridge, more detail gets the visit question once more, then plain answers', () => {
  const thread = T(['inbound', 'they are drafty'], ['outbound', 'Drafty? Which rooms?'], ['inbound', 'the bedrooms'], ['outbound', 'How is that affecting you?'], ['inbound', 'its getting worse'],
    ['outbound', "From what you've shared, I think we can help, since you mentioned the drafts. The easiest next step is a free visit at your home. Would that help?"]);
  const p = planNepqTurn({ channel: 'livechat', nowMs: OPEN_MS, trigger: 'the kids are cold all winter', conversation: thread });
  assert.equal(p.step, 'bridge_followup');
  assert.equal(p.required_move, 'bridge');
  assert.notEqual(p.bridge_line, thread[thread.length - 1].text, 'a variant not sent yet');
  const out = enforceNepqPlan("That makes sense. A quick call would let us figure out what's happening. What day works best for the visit?", p).text;
  assert.ok(!/call/i.test(out), out);
  assert.match(out, /next step/);
  // A second non-answer: no third bridge.
  const again = [...thread, { direction: 'inbound', text: 'the kids are cold all winter' }, { direction: 'outbound', text: p.bridge_line }];
  assert.equal(planNepqTurn({ channel: 'livechat', nowMs: OPEN_MS, trigger: 'it is what it is', conversation: again }).required_move, 'answer');
});

// ── coverage turns get a plan ────────────────────────────────────────────
test('only the zip ask and the out-of-area close own the whole reply', () => {
  assert.equal(coverageOwnsReply(null), false);
  assert.equal(coverageOwnsReply({ plan: { active: false } }), false);
  assert.equal(coverageOwnsReply({ plan: { active: true }, coverage: { status: 'ask_zip' } }), true);
  assert.equal(coverageOwnsReply({ plan: { active: true }, coverage: { status: 'out' } }), true);
  for (const status of ['in', 'place_in', 'unknown', 'place_unknown']) {
    assert.equal(coverageOwnsReply({ plan: { active: true }, coverage: { status } }), false, status);
  }
});
