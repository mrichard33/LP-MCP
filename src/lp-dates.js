// ─── LP Date Utilities — src/lp-dates.js ─────────────────────────
//
// CORRECTED March 25, 2026:
// LP API returns bare datetime strings in UTC (no timezone marker).
// Previous code incorrectly assumed Eastern and appended -04:00/-05:00,
// which double-shifted every timestamp by 4-5 hours.
//
// Evidence: Canvassing Contact Created workflow has a "Subtract 5 Hours"
// step that manually converts LP time to ET — proving LP sends UTC.
// Appointment hour distribution confirmed: raw hour 20 (8 PM UTC)
// = 4 PM ET (valid appointment time), but was stored as 8 PM ET.
//
// Fix: All bare LP datetime strings are now tagged as UTC (+00:00).
// Supabase timestamptz stores everything in UTC natively.
// Query with AT TIME ZONE 'America/New_York' for Eastern display.
//
// Function name kept as lpDateToEastern() to avoid breaking imports
// across sync-leads.js, sync-children.js, full-sync-pass1.js, etc.
// The function now correctly interprets LP input as UTC.

/**
 * Tag a bare LP datetime string as UTC.
 *
 * LP API returns bare datetime strings with no timezone indicator.
 * These are in UTC. This function appends '+00:00' so PostgreSQL
 * timestamptz columns store them correctly.
 *
 * Returns null for null/undefined input. Passes through strings
 * that already have timezone info (Z, +00, -05, -04, etc).
 *
 * NOTE: Function name is lpDateToEastern for backward compatibility
 * with all existing imports. It correctly tags input as UTC.
 *
 * @param {string|null} dateStr - Raw LP datetime string (UTC, bare)
 * @returns {string|null} - Datetime string with +00:00 offset, or null
 */
export function lpDateToEastern(dateStr) {
  if (!dateStr) return null;
  if (typeof dateStr !== 'string') return dateStr;

  const trimmed = dateStr.trim();

  // Already has timezone info — return as-is
  if (trimmed.endsWith('Z')) return trimmed;
  if (trimmed.includes('+')) return trimmed;
  // Check for offset patterns like -04:00 or -05:00 (but not date hyphens)
  // Only match offset at the end of the string: T...HH:MM:SS-04:00
  if (/[+-]\d{2}:\d{2}$/.test(trimmed)) return trimmed;

  // Validate it's a parseable date before tagging
  const parsed = new Date(trimmed + 'Z');
  if (isNaN(parsed.getTime())) {
    // Unparseable — append UTC as safe fallback
    return trimmed + '+00:00';
  }

  // LP sends UTC — tag it as UTC
  return trimmed + '+00:00';
}

/**
 * Resolve the best available lead creation timestamp from LP data.
 * Prefers dateentered (lead-level, has actual time) over entrydate
 * (date-only, midnight-zeroed). Tags as UTC.
 *
 * @param {object} prospect - LP prospect object (top level)
 * @param {object} lead - LP lead object (nested under prospect.leads[])
 * @param {function} getField - Case-insensitive field extractor
 * @returns {string|null} - Timestamptz-ready string with UTC offset
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
