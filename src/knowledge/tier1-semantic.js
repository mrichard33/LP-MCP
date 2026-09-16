/**
 * Tier 1 Semantic — runtime — src/knowledge/tier1-semantic.js
 *
 * Runtime half of the semantic Tier 1 lookups (kb-retriever.js v1.10):
 *   - matchFaqsSemantic()        → match_kb_faqs RPC (sql/077)
 *   - classifyObjectionSemantic() → six embedded type descriptions, cosine in memory
 *   - embedFaqsSweep()           → keeps kb_faqs.embedding fresh by content hash
 *   - startTier1EmbedSweep()     → boot (+30s) and every KB_FAQ_EMBED_INTERVAL_MS
 *   - logKbQuery()               → fire-and-forget row into kb_vector_queries
 *
 * Everything here degrades to "no semantic result" on error. Nothing throws
 * into the reply path except matchFaqsSemantic / classifyObjectionSemantic,
 * which kb-retriever wraps in withTimeout + try/catch.
 *
 * v1.0 — 2026-09-03. Initial.
 */

import supabase from '../supabase.js';
import { embed, embedBatch, cosineSimilarity } from './openai-embeddings.js';
import {
  buildFaqEmbedText,
  hashText,
  makeQueryEmbedder as makeMemoisedEmbedder,
  OBJECTION_TYPE_DESCRIPTIONS,
  pickObjectionType,
  getKbFaqSemanticMode,
} from './tier1-semantic-core.js';
import { matchCiMoments } from './ci-moments.js';
import { getKbCallMomentsMode, scoresFromMoments } from './ci-moments-core.js';

const KB_OBJECTION_FROM_CALLS = String(process.env.KB_OBJECTION_FROM_CALLS || 'true').toLowerCase() !== 'false';

const KB_FAQ_MIN_SIMILARITY       = parseFloat(process.env.KB_FAQ_MIN_SIMILARITY || '0.40');
const KB_OBJECTION_MIN_SIMILARITY = parseFloat(process.env.KB_OBJECTION_MIN_SIMILARITY || '0.30');
const KB_FAQ_EMBED_INTERVAL_MS    = parseInt(process.env.KB_FAQ_EMBED_INTERVAL_MS || '21600000', 10); // 6h

/**
 * Per-turn memoised embedder bound to the real OpenAI client.
 *
 * v1.13 — 2026-09-16. { fast: true }: the reply path gets one attempt and a
 * short timeout instead of the batch client's 3 retries / 20s. A retry inside
 * the 1500ms tier budget can never land, and the abandoned work kept running
 * (and retrying) for up to ~60s after the turn had given up on it.
 */
export function makeQueryEmbedder(messageText) {
  return makeMemoisedEmbedder(messageText, (t) => embed(t, { fast: true }));
}

// ── FAQ semantic match ─────────────────────────────────────────────

export async function matchFaqsSemantic(queryEmbedding, channel = 'sms', limit = 3, threshold = KB_FAQ_MIN_SIMILARITY) {
  if (!queryEmbedding || !Array.isArray(queryEmbedding.embedding)) return [];
  const { data, error } = await supabase.rpc('match_kb_faqs', {
    query_embedding: queryEmbedding.embedding,
    p_channel: channel,
    match_threshold: threshold,
    match_count: limit,
  });
  if (error) throw new Error(`match_kb_faqs: ${error.message}`);
  return data || [];
}

/**
 * v1.13 — 2026-09-16. Shadow runs probe at threshold 0 so the audit row records
 * how close a miss actually was. Before this, a miss wrote top_similarity=null,
 * which cannot tell "just under the floor at 0.39" from "nothing close at 0.05"
 * — so KB_FAQ_MIN_SIMILARITY could only ever be tuned by guessing. Live still
 * queries at the floor, so no extra rows cross the wire on the answering path.
 *
 * @returns {Promise<{matches: Array, top: number|null}>} matches = at/above the
 *   configured floor (the answer); top = true best similarity seen.
 */
export async function matchFaqsProbed(queryEmbedding, channel = 'sms', limit = 3, { probe = false } = {}) {
  const rows = await matchFaqsSemantic(queryEmbedding, channel, limit, probe ? 0 : KB_FAQ_MIN_SIMILARITY);
  const matches = probe ? rows.filter((r) => r.similarity >= KB_FAQ_MIN_SIMILARITY) : rows;
  const top = typeof rows[0]?.similarity === 'number' ? rows[0].similarity : null;
  return { matches, top };
}

// ── Objection type classifier (in memory) ──────────────────────────

let objectionVectorsPromise = null;

async function getObjectionTypeVectors() {
  if (!objectionVectorsPromise) {
    objectionVectorsPromise = (async () => {
      const types = Object.keys(OBJECTION_TYPE_DESCRIPTIONS);
      const { embeddings } = await embedBatch(types.map((t) => OBJECTION_TYPE_DESCRIPTIONS[t]));
      return types.map((type, i) => ({ type, embedding: embeddings[i] }));
    })().catch((err) => {
      objectionVectorsPromise = null; // let the next turn retry
      throw err;
    });
  }
  return objectionVectorsPromise;
}

/**
 * v1.13 — 2026-09-16. Warm the six type descriptions at boot. They were embedded
 * lazily, which put an embedBatch of six paragraph-length strings inside the
 * FIRST live OBJECTION turn after every deploy — a second, larger OpenAI call
 * sharing the same 1500ms budget as the query embed. Never throws: a failed warm
 * just leaves the memo clear and the next turn retries, exactly as before.
 */
