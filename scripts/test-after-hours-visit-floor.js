/**
 * scripts/test-after-hours-visit-floor.js
 *
 * 2026-10-06 (the user): a home visit booked while the team is closed starts no
 * earlier than 2 PM ET on the next open day, so LP can import the lead and a
 * Five9 Conf list can call it first. LP lead 581084 (booked Sunday 7:36 PM for
 * Monday) reached LP at 9:58 AM and was never called before the visit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { visitTooEarlyAfterHours } = await import('../src/agentic/team-hours.js');
const { parseSlots, allowedStartHours } = await import('../src/knowledge/calendar-availability.js');

// 2026-10-04 is a Sunday; October is EDT (UTC-4).
const et = (ymd, hm) => new Date(`${ymd}T${hm}:00-04:00`).getTime();
const SUN_9PM = et('2026-10-04', '21:00');
const MON_2AM = et('2026-10-05', '02:00');
const MON_11AM = et('2026-10-05', '11:00');
const SAT_6PM = et('2026-10-10', '18:00');

test('booked after closing: the next morning goes, the afternoon and later days stay', () => {
  assert.equal(visitTooEarlyAfterHours(et('2026-10-05', '10:00'), SUN_9PM), true, 'Monday 10 AM');
  assert.equal(visitTooEarlyAfterHours(et('2026-10-05', '14:00'), SUN_9PM), false, 'Monday 2 PM');
  assert.equal(visitTooEarlyAfterHours(et('2026-10-05', '18:00'), SUN_9PM), false, 'Monday 6 PM');
  assert.equal(visitTooEarlyAfterHours(et('2026-10-06', '10:00'), SUN_9PM), false, 'Tuesday 10 AM');
});

test('booked before opening: that same morning goes', () => {
  assert.equal(visitTooEarlyAfterHours(et('2026-10-05', '10:00'), MON_2AM), true);
  assert.equal(visitTooEarlyAfterHours(et('2026-10-05', '14:00'), MON_2AM), false);
  assert.equal(visitTooEarlyAfterHours(et('2026-10-06', '10:00'), MON_2AM), false);
});

test('Saturday after 5 PM: Sunday morning goes, Monday morning stays', () => {
  assert.equal(visitTooEarlyAfterHours(et('2026-10-11', '10:00'), SAT_6PM), true);
  assert.equal(visitTooEarlyAfterHours(et('2026-10-11', '14:00'), SAT_6PM), false);
  assert.equal(visitTooEarlyAfterHours(et('2026-10-12', '10:00'), SAT_6PM), false);
});

test('booked while the team is in: nothing changes', () => {
  assert.equal(visitTooEarlyAfterHours(et('2026-10-06', '10:00'), MON_11AM), false);
});

test('earliestHour 0 turns the rule off', () => {
  assert.equal(visitTooEarlyAfterHours(et('2026-10-05', '10:00'), SUN_9PM, 0), false);
});

test('parseSlots: a visit calendar drops the next-morning slot after hours; a call calendar keeps it', () => {
  const day = (ymd) => ['10:00', '14:00', '18:00'].map((t) => `${ymd}T${t}:00-04:00`);
  const data = { a: { slots: day('2026-10-05') }, b: { slots: day('2026-10-06') } };
  const WE = 'aJj14ONxh1oFyDcQ706O';
  const visit = parseSlots(data, WE, 'America/New_York', 120, 0, allowedStartHours(WE), SUN_9PM);
  assert.equal(visit.slots.length, 5, 'only Monday 10 AM goes');
  assert.ok(!visit.slots.some((s) => new Date(s.iso).getTime() === et('2026-10-05', '10:00')), 'no Monday 10 AM visit at 9 PM Sunday');
  assert.ok(visit.slots.some((s) => new Date(s.iso).getTime() === et('2026-10-05', '14:00')), 'Monday 2 PM stays');
  assert.ok(visit.slots.some((s) => new Date(s.iso).getTime() === et('2026-10-06', '10:00')), 'Tuesday 10 AM stays');

  const sameDuringHours = parseSlots(data, WE, 'America/New_York', 120, 0, allowedStartHours(WE), et('2026-10-04', '13:00'));
  assert.equal(sameDuringHours.slots.length, 6, 'booked while open: every slot stays');

  const PPR = 'DQYMaJ22N6zL4SXjHukw';
  const call = parseSlots(data, PPR, 'America/New_York', 120, 0, allowedStartHours(PPR), SUN_9PM);
  assert.ok(call.slots.some((s) => new Date(s.iso).getTime() === et('2026-10-05', '10:00')), 'a call is never limited');
});
