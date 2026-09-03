-- ════════════════════════════════════════════════════════════════════
-- 076_kb_vector_hnsw_and_query_log.sql — Tier 2 vector search:
--   kb_vector_queries audit table + HNSW index on kb_embeddings
-- ════════════════════════════════════════════════════════════════════
-- Doctrine: sql/README.md
--
-- WHAT THIS IS
--   §A  kb_vector_queries — one row per Tier 2 search the response generator
--       runs (shadow or live). Evidence for the shadow → live decision.
--   §B  idx_kb_embeddings_hnsw — HNSW ANN index on kb_embeddings.embedding,
--       partial on active = true (match_kb_embeddings() filters active = true).
--
-- WHAT THIS IS NOT
--   - No change to kb_embeddings rows, match_kb_embeddings(), or ingestion.
--   - The drop of idx_kb_embeddings_vec (the 2026-04 IVFFlat index) is §C, a
--     separate destructive step. APPLIED 2026-09-03 on Mark's instruction —
--     see §C for why it had to run before, not after, Verification 2.
--
-- WHY
--   kb_embeddings: 3,289 rows (1,665 active), 18 source docs, and
--   idx_kb_embeddings_vec has 0 lifetime scans (pg_stat_user_indexes,
--   2026-09-02) — the tier was built in April and never called. The IVFFlat
--   index was created with lists = 100, which is sized for ~100K rows; on
--   <4K rows at the default ivfflat.probes = 1 it searches 1% of the table
--   and misses most neighbours. HNSW needs no training and no probe tuning.
--
-- Mirrored in runMigrations() (src/index.js): §A and a PLAIN (non-CONCURRENT)
-- CREATE INDEX IF NOT EXISTS for §B. Apply §A + §B here BEFORE merging so the
-- boot mirror finds them and no-ops.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_kb_embeddings_hnsw;
--   DROP TABLE IF EXISTS kb_vector_queries;
--   -- only if §C was run:
--   CREATE INDEX idx_kb_embeddings_vec ON kb_embeddings
--     USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
--
-- AFTER RUNNING: set KB_VECTOR_MODE=shadow on the LP MCP Railway service,
--   collect ~2 days of kb_vector_queries, review top_similarity and sources,
--   then decide on live. Code ships with KB_VECTOR_MODE unset (= off).
-- ════════════════════════════════════════════════════════════════════

-- §A — additive DDL. Supabase MCP apply_migration or dashboard. One execution.
CREATE TABLE IF NOT EXISTS kb_vector_queries (
  id             BIGSERIAL PRIMARY KEY,
  intent_class   TEXT,
  mode           TEXT NOT NULL,                       -- 'shadow' | 'live'
  query_text     TEXT,                                -- inbound message, first 500 chars
  match_count    INTEGER NOT NULL DEFAULT 0,
  top_similarity FLOAT8,
  sources        JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{source_doc, section, similarity}]
  latency_ms     INTEGER,
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kb_vector_queries_created
  ON kb_vector_queries (created_at DESC);

COMMENT ON TABLE kb_vector_queries IS
  'Audit row per Tier 2 vector search (kb-retriever v1.9). Review before KB_VECTOR_MODE=live.';

-- §B — RUN SEPARATELY. Dashboard SQL editor, its own execution.
-- CONCURRENTLY cannot run inside a transaction. Builds in seconds at 3,289 rows.
--
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_kb_embeddings_hnsw
--   ON kb_embeddings USING hnsw (embedding vector_cosine_ops)
--   WITH (m = 16, ef_construction = 64)
--   WHERE active = true;

-- §C — APPLIED 2026-09-03, on Mark's explicit instruction. Destructive class
-- per sql/README.md. Recorded here; do not re-run.
--
-- DROP INDEX CONCURRENTLY IF EXISTS idx_kb_embeddings_vec;
--
-- The original gate ("only after Verification 2 shows the planner choosing
-- idx_kb_embeddings_hnsw") could not be satisfied as written: with both
-- indexes present the planner priced IVFFlat lower every time and HNSW stayed
-- at 0 scans, so the gate could never open itself. §C had to run FIRST, and
-- Verification 2 was then confirmed on the far side of the drop.
--
-- Measured on the same query (match_kb_embeddings against a reece_faq_core
-- chunk, threshold 0.35, 4 rows) — the IVFFlat index was silently costing
-- recall, not just speed:
--
--   BEFORE (IVFFlat, lists=100, probes=1)   AFTER (HNSW)
--   1.000 reece_faq_core                    1.000 reece_faq_core
--   0.681 reece_compliance_guardrails       0.814 reece_canonical_kb
--   0.522 reece_content_playbook            0.776 reece_canonical_kb
--   0.498 reece_content_playbook            0.769 reece_canonical_kb
--
-- IVFFlat was missing the true nearest neighbours outright — the whole
-- reece_canonical_kb cluster never surfaced. Calibrate KB_VECTOR_MIN_SIMILARITY
-- from shadow-mode numbers collected AFTER this drop; anything measured with
-- the IVFFlat index in place understates what the KB can return.

-- Verification
-- SELECT indexrelname, idx_scan
--   FROM pg_stat_user_indexes WHERE relname = 'kb_embeddings';
-- SELECT mode, COUNT(*) AS searches,
--        ROUND(AVG(top_similarity)::numeric, 3) AS avg_top_sim,
--        ROUND(AVG(latency_ms)) AS avg_ms,
--        COUNT(*) FILTER (WHERE error IS NOT NULL) AS errors
--   FROM kb_vector_queries GROUP BY mode;
