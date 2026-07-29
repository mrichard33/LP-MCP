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
//   • "important" is encoded in the note TEXT (a "** IMPORTANT **" prefix) so
//     it is visible to the rep regardless of LP's category column. It is ALSO
//     mapped to a dedicated note CATEGORY (nct_id) when
//     GHL_NOTE_IMPORTANT_CATEGORY_ID is set, otherwise the standard category.
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
 * Compact, non-PII description of the AddNotes response shape, recorded when
 * no id could be extracted. 2026-07-29: lp_note_id was NULL on all 131 rows
 * written since the pipeline went live, and nothing captured WHY — so there
 * was no way to tell "LP returns no id" from "our extractor is wrong". This
 * closes that. Never includes the note body or any customer data.
 */
function describeRespShape(resp) {
  if (resp == null) return 'null';
  if (typeof resp !== 'object') return typeof resp;
  const keys = Object.keys(resp);
  if (keys.length === 0) return 'object{}';
  return `object{${keys.slice(0, 10).join(',')}}`;
}

/**
 * Write the note onto the prospect record.
 *
 * Returns a RECEIPT rather than a bare id. `confirmed` is the load-bearing
 * field: addNote() throws on a non-2xx (see withCircuit/lpPost in
 * src/lp-client.js), so reaching the return means LP accepted the write. That
 * is a genuine receipt even when `noteId` is null, and it is what distinguishes
 * "LP does not hand back an id" from "the write silently failed" — previously
 * indistinguishable, since both produced a NULL lp_note_id.
 *
 * @param {string|number} prospectId  LP cst_id (from resolveLPLeadId.prospectId)
 * @param {string} noteText           the rendered [GHL · AI BRIEF …] note
 * @param {boolean} important         landmine flag → important category
 * @returns {Promise<{noteId: string|null, confirmed: boolean, respShape: string|null}>}
 */
export async function writeLpNote(prospectId, noteText, important) {
  if (!prospectId) throw new Error('writeLpNote: prospectId is required');
  if (!noteText) throw new Error('writeLpNote: noteText is required');

  const categoryId = important && IMPORTANT_CATEGORY != null
    ? IMPORTANT_CATEGORY
    : STANDARD_CATEGORY;

  // Encode importance in the note text itself so it surfaces to the rep even
  // when LP's note category column isn't surfaced in their view.
  const notes = important ? `** IMPORTANT **\n${noteText}` : noteText;

  const resp = await addNote({
    rectype: 'cst',
    recid: prospectId,
    notes,
    categoryId,
  });

  const noteId = extractNoteId(resp);
  return {
    noteId,
    confirmed: true,                                  // addNote threw on failure
    respShape: noteId ? null : describeRespShape(resp),
  };
}
