-- ============================================================================
-- 087_dial_priority_log_restart_hardening.sql — Capacity ranker: restart
-- hardening, self-heal and the cycling kill switch
-- ============================================================================
-- Doctrine: sql/README.md. Additive. Safe to re-run.
--
-- WHY
--   2026-09-04: "Data - Warm Leads less than 30" sat NOT_RUNNING for roughly
--   two hours (dial_priority_log id 24, downtime_ms 199717) after a reorder
--   stopped it and the restart never succeeded. Mark started it by hand.
--   ~2,600 warm leads went undialed. Three restart failures that afternoon
--   (ids 18, 19, 24) with an escalating dark window: 16s, 22s, 200s.
--
-- WHAT THESE COLUMNS ARE FOR
--   settle_ms            — how long the graceful stop took to actually settle
--                          to NOT_RUNNING, summed across the campaigns cycled
--                          this run. THE number we need: every other timeout in
--                          src/capacity/applyDialPriority.js is tuned off it.
--                          NULL when nothing was cycled.
--   restart_attempts     — how many startCampaign attempts the restarts needed,
--                          summed across the campaigns cycled this run. The old
--                          budget was 3 attempts at a flat 2s (~6s); it is now
--                          10 attempts over 10 minutes with exponential backoff.
--   healed_at            — when POST /n8n/capacity-ranker/heal brought the
--                          campaigns named in restart_failures back. Stamped on
--                          the row that RECORDED the failure, so an incident
--                          reads as opened → closed in one place.
--   cycle_disabled_until — set to the next ET midnight by any run that ends
--                          with a restart failure. Later runs read the most
--                          recent non-null value and REFUSE to cycle until it
--                          passes; they still compute and log the ranking.
--                          Mark re-arms cycling by NULLing it.
--
-- Rows written by the heal sweeper carry mode = 'heal', ranking = '[]'::jsonb
-- and scoring_basis = 'heal'. They are outcome records, not rankings — exclude
-- them from ranking analytics with `WHERE mode <> 'heal'`.
--
-- THE RUN MUTEX IS NOT HERE. One ranker run at a time is enforced with the
-- existing outbound_locks table (key capacity_ranker:run, Supabase-backed,
-- TTL RANKER_LOCK_TTL_MS / 15 minutes, compare-and-set release) rather than a
-- second lock table. Two lock tables would not exclude each other, which is the
-- one thing a mutex has to do.
--
-- Mirrored in runMigrations() (src/index.js) so a fresh deploy self-heals.
--
-- EXECUTION: Supabase dashboard SQL editor, LP MCP instance. One execution.
--
-- ROLLBACK:
--   ALTER TABLE dial_priority_log
--     DROP COLUMN IF EXISTS settle_ms,
--     DROP COLUMN IF EXISTS restart_attempts,
--     DROP COLUMN IF EXISTS healed_at,
--     DROP COLUMN IF EXISTS cycle_disabled_until;
-- ============================================================================

ALTER TABLE dial_priority_log
  ADD COLUMN IF NOT EXISTS settle_ms            integer,
  ADD COLUMN IF NOT EXISTS restart_attempts     integer,
  ADD COLUMN IF NOT EXISTS healed_at            timestamptz,
  ADD COLUMN IF NOT EXISTS cycle_disabled_until timestamptz;
