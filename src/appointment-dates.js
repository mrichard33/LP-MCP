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

/** ET UTC-offset in minutes (DST-correct) for an instant, e.g. -240 in July, -300 in January. */
export function etOffsetMinutes(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZoneName: 'shortOffset',
  }).formatToParts(date);
  const tzName = parts.find((p) => p.type === 'timeZoneName')?.value || '';
  // 'GMT-4' / 'GMT-04:00' → minutes east of UTC (negative for ET)
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(tzName);
  if (!m) return -300;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
}

/**
 * Convert an LP `appointment_date` timestamp to a GHL startTime ISO string.
 *
 * LP stores the appointment's ET WALL-CLOCK digits mislabeled as UTC
 * (verified live 2026-07-07: lp_leads "2026-07-08T10:00:00+00:00" is the GHL
 * appointment "2026-07-08T10:00:00-04:00"). So the digits are reused verbatim
 * and only the offset is replaced with the DST-correct ET offset for that
 * wall-clock instant.
 *
 * Returns null when there is no usable time-of-day: unparseable input,
 * date-only values ("2026-06-15+00:00"), or exact midnight — LP date-only
 * rows normalize to UTC midnight, and no real appointment is booked at
 * 12:00 AM, so midnight is treated as "date known, time unknown".
 *
 * @param {string|null|undefined} lpTimestamp  lp_leads.appointment_date
 * @returns {string|null}  e.g. '2026-07-08T10:00:00-04:00'
 */
export function lpWallClockToGhlStartTime(lpTimestamp) {
  if (!lpTimestamp) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(lpTimestamp));
  if (!m) return null;
  const [, y, mo, d, h, mi, s = '00'] = m;
  if (h === '00' && mi === '00' && s === '00') return null;

  // Anchor: the wall-clock digits read as if they were UTC. The true instant
  // is that anchor minus the ET offset; the offset itself must be evaluated
  // AT the true instant, so refine once across a possible DST boundary.
  const wallUtcMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  let off = etOffsetMinutes(new Date(wallUtcMs));
  const refined = etOffsetMinutes(new Date(wallUtcMs - off * 60000));
  if (refined !== off) off = refined;

  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  const offStr = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${offStr}`;
}

export const APPOINTMENT_TZ = TZ;
