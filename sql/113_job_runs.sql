-- ─── 113 — Job run history: give the background jobs a name and a memory ─────
--
-- WHY. This service runs ~44 scheduled background jobs. Not one of them has a
-- durable run history. Counted on 2026-09-16, every one of these keeps its last
-- result in a module-level variable and nothing else:
--
--     memory-nightly          lastRun            jobs/memory-nightly.js:324
--     workflow-projection     lastRunSummary     jobs/workflow-projection.js:64
--     five9-config-snapshot   lastSnapshotDate   jobs/five9-config-snapshot.js:480
--     capacity-sweep          lastFastSummary    jobs/capacity-sweep.js
--     scorecard-validate      lastRunDate        jobs/scorecard-validate.js:163
--     source-reconcile        lastRunKey         jobs/source-reconcile.js:488
--     omi-pull                lastRunAt          jobs/omi-pull.js:478
--
-- Railway wipes all of it on every deploy. So "did the nightly job run last
-- night, and did it work?" has had no answer at all — the same blind spot that
-- let the decision engine sit dormant for 47 hours and the fail-closed counter
-- go unread for 71 days. The dashboard's Decision Engine page has been a
-- disabled stub since Phase 1 for exactly this reason.
--
-- WHAT THIS IS NOT. It is not a replacement for the per-run detail tables that
-- already exist (lp_sync_log, lp_source_reconcile_runs, scorecard_ingest_log,
-- five9_config_snapshots). Those stay and keep their detail. job_runs is the
-- ROSTER and the one-line outcome: one row per real pass, for every job, in one
-- place, so a silent job is visible as silence.
--
-- THE STATUS VOCABULARY IS SIX VALUES, NOT TWO. Two of them are the whole point:
--
--   ok           the pass finished and the job said it worked
--   failed       it threw, OR it returned ok:false / success:false without
--                throwing. Many jobs here catch everything internally and
--                report failure in the return value — runMemoryNightly wraps
--                all ten of its steps and returns { ok:false, errors:[...] }.
--                A wrapper that only caught exceptions would file every one of
--                those as a success.
--   unknown      the job could not tell. checkLpReportFreshness tracks a
--                readFailed flag precisely so an unreadable table is not
--                reported as a healthy check. Same three-way rule as the
--                `active` argument to reportAlertCondition (src/alert-state.js):
--                could-not-tell must never be recorded as fine.
--   interrupted  the process was killed mid-pass. This is infrastructure, not a
--                defect. sql/… lesson repeated from src/sync-log.js:56-70 —
--                every SIGTERM row in lp_sync_log came from a Railway deploy,
--                and counting those as failures produced a "23% failure rate"
--                nobody could act on for weeks.
--   skipped      a re-entrancy guard declined to start (the previous pass was
--                still running). Not a defect either.
--   running      in flight right now.
--
-- Apply in the LP Supabase project. Idempotent and additive: safe to re-run.

-- ── A. The roster ───────────────────────────────────────────────────────────
-- Upserted at boot by src/job-runner.js registerJobs(), so it always reflects
-- the code that is actually deployed. This is what makes "never ran" visible:
-- a job present here with no row in job_runs is a job that should have run and
-- did not. Without it, a silent job is indistinguishable from a job that was
-- never wired up at all.

