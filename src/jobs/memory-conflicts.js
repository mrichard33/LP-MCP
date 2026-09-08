/**
 * Memory conflict scan — src/jobs/memory-conflicts.js  (sql/098, 2026-09-08)
 *
 * Files pairs of memory rows that say the same thing into
 * claude_memory_conflicts for Mark to rule on. Nothing is closed, merged or
 * deleted here — a ruling does that (superseded_by / merged_into), and the
 * nightly metadata sync then re-weights the embeddings.
 *
 *   decision   two ACTIVE decisions in the same area with cosine ≥
 *              MEMORY_CONFLICT_THRESHOLD (0.85). Expected ~40–80 pairs on the
 *              first full pass (cleanup batch C4), a handful a week after.
 *   issue      two OPEN issues in the same area with cosine ≥
 *              MEMORY_ISSUE_DUPLICATE_THRESHOLD (0.90) — the second duplicate
 *              pass (batch C5; the trigram pass found 18).
 *
 * Incremental by default: only rows embedded in the last `sinceHours` (24)
 * are the left side of the join, so the nightly cost is tiny. `full: true`
 * scans every row (first pass / manual run).
 *
 * SQL shape follows memory-autoclose.js: SELECT the candidate pairs (run_sql
 * returns no rows for INSERT), then one INSERT ... ON CONFLICT DO NOTHING.
 * Pairs are stored with row_a < row_b so (kind, row_a, row_b) is unique
 * regardless of which side found the other.
 */

export const CONFLICT_KINDS = Object.freeze({
  decision: { table: 'claude_decision_log', status: 'active', envKey: 'MEMORY_CONFLICT_THRESHOLD', defaultThreshold: 0.85 },
  issue:    { table: 'claude_known_issues', status: 'open',   envKey: 'MEMORY_ISSUE_DUPLICATE_THRESHOLD', defaultThreshold: 0.90 },
});
export const SAMPLE_LIMIT = 20;
const MAX_PAIRS = 500;

export function thresholdFor(kind, env = process.env) {
  const k = CONFLICT_KINDS[kind];
  const t = parseFloat(env[k.envKey]);
  return Number.isFinite(t) && t > 0 && t <= 1 ? t : k.defaultThreshold;
}

/**
 * Candidate pairs for one kind. Each left-side row looks at its 3 nearest
 * same-area, same-status neighbours; pairs already on file are skipped.
 */
export function conflictScanSql({ kind, threshold, sinceHours = 24, full = false }) {
  const k = CONFLICT_KINDS[kind];
  if (!k) throw new Error(`conflictScanSql: unknown kind ${kind}`);
  const t = Number(threshold);
  if (!Number.isFinite(t) || t <= 0 || t > 1) throw new Error('conflictScanSql: threshold must be in (0, 1]');
  const since = full ? '' : `\n  AND a.embedded_at > now() - interval '${Math.max(1, Math.trunc(Number(sinceHours) || 24))} hours'`;
  return `
SELECT least(a.source_id, b.source_id) AS row_a, greatest(a.source_id, b.source_id) AS row_b,
       round((1 - (a.embedding <=> b.embedding))::numeric, 4)::float8 AS similarity
FROM claude_memory_embeddings a
JOIN LATERAL (
  SELECT n.source_id, n.embedding FROM claude_memory_embeddings n
  WHERE n.source_table = a.source_table AND n.source_id <> a.source_id
    AND n.area IS NOT DISTINCT FROM a.area AND n.status = '${k.status}' AND NOT n.stale_embedding
  ORDER BY n.embedding <=> a.embedding LIMIT 3
) b ON true
WHERE a.source_table = '${k.table}' AND a.status = '${k.status}' AND NOT a.stale_embedding${since}
  AND 1 - (a.embedding <=> b.embedding) >= ${t}
  AND NOT EXISTS (SELECT 1 FROM claude_memory_conflicts c WHERE c.kind = '${kind}'
                  AND c.row_a = least(a.source_id, b.source_id) AND c.row_b = greatest(a.source_id, b.source_id))
ORDER BY similarity DESC, row_a, row_b
LIMIT ${MAX_PAIRS}`;
}

/** Pure: dedupe and normalise pairs (row_a < row_b, integers only). Exported for tests. */
export function normalizePairs(rows) {
  const seen = new Set();
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const a = Number(r.row_a); const b = Number(r.row_b);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) continue;
    const lo = Math.min(a, b); const hi = Math.max(a, b);
    const key = `${lo}:${hi}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sim = Number(r.similarity);
    out.push({ row_a: lo, row_b: hi, similarity: Number.isFinite(sim) ? Number(sim.toFixed(4)) : 0 });
  }
  return out;
}

export function conflictInsertSql(kind, pairs) {
  if (!CONFLICT_KINDS[kind]) throw new Error(`conflictInsertSql: unknown kind ${kind}`);
  const values = pairs.map((p) => `('${kind}', ${p.row_a}, ${p.row_b}, ${p.similarity})`).join(',\n       ');
  return `INSERT INTO claude_memory_conflicts (kind, row_a, row_b, similarity)
VALUES ${values}
ON CONFLICT (kind, row_a, row_b) DO NOTHING`;
}

const rowsOf = (r) => (Array.isArray(r) ? r : []);

/**
 * @param {Object} opts  dry_run (count only), full (all rows, not just last 24 h),
 *                       kinds (default both), deps { runSQL, env }
 */
export async function runConflictScan({ dry_run = false, full = false, sinceHours = 24, kinds = Object.keys(CONFLICT_KINDS), deps = {} } = {}) {
  const sql = deps.runSQL;
  if (typeof sql !== 'function') throw new Error('runConflictScan: deps.runSQL required');
  const env = deps.env || process.env;
  const result = { dry_run, full, kinds: {}, filed: 0, errors: [] };
  for (const kind of kinds) {
    const threshold = thresholdFor(kind, env);
    const entry = { threshold, candidates: 0, filed: 0, sample: [] };
    result.kinds[kind] = entry;
    try {
      const pairs = normalizePairs(await sql(conflictScanSql({ kind, threshold, sinceHours, full })));
      entry.candidates = pairs.length;
      entry.sample = pairs.slice(0, SAMPLE_LIMIT);
      if (dry_run || !pairs.length) continue;
      await sql(conflictInsertSql(kind, pairs));
      entry.filed = pairs.length;
      result.filed += pairs.length;
    } catch (err) {
      entry.error = err.message;
      result.errors.push(`${kind}: ${err.message}`);
    }
  }
  return result;
}
