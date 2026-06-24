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

test('July 2026 excludes Independence Day (Jul 4, a Saturday)', () => {
  // July 2026: 31 days, 4 Sundays (5,12,19,26) → 27 Mon–Sat, minus Jul 4 = 26.
  assert.equal(isSellingDay('2026-07-04', cal), false);
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
  const dflt = resolveSellingCalendar({ SCORECARD_HOLIDAYS: '' });
  assert.equal(isSellingDay('2026-07-04', dflt), false);
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
