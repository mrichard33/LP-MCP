/**
 * Memory Search — src/memory/memory-search.js
 *
 * Hybrid retrieval over project memory: claude_memory_search() (full-text,
 * sql/090) + match_memory_embeddings() (vector, sql/094), fused in
 * memory-gate.js. Gated by MEMORY_VECTOR_MODE:
 *   off     full-text only, no embed call, no log row
 *   shadow  runs both, logs to memory_vector_queries, RETURNS full-text results
 *           (fused list attached as `shadow` for inspection)
 *   live    runs both, logs, RETURNS the fused list
 *
 * Priority #8 wraps this as the memory_search MCP tool. Until then
 * scripts/memory-search.js is the caller.
 *
 * v1.0 — 2026-09-06. Initial.
 */
import supabase from '../supabase.js';
import { embed } from '../knowledge/openai-embeddings.js';
import { getMemoryVectorMode, fuseResults } from './memory-gate.js';

const DEFAULT_THRESHOLD = parseFloat(process.env.MEMORY_VECTOR_MIN_SIMILARITY || '0.30');
const DEFAULT_MATCH_COUNT = parseInt(process.env.MEMORY_VECTOR_MATCH_COUNT || '20', 10);

function normalizeFts(rows) {
  return (rows || []).map((r) => ({
    kind: r.kind, id: r.id, text: r.text, area: null, origin: r.origin ?? null,
    status: r.status ?? null, category: r.category ?? null, row_date: r.date ?? null,
    fts_rank: null, vec_rank: null, similarity: null, score: r.rank ?? null,
  })).map((r, i) => ({ ...r, fts_rank: i + 1 }));
}

/**
 * @param {string} query
 * @param {Object} [opts] limit, threshold, filterArea, filterKind, includeClosed, mode (override)
 */
export async function hybridMemorySearch(query, opts = {}) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    throw new Error('hybridMemorySearch() requires a non-empty query string');
  }
  if (!supabase) throw new Error('Supabase client not configured');
  const mode = opts.mode || getMemoryVectorMode();
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_MATCH_COUNT, 100));
  const t0 = Date.now();

  const { data: ftsRows, error: ftsErr } = await supabase.rpc('claude_memory_search', {
    p_query: query, p_limit: Math.max(limit, 20),
  });
  if (ftsErr) throw new Error(`claude_memory_search: ${ftsErr.message}`);
  const fts = normalizeFts(ftsRows);

  if (mode === 'off') {
    return { mode, query, results: fts.slice(0, limit), latency_ms: Date.now() - t0 };
  }

  let vec = []; let error = null; let queryCost = 0;
  try {
    const q = await embed(query);
    queryCost = q.cost_usd;
    const { data, error: rpcErr } = await supabase.rpc('match_memory_embeddings', {
      query_embedding: q.embedding,
      match_threshold: opts.threshold ?? DEFAULT_THRESHOLD,
      match_count: Math.max(limit, 20),
      filter_area: opts.filterArea ?? null,
      filter_kind: opts.filterKind ?? null,
      include_closed: opts.includeClosed ?? true,
    });
    if (rpcErr) throw new Error(`match_memory_embeddings: ${rpcErr.message}`);
    vec = data || [];
  } catch (err) {
    error = err.message;
    console.error('[MemorySearch] vector leg failed:', err.message);
  }

  const fused = fuseResults(ftsRows || [], vec, { limit });
  const latency = Date.now() - t0;
  const topSim = vec.length ? Math.max(...vec.map((v) => v.similarity || 0)) : null;

  const { error: logErr } = await supabase.from('memory_vector_queries').insert({
    mode, query_text: query.slice(0, 500),
    fts_count: fused.fts_count, vector_count: fused.vector_count,
    fused_count: fused.results.length, vector_only: fused.vector_only,
    top_similarity: topSim,
    top_hits: fused.results.slice(0, 10).map((r) => ({
      kind: r.kind, id: r.id, fts_rank: r.fts_rank, vec_rank: r.vec_rank,
      similarity: r.similarity, score: Number((r.score ?? 0).toFixed(5)),
    })),
    latency_ms: latency, error,
  });
  if (logErr) console.error('[MemorySearch] log insert failed:', logErr.message);

  const base = { mode, query, latency_ms: latency, query_cost_usd: queryCost, vector_only: fused.vector_only, error };
  return mode === 'live'
    ? { ...base, results: fused.results }
    : { ...base, results: fts.slice(0, limit), shadow: fused.results };
}
