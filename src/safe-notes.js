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
//
// v2 — Deterministic synthetic IDs for wrapped notes (no Math.random)
// v3 — Note enrichment: derives `type` from LP's `important` field
// v4 — REMOVED fake enteredon on string-wrapped notes. LP doesn't provide
//       a date for string notes, so we must not invent one. The GHL notes
//       formatter will omit the date line when created_at_lp is null.
//
// LP note record keys: id, enteredby, enteredon, updatedby, updatedon,
//                       important, category, note
// Missing from LP: rectype (no note type field), rep ID (only name)

/**
 * Generate a deterministic hash code from a string.
 * Used to create stable IDs for notes that lack real LP IDs.
 * Same input always produces the same output — no Math.random().
 *
 * @param {string} str - Input string
 * @returns {string} Hex hash string (8 chars)
 */
function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  // Convert to positive hex string, pad to 8 chars
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Enrich a note object with derived fields that LP doesn't provide natively.
 *
 * Derived fields:
 * - `type`: LP has no `rectype` field. Derived from `important` boolean.
 * - `rep_id`: LP notes have `enteredby` (name) but no rep ID.
 *
 * @param {Object} note - Note object (real LP or synthetic wrapped)
 * @returns {Object} Enriched note object (same reference, mutated)
 */
function enrichNote(note) {
  if (!note || typeof note !== 'object') return note;

  // Derive note_type from LP's `important` flag
  if (!note.type && !note.rectype && !note.RecType && !note.note_type) {
    if (note._source) {
      note.type = 'system';
    } else if (note.important === true || note.important === 'true' || note.important === 'True') {
      note.type = 'important';
    } else {
      note.type = 'standard';
    }
  }

  // Derive created_by_rep_id from enteredby (name) as proxy
  if (!note.rep_id && note.enteredby) {
    note.rep_id = note.enteredby;
  }

  return note;
}

/**
 * Safely extract notes from an LP API field, handling:
 * - null/undefined → []
 * - Array of objects → enriched with derived fields
 * - Array of strings → each wrapped as { note: str, id: deterministic }
 * - Plain string → wrapped as [{ note: str, id: deterministic }]
 * - Any other type → [] (skip silently)
 *
 * IMPORTANT: String-wrapped notes do NOT get a fake enteredon date.
 * LP doesn't provide a date for these — we must not invent one.
 * syncNotes() will store created_at_lp as null, and the GHL note
 * formatter will omit the date line.
 *
 * @param {*} raw - The raw value from getField(obj, 'notes', 'Notes')
 * @param {string} source - Label for logging (e.g., 'prospect', 'lead')
 * @returns {Array} Array of enriched note objects safe for syncNotes()
 */
export function safeNotes(raw, source = '') {
  if (raw === null || raw === undefined) return [];

  // Normal case: array of objects
  if (Array.isArray(raw)) {
    return raw
      .map((item, idx) => {
        if (item === null || item === undefined) return null;
        // String item in array → wrap as note object with deterministic ID
        if (typeof item === 'string') {
          if (item.length <= 1) return null; // Skip single chars (corrupted data)
          const syntheticId = `${source}-str-${hashCode(item)}-${idx}`;
          return enrichNote({
            note: item,
            id: syntheticId,
            // NO enteredon — LP doesn't provide a date for string notes
            _source: `${source}_array_string`,
          });
        }
        // Object item → enrich and return
        if (typeof item === 'object') return enrichNote(item);
        // Anything else → skip
        return null;
      })
      .filter(Boolean);
  }

  // String → wrap as single-item array with deterministic ID
  if (typeof raw === 'string') {
    if (raw.length <= 1) return []; // Skip single chars
    const syntheticId = `${source}-str-${hashCode(raw)}`;
    return [enrichNote({
      note: raw,
      id: syntheticId,
      // NO enteredon — LP doesn't provide a date for string notes
      _source: `${source}_string`,
    })];
  }

  // Anything else (number, boolean, etc.) → skip
  return [];
}

/**
 * Combine prospect-level and lead-level notes safely.
 *
 * @param {*} prospectNotes - Raw notes from prospect level
 * @param {*} leadNotes - Raw notes from lead level
 * @returns {Array} Combined array of enriched note objects
 */
export function combineNotes(prospectNotes, leadNotes) {
  return [
    ...safeNotes(prospectNotes, 'prospect'),
    ...safeNotes(leadNotes, 'lead'),
  ];
}
