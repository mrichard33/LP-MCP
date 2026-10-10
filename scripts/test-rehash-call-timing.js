/**
 * A rehash lead is never promised a call "right now" (2026-10-09, Monica).
 *
 * Monica (LP lead 581695, OPPFDN after her 10/7 demo) missed her Friday 6 PM
 * call because John, the rehash rep, was out. At 6:52 PM she texted "I never
 * got a call" and the bot answered "We're having someone call you back right
 * now." The team was open, so nothing objected, but John was not free until
 * Monday, and his Rehash Call calendar was never read: the `rehash` tag is
 * added by a sweep still in shadow, and the reply writer knew rehash only by
 * that tag.
 *
 * Run: node --test scripts/test-rehash-call-timing.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceRehashCallTiming, rehashOpeningDay, promisedCallback, enforceCallTiming, softenCallTiming } from '../src/agentic/team-hours.js';
import { isInRehash, rehashLeadFromContext } from '../src/agentic/rehash-state.js';
import { planNepqTurn } from '../src/agentic/nepq-planner.js';
import { checkReply } from '../src/eval/reply-invariants.js';

const SENT = "Sorry about that, Monica. We're having someone call you back right now. — Reece Team";
const MONDAY = { iso: '2026-10-12T14:00:00.000Z', day: 'Mon, Oct 12', dayOfWeek: 'Monday', time: '10:00 AM', tz: 'ET' };
const MONDAY_2 = { iso: '2026-10-12T15:00:00.000Z', day: 'Mon, Oct 12', dayOfWeek: 'Monday', time: '11:00 AM', tz: 'ET' };
const FRI_655PM = Date.parse('2026-10-09T22:55:00Z');

// context-builder's `context.lp` for Monica on 10/9 (the watchdog had re-set
// the appointment date to her Friday call; the demo was 10/7).
const MONICA_LP = { matched: true, lead_id: '581695', disposition: 'OPPFDN', demo_date: '2026-10-07', appointment_date: '2026-10-09T18:00:00+00:00' };
const MONICA_TAGS = ['lp-demo-completed', 'f.0-v2', 'callback:requested', 'agentic-active'];

test('"We\'re having someone call you" is a promised call (it read as none, so no guard saw it)', () => {
  assert.equal(promisedCallback("We're having someone call you back right now."), true);
  assert.equal(promisedCallback("We're glad you reached out. What made you reach out today?"), false);
  // The same reader drives the after-hours guard: a Saturday-night version is now caught too.
  const satNight = Date.parse('2026-10-11T02:00:00Z');
  assert.equal(enforceCallTiming("We're having someone call you back right now.", satNight).changed, true);
  assert.equal(softenCallTiming("We're having someone call you back right now."), "We're having someone call you back soon.");
});

test('the sent reply names the day John is next free, never "right now"', () => {
  const r = enforceRehashCallTiming(SENT, { nextOpening: MONDAY });
  assert.equal(r.changed, true);
  assert.equal(r.text, "Sorry about that, Monica. We're having someone call you back on Monday. — Reece Team");
  assert.doesNotMatch(r.text, /right now|10:00/);
});

test('no opening read → "soon"; an opening today is not "today"', () => {
  assert.equal(enforceRehashCallTiming(SENT).text, "Sorry about that, Monica. We're having someone call you back soon. — Reece Team");
  assert.equal(rehashOpeningDay({ ...MONDAY, rel: 'today' }), null);
  assert.equal(rehashOpeningDay({ ...MONDAY, rel: 'tomorrow' }), 'tomorrow');
  assert.equal(rehashOpeningDay({ day: 'Mon, Oct 12', time: '10:00 AM' }), 'on Mon');
});

test('a reply with no immediate call promise is left alone', () => {
  for (const t of ['Ok Monica, John will call you Monday when he is back in.', 'Thanks, Monica. What questions came up after the visit?']) {
    assert.equal(enforceRehashCallTiming(t, { nextOpening: MONDAY }).changed, false, t);
  }
});

test('Monica is in rehash by her LP lead, with no rehash tag', () => {
  const nowMs = Date.parse('2026-10-09T23:00:00Z');
  assert.equal(isInRehash({ tags: MONICA_TAGS, currentLead: rehashLeadFromContext(MONICA_LP), nowMs }), true);
  // The 30-day clock runs from the demo, not the re-set appointment date.
  assert.equal(rehashLeadFromContext(MONICA_LP).appointment_date, '2026-10-07');
  assert.equal(isInRehash({ tags: MONICA_TAGS, currentLead: rehashLeadFromContext(MONICA_LP), nowMs: Date.parse('2026-11-07T12:00:00Z') }), false);
  // Not OPPFDN, finished stage, or no LP match: not rehash.
  assert.equal(isInRehash({ tags: [], currentLead: rehashLeadFromContext({ ...MONICA_LP, disposition: 'Set' }), nowMs }), false);
  assert.equal(isInRehash({ tags: ['rehash-done:581695'], currentLead: rehashLeadFromContext(MONICA_LP), nowMs }), false);
  assert.equal(rehashLeadFromContext({ matched: false, lead_id: null }), null);
  assert.equal(rehashLeadFromContext(null), null);
});

test('with John\'s calendar read, her call request gets his two real Monday times', () => {
  const plan = planNepqTurn({
    channel: 'sms',
    trigger: 'Got one from a different area code than yours but no one was on the other end when I answered',
    conversation: [
      { direction: 'outbound', text: "Hi Monica, just a quick note to confirm your appointment on Friday, October 9, 2026, at 6:00 PM." },
      { direction: 'inbound', text: 'I never got a call' },
    ],
    firstName: 'Monica', hasAppointment: true, nowMs: FRI_655PM, callbackRequested: true,
    postDemo: true, rehashRep: 'John', callSlots: { offer: [MONDAY, MONDAY_2], all: [MONDAY, MONDAY_2] },
  });
  assert.equal(plan.step, 'rehash_offer');
  assert.deepEqual(plan.slots_to_offer.map(s => s.time), ['10:00 AM', '11:00 AM']);
});

test('the hard check fails the sent reply for a rehash lead and skips when unknown', () => {
  assert.ok(checkReply(SENT, { channel: 'sms', rehash: true, allowName: null }).violations.some(v => v.code === 'call_promised_now_to_rehash_lead'));
  assert.ok(!checkReply(SENT, { channel: 'sms', rehash: false }).violations.some(v => v.code === 'call_promised_now_to_rehash_lead'));
  assert.ok(checkReply(SENT, { channel: 'sms' }).skipped.includes('rehash_call_timing'));
});