export async function warmObjectionTypeVectors() {
  try {
    await getObjectionTypeVectors();
    console.log('[Tier1Semantic] objection type vectors warmed');
  } catch (err) {
    console.warn('[Tier1Semantic] objection vector warm failed (retried on first use):', err.message);
  }
}

/**
 * @returns {Promise<{pick: {type, similarity}|null, scores: Object}>}
 */
export async function classifyObjectionSemantic(queryEmbedding, threshold = KB_OBJECTION_MIN_SIMILARITY) {
  if (!queryEmbedding || !Array.isArray(queryEmbedding.embedding)) return { pick: null, scores: {} };

  // v1.12 — prefer nearest REAL objections from ci_moments over the six
  // hand-written descriptions, once the corpus can answer (≥3 neighbours at
  // 0.30). Only in live call-moments mode; any failure falls through.
  if (KB_OBJECTION_FROM_CALLS && getKbCallMomentsMode() === 'live') {
    try {
      const rows = await matchCiMoments(queryEmbedding, { kind: 'objection', wonOnly: false, limit: 8, threshold: 0.30 });
      const scores = scoresFromMoments(rows, 3);
      if (scores) return { pick: pickObjectionType(scores, threshold), scores, basis: 'ci_moments' };
    } catch (err) {
      console.warn('[Tier1Semantic] ci_moments objection lookup failed, using descriptions:', err.message);
    }
  }

  const vectors = await getObjectionTypeVectors();
  const scores = {};
  for (const v of vectors) scores[v.type] = cosineSimilarity(queryEmbedding.embedding, v.embedding);
  return { pick: pickObjectionType(scores, threshold), scores };
}

// ── Audit row ──────────────────────────────────────────────────────

/** Fire-and-forget insert into kb_vector_queries. Never throws. */
export function logKbQuery(row) {
  try {
    supabase
      .from('kb_vector_queries')
      .insert(row)
      .then(({ error }) => {
        if (error) console.warn('[Tier1Semantic] kb_vector_queries insert failed:', error.message);
      })
      .catch(() => {});
  } catch {
    // best-effort
  }
}

// ── Embedding sweep for kb_faqs ────────────────────────────────────

/**
 * Embed every active kb_faqs row whose content hash changed (or that has no
 * embedding yet). Idempotent; safe to run any time. Never throws.
 */
export async function embedFaqsSweep(reason = 'interval') {
  const started = Date.now();
  try {
    const { data, error } = await supabase
      .from('kb_faqs')
      .select('id, question_pattern, canonical_answer, answer_short, embedding_hash')
      .eq('active', true);
    if (error) {
      console.warn(`[Tier1Semantic] sweep(${reason}) select failed (sql/077 applied?):`, error.message);
      return { embedded: 0, skipped: 0, error: error.message };
    }

    const stale = (data || [])
      .map((r) => {
        const text = buildFaqEmbedText(r);
        return { id: r.id, text, hash: hashText(text), current: r.embedding_hash };
      })
      .filter((r) => r.text && r.hash !== r.current);

    if (stale.length === 0) {
      console.log(`[Tier1Semantic] sweep(${reason}): 0 stale of ${(data || []).length} active`);
      return { embedded: 0, skipped: (data || []).length };
    }

    const { embeddings, tokens, cost_usd } = await embedBatch(stale.map((r) => r.text));
    let embedded = 0;
    for (let i = 0; i < stale.length; i++) {
      const { error: upErr } = await supabase
        .from('kb_faqs')
        .update({
          embedding: embeddings[i],
          embedding_hash: stale[i].hash,
          embedded_at: new Date().toISOString(),
        })
        .eq('id', stale[i].id);
      if (upErr) console.warn(`[Tier1Semantic] sweep update id=${stale[i].id} failed:`, upErr.message);
      else embedded++;
    }
    console.log(
      `[Tier1Semantic] sweep(${reason}): embedded=${embedded}/${stale.length} tokens=${tokens}` +
      ` cost=$${cost_usd.toFixed(6)} ${Date.now() - started}ms`,
    );
    return { embedded, skipped: (data || []).length - stale.length, tokens, cost_usd };
  } catch (err) {
    console.warn(`[Tier1Semantic] sweep(${reason}) threw:`, err.message);
    return { embedded: 0, skipped: 0, error: err.message };
  }
}

/**
 * Boot hook. No-op when KB_FAQ_SEMANTIC_MODE=off — nothing is embedded until
 * the flag moves, so flipping to shadow is the single switch that populates
 * kb_faqs.embedding on the next boot.
 */
export function startTier1EmbedSweep() {
  if (getKbFaqSemanticMode() === 'off') {
    console.log('[Tier1Semantic] embed sweep disabled (KB_FAQ_SEMANTIC_MODE=off)');
    return null;
  }
  warmObjectionTypeVectors();
  const first = setTimeout(() => { embedFaqsSweep('boot'); }, 30_000);
  if (typeof first.unref === 'function') first.unref();
  const interval = setInterval(() => { embedFaqsSweep('interval'); }, KB_FAQ_EMBED_INTERVAL_MS);
  if (typeof interval.unref === 'function') interval.unref();
  console.log(`[Tier1Semantic] embed sweep scheduled: boot+30s, then every ${KB_FAQ_EMBED_INTERVAL_MS}ms`);
  return interval;
}
