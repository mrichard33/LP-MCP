// ─── LP Date Utilities — src/lp-dates.js ─────────────────────────
//
// LP API returns bare datetime strings in Eastern time (no timezone).
// PostgreSQL timestamptz columns assume UTC for bare strings, which
// silently shifts every LP timestamp 4-5 hours forward.
//
// This module provides helpers to tag LP dates with the correct
// timezone before writing to Supabase.
//
// Uses Node.js Intl API to detect EST vs EDT for each date, so
// timestamps are accurate year-round (no 1hr DST drift).

/**
 * Determine the correct Eastern offset (-05:00 or -04:00) for a given date.
 * Uses the Intl API which knows exact US DST boundaries.
 *
 * @param {Date} date - JavaScript Date object
 * @returns {string} - '-05:00' (EST) or '-04:00' (EDT)
 */
function getEasternOffset(date) {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      timeZoneName: 'longOffset',
    });
    const parts = formatter.formatToParts(date);
    const tzPart = parts.find(p => p.type === 'timeZoneName');
    if (tzPart?.value) {
      const match = tzPart.value.match(/GMT([+-]\d{2}:\d{2})/);
      if (match) return match[1];
    }
  } catch (_) {
    // Intl API unavailable or error — fall through to fallback
  }
  return '-05:00'; // safe fallback: EST
}

/**
 * Tag a bare LP datetime string with the correct Eastern timezone offset.
 * Detects EST vs EDT automatically for accurate year-round timestamps.
 * Returns null for null/undefined input. Passes through strings
 * that already have timezone info (Z, +, -05, -04).
 *
 * @param {string|null} dateStr - Raw LP datetime string
 * @returns {string|null} - Datetime string with correct offset, or null
 */
export function lpDateToEastern(dateStr) {
  if (!dateStr) return null;
  if (typeof dateStr !== 'string') return dateStr;
  // Already has timezone info — return as-is
  if (dateStr.includes('+') || dateStr.endsWith('Z') || dateStr.includes('-05') || dateStr.includes('-04')) return dateStr;

  const trimmed = dateStr.trim();

  // Parse the date to determine EST vs EDT
  // Append 'Z' so Date() treats the bare string as UTC for parsing only —
  // we just need the year/month/day to look up the DST boundary
  const parsed = new Date(trimmed + 'Z');
  if (isNaN(parsed.getTime())) {
    // Unparseable — append EST as safe fallback
    return trimmed + '-05:00';
  }

  const offset = getEasternOffset(parsed);
  return trimmed + offset;
}

/**
 * Resolve the best available lead creation timestamp from LP data.
 * Prefers dateentered (lead-level, has actual time) over entrydate
 * (date-only, midnight-zeroed). Applies correct Eastern timezone.
 *
 * @param {object} prospect - LP prospect object (top level)
 * @param {object} lead - LP lead object (nested under prospect.leads[])
 * @param {function} getField - Case-insensitive field extractor
 * @returns {string|null} - Timestamptz-ready string with correct offset
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
