/**
 * Note origin classifier — src/note-origin.js
 *
 * Stamped onto lp_notes.note_origin once, at ingest (src/sync-children.js), so
 * the LP→GHL push filter (src/ghl-notes-sync.js) is a plain indexed equality.
 * Pure and dependency-free so it unit-tests without supabase.
 *
 *   'lp'           a person's note in Lead Perfection — push it to GHL
 *   'ghl_ai_brief' written INTO LP by the GHL note pipeline — never push back
 *                  (2026-07-29 echo-loop fix; see sql/050)
 *   'lp_revin'     written by Revin, LP's own texting bot — never push
 *
 * WHY lp_revin (2026-09-25). Revin writes one ~160-character summary note per
 * SMS conversation into LP ("Agent, Revin": 69,658 notes, none a transcript).
 * The push copied every one onto the GHL contact as "📋 LP Note", so the team
 * saw Revin's texting as a wall of LP notes instead of messages. Mark's call
 * (2026-09-24): show them as messages on the dashboard, stop copying them into
 * GHL, leave LP untouched. lp_notes keeps every row; only the push skips them.
 */

const AI_BRIEF = /^\[(?:GHL · )?AI BRIEF · /;
// LP stores reps as "Last, First" — Revin's agent account is "Agent, Revin".
const REVIN_REP = /^\s*agent,\s*revin\b/i;

/**
 * @param {string|null} body     note_body as stored
 * @param {string|null} repName  created_by_rep_name as stored
 * @returns {'lp'|'ghl_ai_brief'|'lp_revin'}
 */
export function noteOriginOf(body, repName = null) {
  // BOTH brief prefixes are matched on purpose: rows written before Task F
  // carry the legacy "[AI BRIEF", rows after carry "[GHL · AI BRIEF".
  // "** IMPORTANT **" is prepended by writeLpNote for landmine notes.
  const b = String(body || '').replace(/^\*\* IMPORTANT \*\*\s*/, '');
  if (AI_BRIEF.test(b)) return 'ghl_ai_brief';
  if (REVIN_REP.test(String(repName || ''))) return 'lp_revin';
  return 'lp';
}

/** note_origin values the LP→GHL push must never send. */
export const NEVER_PUSH_ORIGINS = Object.freeze(['ghl_ai_brief', 'lp_revin']);
