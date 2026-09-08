/**
 * Memory Precheck — src/memory/memory-precheck.js  (sql/098, 2026-09-08)
 *
 * "Have we already decided this, and did Mark ever reject it?" in one call.
 * Given a proposal in plain words (and optionally an area), returns:
 *   active          top 5 ACTIVE decisions on the same subject (same area
 *                   first), each with cosine similarity
 *   closed_matches  superseded / rejected decisions at or above the conflict
 *                   threshold — the "already rejected" signal
 *   open_conflicts  rows in claude_memory_conflicts (status open) that involve
 *                   any of the matched decisions
 *   verdict         clear | already_decided | previously_rejected | conflict_open
 *   next_step       what the caller should do before proposing
 *
 * Callers: Cowork before a finding proposes a change; the Decision Engine
 * before an agent_rules insert (reece-agent-rules step 0); Claude Code before
 * a PR that touches sql/ or src/jobs/. Read-only.
 *
 * Vector leg through match_memory_embeddings (include_closed = true so history
 * is visible here — this is the one place it should be). When embeddings are
 * unavailable (no OPENAI_API_KEY, embed failure) it falls back to the
 * full-text claude_memory_search leg and says so in `leg`.
 */
import supabase from '../supabase.js';
import { getConflictThreshold } from './memory-checkpoint.js';

const CLOSED = new Set(['superseded', 'rejected', 'expired']);
const ACTIVE = new Set(['active']);

async function defaultEmbed(env = process.env) {
  if (!env.OPENAI_API_KEY) return null;
  const m = await import('../knowledge/openai-embeddings.js');
  return m.embed;
}

function shape(h) {
  return {
    id: h.source_id ?? h.id, similarity: typeof h.similarity === 'number' ? Number(h.similarity.toFixed(3)) : null,
    status: h.status ?? null, area: h.area ?? null, origin: h.origin ?? null,
    date: h.row_date ?? h.date ?? null, date_confidence: h.date_confidence ?? null,
    text: String(h.text || '').slice(0, 240),
  };
}

/** Pure: classify a set of shaped hits. Exported for tests. */
export function classify({ active = [], closed = [], conflicts = [], threshold = 0.85 }) {
  if (conflicts.length) return 'conflict_open';
  if (closed.some((c) => (c.similarity ?? 0) >= threshold)) return 'previously_rejected';
  if (active.some((a) => (a.similarity ?? 0) >= threshold)) return 'already_decided';
  return 'clear';
}

export const NEXT_STEP = Object.freeze({
  clear: 'No active decision on this subject at or above the threshold. Propose it; when it is decided, checkpoint it as a new decision.',
  already_decided: 'An active decision already covers this. Re-confirm it (same_as_id) or replace it explicitly (supersedes_id) — do not file a second one.',
  previously_rejected: 'A superseded or rejected decision matches. Read why before re-proposing; if the reason no longer holds, say so and supersede it explicitly.',
  conflict_open: 'An open conflict is waiting on a ruling for this subject. Get the ruling (claude_memory_conflicts) before proposing.',
});

/**
 * @param {string} proposalText
 * @param {Object} [opts]   area, limit (default 5), threshold, db, embed, env
 */
export async function memoryPrecheck(proposalText, opts = {}) {
  const text = typeof proposalText === 'string' ? proposalText.trim() : '';
  if (!text) throw new Error('memoryPrecheck() requires proposal_text');
  const db = opts.db || supabase;
  if (!db) throw new Error('Supabase client not configured');
  const env = opts.env || process.env;
  const threshold = opts.threshold ?? getConflictThreshold(env);
  const limit = Math.max(1, Math.min(opts.limit ?? 5, 20));
  const area = opts.area ? String(opts.area).trim() : null;
  const t0 = Date.now();
  const embed = opts.embed === undefined ? await defaultEmbed(env) : opts.embed;

  let hits = [];
  let leg = 'vector';
  let error = null;
  if (embed && typeof db.rpc === 'function') {
    try {
      const q = await embed(text);
      const res = await db.rpc('match_memory_embeddings', {
        query_embedding: q.embedding, match_threshold: Math.min(0.5, threshold), match_count: 40,
        filter_area: null, filter_kind: 'decision', include_closed: true,
      });
      if (res.error) throw new Error(res.error.message);
      hits = (res.data || []).map(shape);
    } catch (err) { error = err.message; leg = 'fts'; }
  } else leg = 'fts';
  if (leg === 'fts') {
    const res = await db.rpc('claude_memory_search', { p_query: text, p_limit: 40, p_include_closed: true });
    if (res.error) throw new Error(`claude_memory_search: ${res.error.message}`);
    hits = (res.data || []).filter((r) => r.kind === 'decision').map((r) => ({ ...shape(r), similarity: null }));
  }

  // Same area first, then similarity.
  const rank = (a, b) => ((b.area === area) - (a.area === area)) || ((b.similarity ?? 0) - (a.similarity ?? 0));
  const active = hits.filter((h) => ACTIVE.has(String(h.status || 'active'))).sort(rank).slice(0, limit);
  const closed = hits.filter((h) => CLOSED.has(String(h.status || ''))).filter((h) => h.similarity == null || h.similarity >= threshold).sort(rank).slice(0, limit);

  let conflicts = [];
  const ids = [...new Set([...active, ...closed].map((h) => h.id).filter(Number.isInteger))];
  if (ids.length) {
    try {
      const list = ids.join(',');
      const res = await db.from('claude_memory_conflicts').select('id, kind, row_a, row_b, similarity, detected_at, status')
        .eq('status', 'open').eq('kind', 'decision').or(`row_a.in.(${list}),row_b.in.(${list})`).limit(10);
      if (res.error) throw new Error(res.error.message);
      conflicts = res.data || [];
    } catch (err) { error = error ? `${error}; conflicts: ${err.message}` : `conflicts: ${err.message}`; }
  }

  const verdict = classify({ active, closed, conflicts, threshold });
  return {
    proposal: text.slice(0, 300), area, threshold, leg, verdict, next_step: NEXT_STEP[verdict],
    active, closed_matches: closed, open_conflicts: conflicts,
    latency_ms: Date.now() - t0, error,
  };
}
