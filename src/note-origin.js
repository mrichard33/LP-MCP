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
 *   'lp_revin'     written by Revin, LP's own texting bot — pushed like 'lp'
 *
 * WHY lp_revin (2026-09-25). Revin writes one ~160-character summary note per
 * SMS conversation into LP ("Agent, Revin": 69,671 notes, none a transcript).
 * The label lets the dashboard and reports tell Revin's texting apart from a
 * rep's note. The summaries STILL go to GHL (user ruling, 2026-09-25: "I want
 * the Revin notes summaries to still be going to GHL"), so lp_revin is NOT in
 * NEVER_PUSH_ORIGINS. Adding it there is the one-line switch if that changes.
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
export const NEVER_PUSH_ORIGINS = Object.freeze(['ghl_ai_brief']);
