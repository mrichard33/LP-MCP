/**
 * test-reschedule-options.js — computeRescheduleOptions (Pilot v2 v1.5).
 *
 * The four spec table rows verbatim, plus: Sunday evening is never
 * offered, Saturday 6 PM evening IS valid (close 6:30), and the same-day
 * 2-hour-notice boundary.
 *
 * All `now` instants below are July 2026 EDT (UTC-4).
 * 2026: Jul 14 = Tue, Jul 17 = Fri, Jul 18 = Sat, Jul 19 = Sun.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeRescheduleOptions } from '../src/reschedule-options.js';

const phrases = (opts) => opts.map((o) => o.phrase);

test('spec row 1: Tue 9:00 AM, declined Tue 2 PM → "this evening", "tomorrow morning"', () => {
  const now = new Date('2026-07-14T13:00:00Z'); // Tue 9:00 ET
  const declined = new Date('2026-07-14T18:00:00Z'); // Tue 14:00 ET
  assert.deepEqual(phrases(computeRescheduleOptions(declined, now)), [
    'this evening',
    'tomorrow morning',
  ]);
});

test('spec row 2: Tue 4:30 PM, declined Tue 6 PM → "tomorrow morning", "tomorrow afternoon"', () => {
  const now = new Date('2026-07-14T20:30:00Z'); // Tue 16:30 ET
  const declined = new Date('2026-07-14T22:00:00Z'); // Tue 18:00 ET
  assert.deepEqual(phrases(computeRescheduleOptions(declined, now)), [
    'tomorrow morning',
    'tomorrow afternoon',
  ]);
});

test('spec row 3: Sat 1:00 PM, declined Sat 6 PM → Sunday slots, never Sunday evening', () => {
  const now = new Date('2026-07-18T17:00:00Z'); // Sat 13:00 ET
  const declined = new Date('2026-07-18T22:00:00Z'); // Sat 18:00 ET
  const opts = computeRescheduleOptions(declined, now);
  assert.deepEqual(phrases(opts), ['tomorrow morning', 'tomorrow afternoon']);
  // Both options are Sunday slots — verify the engine never emitted a
  // Sunday evening on the way to these two.
  for (const o of opts) {
    assert.notEqual(`${o.weekday} ${o.category}`, 'Sunday evening');
  }
});

test('spec row 4: Fri 7:30 PM, declined Sat 10 AM → "Saturday afternoon", "Saturday evening"', () => {
  const now = new Date('2026-07-17T23:30:00Z'); // Fri 19:30 ET
  const declined = new Date('2026-07-18T14:00:00Z'); // Sat 10:00 ET
  assert.deepEqual(phrases(computeRescheduleOptions(declined, now)), [
    'Saturday afternoon',
    'Saturday evening', // 6 PM ≤ Sat close 6:30 — valid
  ]);
});

test('Sunday evening is never a candidate even when Sunday is otherwise open', () => {
  const now = new Date('2026-07-19T13:00:00Z'); // Sun 9:00 ET
  const declined = new Date('2026-07-19T18:00:00Z'); // Sun 14:00 ET (afternoon declined)
  const opts = computeRescheduleOptions(declined, now);
  // Sun morning fails the 2h rule by 0 min? 10:00 - 9:00 = 1h → fails.
  // Sun afternoon is declined. Sun evening must be skipped for hours, not
  // offered — so both options land on Monday.
  assert.deepEqual(phrases(opts), ['tomorrow morning', 'tomorrow afternoon']);
  for (const o of opts) assert.notEqual(`${o.weekday} ${o.category}`, 'Sunday evening');
});

test('same-day 2-hour boundary: slot exactly 2h out is allowed and offered first', () => {
  const now = new Date('2026-07-14T12:00:00Z'); // Tue 8:00 ET
  const declined = new Date('2026-07-15T14:00:00Z'); // Wed 10:00 ET (declined tomorrow morning)
  const opts = computeRescheduleOptions(declined, now);
  // Tue morning 10:00 is exactly 2h from 8:00 → valid, same-day preferred.
  assert.equal(opts[0].phrase, 'this morning');
  assert.equal(opts[1].phrase, 'this afternoon');
});

test('option slot instants carry correct ET offsets', () => {
  const now = new Date('2026-07-14T13:00:00Z'); // Tue 9:00 ET (EDT)
  const declined = new Date('2026-07-14T18:00:00Z');
  const opts = computeRescheduleOptions(declined, now);
  assert.match(opts[0].slotEtIso, /-04:00$/); // July = EDT
  assert.match(opts[0].slotEtIso, /T18:00:00/); // this evening = 6 PM
});

test('invalid inputs → empty array, never throws', () => {
  assert.deepEqual(computeRescheduleOptions('garbage', new Date()), []);
  assert.deepEqual(computeRescheduleOptions(null, new Date()), []);
});
