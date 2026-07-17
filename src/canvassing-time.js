/**
 * Canvassing appointment time handling — src/canvassing-time.js
 *
 * Replaces the retired I.CC "Subtract 5 Hours" ChatGPT step (whose prompt
 * said minus 4 — broken every DST change) and its six formatter steps.
 *
 * INPUT CONTRACT (pilot v2, amended at plan approval): the I.CV webhook
 * payload carries the appointment as TWO keys, not an ISO datetime:
 *   - appt_date: GHL appointment date merge field. Format varies by GHL
 *     rendering — YYYY-MM-DD, MM/DD/YYYY, or MM-DD-YYYY are all accepted.
 *   - appt_slot: the booked start time as rendered by GHL, e.g. "2:00 PM".
 *     Validated against the canvassing slot whitelist (standard slots per
 *     the v2 form: 10 AM / 2 PM / 6 PM / 6:30 / 7 PM).
 *
 * The slot is ET wall-clock BY DEFINITION — the canvasser and homeowner
 * agreed on a local time at the door. There is deliberately NO timezone
 * parsing of the input; that eliminates the ambiguity class the old
 * ChatGPT step existed to (incorrectly) solve. DST-aware instant
 * construction is used ONLY for the past / 48h / Friday→Monday window
 * checks.
 *
 * Pure module: imports only appointment-dates.js (itself dependency-free).
 */

import { etOffsetMinutes, APPOINTMENT_TZ } from './appointment-dates.js';

// The "48-hour" booking policy is enforced as ET CALENDAR DAYS: an
// appointment up to 2 days ahead passes (the spec's own acceptance table
// has Tuesday 10 AM → Thursday 2 PM — 52 literal hours — as a pass).
// Friday submissions may book through the following Monday 8:00 PM ET.
export const APPT_WINDOW_DAYS = 2;
export const APPT_WINDOW_HOURS = 48; // messaging/display label only

// User-confirmed 2026-07-15: a beyond-window appointment is a notify, not
// a block — the lead still posts to LP WITH adate/atime (supervisor
// exceptions exist) and the canvass channel gets a flag card. Flip this
// to false to post beyond-window leads Set-less instead.
export const SEND_APPT_WHEN_BEYOND_WINDOW = true;

// Canonical slot strings (ET wall-clock). atime is sent to LP verbatim
// from this list — never derived from arithmetic.
export const APPT_SLOTS = ['10:00 AM', '2:00 PM', '6:00 PM', '6:30 PM', '7:00 PM'];

const SLOT_HOURS = {
  '10:00 AM': { hour: 10, minute: 0 },
  '2:00 PM': { hour: 14, minute: 0 },
  '6:00 PM': { hour: 18, minute: 0 },
  '6:30 PM': { hour: 18, minute: 30 },
  '7:00 PM': { hour: 19, minute: 0 },
};

/**
 * Normalize a raw slot string to its canonical whitelist form.
 * Case-insensitive, trimmed, tolerant of missing/extra internal spaces
 * ("2:00pm", " 6:30 PM "). Returns null on any non-whitelisted value.
 */
export function normalizeApptSlot(raw) {
  if (raw === null || raw === undefined) return null;
  const compact = String(raw).toUpperCase().replace(/\s+/g, '');
  for (const slot of APPT_SLOTS) {
    if (slot.replace(/\s+/g, '') === compact) return slot;
  }
  return null;
}

/**
 * Normalize a raw date string to MM/DD/YYYY (LP adate format).
 * Accepts YYYY-MM-DD, MM/DD/YYYY, and MM-DD-YYYY (GHL merge-field date
 * formats vary). Returns null on anything else or a non-real calendar
 * date (e.g. 02/30/2026).
 */
