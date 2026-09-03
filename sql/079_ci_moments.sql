-- ════════════════════════════════════════════════════════════════════
-- 079_ci_moments.sql — Call moments: objections / questions mined from CI
-- ════════════════════════════════════════════════════════════════════
-- Doctrine: sql/README.md
--
-- WHAT THIS IS
--   ci_moment_extractions — one row per call the extractor has visited
--     (done | skipped | failed, attempts ≤ 3). The sweep's cursor.
--   ci_moments — up to 6 moments per call: kind (objection | question |
--     buying_signal), objection_type, the homeowner's words (EMBEDDED), the
--     agent's response, resolved (moved forward within the call), and the
--     call-level outcome from ci_summaries (call_won = appointment_set /
--     confirmed / rescheduled).
--   match_ci_moments() — cosine top-N; p_won_only keeps resolved-or-booked.
--   v_ci_faq_gaps — homeowner questions with their best kb_faqs similarity;
--     rows under ~0.45 are questions no FAQ covers.
--
-- WHAT THIS IS NOT
--   - Nothing in ci_calls / ci_transcripts / ci_summaries / ci_syncs is
--     touched. The CI note pipeline is unaffected.
--   - Not a transcript store: only short scrubbed quotes are kept.
--
-- WHY
--   4,462 transcripts since 2026-08-24, mono, no speaker labels. The
--   homeowner's own objection wording and the answer that worked exist only
--   inside those transcripts. ~2,000 calls are eligible today.
--
-- Mirrored in runMigrations() (src/index.js). Tables are created EMPTY, so
-- the plain HNSW CREATE INDEX is fine here and in the mirror. Apply BEFORE
-- merge. Additive — MCP apply_migration or dashboard; one execution.
--
-- ROLLBACK:
--   DROP VIEW IF EXISTS v_ci_faq_gaps;
--   DROP FUNCTION IF EXISTS match_ci_moments(vector, text, boolean, float8, integer);
--   DROP TABLE IF EXISTS ci_moments;
--   DROP TABLE IF EXISTS ci_moment_extractions;
--
-- AFTER RUNNING: merge, confirm deploy, set KB_CALL_MOMENTS_MODE=shadow and
--   CI_MOMENTS_MODEL_ANTHROPIC=claude-haiku-4-5-20251001. The sweep works
--   the ~2,000-call backlog at 40 calls / 15 min (≈12 h). Review
--   kb_vector_queries WHERE tier='ci_moments' and the queries below before live.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ci_moment_extractions (
  call_id        UUID PRIMARY KEY,
  status         TEXT NOT NULL,              -- done | skipped | failed
  attempts       INTEGER NOT NULL DEFAULT 0,
  moments        INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  model          TEXT,
  prompt_version TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ci_moments (
  id              BIGSERIAL PRIMARY KEY,
  call_id         UUID NOT NULL,
  transcript_id   UUID,
  moment_index    INTEGER NOT NULL,
  kind            TEXT NOT NULL,             -- objection | question | buying_signal
  objection_type  TEXT,                      -- price|timing|spouse|trust|competitor|diy|other
  customer_said   TEXT NOT NULL,             -- homeowner's words, scrubbed — EMBEDDED
  agent_said      TEXT,                      -- agent's immediate response, scrubbed
  resolved        BOOLEAN,                   -- moved forward on this point within the call
  confidence      NUMERIC(3,2),
  call_outcome    TEXT,                      -- ci_summaries.outcome at extraction
  call_won        BOOLEAN NOT NULL DEFAULT false,
  agent_username  TEXT,
  team            TEXT,
  campaign        TEXT,
  call_start      TIMESTAMPTZ,
  extractor_model TEXT,
  prompt_version  TEXT,
  embedding       vector(1536),
  embedding_hash  TEXT,
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (call_id, moment_index)
);

CREATE INDEX IF NOT EXISTS idx_ci_moments_kind_type ON ci_moments (kind, objection_type) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_ci_moments_call ON ci_moments (call_id);
CREATE INDEX IF NOT EXISTS idx_ci_moments_hnsw
  ON ci_moments USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE active = true;

COMMENT ON TABLE ci_moments IS
  'Objection / question / buying-signal moments extracted from CI transcripts (kb-retriever v1.12). Homeowner side embedded; PII-scrubbed.';

CREATE OR REPLACE FUNCTION match_ci_moments (
  query_embedding vector(1536),
  p_kind          TEXT    DEFAULT NULL,
  p_won_only      BOOLEAN DEFAULT true,
  match_threshold FLOAT8  DEFAULT 0.45,
  match_count     INTEGER DEFAULT 2
)
RETURNS TABLE (
  id BIGINT, kind TEXT, objection_type TEXT, customer_said TEXT, agent_said TEXT,
  resolved BOOLEAN, call_won BOOLEAN, call_outcome TEXT, similarity FLOAT8
)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.kind, m.objection_type, m.customer_said, m.agent_said,
         m.resolved, m.call_won, m.call_outcome,
         1 - (m.embedding <=> query_embedding) AS similarity
  FROM ci_moments m
  WHERE m.active = true
    AND m.embedding IS NOT NULL
    AND (p_kind IS NULL OR m.kind = p_kind)
    AND (NOT p_won_only OR m.resolved = true OR m.call_won = true)
    AND (1 - (m.embedding <=> query_embedding)) >= match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

CREATE OR REPLACE VIEW v_ci_faq_gaps AS
  SELECT m.id, m.call_start, m.campaign, m.call_outcome, m.customer_said, m.agent_said, m.confidence,
         (SELECT MAX(1 - (f.embedding <=> m.embedding))
            FROM kb_faqs f WHERE f.active = true AND f.embedding IS NOT NULL) AS best_faq_similarity
  FROM ci_moments m
  WHERE m.kind = 'question' AND m.active = true AND m.embedding IS NOT NULL;

-- Verification
-- SELECT status, COUNT(*), SUM(moments) FROM ci_moment_extractions GROUP BY 1;
-- SELECT kind, objection_type, COUNT(*), COUNT(*) FILTER (WHERE resolved OR call_won) AS wins
--   FROM ci_moments GROUP BY 1, 2 ORDER BY 1, 3 DESC;
-- SELECT customer_said, ROUND(best_faq_similarity::numeric, 2) AS best_faq
--   FROM v_ci_faq_gaps WHERE best_faq_similarity < 0.45 ORDER BY call_start DESC LIMIT 40;
