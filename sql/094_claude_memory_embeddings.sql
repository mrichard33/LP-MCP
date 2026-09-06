-- ─── 094 — claude_memory_embeddings: memory tier on the KB vector stack ─────
--
-- Priority #7 of the Reece Memory System Optimization plan. Applied to Reece
-- Lead Perfection Sync (rcjcgjlqzepicbwhnnjl) on 2026-09-06 through the LP MCP
-- supabase_run_query tool, one statement per call, after Mark's approval. This
-- file is the record. Every statement is idempotent; do NOT re-apply as a way
-- of re-running anything.
--
-- WHAT
--   claude_memory_embeddings  one row per decision / issue / session / pending
--                             item from the claude_* memory tables; unique on
--                             (source_table, source_id); content_hash lets the
--                             backfill skip unchanged rows; embedded_text is
--                             the PII-stripped text that was embedded.
--   match_memory_embeddings   vector-only RPC (cosine). Never returns
--                             status='duplicate'. Fusion with the full-text
--                             claude_memory_search() happens in Node
--                             (src/memory/memory-search.js), not here.
--   memory_vector_queries     one row per hybrid search in shadow or live —
--                             the evidence for the shadow → live decision.
--                             vector_only = rows vector found that full-text
--                             missed; that number decides the flip.
--
-- WHY A SEPARATE TABLE
--   kb_embeddings feeds the agentic chatbot's replies to leads. Project memory
--   must never surface in a customer SMS. Same pgvector, same model
--   (text-embedding-3-small, 1536), same HNSW settings as sql/076 — a wall,
--   not a fork.
--
-- WRITERS: src/memory/memory-embed.js only (scripts/embed-memory.js now, the
-- priority #8 nightly job later). Nothing in the request path writes here.
--
-- Plain CREATE INDEX (not CONCURRENTLY): the table is created empty; HNSW
-- builds incrementally as rows arrive. ~6,900 rows expected.
--
-- NOT mirrored in runMigrations() — same reasoning as sql/051, 090–093: the
-- claude_* tables belong to the skill, not the request path. Priority #8 wraps
-- the search as an MCP tool; that is when it becomes boot-critical and gets
-- mirrored.
--
-- ROLLBACK (no source data touched): remove function match_memory_embeddings,
-- table memory_vector_queries, table claude_memory_embeddings. The memory
-- tables themselves are untouched by this migration.

CREATE TABLE IF NOT EXISTS claude_memory_embeddings (
  id            BIGSERIAL PRIMARY KEY,
  source_table  TEXT NOT NULL,      -- claude_decision_log | claude_known_issues | claude_session_logs | claude_pending_items
  source_id     INTEGER NOT NULL,
  content_hash  TEXT NOT NULL,      -- sha256 of embedded_text + status + area; unchanged rows are skipped on re-run
  embedded_text TEXT NOT NULL,      -- PII-stripped text that was embedded ([phone] / [email])
  embedding     vector(1536) NOT NULL,
  area          TEXT,
  origin        TEXT,               -- live | retro
  status        TEXT,               -- source row status at embed time
  severity      TEXT,
  category      TEXT,
  row_date      DATE,
  token_count   INTEGER,
  embedded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_table, source_id)
);

CREATE INDEX IF NOT EXISTS idx_claude_memory_emb_hnsw
  ON claude_memory_embeddings USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS idx_claude_memory_emb_area_status
  ON claude_memory_embeddings (area, status);

CREATE OR REPLACE FUNCTION match_memory_embeddings (
  query_embedding vector(1536),
  match_threshold FLOAT8  DEFAULT 0.30,
  match_count     INTEGER DEFAULT 20,
  filter_area     TEXT    DEFAULT NULL,
  filter_kind     TEXT    DEFAULT NULL,   -- decision | issue | session | pending
  include_closed  BOOLEAN DEFAULT true
)
RETURNS TABLE (
  kind TEXT, source_id INTEGER, text TEXT, area TEXT, origin TEXT, status TEXT,
  severity TEXT, category TEXT, row_date DATE, similarity FLOAT8
)
LANGUAGE sql STABLE AS $$
  SELECT
    CASE e.source_table
      WHEN 'claude_decision_log'  THEN 'decision'
      WHEN 'claude_known_issues'  THEN 'issue'
      WHEN 'claude_session_logs'  THEN 'session'
      WHEN 'claude_pending_items' THEN 'pending' END AS kind,
    e.source_id, left(e.embedded_text, 300) AS text, e.area, e.origin, e.status,
    e.severity, e.category, e.row_date,
    1 - (e.embedding <=> query_embedding) AS similarity
  FROM claude_memory_embeddings e
  WHERE coalesce(e.status,'') <> 'duplicate'
    AND (filter_area IS NULL OR e.area = filter_area)
    AND (filter_kind IS NULL OR e.source_table = CASE filter_kind
          WHEN 'decision' THEN 'claude_decision_log'
          WHEN 'issue'    THEN 'claude_known_issues'
          WHEN 'session'  THEN 'claude_session_logs'
          WHEN 'pending'  THEN 'claude_pending_items' END)
    AND (include_closed OR coalesce(e.status,'') NOT IN ('superseded','rejected','resolved','done','dropped','archived'))
    AND (1 - (e.embedding <=> query_embedding)) >= match_threshold
  ORDER BY e.embedding <=> query_embedding
  LIMIT greatest(1, least(coalesce(match_count, 20), 100));
$$;

CREATE TABLE IF NOT EXISTS memory_vector_queries (
  id             BIGSERIAL PRIMARY KEY,
  mode           TEXT NOT NULL,                       -- shadow | live
  query_text     TEXT,
  fts_count      INTEGER NOT NULL DEFAULT 0,
  vector_count   INTEGER NOT NULL DEFAULT 0,
  fused_count    INTEGER NOT NULL DEFAULT 0,
  vector_only    INTEGER NOT NULL DEFAULT 0,          -- hits vector found that full-text missed
  top_similarity FLOAT8,
  top_hits       JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{kind, id, fts_rank, vec_rank, similarity, score}]
  latency_ms     INTEGER,
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_memory_vector_queries_created
  ON memory_vector_queries (created_at DESC);

-- ─── Verification ───────────────────────────────────────────────────────────
-- SELECT json_agg(row_to_json(v)) FROM (
--   SELECT
--     (SELECT count(*) FROM information_schema.tables WHERE table_name IN ('claude_memory_embeddings','memory_vector_queries')) AS tables,   -- 2
--     (SELECT count(*) FROM pg_proc WHERE proname = 'match_memory_embeddings') AS fn,                                                        -- 1
--     (SELECT count(*) FROM pg_indexes WHERE indexname = 'idx_claude_memory_emb_hnsw') AS hnsw,                                              -- 1
--     (SELECT count(*) FROM claude_memory_embeddings) AS embedded_rows                                                                        -- ~6,853 after backfill
-- ) v;
--
-- AFTER BACKFILL: set MEMORY_VECTOR_MODE=shadow on the LP MCP Railway service,
-- run scripts/memory-search.js on real questions for a few days, then read
-- memory_vector_queries: if vector_only is consistently > 0 on relevant hits,
-- flip to live. Code ships with MEMORY_VECTOR_MODE unset (= off).
