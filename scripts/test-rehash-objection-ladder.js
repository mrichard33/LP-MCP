/**
 * test-rehash-objection-ladder.js — the post-demo objection ladder, the
 * code-enforced stop and the rebuttal guard (2026-10-15).
 *
 * The regression is Shawn Eastman (39JdHrmdeQQtlJdDyS2r), a post-demo OPPFDN
 * lead, 2026-10-15 14:05–14:24 ET. His real messages, in order, against the
 * lines the planner now sends:
 *   14:05 "…twice the cost of our other estimates…" → ONE ask-back
 *   14:18 "Not at this time. Thanks" (to our call offer) → no #1
 *   14:19 "Cost" → the bridge with two real Rehash Call times
 *   14:21 "The price cut in half or more" → a person (rehash_repeat_objection)
 *   a second no → the stop (rehash_stop), sticky after that
 * and the bot's three live rebuttals, each dropped by enforceNepqPlan.
 *
 * Run: node --test scripts/test-rehash-objection-ladder.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planNepqTurn, enforceNepqPlan, isPostDemoNo, postDemoObjection, POST_DEMO_REBUTTAL_RX } from '../src/agentic/nepq-planner.js';
import { handoffSlackChannels, formatNepqHandoff } from '../src/agentic/nepq-handoff.js';
import { NO_DIAL_REASONS, callbackDecision } from '../src/agentic/bot-callback.js';
import { checkReply } from '../src/eval/reply-invariants.js';

// 2026-10-21: these tests hold the rehash copy from BEFORE the better-price
// framing (REHASH_BETTER_PRICE_FRAMING_ENABLED=false is the undo path, so it
// must keep working). The framing itself: scripts/test-rehash-better-price.js.
process.env.REHASH_BETTER_PRICE_FRAMING_ENABLED = 'false';

const NOW = Date.parse('2026-10-15T18:20:00Z'); // Thu 2:20 PM ET
const out = (text) => ({ direction: 'outbound', text });
const inn = (text) => ({ direction: 'inbound', text });
const S = (iso, day, time, rel) => ({ iso, day, time, ...(rel ? { rel } : {}), tz: 'ET' });
const OPEN = [S('2026-10-16T14:00:00Z', 'Fri, Oct 16', '10:00 AM', 'tomorrow'), S('2026-10-16T18:00:00Z', 'Fri, Oct 16', '2:00 PM', 'tomorrow')];
const CALL_SLOTS = { calendarId: 'ncDzLgzbfKJRfhmtlWtB', rep: 'TYcZ9DcNkuPCFYsFxRFV', repName: 'John', offer: OPEN, all: OPEN };
const plan = (trigger, conversation, { callSlots = CALL_SLOTS, rehashRep = 'John', rehash = true } = {}) => planNepqTurn({
  channel: 'sms', trigger, conversation, slots: [], tzLabel: 'ET', firstName: 'Shawn',
  discipline: { booking: { allowed: false, reason: 'x' } }, nowMs: NOW, postDemo: true, rehashRep, rehash, callSlots,
});

// His real words (HL mirror, 2026-10-15).
const T1405 = "We are still getting estimates and evaluating them. No decisions have been made yet.\n\nWe like your product the best, but the reality is that it is roughly twice the cost of our other estimates. We recognize that you get what you pay for, but I can't buy a Lamborghini on a Honda Civic budget. \n\nI appreciate you following up.";
const NOT_NOW = 'Not at this time. Thanks';
const COST = 'Cost';
const HALF = 'The price cut in half or more';
// The bot's live rebuttals.
const R1417 = 'The cheaper bids we see usually cut something, subcontracted crews or parts-only warranties, and folks end up replacing in five years. Would that help?';
const R1420 = 'Price is the easy number to compare, but what actually holds up is what you can prove five years down the line. What would you need to see to feel good moving forward?';
const R1423 = "Half or more is a real gap, Shawn. Protection is not what you install. It's what you can prove, and cheaper bids usually get there by cutting the crew or the warranty. Someone from our team will reach out to go over it with you directly. Would a quick call help?";

const START = [inn('Thank you'), out("You're welcome, Shawn. Where are you at with it? — John")];

test('14:05: the first objection gets ONE ask-back, no call pitch, no rebuttal', () => {
  const p = plan(T1405, [...START, inn(T1405)]);
  assert.equal(p.step, 'rehash_objection');
  assert.equal(p.required_move, 'objection_play');
  assert.equal(p.objection.type, 'price');
  assert.equal(p.objection.attempt, 1);
  assert.equal(p.fixed_line, 'Too expensive compared to what you were quoted elsewhere, Shawn?');
  assert.equal(p.call_offer_ok, false);
  assert.equal(p.handoff, null);
  // The model argues: the reference ships instead.
  const e = enforceNepqPlan(R1417, p);
  assert.ok(!POST_DEMO_REBUTTAL_RX.test(e.text), e.text);
  assert.ok(e.changes.includes('rebuttal_dropped'));
});

// The thread as it goes with the fix.
const ASK_BACK = out('Too expensive compared to what you were quoted elsewhere, Shawn?');
const OFFER = out('Makes sense, Shawn. That gap is worth looking at. Would a quick call help?');

test('14:18: "Not at this time. Thanks" to a call offer is a no; the ask-back is not re-sent', () => {
  assert.equal(isPostDemoNo(NOT_NOW, OFFER.text), true);
  assert.equal(isPostDemoNo(NOT_NOW, 'Want me to give you a ring?'), true);
  assert.equal(isPostDemoNo(NOT_NOW, R1417), true, 'the live 14:17 message ended "Would that help?"');
  assert.equal(postDemoObjection(NOT_NOW, OFFER.text), null, 'a no is not an objection');
  const conv = [...START, inn(T1405), ASK_BACK, inn('About half'), OFFER, inn(NOT_NOW)];
  const p = plan(NOT_NOW, conv);
  assert.notEqual(p.step, 'rehash_objection');
  assert.notEqual(p.step, 'post_demo_stop', 'one no is not a stop');
  assert.equal(p.counters.post_demo_nos, 1);
});

test('a pre-demo "not right now" to a discovery question is not a no', () => {
  assert.equal(isPostDemoNo('Not right now', 'What got you looking at windows?'), false);
  assert.equal(isPostDemoNo('not right now', 'Did you get a chance to look over the proposal?'), true, 'a rehash track question counts');
});

const AFTER_NO = [...START, inn(T1405), ASK_BACK, inn('About half'), OFFER, inn(NOT_NOW), out("Understood, Shawn. What's holding you back, just so I understand?")];

test('14:19: "Cost" is the second objection: the bridge with two real Rehash Call times', () => {
  const p = plan(COST, [...AFTER_NO, inn(COST)]);
  assert.equal(p.objection.attempt, 2);
  assert.equal(p.step, 'rehash_offer');
  assert.equal(p.required_move, 'offer_slots');
  assert.equal(p.rehash_bridged, true);
  assert.equal(p.rehash_stage, 'bridge', 'so "best deal" is not stripped as pre-bridge');
  assert.deepEqual(p.slots_to_offer.map(s => s.time), ['10:00 AM', '2:00 PM']);
  assert.match(p.fixed_line, /^I want to make sure you're getting the best deal possible\. I may be able to do something for you, it's just easier on a quick call\. I have /);
  assert.ok(!/ with John\b/.test(p.fixed_line), 'the line speaks as John');
  // The reference survives the enforcer as written.
  const e = enforceNepqPlan(p.fixed_line, p);
  assert.equal(e.text, p.fixed_line);
});

test('the bridge without call times asks if a quick call would help, and says "best deal" once', () => {
  const p = plan(COST, [...AFTER_NO, inn(COST)], { callSlots: null });
  assert.equal(p.step, 'rehash_bridge');
  assert.equal(p.fixed_line, "I want to make sure you're getting the best deal possible. I may be able to do something for you, it's just easier on a quick call. Would that help?");
  const used = [...AFTER_NO.slice(0, -1), out("I want to make sure you're getting the best deal possible."), AFTER_NO[AFTER_NO.length - 1], inn(COST)];
  const p2 = plan(COST, used, { callSlots: null });
  assert.equal(p2.fixed_line, "I may be able to do something for you, it's just easier on a quick call. Would that help?");
});

const BRIDGED = [...AFTER_NO, inn(COST), out("I want to make sure you're getting the best deal possible. I may be able to do something for you, it's just easier on a quick call. I have tomorrow at 10:00 AM ET or tomorrow at 2:00 PM ET. Which works better?")];

test('14:21: the same objection after the bridge goes to a person, never a rebuttal', () => {
  const p = plan(HALF, [...BRIDGED, inn(HALF)]);
  assert.equal(p.objection.attempt, 3);
  assert.equal(p.step, 'handoff');
  assert.deepEqual(p.handoff, { reason: 'rehash_repeat_objection', line: "Understood, Shawn. I'll take a look at it and reach out." });
  const e = enforceNepqPlan(R1423, p);
  assert.ok(!POST_DEMO_REBUTTAL_RX.test(e.text), e.text);
  // Not speaking as the rep: the rep is named, never guessed.
  const p2 = plan(HALF, [...BRIDGED, inn(HALF)], { rehashRep: null, rehash: true });
  assert.equal(p2.handoff.line, "Understood, Shawn. I'll have John take a look at it and reach out.");
});

const HANDED = [...BRIDGED, inn(HALF), out("Understood, Shawn. I'll take a look at it and reach out.")];

test('a second no stops the selling and files rehash_stop', () => {
  const p = plan('No thanks', [...HANDED, inn('No thanks')]);
  assert.equal(p.step, 'post_demo_stop');
  assert.equal(p.required_move, 'close');
  assert.equal(p.call_offer_ok, false);
  assert.equal(p.booking.allowed, false);
  assert.deepEqual(p.handoff, { reason: 'rehash_stop', line: "Understood, Shawn. I'm here if anything changes." });
  const e = enforceNepqPlan('Understood, Shawn. Would a quick call help?', p);
  assert.ok(!e.text.includes('?'), e.text);
});

const STOPPED = [...HANDED, inn('No thanks'), out("Understood, Shawn. I'm here if anything changes.")];

test('the stop is sticky: a later "ok" or objection stays stopped, with no second card', () => {
  for (const msg of ['ok', 'Cost is still the issue']) {
    const p = plan(msg, [...STOPPED, inn(msg)]);
    assert.equal(p.step, 'post_demo_stop', msg);
    assert.equal(p.post_demo_sticky, true);
    assert.equal(p.handoff, null, 'the card was filed on the first stop turn');
  }
});

test('the stop releases on a call ask, a schedule ask or a question', () => {
  const p = plan('can you call me tomorrow?', [...STOPPED, inn('can you call me tomorrow?')]);
  assert.equal(p.step, 'rehash_offer', 'planRehashCall: the real call times');
  const q = plan('What was the warranty again?', [...STOPPED, inn('What was the warranty again?')]);
  assert.notEqual(q.step, 'post_demo_stop');
});

test('two no\'s that are not in a row stop a post-demo lead with no rehash rep too', () => {
  const conv = [out('Did you get a chance to look over the proposal?'), inn('No thank you'), out('Would a quick call help?'), inn('Maybe later, we are busy'), out('Would that help?'), inn("We're good")];
  const p = plan("We're good", conv, { rehashRep: null, rehash: false, callSlots: null });
  assert.equal(p.step, 'post_demo_stop');
  assert.equal(p.handoff.reason, 'rehash_stop');
});

test('a post-demo lead off the rehash line (it may be SOLD) gets no ladder', () => {
  const p = plan(COST, [...START, inn(COST)], { rehashRep: null, rehash: false, callSlots: null });
  assert.notEqual(p.step, 'rehash_objection');
  assert.ok(!/best deal/i.test(p.fixed_line || ''));
});

test('a dated deferral and "we signed elsewhere" still win over the ladder', () => {
  assert.equal(plan('Too expensive, check back in November', [...START]).step, 'defer');
  assert.equal(plan('We went with another company, too expensive', [...START]).step, 'competitor_signed');
});

test('asking for room is the warm close, not a ladder step (PR #1324 x #1325, 2026-10-15)', () => {
  const msg = "We need more time, it's been a hard stretch at home";
  assert.equal(postDemoObjection(msg), null);
  assert.equal(plan(msg, [...START, inn(msg)]).step, 'post_demo_space');
});

test('a question about the number is not an objection', () => {
  assert.equal(postDemoObjection('What was the price again?'), null);
  assert.equal(postDemoObjection(COST), 'price');
  assert.equal(postDemoObjection(T1405), 'price');
  assert.equal(postDemoObjection('We need to think it over'), 'think');
  assert.equal(postDemoObjection('We got a lower quote from another company'), 'competitor');
});

test('the rebuttal guard drops each live rebuttal and never ships it on an empty body', () => {
  const p = plan('Not sure yet', [...AFTER_NO, inn('Not sure yet')]);
  for (const r of [R1417, R1420]) {
    const e = enforceNepqPlan(r, p);
    assert.ok(!POST_DEMO_REBUTTAL_RX.test(e.text), e.text);
    assert.ok(e.text.trim().length > 0);
  }
  const e = enforceNepqPlan('Someone from our team will reach out to go over it.', { ...p, step: 'post_demo', required_move: 'answer', fixed_line: null });
  assert.ok(e.changes.includes('unpromised_follow_up_dropped'));
  assert.ok(!/reach out/.test(e.text) && e.text.trim(), e.text);
});

test('the Rehash Call confirmation keeps its "will give you a call" line', () => {
  const p = plan('2pm works', [...BRIDGED, inn('2pm works')]);
  assert.equal(p.step, 'rehash_confirm');
  const e = enforceNepqPlan(p.reference_line, p);
  assert.equal(e.text, p.reference_line);
});

test('both new hand-offs: #contact-rehash only, never dialed', () => {
  const env = { SLACK_CHANNEL_SERVICE: 'CSERVICE', SLACK_CHANNEL_REHASH: 'CREHASH' };
  for (const reason of ['rehash_stop', 'rehash_repeat_objection']) {
    assert.deepEqual(handoffSlackChannels(reason, env), [{ name: 'contact-rehash', id: 'CREHASH' }]);
    assert.ok(NO_DIAL_REASONS.has(reason));
    assert.equal(callbackDecision({ handoffReason: reason }).reason, reason);
    const card = formatNepqHandoff({ reason, channel: 'sms', inbound: HALF, contactId: '39JdHrmdeQQtlJdDyS2r', firstName: 'Shawn' }).card;
    assert.match(card, /Post-demo lead/);
    assert.ok(!/someone from our team will reach out/i.test(card));
  }
  assert.deepEqual(handoffSlackChannels('rehash_stop', {}), [{ name: 'contact-rehash', id: 'C0C5YMHNYJH' }], 'the default #contact-rehash');
  assert.deepEqual(handoffSlackChannels('two_nos', env), [{ name: 'contact-center', id: 'CSERVICE' }], 'other reasons unchanged');
});

test('invariants: a finished post-demo reply never rebuts, promises a follow-up off a hand-off, or asks after the stop', () => {
  assert.deepEqual(checkReply(R1420, { channel: 'sms', postDemoStep: 'post_demo' }).violations.map(v => v.code).filter(c => c.startsWith('post_demo')), ['post_demo_rebuttal']);
  assert.ok(checkReply("Understood, Shawn. I'll take a look at it and reach out.", { channel: 'sms', postDemoStep: 'handoff' }).pass);
  assert.ok(checkReply("Understood, Shawn. I'm here if anything changes.", { channel: 'sms', postDemoStep: 'post_demo_stop' }).pass);
});
