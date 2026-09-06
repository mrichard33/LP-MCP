/**
 * Memory Gate — src/memory/memory-gate.js
 *
 * Pure decision helpers for the memory vector tier (priority #7). No imports on
 * purpose: scripts/test-memory-gate.js exercises this file without SUPABASE_URL
 * or OPENAI_API_KEY. Mirrors src/knowledge/vector-gate.js for the KB tier.
 *
 * v1.0 — 2026-09-06. Initial.
 */

export const MEMORY_VECTOR_MODES = new Set(['off', 'shadow', 'live']);

/** off (default) | shadow (search + log, return full-text) | live (return fused). */
export function getMemoryVectorMode(env = process.env) {
  const m = String(env.MEMORY_VECTOR_MODE || 'off').toLowerCase().trim();
  return MEMORY_VECTOR_MODES.has(m) ? m : 'off';
}

// Status weights: current state outranks history, history is never hidden.
// 'duplicate' is excluded outright (the RPC already drops it; fuse drops it too).
export const STATUS_WEIGHT = Object.freeze({
  active: 1.0, open: 1.0, in_progress: 1.0, blocked: 1.0,
  deferred: 0.9, ratified: 0.9,
  superseded: 0.7, resolved: 0.7, done: 0.7,
  archived: 0.6, dropped: 0.5, rejected: 0.5,
});
export const ORIGIN_WEIGHT = Object.freeze({ live: 1.0, retro: 0.9 });
export const RRF_K = 60;

export function statusWeight(status) {
  if (!status) return 1.0;
  const w = STATUS_WEIGHT[String(status).toLowerCase()];
  return typeof w === 'number' ? w : 0.85;
}

export function originWeight(origin) {
  const w = ORIGIN_WEIGHT[String(origin || 'live').toLowerCase()];
  return typeof w === 'number' ? w : 1.0;
}

/** +0.15 inside 30 days, +0.05 inside 90, else 0. */
export function recencyBoost(rowDate, today = new Date()) {
  if (!rowDate) return 0;
  const d = new Date(rowDate);
  if (Number.isNaN(d.getTime())) return 0;
  const days = (today.getTime() - d.getTime()) / 86_400_000;
  if (days <= 30) return 0.15;
  if (days <= 90) return 0.05;
  return 0;
}

function keyOf(kind, id) { return `${kind}:${id}`; }

/**
 * Reciprocal-rank fusion of full-text hits (claude_memory_search rows:
 * kind, id, date, text, origin, status, category, rank) and vector hits
 * (match_memory_embeddings rows: kind, source_id, text, area, origin, status,
 * severity, category, row_date, similarity).
 *
 * score = Σ 1/(k + rank) over the lists the row appears in
 *       × statusWeight × originWeight + recencyBoost
 *
 * @returns {{ results: Array, vector_only: number, fts_count: number, vector_count: number }}
 */
export function fuseResults(ftsHits = [], vecHits = [], opts = {}) {
  const k = opts.k ?? RRF_K;
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
  const today = opts.today ?? new Date();
  const merged = new Map();

  (Array.isArray(ftsHits) ? ftsHits : []).forEach((h, i) => {
    if (!h || String(h.status || '').toLowerCase() === 'duplicate') return;
    const key = keyOf(h.kind, h.id);
    const cur = merged.get(key) || {
      kind: h.kind, id: h.id, text: h.text, area: h.area ?? null, origin: h.origin ?? null,
      status: h.status ?? null, category: h.category ?? null, row_date: h.date ?? null,
      fts_rank: null, vec_rank: null, similarity: null, rrf: 0,
    };
    cur.fts_rank = i + 1;
    cur.rrf += 1 / (k + i + 1);
    merged.set(key, cur);
  });

  let vectorOnly = 0;
  (Array.isArray(vecHits) ? vecHits : []).forEach((h, i) => {
    if (!h || String(h.status || '').toLowerCase() === 'duplicate') return;
    const key = keyOf(h.kind, h.source_id);
    const existed = merged.has(key);
    const cur = merged.get(key) || {
      kind: h.kind, id: h.source_id, text: h.text, area: h.area ?? null, origin: h.origin ?? null,
      status: h.status ?? null, category: h.category ?? null, row_date: h.row_date ?? null,
      fts_rank: null, vec_rank: null, similarity: null, rrf: 0,
    };
    if (!existed) vectorOnly += 1;
    cur.vec_rank = i + 1;
    cur.similarity = typeof h.similarity === 'number' ? h.similarity : null;
    cur.area = cur.area ?? h.area ?? null;
    cur.rrf += 1 / (k + i + 1);
    merged.set(key, cur);
  });

  const results = [...merged.values()].map((r) => ({
    ...r,
    score: r.rrf * statusWeight(r.status) * originWeight(r.origin) + recencyBoost(r.row_date, today),
  }))
    .sort((a, b) => b.score - a.score || (b.similarity ?? 0) - (a.similarity ?? 0))
    .slice(0, limit)
    .map(({ rrf, ...rest }) => rest);

  return {
    results,
    vector_only: vectorOnly,
    fts_count: Array.isArray(ftsHits) ? ftsHits.length : 0,
    vector_count: Array.isArray(vecHits) ? vecHits.length : 0,
  };
}
