/**
 * Date Parsers — src/actions/date-parsers.js
 *
 * Appointment date parsing utilities used by LP appointment handler.
 * LP accepts MM/DD/YYYY form-encoded; GHL sends ISO-8601. These functions
 * bridge the two formats. Extracted from action-executor.js v4.2 refactor.
 */

import { MONTH_MAP } from './constants.js';

/**
 * Parse long-form dates like "April 25, 2026" → "04/25/2026".
 * Returns null for unparseable inputs.
 */
export function parseLongDate(dateStr) {
  if (!dateStr) return null;
  const match = String(dateStr).trim().match(/^(\w+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (!match) return null;
  const month = MONTH_MAP[match[1].toLowerCase()];
  if (!month) return null;
  const day = String(match[2]).padStart(2, '0');
  return `${month}/${day}/${match[3]}`;
}

/**
 * Convert a resolved appointment date into LP's required MM/DD/YYYY form.
 * Accepts ISO (YYYY-MM-DD, optionally with a "Thh:mm…" suffix), US
 * (M/D/YYYY → zero-padded), and long form ("April 25, 2026").
 *
 * Returns null when the input does not normalize to a valid MM/DD/YYYY.
 * Callers throw on null so an unresolved/garbage merge value (e.g. an
 * empty token or a stale step-output index) fails loud — labeled in
 * agent_actions.error_message — instead of being POSTed to LP's
 * SetAppointment as an opaque 400.
 */
export function toLpApptDate(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;

  let out = null;
  // ISO 8601: YYYY-MM-DD (drop any "T..." time suffix).
  const iso = s.split('T')[0].match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    out = `${iso[2]}/${iso[3]}/${iso[1]}`;
  } else {
    // US M/D/YYYY — pad single-digit month/day.
    const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (us) {
      out = `${String(us[1]).padStart(2, '0')}/${String(us[2]).padStart(2, '0')}/${us[3]}`;
    } else {
      out = parseLongDate(s); // "April 25, 2026" → "04/25/2026" or null
    }
  }

  // Final shape + range guard: MM/DD/YYYY with month 01–12, day 01–31.
  const m = out && out.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const mo = Number(m[1]), day = Number(m[2]);
  if (mo < 1 || mo > 12 || day < 1 || day > 31) return null;
  return out;
}

/**
 * Convert a resolved appointment time into LP's required 24-hour HH:MM.
 * Accepts "h:mm AM/PM" (12-hour), "HH:MM[:SS]" (24-hour; seconds dropped),
 * and "h:mm" (zero-padded). Returns null when the input does not normalize
 * to a valid HH:MM in 00:00–23:59 — callers throw on null (same rationale
 * as toLpApptDate).
 */
export function toLpApptTime(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;

  let h, min;
  const m12 = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (m12) {
    h = parseInt(m12[1], 10);
    min = m12[2];
    const p = m12[3].toUpperCase();
    if (p === 'AM' && h === 12) h = 0;
    if (p === 'PM' && h !== 12) h += 12;
  } else {
    const m24 = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (!m24) return null;
    h = parseInt(m24[1], 10);
    min = m24[2];
  }

  if (!Number.isInteger(h) || h < 0 || h > 23) return null;
  const mins = parseInt(min, 10);
  if (!Number.isInteger(mins) || mins < 0 || mins > 59) return null;
  return `${String(h).padStart(2, '0')}:${min}`;
}

/**
 * Normalize any date string to YYYY-MM-DD for equality comparison.
 * Accepts: ISO (2026-04-25...), US (04/25/2026), long form (April 25, 2026).
 * Returns null for unparseable inputs.
 */
export function normalizeDateForComparison(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  if (s.match(/^\d{4}-\d{2}-\d{2}/)) return s.slice(0, 10);
  const usMatch = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (usMatch) return `${usMatch[3]}-${usMatch[1]}-${usMatch[2]}`;
  const longParsed = parseLongDate(s);
  if (longParsed) {
    const [m, d, y] = longParsed.split('/');
    return `${y}-${m}-${d}`;
  }
  return null;
}

/**
 * Parse LP's `apptdate` into comparable wall-clock parts.
 *
 * LP returns this field in several shapes across endpoints and eras:
 *   "2026-08-07T18:00:00", "2026-08-07 18:00:00", "8/7/2026 6:00:00 PM",
 *   and occasionally a bare "2026-08-07" with no time at all.
 *
 * It is LOCAL WALL CLOCK, not UTC — do not hand it to Date.parse. Verified
 * live 2026-07-31 against /api/Customers/GetLead: apptdate comes back as
 * "2026-09-27T18:00:00" with no offset and no Z. src/appointment-dates.js says
 * the same of the value once it lands in lp_leads ("ET WALL-CLOCK digits
 * mislabeled as UTC"), and casting it shifts by 4-5 hours. String comparison
 * of the normalized parts avoids the whole class of bug.
 *
 * @returns {{date: string, time: string|null, timeStatus: 'known'|'absent'|'unparseable'}|null}
 *   null when no date parses at all. date is YYYY-MM-DD. time is HH:MM
 *   24-hour when timeStatus === 'known', otherwise null:
 *     'absent'      — LP carried no time, or exact midnight (see below)
 *     'unparseable' — LP carried something we could not read; the caller
 *                     writes anyway and logs, so a future LP format change
 *                     surfaces as a bug instead of silent suppression.
 */
export function parseLpApptWallClock(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;

  const [datePart, ...rest] = s.split(/[T\s]+/);
  // toLpApptDate first: normalizeDateForComparison's US branch requires a
  // TWO-digit month and day, so it returns null on LP's "8/7/2026". Composing
  // through toLpApptDate pads that to "08/07/2026" and also absorbs ISO and
  // long form, passing null straight through for garbage.
  const date = normalizeDateForComparison(toLpApptDate(datePart));
  if (!date) return null;

  // Strip fractional seconds and a trailing Z — LP emits ".373" on sibling
  // timestamps (dateadded, setdate), and toLpApptTime rejects both.
  // toLpApptTime's 12-hour branch also does not accept seconds ("6:00:00 PM"),
  // so drop them before the AM/PM marker; its 24-hour branch tolerates them.
  const timeRaw = rest.join(' ').trim()
    .replace(/\.\d+/, '')
    .replace(/Z$/i, '')
    .replace(/^(\d{1,2}:\d{2}):\d{2}(\s*[AP]M)$/i, '$1$2')
    .trim();

  if (!timeRaw) return { date, time: null, timeStatus: 'absent' };

  const time = toLpApptTime(timeRaw);
  if (!time) return { date, time: null, timeStatus: 'unparseable' };

  // Exact midnight is LP's "date known, time unknown", not a real 12:00 AM
  // appointment — 15,890 of 128,766 appointment rows carry it (2026-07-31).
  // Same rule lpWallClockToGhlStartTime applies in appointment-dates.js;
  // encoding it once more here rather than inventing a second one.
  if (time === '00:00') return { date, time: null, timeStatus: 'absent' };

  return { date, time, timeStatus: 'known' };
}
