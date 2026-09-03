/**
 * Vector Search — src/knowledge/vector-search.js
 *
 * Thin wrapper around the match_kb_embeddings(...) Supabase RPC.
 * Used by:
 *   - src/knowledge/kb-retriever.js v1.9 — Tier 2, gated by KB_VECTOR_MODE
 *     (first real caller; from 2026-04 to 2026-09 nothing imported this file)
 *   - NOT used as an LLM tool call from response-generator.js — that was
 *     planned in v1.0 and never built.
 *
 * Flow:
 *   1. Caller passes a query string + optional filters
 *   2. We embed the query via openai-embeddings.js
 *   3. We invoke match_kb_embeddings RPC with the embedding
 *   4. Return ranked chunks with similarity scores
 *
 * v1.2 — 2026-09-03. opts.queryEmbedding: reuse a precomputed query embedding.
 * v1.1 — 2026-09-02. Default threshold 0.7 → 0.35. text-embedding-3-small
 *   cosine similarities run low: a relevant ~500-token chunk against a short
 *   SMS question typically lands 0.35–0.60, unrelated text 0.10–0.30. At 0.7
 *   the tier would return nothing on real traffic. Calibrate from
 *   kb_vector_queries.top_similarity after a shadow run.
 * v1.0 — Initial implementation.
 */

import supabase from '../supabase.js';
import { embed } from './openai-embeddings.js';

const DEFAULT_THRESHOLD = parseFloat(process.env.KB_VECTOR_MIN_SIMILARITY || '0.35');
const DEFAULT_MATCH_COUNT = parseInt(process.env.KB_VECTOR_MATCH_COUNT || '5', 10);

/**
 * Search the KB via vector similarity.
 *
 * @param {string} query — Natural-language query
 * @param {Object} opts
 * @param {number} [opts.threshold=0.7] — Min cosine similarity to return
 * @param {number} [opts.limit=5] — Max results
 * @param {string} [opts.sourceDoc] — Filter to a specific source doc
 * @param {Object} [opts.metadata] — JSONB filter (e.g. { story_arc: 'SA1' })
 * @returns {Promise<{matches: Array, query_tokens: number, query_cost_usd: number}>}
 */
export async function searchKnowledge(query, opts = {}) {
  if (!query || typeof query !== 'string') {
    throw new Error('searchKnowledge() requires non-empty query string');
  }

  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const limit = opts.limit ?? DEFAULT_MATCH_COUNT;
  const sourceDoc = opts.sourceDoc || null;
  const metadata = opts.metadata || null;

  // 1. Embed the query — or reuse one the caller already computed (v1.2:
  //    kb-retriever shares a single per-turn embedding across Tier 1 + Tier 2)
  let queryResult;
  try {
    queryResult = (opts.queryEmbedding && Array.isArray(opts.queryEmbedding.embedding))
      ? opts.queryEmbedding
      : await embed(query);
  } catch (err) {
    console.error('[VectorSearch] Embed failed:', err.message);
    return { matches: [], query_tokens: 0, query_cost_usd: 0, error: err.message };
  }

  // 2. RPC call to Supabase
  const { data, error } = await supabase.rpc('match_kb_embeddings', {
    query_embedding: queryResult.embedding,
    match_threshold: threshold,
    match_count: limit,
    filter_source_doc: sourceDoc,
    filter_metadata: metadata,
  });

  if (error) {
    console.error('[VectorSearch] RPC error:', error.message);
    return {
      matches: [],
      query_tokens: queryResult.tokens,
      query_cost_usd: queryResult.cost_usd,
      error: error.message,
    };
  }

  return {
    matches: data || [],
    query_tokens: queryResult.tokens,
    query_cost_usd: queryResult.cost_usd,
  };
}

/**
 * Convenience: format vector matches as a plain-text block suitable
 * for injection into an LLM prompt.
 *
 * @param {Array} matches — output of searchKnowledge().matches
 * @param {Object} [opts]
 * @param {number} [opts.maxChars=2000] — total budget across all chunks
 * @returns {string} formatted block (empty string if no matches)
 */
export function formatMatchesForPrompt(matches, opts = {}) {
  if (!Array.isArray(matches) || matches.length === 0) return '';
  const maxChars = opts.maxChars || 2000;

  const lines = ['KNOWLEDGE BASE EXCERPTS (background context only — see note below):'];
  let used = lines[0].length;

  for (const m of matches) {
    const sim = (m.similarity || 0).toFixed(2);
    const src = m.source_doc + (m.source_section ? ` § ${m.source_section}` : '');
    const header = `\n[${src} | sim ${sim}]`;
    const body = m.chunk_text || '';
    const piece = `${header}\n${body}`;
    if (used + piece.length > maxChars) {
      // Truncate the last piece
      const remaining = maxChars - used - header.length - 6;
      if (remaining > 100) {
        lines.push(`${header}\n${body.slice(0, remaining)}…`);
      }
      break;
    }
    lines.push(piece);
    used += piece.length;
  }

  return lines.join('\n');
}

/**
 * Convenience: search and format in one call.
 *
 * @param {string} query
 * @param {Object} [opts] — see searchKnowledge + formatMatchesForPrompt
 * @returns {Promise<{text: string, matches: Array, cost_usd: number}>}
 */
export async function searchAndFormat(query, opts = {}) {
  const result = await searchKnowledge(query, opts);
  const text = formatMatchesForPrompt(result.matches, opts);
  return {
    text,
    matches: result.matches,
    cost_usd: result.query_cost_usd || 0,
  };
}
