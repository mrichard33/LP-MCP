-- ════════════════════════════════════════════════════════════════════
-- 012_vector_search.sql — pgvector KB embeddings (Phase 4)
-- ════════════════════════════════════════════════════════════════════
-- Tier 2 of the KB architecture: semantic search across embedded source
-- documents (Antifragile PDF, Dotcom Secrets, technique PDFs, product
-- spec sheets, internal training docs).
--
-- Used when:
--   - Structured KB tables (kb_faqs, kb_objection_scripts, etc.) miss
--   - Lead asks a novel/unanticipated question
--   - The response generator wants supporting context for an arc
--
-- Embedding model: text-embedding-3-small (1536 dims, $0.02/1M tokens)
-- Provider: OpenAI (env: OPENAI_API_KEY)
--
-- ━━━ MANUAL DEPLOY STEP ━━━
-- pgvector must be enabled in the Supabase project BEFORE running this
-- migration. In the Supabase dashboard: Database → Extensions → search
-- "vector" → toggle ON. Then run this file in the SQL Editor.
-- ════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS vector;

-- ─── kb_embeddings ──────────────────────────────────────────────────
-- One row per chunked passage. Source documents are split into ~500-token
-- chunks, embedded, and stored here. Metadata enables filtered search
-- (e.g. only retrieve from product specs, only Antifragile content, etc.).

CREATE TABLE IF NOT EXISTS kb_embeddings (
  id BIGSERIAL PRIMARY KEY,
  chunk_text         TEXT NOT NULL,
  chunk_token_count  INTEGER,
  embedding          vector(1536) NOT NULL,
  source_doc         TEXT NOT NULL,         -- 'antifragile_v3' | 'dotcom_secrets' | 'technique_T1_relevance' | 'product_spec_pgt' | etc.
  source_doc_version TEXT,                  -- For re-ingestion tracking
  source_section     TEXT,                  -- Chapter / section label, if any
  source_page        INTEGER,               -- Page number, if applicable
  metadata           JSONB DEFAULT '{}'::jsonb,
                                            -- Free-form: {story_arc, buyer_stage, technique, channel, freshness}
  active             BOOLEAN NOT NULL DEFAULT true,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kb_embeddings_active
  ON kb_embeddings (active);

CREATE INDEX IF NOT EXISTS idx_kb_embeddings_source
  ON kb_embeddings (source_doc) WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_kb_embeddings_metadata
  ON kb_embeddings USING gin (metadata) WHERE active = true;

-- IVFFlat ANN index. lists=100 is a reasonable default for <100K rows.
-- For >1M rows, increase lists; for <10K, drop to 10.
-- Probe count tuning happens at query time (SET ivfflat.probes = N).
CREATE INDEX IF NOT EXISTS idx_kb_embeddings_vec
  ON kb_embeddings USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);


-- ─── match_kb_embeddings — RPC for semantic search ──────────────────
-- Called from src/knowledge/vector-search.js via Supabase RPC.
-- Returns top-N chunks ordered by cosine similarity.

CREATE OR REPLACE FUNCTION match_kb_embeddings (
  query_embedding   vector(1536),
  match_threshold   FLOAT8 DEFAULT 0.7,
  match_count       INTEGER DEFAULT 5,
  filter_source_doc TEXT DEFAULT NULL,
  filter_metadata   JSONB DEFAULT NULL
)
RETURNS TABLE (
  id BIGINT,
  chunk_text TEXT,
  source_doc TEXT,
  source_section TEXT,
  source_page INTEGER,
  metadata JSONB,
  similarity FLOAT8
)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.id,
    e.chunk_text,
    e.source_doc,
    e.source_section,
    e.source_page,
    e.metadata,
    1 - (e.embedding <=> query_embedding) AS similarity
  FROM kb_embeddings e
  WHERE e.active = true
    AND (filter_source_doc IS NULL OR e.source_doc = filter_source_doc)
    AND (filter_metadata IS NULL OR e.metadata @> filter_metadata)
    AND (1 - (e.embedding <=> query_embedding)) >= match_threshold
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;


-- ─── kb_embeddings_ingestion_log ────────────────────────────────────
-- Tracks ingestion runs. Lets us re-ingest selectively (by source_doc)
-- when source content changes. Audit trail for what's in the KB.

CREATE TABLE IF NOT EXISTS kb_embeddings_ingestion_log (
  id BIGSERIAL PRIMARY KEY,
  source_doc      TEXT NOT NULL,
  source_version  TEXT,
  chunks_added    INTEGER NOT NULL DEFAULT 0,
  chunks_skipped  INTEGER NOT NULL DEFAULT 0,
  chunks_replaced INTEGER NOT NULL DEFAULT 0,
  total_tokens    INTEGER NOT NULL DEFAULT 0,
  embed_cost_usd  NUMERIC(10,6),
  ingested_by     TEXT,                     -- 'manual' | 'cron' | 'claude'
  status          TEXT NOT NULL DEFAULT 'success', -- 'success' | 'partial' | 'failed'
  error_message   TEXT,
  duration_ms     INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kb_ingestion_log_source
  ON kb_embeddings_ingestion_log (source_doc, created_at DESC);


-- ═══════════════════════════════════════════════════════════════════
-- Notes for operators
-- ═══════════════════════════════════════════════════════════════════
-- 1. Setting probe count at query time controls recall/speed tradeoff:
--      SET LOCAL ivfflat.probes = 10;  -- default 1, higher = more accurate
--
-- 2. To re-ingest a document, soft-delete old rows then ingest:
--      UPDATE kb_embeddings SET active = false WHERE source_doc = 'antifragile_v3';
--      -- Then run ingestion script with same source_doc
--
-- 3. To check KB health:
--      SELECT source_doc, COUNT(*), MAX(ingested_at)
--      FROM kb_embeddings WHERE active = true GROUP BY source_doc;
