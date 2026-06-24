// ─── Selling-day calendar — src/selling-days.js ──────────────────────
//
// Source of truth for the Reece scorecard's selling-day basis. The daily job
// (src/jobs/goal-scorecard-daily.js) persists `days_elapsed` (selling days
// elapsed [period_start, as_of]) and `working_days_in_period` (selling days in
// the full month) onto each snapshot; the dashboard read layer consumes those
// directly. The dashboard keeps a TS mirror (Reece-Dashboard/lib/date/sellingDays.ts)
// for the "is the snapshot stale?" guard and the period filter — keep the two in
// sync.
//
// Mon–Sat selling by default, Sunday off, with a Reece closure list (New Year's /
// Jul 4 / Thanksgiving / Christmas) that is NOT the federal-holiday calendar
// (Juneteenth stays a selling day — do NOT reuse src/rescission-window.js, which
// is federal-only). Config from the same env vars as the dashboard:
//   SCORECARD_SELLING_DAYS  (default "mon,tue,wed,thu,fri,sat")
//   SCORECARD_HOLIDAYS      (comma-sep YYYY-MM-DD, or "none"; default Reece closures)

const ET = 'America/New_York';
const DOW_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Today's ET calendar date as YYYY-MM-DD. */
export function todayET() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/** Add N calendar days to a YYYY-MM-DD (noon-UTC anchor avoids DST edges). */
export function addDays(ymd, n) {
  const p = ymd.split('-');
  const anchor = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12, 0, 0));
  anchor.setUTCDate(anchor.getUTCDate() + n);
  const yy = anchor.getUTCFullYear();
  const mm = String(anchor.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(anchor.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** Day-of-week (0=Sun..6=Sat) for a YYYY-MM-DD. */
function dowFromYMD(ymd) {
  const p = ymd.split('-');
  return new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12, 0, 0)).getUTCDay();
}

/** Nth weekday of a month (e.g. 4th Thursday Nov → Thanksgiving). */
function nthWeekdayOfMonth(year, month, weekday, n) {
  const first = new Date(Date.UTC(year, month - 1, 1, 12, 0, 0));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function defaultHolidays(year) {
  return new Set([
    `${year}-01-01`,                    // New Year's Day
    `${year}-07-04`,                    // Independence Day
    nthWeekdayOfMonth(year, 11, 4, 4),  // Thanksgiving
    `${year}-12-25`,                    // Christmas Day
  ]);
}

/** Resolve the selling calendar from env (mirrors the dashboard defaults). */
export function resolveSellingCalendar(env = process.env) {
  const dowRaw = (env.SCORECARD_SELLING_DAYS || 'mon,tue,wed,thu,fri,sat')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const sellingDows = new Set(
    dowRaw.map((name) => DOW_NAMES.indexOf(name)).filter((i) => i >= 0),
  );

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
    if (!cache.has(year)) cache.set(year, explicitSet ?? defaultHolidays(year));
    return cache.get(year);
  };

  return { sellingDows, holidays };
}

export function isSellingDay(ymd, cal) {
  if (!cal.sellingDows.has(dowFromYMD(ymd))) return false;
  return !cal.holidays(Number(ymd.slice(0, 4))).has(ymd);
}

/** Count selling days in [start, asOf] inclusive; 0 when asOf < start. */
export function sellingDaysElapsed(start, asOf, cal) {
  if (asOf < start) return 0;
  let count = 0;
  for (let cur = start; cur <= asOf; cur = addDays(cur, 1)) {
    if (isSellingDay(cur, cal)) count++;
  }
  return count;
}

export function sellingDaysInPeriod(periodStart, periodEnd, cal) {
  return sellingDaysElapsed(periodStart, periodEnd, cal);
}

/** Last COMPLETED selling day strictly before `today` (today is in progress). */
export function lastCompletedSellingDay(today, cal) {
  let cur = addDays(today, -1);
  for (let i = 0; i < 10; i++) {
    if (isSellingDay(cur, cal)) return cur;
    cur = addDays(cur, -1);
  }
  return cur;
}
