-- 038_milestone_tag_suppressed.sql  (#512)
--
-- Audit columns for the RTP job-axis backfill's side-effect suppression.
--
-- The one-shot backfill (src/admin/lp-rtp-job-backfill.js) recovers historical
-- lp_jobs / lp_job_milestones population WITHOUT retroactively firing milestone
-- automations. syncJobAndMilestones' suppressSideEffects path upserts each
-- backfilled completion with ghl_tag_fired=true so BOTH the write-time fire AND
-- the independent sweeper (src/milestones.js processMilestoneTriggers, which
-- fires on act_date NOT NULL + ghl_tag_fired=false) skip it.
--
-- Because ghl_tag_fired=true now means "fired OR deliberately suppressed", these
-- columns keep suppressed rows distinguishable from genuinely-fired tags.
--
-- Idempotent / additive — safe to re-run. Also applied on boot by
-- runMigrations() in src/index.js.

ALTER TABLE lp_job_milestones
  ADD COLUMN IF NOT EXISTS tag_suppressed_backfill BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS tag_suppressed_at TIMESTAMPTZ;
