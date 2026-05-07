/**
 * Florida 3-Business-Day Rescission Window
 * — src/rescission-window.js
 *
 * Computes the Florida home-solicitation cancellation deadline (FL Stat 501.025)
 * for a given signing date. Three business days, excluding Saturdays, Sundays,
 * and observed federal holidays. Returns variant metadata for day-of-week-aware
 * messaging.
 *
 * Built 2026-05-06 from Thomas Michaud (YTk89Ra5NOOgdtdbgsGF) post-mortem.
 * Phase 2 of the Competitor Rescission Rescue plan.
 *
 * Pure functions only — no I/O, no side effects. Unit-testable.
 */

const ET = 'America/New_York';

// ─── Date helpers ──────────────────────────────────────────────────

/** Format a Date as YYYY-MM-DD in the given timezone. */
function toLocalDateString(date, tz = ET) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

/**
 * Add N calendar days to a YYYY-MM-DD string. Returns new YYYY-MM-DD string.
 * Operates on a noon-UTC anchor to avoid DST edge cases.
 */
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const anchor = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  anchor.setUTCDate(anchor.getUTCDate() + n);
  const yy = anchor.getUTCFullYear();
  const mm = String(anchor.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(anchor.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** Day-of-week (0=Sun..6=Sat) for a YYYY-MM-DD. */
function dowFromYMD(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay();
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ─── Federal holiday calendar (computed dynamically) ───────────────

/** Nth weekday of a month, e.g., 3rd Monday (n=3, weekday=1). */
function nthWeekdayOfMonth(year, month, weekday, n) {
  const first = new Date(Date.UTC(year, month - 1, 1, 12, 0, 0));
  const firstDOW = first.getUTCDay();
  const offset = (weekday - firstDOW + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Last Monday of a month. */
function lastMondayOfMonth(year, month) {
  const lastDay = new Date(Date.UTC(year, month, 0, 12, 0, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month - 1, lastDay, 12, 0, 0));
  const dow = last.getUTCDay();
  const offset = (dow - 1 + 7) % 7;
  const day = lastDay - offset;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Apply observed-day shift for fixed-date holidays (per OPM):
 *   Saturday → observed previous Friday
 *   Sunday → observed following Monday
 */
function shiftToObserved(ymd) {
  const dow = dowFromYMD(ymd);
  if (dow === 6) return addDays(ymd, -1); // Sat → Fri
  if (dow === 0) return addDays(ymd, 1);  // Sun → Mon
  return ymd;
}

/**
 * Federal holidays observed in a given year. Returns Set of YYYY-MM-DD strings.
 *
 * Per OPM (5 USC 6103):
 *   - New Year's Day (Jan 1)
 *   - MLK Day (3rd Mon Jan)
 *   - Presidents Day (3rd Mon Feb)
 *   - Memorial Day (last Mon May)
 *   - Juneteenth (Jun 19) — observed
 *   - Independence Day (Jul 4) — observed
 *   - Labor Day (1st Mon Sep)
 *   - Columbus Day (2nd Mon Oct)
 *   - Veterans Day (Nov 11) — observed
 *   - Thanksgiving (4th Thu Nov)
 *   - Christmas (Dec 25) — observed
 *
 * Per D2 architectural decision (2026-05-06): federal-only scope.
 * Florida state-specific holidays NOT included. If FL state holidays
 * become operationally relevant, extend this function.
 */
export function federalHolidaysObserved(year) {
  return new Set([
    shiftToObserved(`${year}-01-01`),    // New Year's
    nthWeekdayOfMonth(year, 1, 1, 3),    // MLK 3rd Mon Jan
    nthWeekdayOfMonth(year, 2, 1, 3),    // Presidents 3rd Mon Feb
    lastMondayOfMonth(year, 5),          // Memorial last Mon May
    shiftToObserved(`${year}-06-19`),    // Juneteenth
    shiftToObserved(`${year}-07-04`),    // Independence
    nthWeekdayOfMonth(year, 9, 1, 1),    // Labor 1st Mon Sep
    nthWeekdayOfMonth(year, 10, 1, 2),   // Columbus 2nd Mon Oct
    shiftToObserved(`${year}-11-11`),    // Veterans
    nthWeekdayOfMonth(year, 11, 4, 4),   // Thanksgiving 4th Thu Nov
    shiftToObserved(`${year}-12-25`),    // Christmas
  ]);
}

const HOLIDAY_CACHE = new Map();
function getHolidaysFor(year) {
  if (!HOLIDAY_CACHE.has(year)) {
    HOLIDAY_CACHE.set(year, federalHolidaysObserved(year));
  }
  return HOLIDAY_CACHE.get(year);
}

/** True if YYYY-MM-DD is Mon-Fri AND not an observed federal holiday. */
export function isBusinessDay(ymd) {
  const dow = dowFromYMD(ymd);
  if (dow === 0 || dow === 6) return false;
  const year = Number(ymd.slice(0, 4));
  if (getHolidaysFor(year).has(ymd)) return false;
  return true;
}

/**
 * Step forward N business days from start date. Day after `start` is day 1.
 * (Florida convention: clock starts the day AFTER signing.)
 */
function addBusinessDays(startYMD, n) {
  let cur = startYMD;
  let added = 0;
  while (added < n) {
    cur = addDays(cur, 1);
    if (isBusinessDay(cur)) added++;
  }
  return cur;
}

// ─── Variant classification ────────────────────────────────────────

/**
 * Variant key from signing date. Drives messaging template selection.
 *
 * Base variants by signing day-of-week:
 *   mon, tue, wed, thu, fri-evening, sat, sun
 *
 * Holiday-week override: if any day in the (signing, deadline] window is
 * a federal holiday, suffix '-holiday' to the variant key for templates
 * that explicitly reference the holiday's effect on the window.
 */
function classifySigning(signingYMD) {
  const dow = dowFromYMD(signingYMD);
  let base;
  switch (dow) {
    case 0: base = 'sun'; break;
    case 1: base = 'mon'; break;
    case 2: base = 'tue'; break;
    case 3: base = 'wed'; break;
    case 4: base = 'thu'; break;
    case 5: base = 'fri-evening'; break;
    case 6: base = 'sat'; break;
    default: base = 'mon';
  }
  // Holiday-week detection: scan calendar days in (signing, deadline]
  const deadline = addBusinessDays(signingYMD, 3);
  let scan = signingYMD;
  let hasHolidayInWindow = false;
  while (scan < deadline) {
    scan = addDays(scan, 1);
    const year = Number(scan.slice(0, 4));
    if (getHolidaysFor(year).has(scan)) {
      hasHolidayInWindow = true;
      break;
    }
  }
  return hasHolidayInWindow ? `${base}-holiday` : base;
}

// ─── Main entry point ──────────────────────────────────────────────

/**
 * Compute the Florida 3-business-day rescission deadline for a signing date.
 *
 * @param {string|Date} signedDate - Date of signing. Date object, ISO string, or YYYY-MM-DD.
 * @param {object} [opts]
 * @param {string} [opts.timezone='America/New_York']
 * @param {string|Date} [opts.now] - "Now" for testing or alternate clocks. Defaults to current time.
 * @returns {{
 *   signed_date_iso: string,            // YYYY-MM-DD in ET
 *   signing_dow: number,                // 0-6 (Sun-Sat)
 *   signing_dow_name: string,           // "Wednesday"
 *   deadline_iso: string,               // YYYY-MM-DD in ET (end of business day)
 *   deadline_dow: number,
 *   deadline_dow_name: string,
 *   deadline_human: string,             // "Wednesday end of business day"
 *   message_variant_key: string,        // 'mon'|'tue'|'wed'|'thu'|'fri-evening'|'sat'|'sun' (with optional '-holiday' suffix)
 *   business_days_remaining: number,    // Business days from today (inclusive) through deadline (inclusive)
 *   past_window: boolean,               // True if today > deadline
 *   holiday_in_window: boolean,
 * }}
 */
export function computeRescissionDeadline(signedDate, opts = {}) {
  const tz = opts.timezone || ET;
  const now = opts.now ? new Date(opts.now) : new Date();

  // Normalize signedDate to YYYY-MM-DD in ET
  let signedYMD;
  if (signedDate instanceof Date) {
    signedYMD = toLocalDateString(signedDate, tz);
  } else if (typeof signedDate === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(signedDate)) {
      signedYMD = signedDate;
    } else {
      const parsed = new Date(signedDate);
      if (isNaN(parsed.getTime())) {
        throw new Error(`computeRescissionDeadline: invalid signedDate string "${signedDate}"`);
      }
      signedYMD = toLocalDateString(parsed, tz);
    }
  } else {
    throw new Error('computeRescissionDeadline: signedDate must be Date or ISO string');
  }

  const todayYMD = toLocalDateString(now, tz);

  // 3 business days AFTER signing
  const deadlineYMD = addBusinessDays(signedYMD, 3);

  // Business days remaining: from max(today, signedYMD+1) through deadline inclusive
  let remaining = 0;
  let cur = todayYMD < signedYMD ? signedYMD : todayYMD;
  while (cur <= deadlineYMD) {
    if (isBusinessDay(cur)) remaining++;
    cur = addDays(cur, 1);
  }

  const past = todayYMD > deadlineYMD;
  if (past) remaining = 0;

  const signingDOW = dowFromYMD(signedYMD);
  const deadlineDOW = dowFromYMD(deadlineYMD);
  const variant = classifySigning(signedYMD);
  const holidayInWindow = variant.endsWith('-holiday');

  return {
    signed_date_iso: signedYMD,
    signing_dow: signingDOW,
    signing_dow_name: DAY_NAMES[signingDOW],
    deadline_iso: deadlineYMD,
    deadline_dow: deadlineDOW,
    deadline_dow_name: DAY_NAMES[deadlineDOW],
    deadline_human: `${DAY_NAMES[deadlineDOW]} end of business day`,
    message_variant_key: variant,
    business_days_remaining: remaining,
    past_window: past,
    holiday_in_window: holidayInWindow,
  };
}

// ─── Sign-date detection from inbound text ─────────────────────────

const REL_NUM_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  couple: 2, few: 3, several: 4,
};

/**
 * Detect a signing-recency cue from inbound message text.
 * Returns a YYYY-MM-DD string if detectable, else null
 * (caller defaults to today per D1 architectural decision).
 *
 * Patterns recognized:
 *   "today" / "earlier today" / "this morning|afternoon|evening" / "tonight" /
 *     "just now" / "just signed" / "just contracted" → today
 *   "yesterday" / "last night" → today − 1
 *   "(N|word) day(s) ago" → today − N
 *   "last week" → today − 7
 *   "(N|word) week(s) ago" → today − 7N
 *
 * Conservative: ambiguous phrasing returns null so caller assumes today
 * (charitable / aggressive rescue posture per D1).
 *
 * @param {string} text - Inbound message text
 * @param {object} [opts]
 * @param {string|Date} [opts.now] - "Now" for testing
 * @param {string} [opts.timezone='America/New_York']
 * @returns {string|null} YYYY-MM-DD or null
 */
export function detectSigningDate(text, opts = {}) {
  if (!text || typeof text !== 'string') return null;
  const tz = opts.timezone || ET;
  const now = opts.now ? new Date(opts.now) : new Date();
  const todayYMD = toLocalDateString(now, tz);
  const lower = text.toLowerCase();

  // Explicit date words win over colloquial intensifiers like "just signed".
  // ORDER MATTERS: explicit > colloquial.

  // Yesterday / last night
  if (/\b(yesterday|last night)\b/.test(lower)) {
    return addDays(todayYMD, -1);
  }
  // "N days ago"
  const dayMatch = lower.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|couple|few|several)\s+days?\s+ago\b/);
  if (dayMatch) {
    const raw = dayMatch[1];
    const n = /^\d+$/.test(raw) ? Number(raw) : REL_NUM_WORDS[raw];
    if (n && n > 0 && n < 60) return addDays(todayYMD, -n);
  }
  // "last week"
  if (/\blast week\b/.test(lower)) {
    return addDays(todayYMD, -7);
  }
  // "N weeks ago"
  const weekMatch = lower.match(/\b(\d+|one|two|three|four|five|six|seven|eight|couple|few)\s+weeks?\s+ago\b/);
  if (weekMatch) {
    const raw = weekMatch[1];
    const n = /^\d+$/.test(raw) ? Number(raw) : REL_NUM_WORDS[raw];
    if (n && n > 0) return addDays(todayYMD, -n * 7);
  }
  // Today / tonight / this morning / just now / just signed (lowest priority — colloquial)
  if (/\b(today|earlier today|this (morning|afternoon|evening)|tonight|just now|just signed|just contracted)\b/.test(lower)) {
    return todayYMD;
  }
  return null;
}

// ─── Test convenience exports ──────────────────────────────────────

export const __test = {
  toLocalDateString,
  addDays,
  dowFromYMD,
  nthWeekdayOfMonth,
  lastMondayOfMonth,
  shiftToObserved,
  classifySigning,
};
