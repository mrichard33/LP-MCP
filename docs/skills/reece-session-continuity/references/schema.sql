-- ============================================================
-- CLAUDE SESSION CONTINUITY — Supabase Table Schema (base tables)
-- ============================================================
-- Run this SQL in the Supabase SQL Editor (Dashboard → SQL Editor)
-- or through LP MCP:supabase_run_query.
-- These tables persist session context across Claude conversations
-- and link each checkpoint back to the chat transcript that produced it.
--
-- FRESH INSTALL: run this file, THEN LP-MCP sql/090 and sql/091 in order
--                (session-start pack, ranked search, lifecycle columns,
--                claude_pending_items — see migration-v3.sql §2).
-- EXISTING v1 INSTALL: run references/migration-v2.sql, then migration-v3.sql.
-- EXISTING v2 INSTALL: run references/migration-v3.sql.
-- ============================================================

-- TABLE 1: Session Logs
-- One row per session. The primary continuity record.
CREATE TABLE claude_session_logs (
  id SERIAL PRIMARY KEY,
  session_date DATE NOT NULL DEFAULT CURRENT_DATE,
  session_title TEXT NOT NULL,
  phase_focus TEXT,

  -- Structured JSONB fields for queryable session data
  workflows_touched JSONB DEFAULT '[]'::jsonb,
  phase_status JSONB DEFAULT '{}'::jsonb,
  decisions_made JSONB DEFAULT '[]'::jsonb,
  issues_found JSONB DEFAULT '[]'::jsonb,
  issues_resolved JSONB DEFAULT '[]'::jsonb,
  pending_items JSONB DEFAULT '[]'::jsonb,
  board_versions JSONB DEFAULT '{}'::jsonb,
  mcp_verified_ids JSONB DEFAULT '{}'::jsonb,
  next_steps JSONB DEFAULT '[]'::jsonb,

  -- Transcript bridge: links this checkpoint to its source chat
  chat_url TEXT,
  chat_title TEXT,
  transcript_search_keys JSONB DEFAULT '[]'::jsonb,
  surface TEXT DEFAULT 'chat' CHECK (surface IN ('chat', 'cowork', 'code')),
  log_origin TEXT DEFAULT 'live' CHECK (log_origin IN ('live', 'retro')),
  link_confidence TEXT DEFAULT 'unlinked'
    CHECK (link_confidence IN ('exact', 'inferred', 'unlinked')),

  -- Free-text summary for full context restoration
  raw_summary TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- TABLE 2: Decision Log
-- Every architectural/strategic decision, searchable across sessions.
CREATE TABLE claude_decision_log (
  id SERIAL PRIMARY KEY,
  session_id INTEGER REFERENCES claude_session_logs(id),
  decision_date DATE NOT NULL DEFAULT CURRENT_DATE,
  category TEXT NOT NULL,
  decision TEXT NOT NULL,
  options_considered JSONB DEFAULT '[]'::jsonb,
  rationale TEXT,
  workflow_id TEXT,
  workflow_name TEXT,
  reversible BOOLEAN DEFAULT true,

  -- Resolves this decision to the chat where it was argued
  transcript_search_keys JSONB DEFAULT '[]'::jsonb,

  -- Provenance (v3): 'live' | 'retro'  /  'confirmed' | 'reconstructed'
  origin TEXT NOT NULL DEFAULT 'live',
  confidence TEXT NOT NULL DEFAULT 'confirmed',

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- TABLE 3: Known Issues
-- Persistent issue tracker across sessions. Issues stay open until resolved.
CREATE TABLE claude_known_issues (
  id SERIAL PRIMARY KEY,
  reported_date DATE NOT NULL DEFAULT CURRENT_DATE,
  reported_session_id INTEGER REFERENCES claude_session_logs(id),
  resolved_date DATE,
  resolved_session_id INTEGER REFERENCES claude_session_logs(id),
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  workflow_id TEXT,
  workflow_name TEXT,
  impact TEXT,
  fix_instructions TEXT,
  status TEXT NOT NULL DEFAULT 'open',

  -- Provenance (v3): 'live' | 'retro'  /  'confirmed' | 'reconstructed'
  origin TEXT NOT NULL DEFAULT 'live',
  confidence TEXT NOT NULL DEFAULT 'confirmed',

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- TABLE 4: Transcript Ledger
-- One row per reviewed chat. The 'no_content' disposition is what stops
-- trivial chats from being re-flagged on every reconciliation pass.
CREATE TABLE claude_transcript_ledger (
  chat_url TEXT PRIMARY KEY,
  chat_title TEXT,
  chat_updated_at TIMESTAMPTZ,
  session_id INTEGER REFERENCES claude_session_logs(id) ON DELETE SET NULL,
  disposition TEXT NOT NULL
    CHECK (disposition IN ('linked', 'retro_written', 'no_content', 'deferred')),
  notes TEXT,
  reviewed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX idx_session_logs_date ON claude_session_logs(session_date DESC);
CREATE INDEX idx_session_logs_phase ON claude_session_logs(phase_focus);
CREATE INDEX idx_session_logs_chat_url ON claude_session_logs(chat_url);
CREATE INDEX idx_session_logs_link_confidence ON claude_session_logs(link_confidence);
CREATE INDEX idx_session_logs_origin ON claude_session_logs(log_origin);
CREATE INDEX idx_decision_log_category ON claude_decision_log(category);
CREATE INDEX idx_decision_log_session ON claude_decision_log(session_id);
CREATE INDEX idx_known_issues_status ON claude_known_issues(status);
CREATE INDEX idx_known_issues_severity ON claude_known_issues(severity);
CREATE INDEX idx_ledger_disposition ON claude_transcript_ledger(disposition);
CREATE INDEX idx_ledger_session ON claude_transcript_ledger(session_id);

-- GIN indexes so search keys can be matched with the @> containment operator
CREATE INDEX idx_session_logs_search_keys
  ON claude_session_logs USING GIN (transcript_search_keys);
CREATE INDEX idx_decision_log_search_keys
  ON claude_decision_log USING GIN (transcript_search_keys);

-- Verification query (run after creation to confirm — expect four tables):
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public' AND table_name LIKE 'claude_%';
