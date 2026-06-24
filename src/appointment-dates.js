/**
 * Appointment date awareness — src/appointment-dates.js
 *
 * Pure, dependency-free helpers that ground the agentic bot in the current date
 * and label an LP appointment as past/future.
 *
 * IMPORTANT: LP `appointment_date` is a DATE-ONLY value stored as UTC midnight
 * (e.g. "2026-06-15+00:00"). It denotes a calendar DAY, not an instant. So we
 * compare calendar days in America/New_York rather than timezone-converting the
 * instant — converting 2026-06-15T00:00:00Z to ET yields June 14 8 PM, an
 * off-by-one. The appointment day is taken literally from its YYYY-MM-DD prefix;
 * "today" is resolved as the current ET calendar day.
 */

const TZ = 'America/New_York';

// Calendar Y/M/D (in ET) for a Date instant.
function etYmd(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { y: Number(get('year')), m: Number(get('month')), d: Number(get('day')) };
}

// Parse the leading YYYY-MM-DD from a date-only / ISO string WITHOUT tz shift.
function parseYmd(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(str));
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

// Whole-day difference (a - b) via UTC anchors — DST-safe.
function dayDiff(a, b) {
  return Math.round((Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(b.y, b.m - 1, b.d)) / 86400000);
}

/**
 * Signed whole-day delta from today (ET) to an LP appointment day.
 * @param {string|null|undefined} apptDate  LP appointment_date (date-only/ISO) or null
 * @param {Date} [now]  reference instant (default: current time)
 * @returns {{ is_past: boolean, days_delta: number }|null}
 *   days_delta: negative = past, 0 = today, positive = future.
 *   null when there is no parseable appointment date.
 */
export function appointmentDelta(apptDate, now = new Date()) {
  if (!apptDate) return null;
  const appt = parseYmd(apptDate);
  if (!appt) return null;
  const days_delta = dayDiff(appt, etYmd(now));
  return { is_past: days_delta < 0, days_delta };
}

/** Human current date in ET, e.g. "Wednesday, June 24, 2026". */
export function formatDateHuman(date = new Date()) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  }).format(date);
}

export const APPOINTMENT_TZ = TZ;
