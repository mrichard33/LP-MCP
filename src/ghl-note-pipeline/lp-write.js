// ─── LP note write — src/ghl-note-pipeline/lp-write.js ───────────
//
// Writes the summarized GHL conversation note into Lead Perfection via the
// existing addNote() wrapper (POST /api/SalesApi/AddNotes, src/lp-client.js).
//
// The AddNotes API accepts only { rectype, recid, notes, nct_id }. It has no
// `rep_id` or `important` boolean — those are read-only fields in LP's note
// model. So:
//   • The AI-brief identity lives in the note TEXT header ("[AI BRIEF …]"),
//     produced by the summarizer.
//   • "important" is mapped to a dedicated LP note CATEGORY (nct_id) via
//     GHL_NOTE_IMPORTANT_CATEGORY_ID, falling back to the standard category
//     when no important category is configured.
//   • Notes attach to the PROSPECT record (rectype 'cst', recid = prospectId).

import { addNote } from '../lp-client.js';

const STANDARD_CATEGORY = parseInt(process.env.GHL_NOTE_CATEGORY_ID || '1', 10);
const IMPORTANT_CATEGORY = process.env.GHL_NOTE_IMPORTANT_CATEGORY_ID
  ? parseInt(process.env.GHL_NOTE_IMPORTANT_CATEGORY_ID, 10)
  : null;

/**
 * Best-effort extraction of the new note id from the AddNotes response, which
 * (like AddLead) may be a structured object or a legacy "...: <id>" message.
 */
function extractNoteId(resp) {
  if (!resp) return null;
  if (resp.note_id) return String(resp.note_id);
  if (resp.noteId) return String(resp.noteId);
  if (resp.id) return String(resp.id);
  const msg = String(resp.message || '');
  const match = msg.match(/(\d+)\s*$/);
  return match ? match[1] : null;
}

/**
 * Write the note onto the prospect record.
 * @param {string|number} prospectId  LP cst_id (from resolveLPLeadId.prospectId)
 * @param {string} noteText           the rendered [AI BRIEF …] note
 * @param {boolean} important         landmine flag → important category
 * @returns {Promise<string|null>}    the new LP note id, or null if unparseable
 */
export async function writeLpNote(prospectId, noteText, important) {
  if (!prospectId) throw new Error('writeLpNote: prospectId is required');
  if (!noteText) throw new Error('writeLpNote: noteText is required');

  const categoryId = important && IMPORTANT_CATEGORY != null
    ? IMPORTANT_CATEGORY
    : STANDARD_CATEGORY;

  const resp = await addNote({
    rectype: 'cst',
    recid: prospectId,
    notes: noteText,
    categoryId,
  });

  return extractNoteId(resp);
}
