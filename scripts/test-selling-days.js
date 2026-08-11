/**
 * Tests — Selling-day calendar (scorecard Days-Elapsed fix)
 * scripts/test-selling-days.js
 *
 * Run with:  node --test scripts/test-selling-days.js
 *
 * Pure-function tests — no DB, no network. Guards the selling-day basis the
 * scorecard goal/pace math depends on: Mon–Sat selling, Sunday off, a Reece
 * closure list (NOT the federal-holiday calendar — Juneteenth stays a selling
 * day), and the last-completed-selling-day as-of anchor.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveSellingCalendar, isSellingDay, sellingDaysElapsed,
  sellingDaysInPeriod, lastCompletedSellingDay, monthEnd,
} from '../src/selling-days.js';

// Default calendar (Mon–Sat; New Year's / Jul 4 / Thanksgiving / Christmas).
const cal = resolveSellingCalendar({});

test('June 2026 has 26 selling days (acceptance target)', () => {
  assert.equal(sellingDaysInPeriod('2026-06-01', '2026-06-30', cal), 26);
  assert.equal(monthEnd('2026-06-15'), '2026-06-30');
});

test('elapsed June 1 → 20, 2026 (through Sat) = 18', () => {
  assert.equal(sellingDaysElapsed('2026-06-01', '2026-06-20', cal), 18);
});

test('Juneteenth (Fri Jun 19 2026) IS a selling day', () => {
  assert.equal(isSellingDay('2026-06-19', cal), true);
});

test('Saturdays are selling days, Sundays are not', () => {
  assert.equal(isSellingDay('2026-06-20', cal), true);  // Saturday
  assert.equal(isSellingDay('2026-06-21', cal), false); // Sunday
});

test('lastCompletedSellingDay: Monday → prior Saturday', () => {
  // Mon Jun 22 2026 → walk back past Sun Jun 21 to Sat Jun 20.
  assert.equal(lastCompletedSellingDay('2026-06-22', cal), '2026-06-20');
});

test('lastCompletedSellingDay: Sunday → Saturday', () => {
  // Sun Jun 21 2026 → yesterday Sat Jun 20 is a selling day.
  assert.equal(lastCompletedSellingDay('2026-06-21', cal), '2026-06-20');
});

test('lastCompletedSellingDay: Tuesday → Monday', () => {
  assert.equal(lastCompletedSellingDay('2026-06-23', cal), '2026-06-22');
});

test('July 2026 excludes Independence Day OBSERVED (Fri Jul 3)', () => {
  // July 2026: 31 days, 4 Sundays (5,12,19,26) → 27 Mon–Sat, minus one closure = 26.
  //
  // Jul 4 2026 is a Saturday, and Saturday is a selling day here, so the closure
  // is observed on Friday the 3rd. The month total is 26 either way — but WHICH
  // day is excluded decides which day the floor is measured against, and the
  // dashboard has always used the observed date. This module used to exclude the
  // 4th; it now agrees with the read side.
  assert.equal(isSellingDay('2026-07-03', cal), false);
  assert.equal(isSellingDay('2026-07-04', cal), true);
  assert.equal(sellingDaysInPeriod('2026-07-01', '2026-07-31', cal), 26);
});

test('Thanksgiving & Christmas 2026 are non-selling', () => {
  assert.equal(isSellingDay('2026-11-26', cal), false); // 4th Thu Nov
  assert.equal(isSellingDay('2026-12-25', cal), false);
});

test('elapsed returns 0 when asOf precedes start', () => {
  assert.equal(sellingDaysElapsed('2026-06-10', '2026-06-01', cal), 0);
});

test("empty/unset SCORECARD_HOLIDAYS keeps the default closure set", () => {
  // Empty is indistinguishable from unset in process.env → default applies.
  // This matters in production: .env.example ships SCORECARD_HOLIDAYS= empty, so
  // the built-in list is what Railway actually runs unless someone sets it.
  const dflt = resolveSellingCalendar({ SCORECARD_HOLIDAYS: '' });
  assert.equal(isSellingDay('2026-07-03', dflt), false, 'Independence Day observed');
  assert.equal(isSellingDay('2026-05-25', dflt), false, 'Memorial Day');
  assert.equal(isSellingDay('2026-12-24', dflt), false, 'Christmas Eve');
});

test("SCORECARD_HOLIDAYS='none' disables all closures → July = 27 Mon–Sat", () => {
  const noneCal = resolveSellingCalendar({ SCORECARD_HOLIDAYS: 'none' });
  assert.equal(isSellingDay('2026-07-04', noneCal), true);
  assert.equal(isSellingDay('2026-12-25', noneCal), true);
  assert.equal(sellingDaysInPeriod('2026-07-01', '2026-07-31', noneCal), 27);
});

test('env override: explicit holiday list replaces the default set', () => {
  const custom = resolveSellingCalendar({ SCORECARD_HOLIDAYS: '2026-06-20' });
  assert.equal(isSellingDay('2026-06-20', custom), false); // now a closure
  assert.equal(isSellingDay('2026-12-25', custom), true);  // default no longer applies
  assert.equal(sellingDaysInPeriod('2026-06-01', '2026-06-30', custom), 25);
});

test('env override: weekend pattern (no Saturday selling)', () => {
  const noSat = resolveSellingCalendar({ SCORECARD_SELLING_DAYS: 'mon,tue,wed,thu,fri' });
  assert.equal(isSellingDay('2026-06-20', noSat), false); // Saturday off
  // June 2026 Mon–Fri: 30 days − 4 Sun − 4 Sat(6,13,20,27) = 22.
  assert.equal(sellingDaysInPeriod('2026-06-01', '2026-06-30', noSat), 22);
});

// ── The writer/reader calendar contract ─────────────────────────────────────
//
// This module WRITES days_elapsed and working_days_in_period onto
// lp_market_scorecard_daily; the dashboard's lib/date/holidays.ts only mirrors
// it for staleness checks. So when the two disagree, this side is the one that
// reaches the numbers.
//
// They did disagree. This module listed four closures and applied no observed
// shift; the dashboard lists eight with shifts. May, Sep, Nov and Dec 2026 each
// counted one selling day too many here — 309/yr against the dashboard's 305 —
// so every target-to-date in those months was prorated over the wrong
// denominator. August agreed by luck, which is why it went unnoticed.

test('2026 selling days per month match the frozen Reece calendar', () => {
  // These are the per-month totals documented in the dashboard's holidays.ts and
  // frozen into scorecard_goals_monthly.working_days. All three must agree.
  const expected = {
    '01': 26, '02': 24, '03': 26, '04': 26, '05': 25, '06': 26,
    '07': 26, '08': 26, '09': 25, '10': 27, '11': 23, '12': 25,
  };
  let year = 0;
  for (const [mm, want] of Object.entries(expected)) {
    const start = `2026-${mm}-01`;
    const got = sellingDaysInPeriod(start, monthEnd(start), cal);
    assert.equal(got, want, `2026-${mm}: expected ${want} selling days, got ${got}`);
    year += got;
  }
  assert.equal(year, 305, 'the Reece selling year is 305 days');
});

test('all eight Reece closures are excluded, and only those', () => {
  // The four that were missing before — each one a whole selling day of target.
  assert.equal(isSellingDay('2026-05-25', cal), false, 'Memorial Day');
  assert.equal(isSellingDay('2026-09-07', cal), false, 'Labor Day');
  assert.equal(isSellingDay('2026-11-27', cal), false, 'day after Thanksgiving');
  assert.equal(isSellingDay('2026-12-24', cal), false, 'Christmas Eve');

  assert.equal(isSellingDay('2026-01-01', cal), false, "New Year's Day");
  assert.equal(isSellingDay('2026-11-26', cal), false, 'Thanksgiving');
  assert.equal(isSellingDay('2026-12-25', cal), false, 'Christmas Day');

  // Independence Day 2026 is a Saturday, so the closure is OBSERVED on Friday
  // the 3rd. Saturday is a selling day here, so which one is excluded changes
  // which day the floor is measured against — not just the count.
  assert.equal(isSellingDay('2026-07-03', cal), false, 'Independence Day observed');
  assert.equal(isSellingDay('2026-07-04', cal), true, 'the actual 4th is a working Saturday');

  // Federal holidays that are NOT Reece closures stay selling days.
  assert.equal(isSellingDay('2026-06-19', cal), true, 'Juneteenth');
  assert.equal(isSellingDay('2026-10-12', cal), true, 'Columbus Day');
  assert.equal(isSellingDay('2026-11-11', cal), true, 'Veterans Day');
});

test('an unfrozen year computes the same eight closures, never zero', () => {
  // A year with no frozen list must not silently degrade to "no closures" — that
  // would inflate the denominator and deflate every rate for a whole year.
  const y2027 = resolveSellingCalendar({});
  assert.equal(isSellingDay('2027-01-01', y2027), false, "New Year's Day 2027");
  assert.equal(isSellingDay('2027-05-31', y2027), false, 'Memorial Day 2027 (last Mon May)');
  assert.equal(isSellingDay('2027-09-06', y2027), false, 'Labor Day 2027 (1st Mon Sep)');
  assert.equal(isSellingDay('2027-11-25', y2027), false, 'Thanksgiving 2027 (4th Thu Nov)');
  assert.equal(isSellingDay('2027-11-26', y2027), false, 'day after Thanksgiving 2027');
});
