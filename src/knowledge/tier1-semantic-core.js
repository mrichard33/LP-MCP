/**
 * Tier 1 Semantic — core — src/knowledge/tier1-semantic-core.js
 *
 * Pure helpers for the semantic Tier 1 lookups in kb-retriever.js v1.10.
 * Only import is node:crypto, so scripts/test-kb-faq-semantic.js runs with no
 * SUPABASE_URL / OPENAI_API_KEY. Runtime wiring lives in tier1-semantic.js.
 *
 * v1.0 — 2026-09-03. Initial.
 */

import { createHash } from 'node:crypto';

export const KB_FAQ_SEMANTIC_MODES = new Set(['off', 'shadow', 'live']);

/** off (default) | shadow (keyword answers, semantic logged) | live (semantic first). */
export function getKbFaqSemanticMode(env = process.env) {
  const m = String(env.KB_FAQ_SEMANTIC_MODE || 'off').toLowerCase().trim();
  return KB_FAQ_SEMANTIC_MODES.has(m) ? m : 'off';
}

/**
 * Text that gets embedded for one kb_faqs row: the question pattern plus the
 * first 240 chars of the short answer. The answer adds topical signal when the
 * pattern is terse ("hurricane rating / impact / wind") without letting a long
 * canonical_answer dominate the vector.
 */
export function buildFaqEmbedText(row = {}) {
  const pattern = String(row.question_pattern || '').trim();
  const answer = String(row.answer_short || row.canonical_answer || '').trim();
  return `${pattern}\n${answer.slice(0, 240)}`.trim();
}

/** Stable content hash — a row is re-embedded only when this changes. */
export function hashText(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 32);
}

/**
 * Memoised per-turn query embedder. Returns an async getter that calls
 * embedFn(text) at most once per turn (a failure clears the memo so a retry
 * within the same turn is possible). Empty text → getter resolves null and
 * never calls embedFn.
 */
export function makeQueryEmbedder(text, embedFn) {
  if (typeof embedFn !== 'function') throw new Error('makeQueryEmbedder requires embedFn');
  let pending = null;
  return async () => {
    if (!text || typeof text !== 'string' || !text.trim()) return null;
    if (!pending) {
      pending = Promise.resolve()
        .then(() => embedFn(text))
        .catch((err) => { pending = null; throw err; });
    }
    return pending;
  };
}

/**
 * Lead-voice descriptions of the six objection types in kb_objection_scripts.
 * Keys MUST equal kb_objection_scripts.objection_type values exactly.
 * These are embedded once per process and compared in memory — no table.
 */
export const OBJECTION_TYPE_DESCRIPTIONS = Object.freeze({
  price:      "It costs too much. I can't afford that right now. That's way over our budget. I'm looking for something cheaper. The price is too high for us.",
  timing:     "Not right now. Maybe next year. We're too busy at the moment. Call me back in a few months. It's a bad time — we just had a baby, there's a surgery coming up, there's a family emergency.",
  spouse:     "I need to talk to my husband first. My wife handles this kind of thing. Let me discuss it with my partner before we decide anything.",
  trust:      "I've been burned by contractors before. This sounds like a scam. I don't trust window companies. What are your reviews like? Are you on the BBB?",
  competitor: "I already got another quote. I'm comparing a few companies. I'm shopping around. Another company came out last week and gave me an estimate.",
  diy:        "I'll just do it myself. I'm pretty handy. I can install them on my own and save the labor.",
});

/**
 * Pick the best-scoring type at or above threshold. scores = { type: cosine }.
 * Returns { type, similarity } or null.
 */
export function pickObjectionType(scores, threshold) {
  let best = null;
  for (const [type, sim] of Object.entries(scores || {})) {
    if (typeof sim !== 'number' || Number.isNaN(sim)) continue;
    if (sim < threshold) continue;
    if (!best || sim > best.similarity) best = { type, similarity: sim };
  }
  return best;
}
