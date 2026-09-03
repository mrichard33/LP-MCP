/**
 * Vector Gate — src/knowledge/vector-gate.js
 *
 * Pure decision helpers for the Tier 2 vector search in kb-retriever.js v1.9.
 * No imports on purpose: scripts/test-kb-vector-gate.js exercises this file
 * without needing SUPABASE_URL / OPENAI_API_KEY in the environment.
 *
 * v1.0 — 2026-09-02. Initial.
 */

export const KB_VECTOR_MODES = new Set(['off', 'shadow', 'live']);

/** off (default) | shadow (search + log, never injected) | live (injected). */
export function getKbVectorMode(env = process.env) {
  const m = String(env.KB_VECTOR_MODE || 'off').toLowerCase().trim();
  return KB_VECTOR_MODES.has(m) ? m : 'off';
}

// Which intents reach Tier 2, and on what condition.
//   'miss'   → only when the Tier 1 structured lookup came back empty
//   'always' → every turn of that intent
// Booking / callback / status / not-interested intents never run it: there is
// no knowledge question to answer and each search costs an OpenAI round-trip.
export const VECTOR_INTENT_POLICY = Object.freeze({
  QUESTION:  'miss',    // Tier 1 = kb_faqs
  OBJECTION: 'miss',    // Tier 1 = kb_objection_scripts
  PRICING:   'always',
  SEND_INFO: 'always',
  UNCLEAR:   'always',
});

export function shouldRunVectorSearch(intentClass, pack = {}) {
  const policy = VECTOR_INTENT_POLICY[intentClass];
  if (!policy) return false;
  if (policy === 'always') return true;
  if (intentClass === 'QUESTION')  return !Array.isArray(pack.faqs) || pack.faqs.length === 0;
  if (intentClass === 'OBJECTION') return !pack.objection_script;
  return false;
}

// Docs the deterministic belief-stack path (getConciergeBeliefDocs) already
// attaches VERBATIM on OBJECTION / PRICING. When that block is present, drop
// the same docs from vector results so nothing lands in the prompt twice.
export const BELIEF_STACK_DOCS = new Set([
  'reece_belief_stack',
  'reece_objection_playbook',
  'reece_pricing_policy',
]);

export function dedupeVectorMatches(matches, pack = {}) {
  if (!Array.isArray(matches)) return [];
  if (!pack || !pack.belief_stack) return matches;
  return matches.filter((m) => !BELIEF_STACK_DOCS.has(m.source_doc));
}
