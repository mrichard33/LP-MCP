-- ════════════════════════════════════════════════════════════════════
-- 078_kb_exemplars.sql — Past-win exemplars: lead said → we replied → outcome
-- ════════════════════════════════════════════════════════════════════
-- Doctrine: sql/README.md
--
-- WHAT THIS IS
--   kb_exemplars — one row per (inbound lead message, first outbound reply
--   within 24 h) pair from the HL warehouse, PII-scrubbed, with the outcome
--   from HL appointments added within KB_EXEMPLAR_OUTCOME_WINDOW_DAYS:
--     showed > confirmed > booked   (wins)
--     none                          (window closed, no booking)
--     pending                       (window still open; relabeled each sweep)
--   Only the LEAD side (inbound_text) is embedded — it is the retrieval key.
--   match_kb_exemplars() returns the closest wins for the current inbound.
--
-- WHAT THIS IS NOT
--   - Nothing in the HL Supabase is written. The sweep reads messages +
--     appointments there and writes here (src/knowledge/exemplars.js).
--   - Not a transcript store: prior_outbound/inbound/reply are capped and
--     scrubbed (emails, phones, street addresses, links).
--
-- WHY
--   Measured 2026-09-02, since 2026-06-01: 1,747 inbound lead messages,
--   1,603 answered within 24 h, 177 followed by a booking within 14 days.
--   That is the only corpus of what has actually worked for Reece leads, and
--   nothing reads it.
--
-- Mirrored in runMigrations() (src/index.js). Table is created EMPTY, so the
-- plain CREATE INDEX (HNSW) is fine both here and in the mirror. Apply here
-- BEFORE merge so the boot mirror no-ops. Additive — MCP apply_migration or
-- dashboard; one execution.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS match_kb_exemplars(vector, text, boolean, float8, integer);
--   DROP TABLE IF EXISTS kb_exemplars;
--
-- AFTER RUNNING: merge, confirm deploy, set KB_EXEMPLAR_MODE=shadow. The boot
--   sweep backfills KB_EXEMPLAR_BACKFILL_DAYS (120) of pairs and embeds them
--   (~1,600 rows, ~$0.001). Review kb_vector_queries WHERE tier='kb_exemplars'
--   for 1–2 days before live.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS kb_exemplars (
  id                 BIGSERIAL PRIMARY KEY,
  inbound_message_id TEXT NOT NULL UNIQUE,            -- HL messages.ghl_message_id (dedupe key)
  ghl_contact_id     TEXT NOT NULL,
  channel            TEXT NOT NULL,                   -- sms | email | livechat
  prior_outbound     TEXT,                            -- what we had said before (context, ≤400 chars)
  inbound_text       TEXT NOT NULL,                   -- the lead's message — EMBEDDED
  reply_text         TEXT NOT NULL,                   -- our reply within 24 h
  reply_source       TEXT NOT NULL DEFAULT 'other',   -- bot | other (best-effort via message_scores)
  inbound_sent_at    TIMESTAMPTZ NOT NULL,
  reply_sent_at      TIMESTAMPTZ,
  outcome            TEXT NOT NULL DEFAULT 'pending', -- showed | confirmed | booked | none | pending
  outcome_at         TIMESTAMPTZ,
  embedding          vector(1536),
  embedding_hash     TEXT,
  active             BOOLEAN NOT NULL DEFAULT true,
  built_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kb_exemplars_outcome ON kb_exemplars (outcome, inbound_sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_exemplars_contact ON kb_exemplars (ghl_contact_id);
CREATE INDEX IF NOT EXISTS idx_kb_exemplars_hnsw
  ON kb_exemplars USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE active = true;

COMMENT ON TABLE kb_exemplars IS
  'Past-win exemplars (kb-retriever v1.11): lead message → reply → booking outcome. Built by exemplars.js from the HL warehouse; PII-scrubbed.';

CREATE OR REPLACE FUNCTION match_kb_exemplars (
  query_embedding vector(1536),
  p_channel       TEXT    DEFAULT NULL,
  p_won_only      BOOLEAN DEFAULT true,
  match_threshold FLOAT8  DEFAULT 0.45,
  match_count     INTEGER DEFAULT 2
)
RETURNS TABLE (
  id BIGINT, channel TEXT, prior_outbound TEXT, inbound_text TEXT, reply_text TEXT,
  reply_source TEXT, outcome TEXT, similarity FLOAT8
)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN QUERY
  SELECT e.id, e.channel, e.prior_outbound, e.inbound_text, e.reply_text,
         e.reply_source, e.outcome,
         1 - (e.embedding <=> query_embedding) AS similarity
  FROM kb_exemplars e
  WHERE e.active = true
    AND e.embedding IS NOT NULL
    AND (p_channel IS NULL OR e.channel = p_channel)
    AND (NOT p_won_only OR e.outcome IN ('booked', 'confirmed', 'showed'))
    AND (1 - (e.embedding <=> query_embedding)) >= match_threshold
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Verification
-- SELECT outcome, reply_source, COUNT(*), COUNT(embedding) AS embedded
--   FROM kb_exemplars GROUP BY 1, 2 ORDER BY 1, 2;
