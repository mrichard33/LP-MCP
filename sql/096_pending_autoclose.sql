-- ─── 096 — Pending-item auto-close (shadow → live), stale flag, checkpoint key ─
--
-- Ruling basis: Mark, 2026-09-06 — auto-close rules A–E approved; rule F
-- (age-only close of unfixed items) REJECTED: "If it's not fixed, it stays
-- open." Rule F is replaced by a stale FLAG (never a status change).
--
-- Additive only. No drops, no data changes. Apply through the LP MCP
-- supabase_run_query tool BEFORE merging (Mark approves the statement); this
-- file stays in the repo as the record. Every statement is idempotent.
--
-- ─── A. claude_pending_items — auto-close columns ───────────────────────────
--
--   closed_by      'nightly' | 'checkpoint' | 'mark' — who closed the row.
--   closed_reason  rule tag, e.g. 'A:next_step_30d', 'C:duplicate'.
--   closed_at      when.
--   would_close    SHADOW column. When MEMORY_AUTOCLOSE_MODE=shadow the nightly
--                  job writes the rule tag here and touches nothing else, so
--                  Mark can review what live mode would do:
--                    SELECT would_close, count(*) FROM claude_pending_items
--                    WHERE would_close IS NOT NULL GROUP BY 1;
--                  Cleared on rows that no longer match, and on rows the live
--                  pass closes.
--   superseded_by  rule C: the newest open copy of an exact-duplicate
--                  description.
--   stale          replaces rejected rule F: open, not protected, untouched
--                  120+ days → stale=true. A flag, never a status. Cleared only
--                  by verified_at (set by the memory_checkpoint verified/close
--                  paths), never by activity.
--   verified_at    when a human or a code check last confirmed the row.
--
-- Protected set — NEVER touched by any rule, in any mode:
--   item_type IN ('decision_needed','unconfirmed_decision','open_question','approval_needed')

ALTER TABLE claude_pending_items
  ADD COLUMN IF NOT EXISTS closed_by     text,
  ADD COLUMN IF NOT EXISTS closed_reason text,
  ADD COLUMN IF NOT EXISTS closed_at     timestamptz,
  ADD COLUMN IF NOT EXISTS would_close   text,
  ADD COLUMN IF NOT EXISTS superseded_by integer REFERENCES claude_pending_items(id),
  ADD COLUMN IF NOT EXISTS stale         boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS verified_at   timestamptz;

CREATE INDEX IF NOT EXISTS idx_claude_pending_open_kind
  ON claude_pending_items (kind, session_date) WHERE status = 'open';

-- 'expired' is a new terminal status. Documented next to the existing ones.
COMMENT ON COLUMN claude_pending_items.status IS
  'open | done | dropped | superseded | blocked | deferred | ratified | expired. expired = plan aged out (nightly rule A/B), not rejected. Reopen: SET status=''open'', closed_by=NULL, closed_reason=NULL, closed_at=NULL.';

-- ─── B. claude_memory_autoclose_log — one row per rule per nightly pass ─────
--
--   mode       off | shadow | live
--   rule       A | B | C | D | STALE | DIGEST
--   affected   rows tagged (shadow) or changed (live); DIGEST = items waiting
--   sample_ids up to 20 ids for spot-checks

CREATE TABLE IF NOT EXISTS claude_memory_autoclose_log (
  id           bigserial PRIMARY KEY,
  ran_at       timestamptz NOT NULL DEFAULT now(),
  mode         text NOT NULL,
  rule         text NOT NULL,
  affected     integer NOT NULL DEFAULT 0,
  sample_ids   integer[],
  notes        text
);

CREATE INDEX IF NOT EXISTS idx_claude_memory_autoclose_log_ran_at
  ON claude_memory_autoclose_log (ran_at DESC);

-- ─── C. claude_session_logs — checkpoint idempotency key (issue #1627) ──────
--
-- memory_checkpoint generates one uuid per tool call and stores it here on the
-- session INSERT. A transport retry after a partial write finds the session by
-- key and UPDATEs it instead of inserting a second row for the same chat.

ALTER TABLE claude_session_logs
  ADD COLUMN IF NOT EXISTS checkpoint_key text UNIQUE;

-- ROLLBACK (discards shadow marks and close provenance — archive first):
--   ALTER TABLE claude_pending_items DROP COLUMN closed_by, DROP COLUMN closed_reason,
--     DROP COLUMN closed_at, DROP COLUMN would_close, DROP COLUMN superseded_by,
--     DROP COLUMN stale, DROP COLUMN verified_at;
--   DROP INDEX idx_claude_pending_open_kind;
--   DROP TABLE claude_memory_autoclose_log;
--   ALTER TABLE claude_session_logs DROP COLUMN checkpoint_key;
--
-- ─── Verification ───────────────────────────────────────────────────────────
-- SELECT
--   (SELECT count(*) FROM information_schema.columns WHERE table_name='claude_pending_items'
--      AND column_name IN ('closed_by','closed_reason','closed_at','would_close','superseded_by','stale','verified_at')) AS pending_cols, -- 7
--   (SELECT count(*) FROM information_schema.tables WHERE table_name='claude_memory_autoclose_log') AS log_table,             -- 1
--   (SELECT count(*) FROM information_schema.columns WHERE table_name='claude_session_logs' AND column_name='checkpoint_key') AS key_col; -- 1
