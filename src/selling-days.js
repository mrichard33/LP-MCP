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
 *   - A Reece closure (holiday) list, excluded even when Mon–Sat. Eight closures:
 *     New Year's Day, Memorial Day, Independence Day, Labor Day, Thanksgiving,
 *     the day after Thanksgiving, Christmas Eve and Christmas Day.
 *     Override with SCORECARD_HOLIDAYS=YYYY-MM-DD,...
 *
 * NOTE: Juneteenth is intentionally a SELLING day, so June 2026 = 26 selling
 * days (matches the official Reece report). These are showroom-closure days,
 * NOT the federal-holiday calendar in rescission-window.js: Columbus Day and
 * Veterans Day stay selling days, while the day after Thanksgiving and Christmas
 * Eve are closures despite not being federal holidays.
 *
 * Fixed-date closures ARE shifted to the nearest weekday when they fall on a
 * weekend (Sat → prior Fri, Sun → next Mon), matching the dashboard. This module
 * previously listed only four closures and applied no shift, which put it four
 * selling days a year ahead of the read side — May, Sep, Nov and Dec 2026 each
 * counted one day too many (309/yr here vs 305 in the dashboard). Since this is
 * the module that WRITES days_elapsed and working_days_in_period, every
 * target-to-date in those months was being computed against the wrong
 * denominator. August happened to agree, which is why it went unnoticed.
 *
 * ⚠ This is the server-side source of truth. Its read-side mirror is
 * lib/date/holidays.ts in the dashboard; the two lists must stay identical.
 *
 * Pure functions only — no I/O, no side effects. Unit-testable.
 */

import {
  addDays, dowFromYMD, nthWeekdayOfMonth, lastMondayOfMonth, shiftToObserved,
} from './rescission-window.js';

const DOW_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Frozen closure lists (YYYY-MM-DD, observed dates already applied).
 *
 * Must stay identical to REECE_HOLIDAYS in the dashboard's lib/date/holidays.ts.
 * That file is the read-side mirror; this module is what actually writes
 * days_elapsed and working_days_in_period onto lp_market_scorecard_daily, so a
 * disagreement here is the one that reaches the numbers.
 */
const FROZEN_HOLIDAYS = {
  2026: [
    '2026-01-01', // New Year's Day (Thu)
    '2026-05-25', // Memorial Day (Mon)
    '2026-07-03', // Independence Day — observed (Fri; Jul 4 falls on Sat)
    '2026-09-07', // Labor Day (Mon)
    '2026-11-26', // Thanksgiving (Thu)
    '2026-11-27', // Day after Thanksgiving (Fri)
    '2026-12-24', // Christmas Eve (Thu)
    '2026-12-25', // Christmas Day (Fri)
  ],
};

/**
 * Computed fallback for years not frozen above — same pattern, so a future year
 * never silently degrades to "no closures". Freeze new years here and validate
 * against the working_days column in scorecard_goals_monthly.
 */
function computedHolidays(year) {
  const thanksgiving = nthWeekdayOfMonth(year, 11, 4, 4);
  return new Set([
    shiftToObserved(`${year}-01-01`),   // New Year's Day
    lastMondayOfMonth(year, 5),         // Memorial Day — last Monday of May
    shiftToObserved(`${year}-07-04`),   // Independence Day
    nthWeekdayOfMonth(year, 9, 1, 1),   // Labor Day — 1st Monday of September
    thanksgiving,                       // Thanksgiving — 4th Thursday of November
    addDays(thanksgiving, 1),           // Day after Thanksgiving
    shiftToObserved(`${year}-12-24`),   // Christmas Eve
    shiftToObserved(`${year}-12-25`),   // Christmas Day
  ]);
}

/** Reece closure days for a year. Frozen list when present, else computed. */
function defaultHolidays(year) {
  const frozen = FROZEN_HOLIDAYS[year];
  return frozen ? new Set(frozen) : computedHolidays(year);
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