CREATE TABLE IF NOT EXISTS public.job_registry (
  job_id          TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  job_group       TEXT NOT NULL DEFAULT 'general',
  cadence         TEXT,               -- human text, e.g. 'daily 03:00 ET'
  enabled_env     TEXT,               -- env var that switches it off, if any
  enabled_default BOOLEAN NOT NULL DEFAULT TRUE,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  registered_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Re-runnable on an instance created before `enabled` existed.
ALTER TABLE public.job_registry
  ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON TABLE public.job_registry IS
  'Every instrumented background job. Upserted at boot by src/job-runner.js.';
COMMENT ON COLUMN public.job_registry.enabled_default IS
  'What the gate env var defaults to when unset — documents whether a job ships dark.';
COMMENT ON COLUMN public.job_registry.enabled IS
  'The gate RESOLVED at boot against this service''s own env. The dashboard cannot read those vars, so without this a deliberately disabled job would read as stale. Lets the UI say "disabled" instead.';

-- ── B. The history ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.job_runs (
  id           BIGSERIAL PRIMARY KEY,
  job_id       TEXT NOT NULL,
  status       TEXT NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  elapsed_ms   INTEGER,
  summary      TEXT,                          -- one line, for the roster
  detail       JSONB,                         -- the job's own returned object
  instance_id  TEXT,                          -- which replica ran it
  CONSTRAINT job_runs_status_check
    CHECK (status IN ('running', 'ok', 'failed', 'unknown', 'skipped', 'interrupted'))
);

COMMENT ON TABLE public.job_runs IS
  'One row per real pass of a scheduled job. See sql/113 header for the six-value status vocabulary.';
COMMENT ON COLUMN public.job_runs.status IS
  'failed includes jobs that returned ok:false WITHOUT throwing. unknown = could not tell. interrupted = killed by a deploy, never a defect.';

-- The roster read: newest run per job.
CREATE INDEX IF NOT EXISTS idx_job_runs_job_started
  ON public.job_runs (job_id, started_at DESC);

-- The orphan reaper at boot, and the "what is in flight" question. Partial, so
-- it stays tiny however large the history grows.
CREATE INDEX IF NOT EXISTS idx_job_runs_running
  ON public.job_runs (instance_id, started_at)
  WHERE status = 'running';

-- The 90-day prune and any time-ranged rollup.
CREATE INDEX IF NOT EXISTS idx_job_runs_started
  ON public.job_runs (started_at DESC);

-- ── C. The dashboard read ───────────────────────────────────────────────────
-- One row per registered job with its latest run and a 24h tally. DISTINCT ON
-- keeps "latest run per job" in SQL, where it is one index scan, instead of
-- pulling the history into the app to sort it. Same shape of contract as
-- v_command_center_queue: the dashboard reads the view, never the raw tables.
--
-- LEFT JOIN, not INNER: a registered job with no runs MUST still appear, as a
-- row with last_status NULL. That row is the entire point of the table.

CREATE OR REPLACE VIEW public.v_job_status AS
WITH latest AS (
  SELECT DISTINCT ON (job_id)
         job_id, status, started_at, finished_at, elapsed_ms, summary, instance_id
  FROM public.job_runs
  ORDER BY job_id, started_at DESC
),
tally AS (
  SELECT job_id,
         count(*) FILTER (WHERE status = 'ok')          AS ok_24h,
         count(*) FILTER (WHERE status = 'failed')      AS failed_24h,
         count(*) FILTER (WHERE status = 'unknown')     AS unknown_24h,
         count(*) FILTER (WHERE status = 'interrupted') AS interrupted_24h,
         count(*)                                       AS runs_24h
  FROM public.job_runs
  WHERE started_at >= now() - INTERVAL '24 hours'
  GROUP BY job_id
)
SELECT r.job_id,
       r.label,
       r.job_group,
       r.cadence,
       r.enabled_env,
       r.enabled_default,
       r.enabled,
       l.status           AS last_status,
       l.started_at       AS last_started_at,
       l.finished_at      AS last_finished_at,
       l.elapsed_ms       AS last_elapsed_ms,
       l.summary          AS last_summary,
       l.instance_id      AS last_instance_id,
       COALESCE(t.runs_24h, 0)         AS runs_24h,
       COALESCE(t.ok_24h, 0)           AS ok_24h,
       COALESCE(t.failed_24h, 0)       AS failed_24h,
       COALESCE(t.unknown_24h, 0)      AS unknown_24h,
       COALESCE(t.interrupted_24h, 0)  AS interrupted_24h
FROM public.job_registry r
LEFT JOIN latest l ON l.job_id = r.job_id
LEFT JOIN tally  t ON t.job_id = r.job_id
ORDER BY r.job_group, r.label;

COMMENT ON VIEW public.v_job_status IS
  'Roster + latest run + 24h tally, one row per registered job. A job that has never run appears with last_status NULL.';
