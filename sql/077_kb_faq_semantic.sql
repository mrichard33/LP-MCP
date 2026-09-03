-- ════════════════════════════════════════════════════════════════════
-- 077_kb_faq_semantic.sql — Semantic Tier 1: kb_faqs embeddings + RPC
-- ════════════════════════════════════════════════════════════════════
-- Doctrine: sql/README.md
--
-- WHAT THIS IS
--   1. kb_faqs gains embedding / embedding_hash / embedded_at (all nullable).
--      tier1-semantic.js embedFaqsSweep() fills them by content hash on boot
--      and every KB_FAQ_EMBED_INTERVAL_MS while KB_FAQ_SEMANTIC_MODE != off.
--   2. kb_vector_queries gains tier ('kb_embeddings' | 'kb_faqs' |
--      'objection_type') and keyword_match_count, so shadow rows can be
--      compared keyword-vs-semantic per turn.
--   3. match_kb_faqs() — cosine top-N over active, channel-matched FAQs.
--
-- WHAT THIS IS NOT
--   - No rows are modified. No index is added: kb_faqs has 56 active rows
--     (2026-09-02); add an HNSW index only if it ever passes ~5,000.
--   - kb_objection_scripts is untouched — objection typing is done in memory
--     against six fixed type descriptions (tier1-semantic-core.js).
--
-- WHY
--   searchFaqs() is Postgres full-text on question_pattern and only hits on
--   word overlap. v1.9 shadow data (kb_vector_queries) is the running record of
--   what leads ask that the keyword path misses; this migration lets Tier 1
--   match by meaning instead of falling through to Tier 2.
--
-- Mirrored in runMigrations() (src/index.js). Apply here BEFORE merge so the
-- boot mirror no-ops. All statements are additive — Supabase MCP
-- apply_migration is fine; one execution.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS match_kb_faqs(vector, text, float8, integer);
--   ALTER TABLE kb_faqs DROP COLUMN IF EXISTS embedding,
--     DROP COLUMN IF EXISTS embedding_hash, DROP COLUMN IF EXISTS embedded_at;
--   ALTER TABLE kb_vector_queries DROP COLUMN IF EXISTS tier,
--     DROP COLUMN IF EXISTS keyword_match_count;
--
-- AFTER RUNNING: merge, confirm deploy, then set KB_FAQ_SEMANTIC_MODE=shadow.
--   The boot sweep embeds the 56 rows (~$0.0002). Review kb_vector_queries
--   WHERE tier IN ('kb_faqs','objection_type') for 1–2 days before live.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE kb_faqs
  ADD COLUMN IF NOT EXISTS embedding      vector(1536),
  ADD COLUMN IF NOT EXISTS embedding_hash TEXT,
  ADD COLUMN IF NOT EXISTS embedded_at    TIMESTAMPTZ;

ALTER TABLE kb_vector_queries
  ADD COLUMN IF NOT EXISTS tier                TEXT NOT NULL DEFAULT 'kb_embeddings',
  ADD COLUMN IF NOT EXISTS keyword_match_count INTEGER;

COMMENT ON COLUMN kb_faqs.embedding IS
  'text-embedding-3-small of buildFaqEmbedText(row); refreshed when embedding_hash changes (tier1-semantic.js).';

CREATE OR REPLACE FUNCTION match_kb_faqs (
  query_embedding vector(1536),
  p_channel       TEXT    DEFAULT 'sms',
  match_threshold FLOAT8  DEFAULT 0.40,
  match_count     INTEGER DEFAULT 3
)
RETURNS TABLE (
  id BIGINT, question_pattern TEXT, canonical_answer TEXT, answer_short TEXT,
  story_arc TEXT, channel TEXT, tier TEXT, similarity FLOAT8
)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN QUERY
  SELECT f.id, f.question_pattern, f.canonical_answer, f.answer_short,
         f.story_arc, f.channel, f.tier,
         1 - (f.embedding <=> query_embedding) AS similarity
  FROM kb_faqs f
  WHERE f.active = true
    AND f.embedding IS NOT NULL
    AND f.channel IN (p_channel, 'both')
    AND (1 - (f.embedding <=> query_embedding)) >= match_threshold
  ORDER BY f.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Verification
-- SELECT COUNT(*) AS active, COUNT(embedding) AS embedded FROM kb_faqs WHERE active;
-- SELECT tier, mode, COUNT(*) FROM kb_vector_queries GROUP BY 1, 2;
