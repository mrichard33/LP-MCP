// ─── Safe Notes Extraction — src/safe-notes.js ───────────────────
//
// Bug Fix: LP API sometimes returns notes as a STRING instead of an
// array of objects. When JavaScript spreads a string [..."Hello"],
// it produces ['H','e','l','l','o'] — five "notes" each being a
// single character. This created 1.75M junk rows in lp_notes with:
//   - Math.random()-generated IDs (no real note ID found on a char)
//   - null note_body (getField('H', 'note', 'Notes', ...) = null)
//   - single-character raw_lp_data that corrupts JSONB columns
//
// This module provides a safe extraction function used everywhere
// notes are assembled from LP API responses.

/**
 * Safely extract notes from an LP API field, handling:
 * - null/undefined → []
 * - Array of objects → returned as-is (normal case)
 * - Array of strings → each wrapped as { note: str }
 * - Plain string → wrapped as [{ note: str }]
 * - Any other type → [] (skip silently)
 *
 * @param {*} raw - The raw value from getField(obj, 'notes', 'Notes')
 * @param {string} source - Label for logging (e.g., 'prospect', 'lead')
 * @returns {Array} Array of note objects safe for syncNotes()
 */
export function safeNotes(raw, source = '') {
  if (raw === null || raw === undefined) return [];

  // Normal case: array of objects
  if (Array.isArray(raw)) {
    return raw
      .map(item => {
        if (item === null || item === undefined) return null;
        // String item in array → wrap as note object
        if (typeof item === 'string') {
          if (item.length <= 1) return null; // Skip single chars (corrupted data)
          return { note: item, _source: `${source}_array_string` };
        }
        // Object item → return as-is (this is the expected format)
        if (typeof item === 'object') return item;
        // Anything else → skip
        return null;
      })
      .filter(Boolean);
  }

  // String → wrap as single-item array
  if (typeof raw === 'string') {
    if (raw.length <= 1) return []; // Skip single chars
    return [{ note: raw, _source: `${source}_string` }];
  }

  // Anything else (number, boolean, etc.) → skip
  return [];
}

/**
 * Combine prospect-level and lead-level notes safely.
 * Replaces the buggy pattern:
 *   [...(getField(prospect, 'notes') || []), ...(getField(lead, 'notes') || [])]
 *
 * @param {*} prospectNotes - Raw notes from prospect level
 * @param {*} leadNotes - Raw notes from lead level
 * @returns {Array} Combined array of note objects
 */
export function combineNotes(prospectNotes, leadNotes) {
  return [
    ...safeNotes(prospectNotes, 'prospect'),
    ...safeNotes(leadNotes, 'lead'),
  ];
}
