-- 086_sync_log_sweep_api_calls_rename.sql
--
-- WO-14/G4: name the paging counter for what it actually measures.
--
-- ⚠️ RUN THIS WITH THE DEPLOY, NOT BEFORE IT. ⚠️
--
-- This is a rename, so it is only correct simultaneously with the build that
-- writes the new name. src/sync-log.js swallows telemetry errors by design
-- ("telemetry must never break a sync"), so running this early does not break
-- anything loudly — it just silently stops recording paging telemetry until the
-- deploy lands, which is the one blind spot worth avoiding during an active P1.
-- That is why it is split out of 085; everything in 085 is safe to run against
-- the current production build.
--
--
-- THE DEFECT
-- ----------
-- Measured 2026-09-04, every instrumented entity in a run reported an IDENTICAL
-- api_calls: 101/101/101/101, then 84/84/84/84, then 77/77/77/77. That is not
-- per-entity instrumentation. It is one paging loop's counter written onto every
-- entity row that loop feeds — runLeadsSweep pages getLeadData once and writes
-- its single number to leads, calls, notes and activities.
--
-- The number was never wrong. The NAME was: `api_calls` on a row whose
-- entity_type is `notes` reads as "LP calls made for notes", and no such
-- quantity was ever measured. Same defect class as `failed_syncs` counting
-- container kills — a metric whose name does not describe what it measures is
-- worse than no metric, because it looks actionable.
--
--
-- WHY `sweep_api_calls` AND NOT `run_api_calls`
-- ---------------------------------------------
-- The counter is scoped to one SWEEP, not one run. An incremental run makes two
-- independent paging loops with two independent counters, landing on different
-- rows:
--
--   runLeadsSweep       pages getLeadData          → leads, calls, notes, activities
--   runJobChangesSweep  pages getJobStatusChanges  → jobs
--
-- `run_api_calls` would have been just as untrue as `api_calls`, one level up:
-- it would claim a run total that no single row holds. `sweep_api_calls` is the
-- honest scope. To get a run total, SUM the DISTINCT values across the run's
-- rows — do not average them, and do not read one row as the run.

BEGIN;

ALTER TABLE lp_sync_log
  RENAME COLUMN api_calls TO sweep_api_calls;

COMMENT ON COLUMN lp_sync_log.sweep_api_calls IS
  'LP round trips made by the SWEEP that owns this row (runLeadsSweep or runJobChangesSweep) — not by this entity alone, and not by the whole run. One sweep writes its single counter to every entity row it feeds, so identical values across sibling rows of the same run are expected and correct. Sum distinct values across a run for a run total.';

COMMIT;

-- ─── VERIFY ──────────────────────────────────────────────────────────────────
--
-- Run totals, correctly computed — one row per run, not per entity:
--
--   SELECT started_at,
--          sum(DISTINCT sweep_api_calls) AS run_api_calls,
--          count(*)                      AS entity_rows
--     FROM lp_sync_log
--    WHERE sync_type = 'incremental' AND sweep_api_calls IS NOT NULL
--    GROUP BY started_at
--    ORDER BY started_at DESC LIMIT 12;
