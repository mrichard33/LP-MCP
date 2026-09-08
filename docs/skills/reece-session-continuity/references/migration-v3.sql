-- ============================================================
-- CLAUDE SESSION CONTINUITY — Migration v2 → current (v3 + v4)
-- Adds origin / confidence provenance, then points at the two
-- LP-MCP migrations that supply the session-start pack, ranked
-- search, lifecycle columns and the claude_pending_items table.
-- ============================================================
-- Run through LP MCP:supabase_run_query (CREATE / ALTER are allowed
-- there — sql/090 and sql/091 were both applied this way) or in the
-- Supabase Dashboard → SQL Editor (LP MCP instance).
-- Safe to re-run: every statement is IF NOT EXISTS guarded.
--
-- ALREADY APPLIED to Reece Lead Perfection Sync (rcjcgjlqzepicbwhnnjl)
-- on 2026-09-05/06. This file exists for a fresh or v2 install only.
-- ============================================================

-- ---------- 1. Provenance columns (v3) ----------
-- Matches the live definitions: TEXT NOT NULL, plain vocabulary, no
-- CHECK constraint (sql/051 convention). Neither sql/090 nor sql/091
-- adds these — they were added during the 2026-09-06 retro promotion.
--   origin       'live' (written during the session) | 'retro' (promoted
--                from a reconstructed checkpoint's JSON)
--   confidence   'confirmed' | 'reconstructed'

ALTER TABLE claude_decision_log
  ADD COLUMN IF NOT EXISTS origin     TEXT NOT NULL DEFAULT 'live',
  ADD COLUMN IF NOT EXISTS confidence TEXT NOT NULL DEFAULT 'confirmed';

ALTER TABLE claude_known_issues
  ADD COLUMN IF NOT EXISTS origin     TEXT NOT NULL DEFAULT 'live',
  ADD COLUMN IF NOT EXISTS confidence TEXT NOT NULL DEFAULT 'confirmed';

-- ---------- 2. Context pack, search, lifecycle (v3 + v4) ----------
-- Run these two LP-MCP files, in order, exactly as they are in the repo.
-- They are kept there, not copied here, so there is one definition of
-- each to maintain. Both are IF NOT EXISTS / CREATE OR REPLACE and
-- touch no rows.
--
--   sql/090_claude_memory_context.sql          (mrichard33/LP-MCP, main)
--       claude_memory_search(), three FTS GIN indexes, and the first
--       claude_memory_context()
--   sql/091_memory_lifecycle_pending_items.sql (mrichard33/LP-MCP, PR #864
--       until merged, then main)
--       issue triage columns, decision status, claude_pending_items, and
--       the v3 claude_memory_context() that replaces the one from 090
--
-- Fetch each with LP MCP:github_get_file and run the whole file.

-- ---------- 3. Verification ----------
-- Expect: functions = 2, fts_indexes = 3, provenance_cols = 4,
-- pending_items_table = 1, pack_chars between 25000 and 40000.
SELECT json_agg(row_to_json(v)) FROM (
  SELECT
    (SELECT count(*) FROM pg_proc
      WHERE proname IN ('claude_memory_context','claude_memory_search')) AS functions,
    (SELECT count(*) FROM pg_indexes
      WHERE indexname IN ('idx_claude_decision_fts','idx_claude_issues_fts','idx_claude_sessions_fts')) AS fts_indexes,
    (SELECT count(*) FROM information_schema.columns
      WHERE table_name IN ('claude_decision_log','claude_known_issues')
        AND column_name IN ('origin','confidence')) AS provenance_cols,
    (SELECT count(*) FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'claude_pending_items') AS pending_items_table,
    length(claude_memory_context(NULL)::text) AS pack_chars
) v;
