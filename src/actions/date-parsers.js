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
