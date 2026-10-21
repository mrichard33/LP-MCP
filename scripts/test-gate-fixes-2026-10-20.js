/**
 * test-gate-fixes-2026-10-20.js — the bot gate's remaining failures (2026-10-20):
 *  - two quick texts are one inbound (burst-trigger.js), and "more quotes to come
 *    in / sounds good" is a sign-off, never a repeat_objection hand-off;
 *  - a post-demo lead "still thinking it over" is asked back about the hesitation
 *    the visit recorded (POST_DEMO_VISIT_ASK), with no figure;
 *  - the scorer allows the cancel identity ask by the turn's own flow step.
 *
 * Run: node --test scripts/test-gate-fixes-2026-10-20.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { appendTrigger } = await import('../src/agentic/burst-trigger.js');
const { planNepqTurn, POST_DEMO_VISIT_ASK } = await import('../src/agentic/nepq-planner.js');
const { isLeadSignOff } = await import('../src/agentic/sign-off.js');
const { visitHesitationOf } = await import('../src/siro/presentation-facts.js');
const { hasBetterPrice } = await import('../src/agentic/rehash-nepq.js');
const S = await import('../src/simulator/sim-scoring.js');

const NOW = Date.parse('2026-10-13T15:00:00Z');
const T = (...pairs) => pairs.map(([d, t]) => ({ direction: d === 'o' ? 'outbound' : 'inbound', text: t }));

test('a burst trigger replaces its own texts, never adds a second copy', () => {
  const turns = T(['o', 'Hi'], ['i', 'Still got a couple more quotes to come in'], ['i', 'Sounds good 👍']);
  const out = appendTrigger(turns, 'Still got a couple more quotes to come in\nSounds good 👍');
  assert.equal(out.filter(t => t.direction === 'inbound').length, 1);
  assert.equal(out.at(-1).text, 'Still got a couple more quotes to come in\nSounds good 👍');
  // I.L3-IN's relayed "\n" (two characters) splits the same way.
  assert.equal(appendTrigger(turns, 'Still got a couple more quotes to come in\\nSounds good 👍').filter(t => t.direction === 'inbound').length, 1);
  // A single text already in the thread is not added again; a new one is.
  assert.equal(appendTrigger(T(['i', 'hello']), 'hello').length, 1);
  assert.equal(appendTrigger(T(['i', 'hello']), 'are you there?').length, 2);
});

test('"more quotes to come in / sounds good" is a sign-off: no hand-off, nothing filed', () => {
  const trigger = 'Still got a couple more quotes to come in\nSounds good 👍';
  assert.equal(isLeadSignOff(trigger), true);
  const p = planNepqTurn({ channel: 'sms', nowMs: NOW, slots: [], allSlots: [], tzLabel: 'ET', conversation: T(['i', 'Still got a couple more quotes to come in'], ['i', 'Sounds good 👍']), trigger });
  assert.equal(p.step, 'sign_off');
  assert.ok(!p.handoff, JSON.stringify(p.handoff));
  // A question beside the quotes is not a sign-off.
  assert.equal(isLeadSignOff('Waiting on a few other quotes, how long is the install?'), false);
});

test('a burst counts its objection once (shopping attempt 1, not a repeat hand-off)', () => {
  const p = planNepqTurn({ channel: 'sms', nowMs: NOW, slots: [], allSlots: [], tzLabel: 'ET', conversation: T(['i', 'Getting a few quotes'], ['i', 'what do you charge per window']), trigger: 'Getting a few quotes\nwhat do you charge per window' });
  assert.ok(!p.handoff, JSON.stringify(p.handoff));
});

// The ask-back is the copy with REHASH_BETTER_PRICE_FRAMING_ENABLED=false (its undo path); with the
// switch on (unset), the better-price line answers instead (the user, 2026-10-21, Part 2).
const withBetterPrice = (value, fn) => {
  const prev = process.env.REHASH_BETTER_PRICE_FRAMING_ENABLED;
  process.env.REHASH_BETTER_PRICE_FRAMING_ENABLED = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.REHASH_BETTER_PRICE_FRAMING_ENABLED;
    else process.env.REHASH_BETTER_PRICE_FRAMING_ENABLED = prev;
  }
};

test('better-price framing on: a price hesitation from the visit gets the better-price line; a spouse keeps the ask-back', () => withBetterPrice('', () => {
  const base = { channel: 'sms', nowMs: NOW, slots: [], allSlots: [], tzLabel: 'ET', firstName: 'Monica', postDemo: true, rehash: true, rehashRep: 'John' };
  const conv = T(['o', 'Hi Monica, it is John from Reece. Did you get a chance to look over the proposal?']);
  const p = planNepqTurn({ ...base, conversation: conv, trigger: 'Hi, got your message. We are still thinking it over', visitHesitation: 'price' });
  assert.equal(p.objection?.type, 'price');
  assert.equal(p.objection?.source, 'visit');
  assert.ok(hasBetterPrice(p.fixed_line), p.fixed_line);
  assert.match(p.fixed_line, /price/i); // the scenario's visit_hesitation_ignored check reads this
  assert.doesNotMatch(p.fixed_line, /\$\s?\d|\b\d[\d,]{2,}\b/); // price_from_visit_stated's own test
  assert.equal((p.fixed_line.match(/\?/g) || []).length, 1);
  const s = planNepqTurn({ ...base, conversation: conv, trigger: 'Hi, got your message. We are still thinking it over', visitHesitation: 'spouse' });
  assert.equal(s.step, 'rehash_objection');
  assert.equal(s.rehash_ladder, 'ask_back');
}));

test('post-demo "still thinking it over" with a price hesitation from the visit asks it back by name', () => withBetterPrice('false', () => {
  const base = { channel: 'sms', nowMs: NOW, slots: [], allSlots: [], tzLabel: 'ET', firstName: 'Monica', postDemo: true, rehash: true, rehashRep: 'John' };
  const conv = T(['o', 'Hi Monica, it is John from Reece. Did you get a chance to look over the proposal?']);
  const p = planNepqTurn({ ...base, conversation: conv, trigger: 'Hi, got your message. We are still thinking it over', visitHesitation: 'price' });
  assert.equal(p.step, 'rehash_objection');
  assert.equal(p.fixed_line, POST_DEMO_VISIT_ASK.price(', Monica'));
  assert.match(p.fixed_line, /budget/);
  assert.doesNotMatch(p.fixed_line, /\$|\d/);
  assert.equal((p.fixed_line.match(/\?/g) || []).length, 1);
  // No hesitation recorded: the track's own question, as before.
  assert.notEqual(planNepqTurn({ ...base, conversation: conv, trigger: 'Hi, got your message. We are still thinking it over' }).step, 'rehash_objection');
  // Asked once: the next objection is the bridge, not a second ask-back.
  const next = planNepqTurn({ ...base, conversation: [...conv, ...T(['i', 'Hi, got your message. We are still thinking it over'], ['o', 'Are you still weighing the budget, Monica?'])], trigger: 'Yes, honestly the price is more than we wanted to spend', visitHesitation: 'price' });
  assert.equal(next.objection?.attempt, 2);
  assert.notEqual(next.rehash_ladder, 'ask_back');
}));

test('visitHesitationOf reads the visit facts, Siro main objection first', () => {
  assert.equal(visitHesitationOf(null), null);
  assert.equal(visitHesitationOf({ insights: { main_objection: 'Pricing' }, objections: [], interests: [] }), 'price');
  assert.equal(visitHesitationOf({ insights: {}, objections: [{ type: 'spouse' }], interests: [] }), 'spouse');
  assert.equal(visitHesitationOf({ insights: {}, objections: [{ type: 'trust' }], interests: [] }), null);
});

test('the scorer allows the cancel identity ask by the turn\'s flow step, whatever the scenario is called', () => {
  const r = { channel: 'livechat', scenario: 'reschedule_unclear', transcript: [{ turn: 1, customer: 'I need to cancel my appointment', bot: ["I can help with that. What's the full name and phone number the appointment is under?"], flow: 'ask_identity' }], would_do: [] };
  assert.ok(!S.scoreResult(r).failures.some(f => f.code === 'more_than_one_ask'));
});
