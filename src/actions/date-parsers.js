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
