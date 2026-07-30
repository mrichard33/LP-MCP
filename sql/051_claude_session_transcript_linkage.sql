-- ─── 051 — Transcript linkage for the Claude session-continuity tables ──────
--
-- The claude_session_logs / claude_decision_log pair (reece-session-continuity)
-- has always recorded WHAT a session concluded but never WHERE that session
-- happened. Once a log row exists there is no way back to the conversation that
-- produced it: no chat url, no title, no way to tell a log written live at the
-- end of a session from one reconstructed later from a transcript. That makes
-- two things impossible — auditing a claim back to its source conversation, and
-- knowing which transcripts have already been mined so a backfill pass does not
-- re-log the same conversation twice.
--
-- These columns are provenance, not new behaviour. Every one is nullable or
-- defaulted, so existing rows stay valid and every current reader keeps working
-- (HL-MCP's lp_session_context fallback in src/tools/admin/lp-fallback.ts
-- selects an explicit column list and is unaffected).
--
--   chat_url                canonical link to the conversation behind this log
--   chat_title              its title at review time — chats get renamed, so
--                           this is a snapshot, not a live mirror
--   transcript_search_keys  distinctive strings (contact ids, PR numbers, error
--                           text) that locate this session inside a transcript
--                           search when the url is unknown or has rotted
--   surface                 where the session ran (web / desktop / cowork / …)
--   log_origin              'live' = written during the session (the default,
--                           and true of every pre-existing row), vs a value
--                           marking a log reconstructed after the fact
--   link_confidence         'unlinked' until a transcript is actually matched;
--                           the default is deliberately the pessimistic value
--                           so backfilled rows are never mistaken for verified
--                           ones
--
-- Vocabulary for surface / log_origin / link_confidence / disposition is a
-- convention, not a CHECK constraint. Pinning it in DDL now would need a
-- migration every time the set grows, and these tables are written by a skill
-- rather than by request-path code — the constraint would buy little and break
-- writes at the worst moment.
ALTER TABLE claude_session_logs
  ADD COLUMN IF NOT EXISTS chat_url TEXT,
  ADD COLUMN IF NOT EXISTS chat_title TEXT,
  ADD COLUMN IF NOT EXISTS transcript_search_keys JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS surface TEXT,
  ADD COLUMN IF NOT EXISTS log_origin TEXT DEFAULT 'live',
  ADD COLUMN IF NOT EXISTS link_confidence TEXT DEFAULT 'unlinked';

-- Decisions are the rows most often quoted back months later ("we decided X
-- because Y") and are the ones most in need of a path back to the argument that
-- produced them. They inherit the session's chat_url through session_id, so
-- only the search keys are duplicated here — a decision is usually findable by
-- a narrower string than its whole session.
ALTER TABLE claude_decision_log
  ADD COLUMN IF NOT EXISTS transcript_search_keys JSONB DEFAULT '[]'::jsonb;

-- ─── Ledger of reviewed transcripts ─────────────────────────────────────────
--
-- One row per conversation that has been LOOKED AT, whatever the outcome. This
-- is what makes a transcript backfill resumable and idempotent: chat_url as the
-- primary key means reviewing the same chat twice is an upsert, not a second
-- session log. disposition records the verdict (logged / skipped / duplicate /
-- …) and is NOT NULL because a ledger row with no verdict answers nothing —
-- "reviewed, outcome unknown" is indistinguishable from never reviewed.
--
-- session_id is nullable on purpose: most reviewed chats produce no session log
-- (nothing worth logging, or already covered by an existing row), and those are
-- exactly the ones worth remembering so they are not re-read every pass.
-- chat_updated_at is the chat's own last-modified stamp, kept so a chat that has
-- moved on since review can be re-queued; reviewed_at is when we looked.
CREATE TABLE IF NOT EXISTS claude_transcript_ledger (
  chat_url TEXT PRIMARY KEY,
  chat_title TEXT,
  chat_updated_at TIMESTAMPTZ,
  session_id INTEGER REFERENCES claude_session_logs(id),
  disposition TEXT NOT NULL,
  reviewed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Both indexes serve the two hot lookups: "which session log came from this
-- chat" (dedupe on write, audit on read) and "what is still pending / was
-- skipped" (the backfill's work queue).
CREATE INDEX IF NOT EXISTS idx_session_logs_chat_url ON claude_session_logs(chat_url);
CREATE INDEX IF NOT EXISTS idx_ledger_disposition ON claude_transcript_ledger(disposition);

-- NOTE: none of this is mirrored in runMigrations(). That rule exists so a
-- fresh deploy self-heals the tables the LP-MCP request path depends on, and
-- LP-MCP does not read or write the claude_* tables at all — they are written
-- by the reece-session-continuity skill over the Supabase MCP and read by
-- HL-MCP's session-context fallback. Adding them to boot-time migrations would
-- put startup DDL in a service that has no stake in the schema.
--
-- Applied to Reece Lead Perfection Sync (rcjcgjlqzepicbwhnnjl) on 2026-07-30 as
-- migration claude_session_logs_transcript_linkage. Verified after apply: all 6
-- session-log columns, the decision-log column, the ledger table with its FK to
-- claude_session_logs(id), and both indexes present. The ledger came up with
-- RLS enabled and zero policies, matching the three sibling claude_* tables —
-- service-role access only, no anon/authenticated reach.
