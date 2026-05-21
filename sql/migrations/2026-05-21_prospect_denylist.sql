-- ─── Prospect Deny-List Substrate ─────────────────────────────────
-- 2026-05-21_prospect_denylist.sql
--
-- Tracks LP prospect cstIds that consistently time out during sync.
--
-- A cstId is "denylisted" when consecutive_failures crosses
-- PROSPECT_DENYLIST_THRESHOLD (default 5). While denylisted, the
-- leads sweep skips processProspect for that cstId. denylisted_until
-- expires after PROSPECT_DENYLIST_DURATION_HOURS (default 24h), at
-- which point the cstId is re-tried on the next sweep — if it
-- succeeds, the row is deleted (clean slate). If it fails again, the
-- counter ratchets back up.
--
-- Problem this solves:
-- 2026-05-21 audit revealed ~20 cstIds chronically timing out
-- (40-130 occurrences each over 7 days). Each timeout consumes 180s
-- of sync wall-clock (per SYNC_PROSPECT_TIMEOUT_SEC). At 3-concurrent
-- prospect handling, these alone eat ~20-30 minutes of every sync
-- cycle — pushing the 20-minute per-sweep budget into Railway
-- SIGTERM territory and the 35-minute per-sync budget into outright
-- failure. Last successful incremental leads sync was 2026-05-05;
-- every sync since failed with either "N records failed" or SIGTERM.
--
-- This table provides a self-managing skip mechanism. No manual
-- intervention needed — entries auto-expire after the configured
-- window. If LP fixes a problematic record on their side, the
-- cstId successfully syncs on retry and is removed from the table.
--
-- Application logic: src/prospect-denylist.js
-- Integration point: src/sync-engine.js runLeadsSweep batch handler

CREATE TABLE IF NOT EXISTS lp_prospect_denylist (
  cst_id text PRIMARY KEY,
  consecutive_failures int NOT NULL DEFAULT 0,
  first_failed_at timestamptz NOT NULL DEFAULT now(),
  last_failed_at timestamptz NOT NULL DEFAULT now(),
  denylisted_at timestamptz NULL,
  denylisted_until timestamptz NULL,
  reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Index for the active-denylist lookup at sweep start:
--   SELECT cst_id FROM lp_prospect_denylist WHERE denylisted_until > now()
-- Partial index keeps it small — most rows in steady state have
-- denylisted_until = NULL (still accumulating failures, not yet over
-- threshold).
CREATE INDEX IF NOT EXISTS idx_prospect_denylist_until
  ON lp_prospect_denylist (denylisted_until)
  WHERE denylisted_until IS NOT NULL;

-- Index for observability queries (recently-failed lookup).
CREATE INDEX IF NOT EXISTS idx_prospect_denylist_last_failed
  ON lp_prospect_denylist (last_failed_at DESC);

COMMENT ON TABLE lp_prospect_denylist IS
  'Self-managing deny-list of LP cstIds that chronically timeout during sync. Auto-populated by src/prospect-denylist.js, consumed by src/sync-engine.js runLeadsSweep. Entries auto-expire after PROSPECT_DENYLIST_DURATION_HOURS (default 24h). Successful sync deletes the row entirely (clean slate).';

COMMENT ON COLUMN lp_prospect_denylist.consecutive_failures IS
  'Number of consecutive timeout failures since last successful sync. Resets to 0 (row deletion) when processProspect succeeds.';

COMMENT ON COLUMN lp_prospect_denylist.denylisted_until IS
  'Timestamp beyond which the cstId is eligible for re-try. NULL = below threshold, still accumulating failures.';
