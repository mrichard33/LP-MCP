-- 089_sync_log_paging_mode_na.sql
--
-- Make an empty paging_mode mean exactly one thing.
--
-- Safe to run before, with, or after the deploy. This migration changes no data
-- and no constraints — it is a column comment and a corrected reporting query.
-- The value it documents ('n/a') starts appearing when the build lands; until
-- then the comment simply describes a bucket that is always empty.
--
--
-- THE DEFECT
-- ----------
-- `paging_mode` was documented in 082 as a two-value column:
--
--     'normal | deep — set from the paging branch actually taken, not inferred
--      from duration. deep = LP served one row per call at a deep StartIndex.'
--
-- which left NULL carrying two incompatible meanings at once:
--
--   1. "this entity does not page"  — milestones are never fetched from LP.
--      syncJobAndMilestones() makes zero LP calls; it reads milestones out of
--      the job payload it is handed. The rows arrive inside pages that the jobs
--      sweep already paged for and already charged to the `jobs` row.
--
--   2. "nobody instrumented this"   — full syncs call syncLogTelemetry not at
--      all, so every telemetry column is NULL for sync_type='full'; and any
--      sweep that dies before its telemetry write leaves the same NULL behind.
--
-- Those two look identical in the table, and the second one is an alarm. On
-- 2026-09-04 the jobs sweep died on its first loop iteration for five hours
-- (a missing walker construction — see the commit that ships with this file).
-- Its row read `completed`, 0 records, NULL telemetry. Reading NULL as "jobs
-- don't page, that's normal" is precisely the mistake the column invited.
--
--
-- THE FIX
-- -------
-- Three values, and NULL means one thing:
--
--   'normal'  the sweep paged LP by page index (or by row offset before WO-13)
--   'deep'    the sweep fell back to one row per LP call at a deep StartIndex
--   'n/a'     this entity does not page — it has no sweep of its own
--   NULL      uninstrumented: no telemetry was written for this row
--
-- sweep_api_calls and rows_scanned stay NULL alongside 'n/a'. That is not an
-- omission. There is no independent measurement to report for an entity that
-- rides inside another entity's pages, and mirroring the jobs sweep's numbers
-- onto the milestones row would read as one — which is the same ambiguity in a
-- different column. Read those two only where paging_mode is 'normal' or 'deep'.
--
-- No CHECK constraint exists on lp_sync_log (verified against pg_constraint
-- 2026-09-04 and again for this migration: primary key only), so nothing rejects
-- the third value and no constraint edit is needed. As in 082, the vocabulary is
-- documented here rather than enforced, so the next reader does not have to go
-- looking for it.

COMMENT ON COLUMN lp_sync_log.paging_mode IS
  'normal | deep | n/a — set from the paging branch actually taken, never inferred from duration. '
  'deep = LP served one row per call at a deep StartIndex. '
  'n/a = this entity does not page: it has no sweep of its own and its rows arrive embedded in '
  'another entity''s pages (milestones inside job payloads), so sweep_api_calls and rows_scanned are '
  'NULL beside it because there is no independent measurement to report. '
  'NULL = uninstrumented — no telemetry was written for this row (full syncs write none), which is a '
  'gap to investigate, not a statement about the entity.';

COMMENT ON COLUMN lp_sync_log.sweep_api_calls IS
  'LP API round trips made by the sweep that owns this row — sweep-scoped, not run-scoped: one run '
  'holds two independent counters (leads sweep, job-changes sweep) written onto the rows each owns. '
  'To get a run total, SUM the DISTINCT values across the run''s rows; do not average them, and do '
  'not read one row as the run. NULL where paging_mode is ''n/a'' (nothing was paged for) or NULL '
  '(nothing was instrumented).';

-- ─── Reporting query, superseding the one documented in 084 ──────
--
-- 084 grouped by paging_mode over `WHERE rows_scanned IS NOT NULL`, which
-- happened to exclude the 'n/a' rows for the right reason by accident — they
-- have no rows_scanned. Stating the filter explicitly instead, so the intent
-- survives the next edit: cost-per-row is only meaningful for rows that did
-- their own paging.
--
--   SELECT paging_mode,
--          count(*)                                                  AS runs,
--          round(avg(rows_scanned))                                  AS avg_scanned,
--          round(avg(sweep_api_calls))                               AS avg_api_calls,
--          round(avg(sweep_api_calls)::numeric
--                / nullif(avg(rows_scanned),0), 2)                   AS calls_per_row,
--          round(avg(extract(epoch FROM (completed_at - started_at)))) AS avg_sec
--     FROM lp_sync_log
--    WHERE paging_mode IN ('normal','deep')   -- entities that page for themselves
--      AND rows_scanned IS NOT NULL
--      AND completed_at IS NOT NULL
--    GROUP BY paging_mode;
--
-- And the coverage check that the 'n/a' value exists to make answerable —
-- every incremental row should now be one of the three, and anything still NULL
-- is an instrumentation gap worth a look:
--
--   SELECT entity_type,
--          count(*) FILTER (WHERE paging_mode IS NULL) AS uninstrumented,
--          count(*)                                    AS rows_total
--     FROM lp_sync_log
--    WHERE sync_type = 'incremental'
--      AND started_at > now() - interval '24 hours'
--    GROUP BY entity_type
--    ORDER BY uninstrumented DESC;
