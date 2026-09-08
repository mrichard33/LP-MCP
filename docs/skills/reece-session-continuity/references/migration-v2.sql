-- ============================================================
-- CLAUDE SESSION CONTINUITY — Migration v1 → v2
-- Adds the transcript bridge: links checkpoints to chat transcripts
-- ============================================================
-- Run in Supabase Dashboard → SQL Editor (LP MCP instance).
-- DDL cannot execute through supabase_run_query.
-- Safe to re-run: every statement is IF NOT EXISTS guarded.
-- ============================================================

-- ---------- 1. Link columns on the session log ----------

ALTER TABLE claude_session_logs
  ADD COLUMN IF NOT EXISTS chat_url TEXT,
  ADD COLUMN IF NOT EXISTS chat_title TEXT,
  ADD COLUMN IF NOT EXISTS transcript_search_keys JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS surface TEXT DEFAULT 'chat',
  ADD COLUMN IF NOT EXISTS log_origin TEXT DEFAULT 'live',
  ADD COLUMN IF NOT EXISTS link_confidence TEXT DEFAULT 'unlinked';

-- surface:          'chat' | 'cowork' | 'code'
-- log_origin:       'live' (written during the session) | 'retro' (reconstructed from transcript)
-- link_confidence:  'exact' (URL known) | 'inferred' (timestamp-matched) | 'unlinked' (search keys only)

ALTER TABLE claude_session_logs
  DROP CONSTRAINT IF EXISTS claude_session_logs_surface_check;
ALTER TABLE claude_session_logs
  ADD CONSTRAINT claude_session_logs_surface_check
  CHECK (surface IN ('chat', 'cowork', 'code'));

ALTER TABLE claude_session_logs
  DROP CONSTRAINT IF EXISTS claude_session_logs_log_origin_check;
ALTER TABLE claude_session_logs
  ADD CONSTRAINT claude_session_logs_log_origin_check
  CHECK (log_origin IN ('live', 'retro'));

ALTER TABLE claude_session_logs
  DROP CONSTRAINT IF EXISTS claude_session_logs_link_confidence_check;
ALTER TABLE claude_session_logs
  ADD CONSTRAINT claude_session_logs_link_confidence_check
  CHECK (link_confidence IN ('exact', 'inferred', 'unlinked'));

-- ---------- 2. Search keys on the decision log ----------
-- Lets a single decision resolve to the chat where it was argued,
-- not just to its parent session.

ALTER TABLE claude_decision_log
  ADD COLUMN IF NOT EXISTS transcript_search_keys JSONB DEFAULT '[]'::jsonb;

-- ---------- 3. The transcript ledger ----------
-- One row per reviewed chat. The 'no_content' disposition is what stops
-- trivial chats from being re-flagged on every reconciliation pass.

CREATE TABLE IF NOT EXISTS claude_transcript_ledger (
  chat_url TEXT PRIMARY KEY,
  chat_title TEXT,
  chat_updated_at TIMESTAMPTZ,
  session_id INTEGER REFERENCES claude_session_logs(id) ON DELETE SET NULL,
  disposition TEXT NOT NULL,
  notes TEXT,
  reviewed_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT claude_transcript_ledger_disposition_check
    CHECK (disposition IN ('linked', 'retro_written', 'no_content', 'deferred'))
);

-- ---------- 4. Indexes ----------

CREATE INDEX IF NOT EXISTS idx_session_logs_chat_url
  ON claude_session_logs(chat_url);
CREATE INDEX IF NOT EXISTS idx_session_logs_link_confidence
  ON claude_session_logs(link_confidence);
CREATE INDEX IF NOT EXISTS idx_session_logs_origin
  ON claude_session_logs(log_origin);
CREATE INDEX IF NOT EXISTS idx_ledger_disposition
  ON claude_transcript_ledger(disposition);
CREATE INDEX IF NOT EXISTS idx_ledger_session
  ON claude_transcript_ledger(session_id);

-- GIN index so search keys can be matched with the @> containment operator
CREATE INDEX IF NOT EXISTS idx_session_logs_search_keys
  ON claude_session_logs USING GIN (transcript_search_keys);
CREATE INDEX IF NOT EXISTS idx_decision_log_search_keys
  ON claude_decision_log USING GIN (transcript_search_keys);

-- ---------- 5. Backfill existing rows ----------
-- Pre-migration checkpoints have no keys and no link. Mark them honestly
-- rather than leaving NULLs that read as "not yet processed".

UPDATE claude_session_logs
SET link_confidence = 'unlinked'
WHERE link_confidence IS NULL;

UPDATE claude_session_logs
SET log_origin = 'live'
WHERE log_origin IS NULL;

UPDATE claude_session_logs
SET transcript_search_keys = '[]'::jsonb
WHERE transcript_search_keys IS NULL;

-- ---------- 6. Verification ----------
-- Expect four tables:
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name LIKE 'claude_%'
ORDER BY table_name;

-- Expect the six new columns on claude_session_logs:
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'claude_session_logs'
  AND column_name IN ('chat_url', 'chat_title', 'transcript_search_keys',
                      'surface', 'log_origin', 'link_confidence')
ORDER BY column_name;
