// ─── LP Date Utilities — src/lp-dates.js ─────────────────────────
//
// LP API returns bare datetime strings in Eastern time (no timezone).
// PostgreSQL timestamptz columns assume UTC for bare strings, which
// silently shifts every LP timestamp 4-5 hours forward.
//
// This module provides helpers to tag LP dates with the correct
// timezone before writing to Supabase.
//
// EST hardcoded at -05:00 — at most 1hr off during EDT summer months,
// which is negligible for Reece's operational use cases (Day 15
// handoff, reporting, pipeline timing).

/**
 * Tag a bare LP datetime string with Eastern timezone offset.
 * Returns null for null/undefined input. Passes through strings
 * that already have timezone info (Z, +, -05, -04).
 *
 * @param {string|null} dateStr - Raw LP datetime string
 * @returns {string|null} - Datetime string with -05:00 suffix, or null
 */
export function lpDateToEastern(dateStr) {
  if (!dateStr) return null;
  if (typeof dateStr !== 'string') return dateStr;
  // Already has timezone info — return as-is
  if (dateStr.includes('+') || dateStr.endsWith('Z') || dateStr.includes('-05') || dateStr.includes('-04')) return dateStr;
  // Strip trailing whitespace and append EST offset
  return dateStr.trim() + '-05:00';
}

/**
 * Resolve the best available lead creation timestamp from LP data.
 * Prefers dateentered (lead-level, has actual time) over entrydate
 * (date-only, midnight-zeroed). Applies Eastern timezone.
 *
 * @param {object} prospect - LP prospect object (top level)
 * @param {object} lead - LP lead object (nested under prospect.leads[])
 * @param {function} getField - Case-insensitive field extractor
 * @returns {string|null} - Timestamptz-ready string with -05:00
 */
export function lpCreatedDate(prospect, lead, getField) {
  // Lead-level dateentered has actual time (e.g. "2025-04-16T17:00:07")
  const dateentered = getField(lead, 'dateentered', 'DateEntered');
  if (dateentered) return lpDateToEastern(dateentered);

  // Prospect-level dateadded also has time, but is per-prospect not per-lead
  // Use as secondary fallback for single-lead prospects
  const dateadded = getField(prospect, 'dateadded', 'DateAdded');
  if (dateadded) return lpDateToEastern(dateadded);

  // Last resort: lead entrydate (date-only, midnight-zeroed)
  return lpDateToEastern(getField(lead, 'entrydate', 'EntryDate'));
}
