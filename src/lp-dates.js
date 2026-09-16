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
 * Earliest year an LP appointment date can plausibly carry.
 *
 * LP is a Delphi application, and Delphi's TDateTime zero is 1899-12-30. When a
 * lead has an appointment TIME but no appointment DATE, LP serialises the time
 * onto that zero date and returns it as a normal-looking timestamp:
 * "1900-01-01T14:00:00" is LP saying "2:00 PM, date unknown" — not an
 * appointment in 1900.
 */
const LP_APPT_MIN_YEAR = 2000;

/**
 * An LP `apptdate` with the date actually filled in, or null.
 *
 * WHY (2026-09-16): lead 575791 mirrored `appointment_date = 1900-01-01T14:00`
 * straight from LP. We did not corrupt it — the raw payload contains that
 * verbatim, and one sibling row carries the literal Delphi zero
 * `1899-12-30T11:00:00`. 71 of 134,257 dated leads are affected, still accruing
 * a few a month since 2026-03-20.
 *
 * Storing the sentinel is worse than storing nothing: a 1900 date reads as a
 * real appointment to anything that does not special-case it, and
 * response-generator renders it into customer-facing model context. Returning
 * null says what LP actually means — the date is unknown.
 *
 * `appointment_set` is deliberately NOT inferred from this. LP is still
 * asserting the appointment exists; only the date is missing, and callers that
 * care about existence read the boolean.
 *
 * A few affected rows carry plausible-looking but wrong years (1971, 1983,
 * 1988) that look like human typos in LP rather than the zero date. The same
 * floor catches those, which is why this is a year floor and not an equality
 * check against the Delphi epoch.
 */
export function sanitizeLpApptDate(dateStr) {
  const tagged = lpDateToEastern(dateStr);
  if (!tagged) return null;
  const ms = Date.parse(tagged);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).getUTCFullYear() < LP_APPT_MIN_YEAR ? null : tagged;
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

// ═══════════════════════════════════════════════════════════════════
// READ SIDE — 2026-09-03
//
// The March 25 note above is wrong for the fields feeding created_at_lp.
// Measured 2026-09-03 on rows synced minutes after creation:
//   lp_leads  max(synced_at) - max(created_at_lp) = 4.54 h
//   lp_notes  same shape                          = 4.03 h
// and LP leads 572927/572928/572929 (contact eqjK58AwEZ1juYJH6szE) are
// stored 19:57:45+00:00 while their own lp.disposition_changed events fired
// at 23:59:48Z, two minutes after real creation. src/ci/lp-readback.js:43 and
// scripts/test-ci-verify-lp.js:84 already say the same thing about lp_notes.
//
// So a stored value is ET WALL-CLOCK WEARING A +00:00 OFFSET, and comparing
// it to a true-UTC Date.now() reads every row as ~4 h older than it is.
//
// THE WRITE PATH DOES NOT CHANGE. Re-tagging lpDateToEastern() with -04:00
// would give new rows different semantics from ~228k existing ones with no
// marker separating the two eras, and would collide with
// lpWallClockToGhlStartTime()'s normalization of appointment_date. Callers
// that need real elapsed time convert on READ, here.
//
// Use this ONLY for columns written through lpDateToEastern(): lp_leads and
// lp_notes created_at_lp/updated_at_lp, lp_call_logs.call_date,
// lp_activities.activity_date, lp_jobs.created_at_lp, and — added 2026-09-04
// — lp_leads appointment_date / demo_date / set_date / confirmed_date. Do NOT
// use it on synced_at, or on any system_events / agent_actions column — those
// are written by this service and are already true UTC.
//
// THE APPOINTMENT COLUMNS, ADDED 2026-09-04. They were left off this list
// because lpWallClockToGhlStartTime() already re-stamps appointment_date at
// the GHL claim boundary. That covers every site that BUILDS a GHL appointment
// and no site that COMPARES the column to now(). duplicate-lead-guard.js did
// the latter — .gte('appointment_date', new Date().toISOString()) — putting a
// true-UTC bound against an ET-wall-clock column, so a 6:00 PM ET appointment
// read as past from 2:00 PM ET and the guard stopped protecting a booked
// customer four hours before their appointment (contact zLDD7V1eosF8vldF5U7i,
// lead 459770, 2026-09-04).
//
// The two mechanisms must never both be active on one value. The split is by
// DIRECTION, not by column: utcToLpStoredIso() converts a BOUND into the
// stored frame for comparison; lpWallClockToGhlStartTime() converts a stored
// VALUE out of it for GHL. Neither touches what the other reads, and no stored
// row changes, so nothing double-corrects. Do not "simplify" this by
// converting the column instead of the bound — that also drops index
// eligibility on every one of these queries.
// ═══════════════════════════════════════════════════════════════════

/** Offset in ms between UTC and a named zone at a given instant. */
function zoneOffsetMs(atMs, timeZone) {
  const d = new Date(atMs);
  const asUtc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  const asZone = new Date(d.toLocaleString('en-US', { timeZone }));
  return asUtc.getTime() - asZone.getTime();
}

/**
 * Convert a stored LP timestamp (ET wall-clock tagged +00:00) to true UTC ms.
 *
 * Two passes: the offset is looked up at the naive instant, then re-looked-up
 * at the corrected instant. Within four hours of a DST transition those two
 * differ, and the second answer is the right one. Exactly on the spring-forward
 * gap the wall-clock time does not exist; we take the later offset, which is
 * the same convention Postgres AT TIME ZONE uses.
 *
 * @param {string|Date|null} stored
 * @returns {number|null} epoch ms in true UTC, or null if unparseable
 */
export function lpStoredToUtcMs(stored) {
  if (!stored) return null;
  const naiveMs = stored instanceof Date ? stored.getTime() : Date.parse(stored);
  if (!Number.isFinite(naiveMs)) return null;
  const firstPass = naiveMs + zoneOffsetMs(naiveMs, 'America/New_York');
  return naiveMs + zoneOffsetMs(firstPass, 'America/New_York');
}

/**
 * Age in minutes of a stored LP timestamp, measured against true now.
 * Returns null when unparseable so callers can distinguish "no data" from
 * "zero minutes old" — a freshness monitor must never read those the same way.
 */
export function lpStoredAgeMinutes(stored, nowMs = Date.now()) {
  const utcMs = lpStoredToUtcMs(stored);
  if (utcMs == null) return null;
  return Math.round((nowMs - utcMs) / 60000);
}

/** ISO string in true UTC, for logging and for building query bounds. */
export function lpStoredToUtcIso(stored) {
  const ms = lpStoredToUtcMs(stored);
  return ms == null ? null : new Date(ms).toISOString();
}

/**
 * The inverse: a true-UTC instant expressed in the stored (ET wall-clock,
 * +00:00-tagged) form, for building .gte/.lte bounds against these columns
 * without converting every row. Prefer this over converting the column when
 * the query must stay index-eligible.
 */
export function utcToLpStoredIso(atMs = Date.now()) {
  const shifted = atMs - zoneOffsetMs(atMs, 'America/New_York');
  return new Date(shifted).toISOString().replace('Z', '+00:00');
}
