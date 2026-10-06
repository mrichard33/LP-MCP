-- ════════════════════════════════════════════════════════════════════
-- sql/146_match_kb_embeddings_scoped.sql — 2026-10-06 (AI OS batch 1, PR 1)
--
-- WHAT
--   A NEW function, match_kb_embeddings_scoped(), with the same output
--   columns as match_kb_embeddings(). It returns only ACTIVE rows whose
--   source_doc starts with allowed_prefix (called with 'reece_').
--   match_kb_embeddings() is not touched.
--
-- WHY
--   On 2026-10-06, 1,598 of 1,671 active kb_embeddings rows were marketing
--   books (antifragile_v3 601, dotcom_secrets 350, traffic_secrets 305,
--   expert_secrets 281, headline_templates 61); about 70 were Reece facts.
--   The reply writers' vector tier rendered whatever came back, so book
--   content reached customer replies. Customer-facing retrieval is now an
--   ALLOWLIST (deny by default, CANON.STD.017; category filter, RULE.033).
--
-- starts_with(), not LIKE: in LIKE the "_" in 'reece_' matches any one
-- character, so 'reeceXanything' would pass.
--
-- match_threshold is a 4th parameter with the old function's semantics
-- (the code passes KB_VECTOR_MIN_SIMILARITY, 0.35 by default), so a scoped
-- call returns the same rows the old one would, minus the books.
--
-- Mirrored at boot (src/admin/startup-mirrors.js, block 'sql/146'). The code
-- works before this runs: vector-search.js falls back to 50 rows from the
-- old function, filtered in code (KB_CUSTOMER_SCOPE_MODE=live only).
--
-- APPLY: Supabase dashboard SQL editor, LP MCP instance, one execution.
-- ROLLBACK: DROP FUNCTION IF EXISTS match_kb_embeddings_scoped(vector, integer, text, double precision);
--   (and set KB_CUSTOMER_SCOPE_MODE=shadow or off)
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION match_kb_embeddings_scoped (
  query_embedding vector(1536),
  match_count     INTEGER DEFAULT 4,
  allowed_prefix  TEXT    DEFAULT 'reece_',
  match_threshold FLOAT8  DEFAULT 0.35
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
  IF allowed_prefix IS NULL OR allowed_prefix = '' THEN
    RETURN;  -- deny by default: no prefix, no rows
  END IF;
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
    AND starts_with(e.source_doc, allowed_prefix)
    AND (1 - (e.embedding <=> query_embedding)) >= match_threshold
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
