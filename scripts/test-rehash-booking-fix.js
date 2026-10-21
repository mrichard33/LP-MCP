/**
 * Rehash booking fix (2026-10-21 handoff, REHASH_BOOKING_FIX_ENABLED). The
 * cases are the live threads of 2026-10-20, names removed:
 *   A  "I can do 930am" / "Thursday at 2pm" got a new pair every turn
 *   B  "9:30" to our 9:30 / 10:30 offer booked nothing; "I'll call you at 9:30 … Would a quick call help?"
 *   C  "Ready to move … final costs" got the price ask-back
 *   D  "Decided not needed at this time." got "Where are you at with it?"
 *
 * Run: node --test scripts/test-rehash-booking-fix.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planNepqTurn, enforceNepqPlan } from '../src/agentic/nepq-planner.js';
import { readRehashTime, pickRehashTime, rehashTimeSlots } from '../src/agentic/rehash-time.js';
import { rehashBookingFix } from '../src/agentic/rehash-flags.js';
import { checkBookingTruth, findUnbackedBookingClaim } from '../src/agentic/booking-claim.js';
import { checkReply } from '../src/eval/reply-invariants.js';
import { runWithSimOverrides } from '../src/simulator/sim-overrides.js';
import { SCENARIO_EXPECTATIONS } from '../src/simulator/sim-scoring.js';
import { SCENARIOS, nameOfferedCallTime } from '../src/simulator/bot-simulator.js';

const NOW = Date.parse('2026-10-20T20:50:00Z'); // Tue 4:50 PM ET
const S = (iso, day, time, rel, dow) => ({ iso, day, time, dayOfWeek: dow, ...(rel ? { rel } : {}), tz: 'ET' });
const W930 = S('2026-10-21T13:30:00Z', 'Wed, Oct 21', '9:30 AM', 'tomorrow', 'Wednesday');
const W1030 = S('2026-10-21T14:30:00Z', 'Wed, Oct 21', '10:30 AM', 'tomorrow', 'Wednesday');
const W200 = S('2026-10-21T18:00:00Z', 'Wed, Oct 21', '2:00 PM', 'tomorrow', 'Wednesday');
const T130 = S('2026-10-22T17:30:00Z', 'Thu, Oct 22', '1:30 PM', null, 'Thursday');
const T200 = S('2026-10-22T18:00:00Z', 'Thu, Oct 22', '2:00 PM', null, 'Thursday');
const T230 = S('2026-10-22T18:30:00Z', 'Thu, Oct 22', '2:30 PM', null, 'Thursday');
const T330 = S('2026-10-22T19:30:00Z', 'Thu, Oct 22', '3:30 PM', null, 'Thursday');
const ALL = [W930, W1030, W200, T130, T200, T230, T330];
const SLOTS = (all = ALL, offer = [W930, W1030]) => ({ calendarId: 'cal', rep: 'u1', repName: 'John', offer, all });
const out = (text) => ({ direction: 'outbound', text });
const inn = (text) => ({ direction: 'inbound', text });
const OFFER = out("I have tomorrow at 9:30 AM ET or tomorrow at 10:30 AM ET. Which works better? — John");
const OFFER_B = out("Tomorrow at 9:30 AM ET or 10:30 AM ET, I'll call and we'll go through the numbers together. Which works better?");

const plan = (trigger, conversation = [OFFER], callSlots = SLOTS()) => planNepqTurn({
  channel: 'sms', trigger, conversation, slots: [], tzLabel: 'ET', firstName: 'Pat',
  discipline: { booking: { allowed: false, reason: 'x' } }, nowMs: NOW, postDemo: true, rehashRep: 'John', rehash: true, callSlots,
});
const off = (fn) => runWithSimOverrides({ rehashBookingFix: 'off' }, fn);

test('flag: unset is on; "false" is off; a gate run may force it', () => {
  assert.equal(rehashBookingFix({}), true);
  assert.equal(rehashBookingFix({ REHASH_BOOKING_FIX_ENABLED: 'false' }), false);
  assert.equal(rehashBookingFix({ REHASH_BOOKING_FIX_ENABLED: 'true' }), true);
  assert.equal(off(() => rehashBookingFix({})), false);
});

test('readRehashTime: the times people text', () => {
  assert.deepEqual(readRehashTime('9:30'), { minutes: 570, day: null });
  assert.deepEqual(readRehashTime('930am'), { minutes: 570, day: null });
  assert.deepEqual(readRehashTime('Thursday at 2pm'), { minutes: 840, day: 'thursday' });
  assert.deepEqual(readRehashTime("I'm sorry so no 930am option tomorrow? \nI can do Thursday at 6pm then."), { minutes: 1080, day: 'thursday' });
  for (const none of ['we have 10,000 to spend', '33756', '3 windows', '$9.30', 'Can you call me tomorrow?']) assert.equal(readRehashTime(none), null, none);
  assert.equal(pickRehashTime('9:30', [W930, W1030]), W930);
  assert.equal(pickRehashTime('Thursday at 2pm', [W200, T200]), T200);
});

test('B: "9:30" to our 9:30 / 10:30 offer books 9:30 and the confirm asks nothing', () => {
  const p = plan('9:30', [OFFER_B]);
  assert.equal(p.step, 'rehash_confirm');
  assert.equal(p.rehash_pick.iso, W930.iso);
  assert.equal(p.booking.allowed, true);
  assert.match(p.reference_line, /^You're all set for tomorrow at 9:30 AM ET\. I'll call you at this number then\.$/);
  assert.ok(!p.reference_line.includes('?'));
  // The flag off: the old plan (no booking).
  assert.notEqual(off(() => plan('9:30', [OFFER_B])).step, 'rehash_confirm');
});

test('A: "I can do 930am" with 9:30 open books it', () => {
  const p = plan('I can do 930am. \\nI would still like to see itemized estimates to understand what each window & sliding door is costing.');
  assert.equal(p.step, 'rehash_confirm');
  assert.equal(p.rehash_pick.iso, W930.iso);
});

test('A: 9:30 taken → said plainly, the two closest that day', () => {
  const all = ALL.filter(s => s !== W930);
  const p = plan('I can do 930am', [OFFER], SLOTS(all, [W1030, W200]));
  assert.equal(p.step, 'rehash_offer');
  assert.deepEqual(p.slots_to_offer.map(s => s.iso), [W1030.iso, W200.iso]);
  assert.match(p.fixed_line, /^9:30 AM isn't open, but I have tomorrow at 10:30 AM ET or tomorrow at 2:00 PM ET\./);
});

test('A: "Thursday at 2pm" books Thursday 2 PM though 2 PM is open Wednesday too', () => {
  const p = plan('Yes I can do Thursday at 2pm.', [out('I have Thu, Oct 22 at 1:30 PM ET or Thu, Oct 22 at 2:30 PM ET open. Which one works for you?')]);
  assert.equal(p.step, 'rehash_confirm');
  assert.equal(p.rehash_pick.iso, T200.iso);
});

test('A: "Thursday at 6pm" (not open) → the two closest on Thursday', () => {
  const p = plan("I'm sorry so no 930am option tomorrow? \\nI can do Thursday at 6pm then.", [out('Thanks for the note.')]);
  assert.equal(p.step, 'rehash_offer');
  assert.deepEqual(p.slots_to_offer.map(s => s.iso), [T230.iso, T330.iso]);
});

test('stable offers: a call ask re-offers the pair on the table, not a fresh soonest pair', () => {
  const fresh = SLOTS(ALL, [W200, T130]);
  const p = plan('Can you call me?', [OFFER], fresh);
  assert.equal(p.step, 'rehash_offer');
  assert.deepEqual(p.slots_to_offer.map(s => s.iso), [W930.iso, W1030.iso]);
  const old = off(() => plan('Can you call me?', [OFFER], fresh));
  assert.deepEqual(old.slots_to_offer.map(s => s.iso), [W200.iso, T130.iso]);
});

test('stable offers: "so many different times" gets the same two again', () => {
  const p = plan('I am so confused. Youve given so many different times now lol');
  assert.equal(p.step, 'rehash_offer');
  assert.deepEqual(p.slots_to_offer.map(s => s.iso), [W930.iso, W1030.iso]);
  assert.match(p.fixed_line, /^Sorry for the mix-up, Pat\./);
});

test('C: "Ready to move … final costs" → the call with two times, never the price ask-back', () => {
  const t = 'Ready to move. Would like to see final description of project and final costs first.';
  const p = plan(t, [out('Did you get a chance to look over the proposal?')]);
  assert.equal(p.step, 'rehash_offer');
  assert.equal(p.slots_to_offer.length, 2);
  assert.match(p.fixed_line, /go over the final project and price with you on a quick call\. I have /);
  assert.ok(!/too expensive|compared to what/i.test(p.fixed_line));
  // No Rehash Call times read: ask for the call, still no objection.
  const q = plan(t, [out('Did you get a chance to look over the proposal?')], null);
  assert.equal(q.step, 'rehash_bridge');
  assert.match(q.fixed_line, /final project and price with you\. Would a quick call work for that\?$/);
  // The old ladder read it as price.
  assert.equal(off(() => plan(t, [out('Did you get a chance to look over the proposal?')], null)).step, 'rehash_objection');
});

test('D: a firm first no → one line, no question; a second → the stop', () => {
  const first = plan('Sorry. We are not doing windows at this time. Another in', [out('Did you get a chance to look over the proposal?')], null);
  assert.equal(first.no_question, true);
  const e = enforceNepqPlan('Understood, Pat. We will leave it there for now. Where are you at with it?', first);
  assert.ok(!e.text.includes('?'), e.text);
  const second = plan('Decided not needed at this time. We\'ll keep your contact info for future reference.',
    [out('Did you get a chance to look over the proposal?'), inn('Sorry. We are not doing windows at this time. Another in'), out("Understood, Pat. We're here whenever you're ready.")], null);
  assert.equal(second.no_question, true);
  assert.ok(['post_demo_stop', 'post_demo_close', 'post_demo'].includes(second.step));
  const e2 = enforceNepqPlan("Understood, Pat. If anything changes down the road, just text me here. Where are you at with it?", second);
  assert.ok(!e2.text.includes('?'), e2.text);
  // Flag off: the track asked its question.
  const old = off(() => plan('Decided not needed at this time.', [out('Did you get a chance to look over the proposal?')], null));
  assert.notEqual(old.no_question, true);
});

test('D invariant: a question after a firm first no fails', () => {
  const r = checkReply('Understood. Where are you at with it?', { channel: 'sms', postDemoStep: 'post_demo', postDemoPlanStep: 'door_open' });
  assert.ok(r.violations.some(f => f.code === 'question_after_post_demo_firm_no'), JSON.stringify(r.violations));
});

test('B: a draft stating a call time on a non-booking turn asks nothing after it, and a foreign time goes', () => {
  const p = plan('My neighbor got windows from you last year', [out('Did you get a chance to look over the proposal?')]);
  assert.equal(p.rehash_fix, true);
  const e = enforceNepqPlan("Got it, I'll call you at 9:30 AM ET tomorrow and we'll go through the numbers. Would a quick call help?", p);
  assert.ok(!e.text.includes('?'), e.text);
  const f = enforceNepqPlan('Happy to help. I have tomorrow at 6:00 PM ET or Thu, Oct 22 at 6:00 PM ET open.', p);
  assert.ok(!/6:00 PM/.test(f.text), f.text);
  assert.ok(f.changes.includes('rehash_foreign_time_dropped'));
  // A call already booked: its time is restated, not dropped.
  const booked = planNepqTurn({ channel: 'sms', trigger: 'Will John have the new numbers ready by then?', conversation: [out('Did you get a chance to look over the proposal?')], slots: [], tzLabel: 'ET',
    discipline: { booking: { allowed: false, reason: 'x' } }, nowMs: NOW, postDemo: true, rehashRep: 'John', rehash: true, callSlots: SLOTS(), hasAppointment: true });
  const g = enforceNepqPlan('John will call you tomorrow at 11:00 AM ET.', booked);
  assert.match(g.text, /11:00 AM/);
});

test('B: "I\'ll call you at 9:30" with nothing booked is a claim on the rehash line only', () => {
  const s = "Got it, I'll call you at 9:30 AM ET tomorrow.";
  assert.equal(checkBookingTruth(s, { rehash: true }).allowed, false);
  assert.equal(checkBookingTruth(s, {}).allowed, true);
  assert.ok(findUnbackedBookingClaim(s, { rehash: true }));
  assert.equal(findUnbackedBookingClaim(s, {}), null);
  assert.equal(checkBookingTruth(s, { rehash: true, result: { booked: true, appointment_id: 'a1' } }).allowed, true);
});

test('rehashTimeSlots: no day named, no offer → the soonest day that has the time', () => {
  const r = rehashTimeSlots('2pm', ALL, { nowMs: NOW });
  assert.equal(r.exact.iso, W200.iso);
});

// ── The gate's scenario checks (sim-scoring.js) ──────────────────────────

const T = (n, bot, nepq, extra = {}) => ({ turn: n, customer: 'x', bot: [bot], nepq: { post_demo: true, ...nepq }, ...extra });
const R = (scenario, transcript, flag = 'on') => ({ channel: 'sms', scenario, family: 'rehash', rehash_booking_fix: flag, transcript, would_do: [] });

test('scenario: the named time is read off our own offer', () => {
  assert.equal(nameOfferedCallTime('bare')('I have tomorrow at 9:30 AM ET or tomorrow at 10:30 AM ET. Which works better?'), '9:30');
  assert.equal(nameOfferedCallTime('compact')('I have tomorrow at 9:30 AM ET or tomorrow at 10:30 AM ET.'), 'I can do 930am');
  for (const k of ['rehash_bare_time_pick', 'rehash_named_time', 'rehash_ready_to_move', 'rehash_firm_no']) assert.ok(SCENARIOS[k] && SCENARIO_EXPECTATIONS[k], k);
});

test('scenario check: a pick that books with a question-free confirm passes; a new pair fails', () => {
  const book = { kind: 'would_book_appointment', payload: { rehash_call: true } };
  const good = R('rehash_bare_time_pick', [T(1, 'I have tomorrow at 9:30 AM ET or tomorrow at 10:30 AM ET. Which works better?', { step: 'rehash_offer' }),
    T(2, "You're all set for tomorrow at 9:30 AM ET. I'll call you at this number then.", { step: 'rehash_confirm' }, { would_do: [book] })]);
  assert.deepEqual(SCENARIO_EXPECTATIONS.rehash_bare_time_pick(good).map(f => f.code), []);
  const bad = R('rehash_bare_time_pick', [T(1, 'I have tomorrow at 9:30 AM ET or tomorrow at 10:30 AM ET. Which works better?', { step: 'rehash_offer' }),
    T(2, "Got it, I'll call you at 9:30 AM ET tomorrow. Would a quick call help?", { step: 'post_demo' })]);
  const codes = SCENARIO_EXPECTATIONS.rehash_bare_time_pick(bad).map(f => f.code);
  assert.ok(codes.includes('named_time_not_booked') && codes.includes('rehash_call_not_booked') && codes.includes('question_after_booking'), codes.join());
  // The switch off: not checked.
  assert.deepEqual(SCENARIO_EXPECTATIONS.rehash_bare_time_pick({ ...bad, rehash_booking_fix: 'off' }).map(f => f.code).filter(c => c !== 'rehash_lane'), []);
});

test('scenario check: ready → the call; a firm no → no question', () => {
  const ready = R('rehash_ready_to_move', [T(1, 'Too expensive compared to what you were quoted elsewhere?', { step: 'rehash_objection' })]);
  assert.ok(SCENARIO_EXPECTATIONS.rehash_ready_to_move(ready).some(f => f.code === 'ready_read_as_objection'));
  const no = R('rehash_firm_no', [T(1, 'Did you get a chance to look over the proposal?', { step: 'post_demo' }), T(2, 'Understood. Where are you at with it?', { step: 'post_demo' })]);
  assert.ok(SCENARIO_EXPECTATIONS.rehash_firm_no(no).some(f => f.code === 'question_after_firm_no'));
});
