/**
 * Ask Lead Perfection whether a note we wrote is actually there
 * src/ci/lp-readback.js
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * /api/SalesApi/AddNotes answers every successful write with the bare string
 *
 *     "UPDATED SUCCESSFULLY!"
 *
 * — a constant. No id, no echo, no discriminator (proven and pinned by
 * scripts/test-ci-lp-note-id.js). So "addNote did not throw" is the ONLY signal
 * the write site has, and it is a weak one: it proves LP answered 2xx, not that
 * a note exists on a record a rep can read.
 *
 * On 2026-08-24 that gap cost four hours. 286 ci_syncs rows recorded `synced`
 * on nothing more than a non-throw, and when Mark could not find the notes
 * there was no way to tell a phantom write from a note filed somewhere he
 * wasn't looking. This module closes it: after the write, go and look.
 *
 * ── THE READ IS /api/Customers/GetLead ─────────────────────────────────────
 * GetNotes and GetLeadNotes both 404. GetLead does not: it returns the prospect
 * with `notes` at the TOP level and another `notes` array nested under each
 * inquiry in `leads[]`. That is exactly how src/sync-children.js:697 builds the
 * lp_notes mirror (combineNotes(prospect.notes, lead.notes)), so the shape is
 * long-established rather than assumed here.
 *
 * One read per PROSPECT covers every note on that person — prospect-attached
 * and lead-attached alike — which is why callers group by prospect rather than
 * reading once per note.
 *
 * ── WHICH SIDE THE NOTE LANDED ON IS THE POINT, NOT A DETAIL ───────────────
 * collectLpNotes tags every note `prospect` or `lead`, because "the note is in
 * LP" and "the note is where a rep will see it" are different facts and the
 * 2026-08-24 incident is precisely the gap between them. A caller that only
 * asked "found?" would have called that day a success.
 *
 * ── MATCHING IS BY OUR OWN MARKER, NEVER BY TIMESTAMP ──────────────────────
 * Every CI note ends with `[AI-CI:<shortId> | Five9 <id> | …]` (src/ci/notes.js).
 * That marker is minted by us, unique per call, and survives whatever LP does
 * to whitespace. The obvious alternative — correlate by time — is a trap: LP
 * returns `enteredon` as a NAIVE local Eastern string, while lpDateToEastern
 * (src/lp-dates.js:37-59) tags it '+00:00' as though it were UTC. Every
 * lp_notes.created_at_lp is therefore 4–5 hours early, and reading that column
 * as UTC is what made a healthy mirror look four hours stale during the
 * incident. Nothing here depends on an LP timestamp.
 */

import { getField, extractArray } from '../sync-utils.js';
import { shortId } from './notes.js';

/**
 * The needle: the provenance marker minted at the end of every CI note.
 *
 * Deliberately WITHOUT the trailing `| Five9 …` — the call id alone is unique,
 * and matching less of the line means a future edit to the provenance format
 * cannot silently turn every verification into "not found", which would read as
 * mass delivery failure.
 */
export function markerFor(callId) {
  const id = shortId(callId);
  return id ? `[AI-CI:${id}` : null;
}

/**
 * Flatten one GetLead prospect payload into every note it carries, each tagged
 * with the side it was attached to. Pure.
 *
 * @param {object} prospect  one record from the GetLead response
 * @returns {Array<{side:'prospect'|'lead', ldsId:string|null, lpNoteId:string|null,
 *                  body:string, enteredOn:string|null}>}
 */
export function collectLpNotes(prospect) {
  const out = [];
  const push = (note, side, ldsId) => {
    if (note == null) return;
    // LP returns note arrays that sometimes hold bare strings rather than
    // objects (see safeNotes in src/safe-notes.js). A bare string still carries
    // the marker, so it must not be skipped for lacking an id.
    const body = typeof note === 'string'
      ? note
      : getField(note, 'note', 'notes', 'Notes', 'body', 'text', 'NoteBody', 'content');
    if (!body) return;
    out.push({
      side,
      ldsId: ldsId != null ? String(ldsId) : null,
      lpNoteId: typeof note === 'string' ? null : (getField(note, 'id', 'note_id', 'NoteID') ?? null),
      body: String(body),
      enteredOn: typeof note === 'string' ? null : (getField(note, 'enteredon', 'EnteredOn', 'date', 'Date') ?? null),
    });
  };

  const prospectNotes = getField(prospect, 'notes', 'Notes');
  for (const n of (Array.isArray(prospectNotes) ? prospectNotes : [])) push(n, 'prospect', null);

  const leads = getField(prospect, 'leads', 'Leads');
  for (const lead of (Array.isArray(leads) ? leads : [])) {
    const ldsId = getField(lead, 'id', 'lds_id', 'LeadID');
    const leadNotes = getField(lead, 'notes', 'Notes');
    for (const n of (Array.isArray(leadNotes) ? leadNotes : [])) push(n, 'lead', ldsId);
  }

  return out;
}

/**
 * Is this call's note present on this prospect, and where? Pure.
 *
 * `found: false` means "this payload does not contain it" — it does NOT mean
 * "LP does not have it". Only a caller that knows the read SUCCEEDED may draw
 * that second conclusion, which is why the read failure path is kept strictly
 * separate in every consumer of this module.
 *
 * @returns {{found: boolean, side: string|null, ldsId: string|null,
 *            lpNoteId: string|null, copies: number}}
 */
export function findCiNote(prospect, callId) {
  const marker = markerFor(callId);
  const miss = { found: false, side: null, ldsId: null, lpNoteId: null, copies: 0 };
  if (!marker) return miss;

  const hits = collectLpNotes(prospect).filter((n) => n.body.includes(marker));
  if (!hits.length) return miss;

  // A prospect-side hit wins the report when both exist: that is the copy a rep
  // actually reads, and `copies` still says there was more than one.
  const best = hits.find((h) => h.side === 'prospect') || hits[0];
  return {
    found: true,
    side: best.side,
    ldsId: best.ldsId,
    lpNoteId: best.lpNoteId != null ? String(best.lpNoteId) : null,
    copies: hits.length,
  };
}

/**
 * Read one prospect from LP and hand back its record.
 *
 * Distinguishes THREE outcomes on purpose, because collapsing them is the bug
 * this module exists to prevent:
 *
 *   ok: true,  prospect: {...}   the record was read
 *   ok: true,  prospect: null    LP has no such prospect — a real absence
 *   ok: false, error: '…'        we could not ask. UNKNOWN, never "absent"
 *
 * A caller that treats the third as the second releases an idempotency key on a
 * note that may have landed, and the retry double-posts onto a customer record.
 *
 * @param {number|string} cstId
 * @param {{ lpReader?: (cstId:any) => Promise<any> }} [deps]
 */
export async function readProspect(cstId, { lpReader } = {}) {
  if (cstId == null || cstId === '') return { ok: false, prospect: null, error: 'no prospect id' };
  if (typeof lpReader !== 'function') return { ok: false, prospect: null, error: 'no LP reader injected' };
  try {
    const resp = await lpReader(cstId);
    const rows = extractArray(resp);
    return { ok: true, prospect: rows[0] ?? null, error: null };
  } catch (err) {
    return { ok: false, prospect: null, error: err?.message || String(err) };
  }
}

export default { markerFor, collectLpNotes, findCiNote, readProspect };