export function normalizeApptDate(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();

  let y, m, d;
  let match;
  if ((match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) {
    [, y, m, d] = match.map(Number);
  } else if ((match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) {
    [, m, d, y] = match.map(Number);
  } else if ((match = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s))) {
    [, m, d, y] = match.map(Number);
  } else {
    return null;
  }

  // Reject impossible calendar dates via UTC roundtrip (Date.UTC rolls
  // 02/30 into March; the roundtrip check catches that).
  const roundtrip = new Date(Date.UTC(y, m - 1, d));
  if (
    roundtrip.getUTCFullYear() !== y ||
    roundtrip.getUTCMonth() !== m - 1 ||
    roundtrip.getUTCDate() !== d
  ) {
    return null;
  }

  return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`;
}

/**
 * Build the true instant for an ET wall-clock date+time. Same refine
 * technique as lpWallClockToGhlStartTime (appointment-dates.js): anchor
 * the digits as if UTC, subtract the ET offset, and re-evaluate the
 * offset at the shifted instant once so DST boundaries resolve correctly.
 */
export function etWallClockToInstant({ year, month, day, hour, minute }) {
  const wallUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  let off = etOffsetMinutes(new Date(wallUtcMs));
  const refined = etOffsetMinutes(new Date(wallUtcMs - off * 60000));
  if (refined !== off) off = refined;
  return new Date(wallUtcMs - off * 60000);
}

// ET calendar parts + weekday for an instant. Weekday comes from Intl in
// ET — never server-local getDay().
export function etParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: APPOINTMENT_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: get('weekday'), // 'Mon'..'Sun'
  };
}

/**
 * Friday exception deadline: when `now` is a Friday in ET, a canvasser
 * may book through the following Monday 8:00 PM ET. Returns that
 * deadline as a Date instant, or null when `now` isn't Friday in ET.
 */
export function fridayExceptionDeadline(now = new Date()) {
  const p = etParts(now);
  if (p.weekday !== 'Fri') return null;
  // Friday + 3 calendar days = Monday. Date.UTC normalizes month/year
  // rollover; DST is handled by etWallClockToInstant.
  const monday = new Date(Date.UTC(p.year, p.month - 1, p.day + 3));
  return etWallClockToInstant({
    year: monday.getUTCFullYear(),
    month: monday.getUTCMonth() + 1,
    day: monday.getUTCDate(),
    hour: 20,
    minute: 0,
  });
}

/**
 * Validate + convert the canvassing appointment payload keys.
 *
 * @param {object} appt
 * @param {string} appt.appt_date — see normalizeApptDate
 * @param {string} appt.appt_slot — see normalizeApptSlot
 * @param {Date} [now]
 * @returns {{
 *   status: 'ok'|'unparseable'|'past'|'beyond_window',
 *   adate: string|null,     // MM/DD/YYYY — null only when unparseable
 *   atime: string|null,     // canonical slot — null only when unparseable
 *   hoursOut: number|null,  // signed hours from now to the slot instant
 *   apptInstant: Date|null,
 * }}
 *   'past' and 'unparseable' → caller must NOT send adate/atime to LP.
 *   'beyond_window' → caller decides (SEND_APPT_WHEN_BEYOND_WINDOW).
 */
export function convertCanvassAppointment({ appt_date, appt_slot } = {}, now = new Date()) {
  const unparseable = { status: 'unparseable', adate: null, atime: null, hoursOut: null, apptInstant: null };

  const atime = normalizeApptSlot(appt_slot);
  const adate = normalizeApptDate(appt_date);
  if (!atime || !adate) return unparseable;

  const [m, d, y] = adate.split('/').map(Number);
  const { hour, minute } = SLOT_HOURS[atime];
  const apptInstant = etWallClockToInstant({ year: y, month: m, day: d, hour, minute });
  const hoursOut = (apptInstant.getTime() - now.getTime()) / 3600000;

  if (hoursOut < 0) {
    return { status: 'past', adate: null, atime: null, hoursOut, apptInstant };
  }

  // Whole-ET-calendar-day delta from today to the appointment day (UTC
  // anchors on the Y/M/D parts — DST-safe).
  const nowEt = etParts(now);
  const daysOut = Math.round(
    (Date.UTC(y, m - 1, d) - Date.UTC(nowEt.year, nowEt.month - 1, nowEt.day)) / 86400000
  );

  if (daysOut > APPT_WINDOW_DAYS) {
    const fridayDeadline = fridayExceptionDeadline(now);
    const withinFridayException =
      fridayDeadline !== null && apptInstant.getTime() <= fridayDeadline.getTime();
    if (!withinFridayException) {
      // Notify-not-block: adate/atime are still returned so the caller
      // can post the lead as Set and flag it.
      return { status: 'beyond_window', adate, atime, hoursOut, apptInstant };
    }
  }

  return { status: 'ok', adate, atime, hoursOut, apptInstant };
}
