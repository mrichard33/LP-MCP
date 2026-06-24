/**
 * Selling-Day Calendar — src/selling-days.js
 *
 * Counts SELLING days (not calendar days) for the goal scorecard, with a
 * consistent basis for numerator (elapsed) and denominator (period total),
 * anchored to the last COMPLETED selling day.
 *
 * Selling-day definition (config, env-overridable):
 *   - Default weekly pattern: Mon–Sat are selling days; Sunday is not.
 *     Override with SCORECARD_SELLING_DAYS=mon,tue,wed,thu,fri,sat
 *   - A Reece closure (holiday) list, excluded even when Mon–Sat. Default set:
 *     New Year's Day (Jan 1), Independence Day (Jul 4), Thanksgiving (4th Thu
 *     Nov), Christmas (Dec 25). Override with SCORECARD_HOLIDAYS=YYYY-MM-DD,...
 *
 * NOTE: Juneteenth is intentionally a SELLING day, so June 2026 = 26 selling
 * days (matches the official Reece report). Holidays here are showroom-closure
 * days, NOT the federal-holiday calendar in rescission-window.js — so we do not
 * apply OPM observed-day shifts (a closure is on the actual day; a holiday that
 * lands on a Sunday is already non-selling).
 *
 * Pure functions only — no I/O, no side effects. Unit-testable.
 */

import { addDays, dowFromYMD, nthWeekdayOfMonth } from './rescission-window.js';

const DOW_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Default closure days for a year: New Year's, July 4, Thanksgiving, Christmas. */
function defaultHolidays(year) {
  return new Set([
    `${year}-01-01`,                  // New Year's Day
    `${year}-07-04`,                  // Independence Day
    nthWeekdayOfMonth(year, 11, 4, 4), // Thanksgiving — 4th Thursday Nov
    `${year}-12-25`,                  // Christmas Day
  ]);
}

/**
 * Resolve the selling calendar from env (or an explicit env-like object).
 * Returns { sellingDows:Set<0..6>, holidays(year):Set<'YYYY-MM-DD'> }.
 */
export function resolveSellingCalendar(env = process.env) {
  // Weekly selling pattern.
  const dowRaw = (env.SCORECARD_SELLING_DAYS || 'mon,tue,wed,thu,fri,sat')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const sellingDows = new Set(
    dowRaw.map((name) => DOW_NAMES.indexOf(name)).filter((i) => i >= 0),
  );

  // Holiday override: SCORECARD_HOLIDAYS='none' disables all closures; a CSV of
  // explicit YYYY-MM-DD dates replaces the default set verbatim; empty/unset
  // keeps the computed per-year default (New Year's / Jul 4 / Thanksgiving /
  // Christmas).
  const rawHolidays = (env.SCORECARD_HOLIDAYS || '').trim();
  let explicitSet = null;
  if (rawHolidays.toLowerCase() === 'none') {
    explicitSet = new Set();
  } else {
    const explicit = rawHolidays
      .split(',').map((s) => s.trim()).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
    explicitSet = explicit.length ? new Set(explicit) : null;
  }

  const cache = new Map();
  const holidays = (year) => {
    if (!cache.has(year)) {
      // When an explicit list is configured it fully replaces the default set;
      // only the entries for this year are relevant to the membership check.
      cache.set(year, explicitSet ?? defaultHolidays(year));
    }
    return cache.get(year);
  };

  return { sellingDows, holidays };
}

/** True if a YYYY-MM-DD (ET) is a selling day under `cal`. */
export function isSellingDay(ymd, cal) {
  if (!cal.sellingDows.has(dowFromYMD(ymd))) return false;
  const year = Number(ymd.slice(0, 4));
  if (cal.holidays(year).has(ymd)) return false;
  return true;
}

/**
 * Count selling days in [start, asOf] inclusive (ET calendar days).
 * Returns 0 when asOf < start.
 */
export function sellingDaysElapsed(start, asOf, cal) {
  if (asOf < start) return 0;
  let count = 0;
  for (let cur = start; cur <= asOf; cur = addDays(cur, 1)) {
    if (isSellingDay(cur, cal)) count++;
  }
  return count;
}

/** Count selling days in the FULL period [periodStart, periodEnd] inclusive. */
export function sellingDaysInPeriod(periodStart, periodEnd, cal) {
  return sellingDaysElapsed(periodStart, periodEnd, cal);
}

/**
 * The last COMPLETED selling day strictly before `today` (ET) — today is still
 * in progress, so we start the walk-back at yesterday. Mon → prior Sat;
 * Sun → Sat. Walks back at most ~10 days as a safety bound.
 */
export function lastCompletedSellingDay(today, cal) {
  let cur = addDays(today, -1);
  for (let i = 0; i < 10; i++) {
    if (isSellingDay(cur, cal)) return cur;
    cur = addDays(cur, -1);
  }
  return cur; // fallback — should never hit with a sane calendar
}

/** Last calendar day of the month containing a YYYY-MM-DD (ET-safe). */
export function monthEnd(ymd) {
  const [y, m] = ymd.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0, 12, 0, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}
