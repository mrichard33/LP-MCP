-- ─── 114 — One run per occurrence, across replicas ──────────────────────────
--
-- WHY. sql/113 gave every scheduled job a run history, but nothing stops two
-- copies of this service running the same nightly pass twice.
--
-- The six daily jobs guard themselves with a module-level date claimed before
-- awaiting — `lastRunDate`, `lastRunKey`, `lastSnapshotDate`, `lastReconDate`.
-- That is correct within one process and worth nothing across two: each replica
-- has its own copy of the variable, both see "not run today", and both run. The
-- scorecard gets computed twice, the reconcile sweeps twice, and the Five9
-- snapshot writes the day's config row twice.
--
-- It has not bitten yet because the service runs a single replica. That is a
-- deployment setting, not a guarantee, and the failure would be silent — two
-- successful-looking runs in job_runs and no error anywhere.
--
-- WHAT THIS DOES. `occurrence_key` names the slot a run belongs to: for the
-- daily jobs it is the Eastern-time date they already compute for their own
-- gate, so the key is exactly the thing that was already meant to be unique.
-- The partial unique index turns "I believe I am first" into "the database
-- says I am first": the second replica's INSERT loses, runJob returns `skipped`
-- and never calls the job.
--
-- Interval jobs (capacity sweep, watchdogs, projection) pass no key, store
-- NULL, and are unaffected — the index ignores NULLs. Running those twice is
-- harmless; running a nightly twice is not.
--
-- WHY THE KEY IS TEXT AND NOT A TIMESTAMP. The jobs hold an ET calendar date
-- ('2026-09-16'), not an instant. Storing it as a timestamptz would invite a
-- timezone conversion on the way in or out, and the two replicas racing are the
-- last place a date should change meaning.
--
-- WHY THE INDEX COVERS EVERY STATUS. A row exists for the slot whether the run
-- succeeded, failed or was interrupted, so a failed nightly is not retried on
-- the same day. That matches what the existing per-process guards already do:
-- they claim the date BEFORE awaiting, so a throwing run does not re-fire
-- either. Tomorrow's key is a different slot.
--
-- Apply in the LP Supabase project. Idempotent and additive: safe to re-run,
-- and safe to apply while sql/113 is already live.

ALTER TABLE public.job_runs
  ADD COLUMN IF NOT EXISTS occurrence_key TEXT;

COMMENT ON COLUMN public.job_runs.occurrence_key IS
  'The slot this run belongs to (ET date for the daily jobs). NULL for interval jobs. Unique per job_id — the cross-replica claim.';

-- The claim. Partial on NOT NULL so interval jobs are untouched.
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_runs_job_occurrence
  ON public.job_runs (job_id, occurrence_key)
  WHERE occurrence_key IS NOT NULL;

-- v_job_status is unchanged by this migration: SELECT r.*, l.* style columns
-- are listed explicitly there, so the new column does not alter its shape.
