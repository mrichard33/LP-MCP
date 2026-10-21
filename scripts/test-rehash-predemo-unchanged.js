/**
 * The rehash switches never reach the pre-demo bot (2026-10-21 handoff, scope
 * rule: "Pre-demo path … must produce byte-identical output"). Every pre-demo
 * plan, and its enforced reply, is the same with REHASH_BOOKING_FIX_ENABLED and
 * REHASH_BETTER_PRICE_FRAMING_ENABLED on and off. The prompt side is
 * test-response-prompt-snapshot.js: its frozen env leaves both switches unset
 * (= on), and every pre-demo snapshot is unchanged.
 *
 * Run: node --test scripts/test-rehash-predemo-unchanged.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planNepqTurn, enforceNepqPlan } from '../src/agentic/nepq-planner.js';
import { checkBookingTruth, findUnbackedBookingClaim } from '../src/agentic/booking-claim.js';
import { runWithSimOverrides } from '../src/simulator/sim-overrides.js';

const NOW = Date.parse('2026-10-20T16:00:00Z');
const S = (iso, day, time, rel) => ({ iso, day, time, dayOfWeek: day.slice(0, 3), ...(rel ? { rel } : {}), tz: 'ET' });
const SLOTS = [S('2026-10-21T14:00:00Z', 'Wed, Oct 21', '10:00 AM', 'tomorrow'), S('2026-10-21T18:00:00Z', 'Wed, Oct 21', '2:00 PM', 'tomorrow'), S('2026-10-22T22:00:00Z', 'Thu, Oct 22', '6:00 PM')];
const out = (text) => ({ direction: 'outbound', text });
const inn = (text) => ({ direction: 'inbound', text });

const CASES = [
  ['Hi, I need new windows', []],
  ['How much do impact windows cost?', []],
  ['9:30', [out('I have tomorrow at 10:00 AM ET or tomorrow at 2:00 PM ET. Which works better?')]],
  ['I can do 930am', [out('I have tomorrow at 10:00 AM ET or tomorrow at 2:00 PM ET. Which works better?')]],
  ['Thursday at 6pm', [out('I have tomorrow at 10:00 AM ET or Thu, Oct 22 at 6:00 PM ET. Which works better?')]],
  ['Ready to move. Would like to see final costs first.', [out("What's got you looking at windows?")]],
  ['Decided not needed at this time.', [out("What's got you looking at windows?")]],
  ['We are getting a couple more quotes', [out("What's got you looking at windows?")]],
  ['I am so confused, so many different times', [out('I have tomorrow at 10:00 AM ET or tomorrow at 2:00 PM ET. Which works better?')]],
  ['Can you call me?', []],
  ['Yes', [out('Would a free visit at your home help you see the options?')]],
  ['Not interested', [out('Would a free visit at your home help?')]],
  ['My wife needs to see it too', [inn('Hi'), out('What made you reach out?')]],
];

const planFor = (trigger, conversation) => planNepqTurn({
  channel: 'sms', trigger, conversation, slots: SLOTS.slice(0, 2), allSlots: SLOTS, tzLabel: 'ET', firstName: 'Dana',
  discipline: { booking: { allowed: true, reason: 'x' } }, nowMs: NOW,
});
const both = (fn) => [
  runWithSimOverrides({ rehashBookingFix: 'on', rehashBetterPrice: 'on' }, fn),
  runWithSimOverrides({ rehashBookingFix: 'off', rehashBetterPrice: 'off' }, fn),
];

for (const [trigger, conversation] of CASES) {
  test(`pre-demo plan unchanged by the rehash switches: ${JSON.stringify(trigger)}`, () => {
    const [on, off] = both(() => planFor(trigger, conversation));
    assert.deepEqual(on, off);
    assert.equal(on.rehash_fix, undefined);
    const draft = 'Got it, I will call you at 9:30 AM ET tomorrow. Where are you at with it? I have tomorrow at 6:00 PM ET open.';
    const [eOn, eOff] = both(() => enforceNepqPlan(draft, planFor(trigger, conversation)));
    assert.deepEqual(eOn, eOff);
  });
}

test('the booking-claim guard reads a call-time promise only when asked (rehash)', () => {
  const s = "Got it, I'll call you at 9:30 AM ET tomorrow.";
  assert.equal(checkBookingTruth(s).allowed, true);
  assert.equal(findUnbackedBookingClaim(s), null);
});
