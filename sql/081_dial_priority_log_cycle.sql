-- ============================================================================
-- 081_dial_priority_log_cycle.sql — Capacity ranker: campaign cycle columns
-- ============================================================================
-- Additive. Extends dial_priority_log (sql/080) with what the stop → reorder →
-- restart cycle records per run (src/capacity/applyDialPriority.js,
-- src/routes/capacityRanker.js):
--
--   cycled           — true when at least one Data campaign was stopped for
--                      the reorder this run (CAPACITY_RANKER_CYCLE_CAMPAIGNS).
--   downtime_ms      — total milliseconds the campaigns were stopped, summed
--                      across the two campaigns (they never overlap). NULL when
--                      nothing was cycled.
--   restart_failures — jsonb array of campaign names that did NOT read RUNNING
--                      after the bounded restart attempts. NULL when none. A
--                      non-null value here is an emergency: that campaign is
--                      stopped and the floor is not dialing it.
--
-- Mirrored in runMigrations() (src/index.js). Safe to re-run.
--
-- Rollback:
--   ALTER TABLE dial_priority_log
--     DROP COLUMN IF EXISTS cycled,
--     DROP COLUMN IF EXISTS downtime_ms,
--     DROP COLUMN IF EXISTS restart_failures;
-- ============================================================================

ALTER TABLE dial_priority_log
  ADD COLUMN IF NOT EXISTS cycled           boolean,
  ADD COLUMN IF NOT EXISTS downtime_ms      integer,
  ADD COLUMN IF NOT EXISTS restart_failures jsonb;
