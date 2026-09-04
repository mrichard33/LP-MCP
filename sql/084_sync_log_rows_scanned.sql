-- 084_sync_log_rows_scanned.sql
--
-- WO-3: make the deep-offset paging theory confirmable from the database.
--
-- THE GAP THIS CLOSES
-- -------------------
-- 082 added api_calls and paging_mode so the theory could be tested. It is
-- still not testable, because the variable that DECIDES deep-offset — how many
-- rows the sweep actually walked — is computed and logged but never persisted.
-- Measured 2026-09-04 at 05:03: the leads sweep logged `scanned=543` while
-- `lp_sync_log.records_synced` for that run read 303. records_synced counts
-- rows WRITTEN; deep-offset triggers on rows FETCHED. Correlating duration
-- against records_synced therefore answers the wrong question, which is exactly
-- why the first confirming attempt came back inconclusive: runs at <=50 leads
-- synced still reached 1,483s because they had scanned far more than 50.
--
-- WHY IT MATTERS NOW
-- ------------------
-- With the unchanged-write skip shipped (#837/#839), milestone writes on a
-- quiet cycle fell to zero and this paging fallback is the dominant remaining
-- cost: it is the whole difference between a 0.4-minute sync and a 54-minute
-- one. Entry is deterministic at StartIndex=51 against SYNC_PAGE_SIZE=50 — LP
-- serves page 1 then returns an empty page 2 — after which every remaining row
-- costs one LP round trip.
--
-- Additive and reversible. Nullable, no default, no backfill: rows written
-- before this deploy legitimately do not know their scanned count, and
-- inventing a value for them (records_synced, say) would recreate the exact
-- confusion this column exists to end.
--
-- ROLLBACK
--   ALTER TABLE lp_sync_log DROP COLUMN IF EXISTS rows_scanned;

ALTER TABLE lp_sync_log ADD COLUMN IF NOT EXISTS rows_scanned integer;

COMMENT ON COLUMN lp_sync_log.rows_scanned IS
  'Rows FETCHED from LP by the sweep that owns this row''s paging, whether or not they were written. Distinct from records_synced, which counts rows written. This is the variable deep-offset paging triggers on: with SYNC_PAGE_SIZE=50, a sweep whose window exceeds 50 rows enters PageSize=1 for the remainder, so cost tracks rows_scanned, never records_synced. NULL for rows written before 084 and for entities whose sweep does not page LP directly.';

-- Confirming query for WO-3 once this has collected data. Deep runs should
-- show api_calls climbing ~1:1 with rows_scanned past the first page, while
-- normal runs stay near rows_scanned/50. Duration is the dependent variable,
-- never the classifier — paging_mode is written from the branch actually taken.
--
--   SELECT paging_mode,
--          count(*)                                            AS runs,
--          round(avg(rows_scanned))                            AS avg_scanned,
--          round(avg(api_calls))                               AS avg_api_calls,
--          round(avg(api_calls)::numeric / nullif(avg(rows_scanned),0), 2) AS calls_per_row,
--          round(avg(extract(epoch FROM (completed_at - started_at)))) AS avg_sec
--     FROM lp_sync_log
--    WHERE rows_scanned IS NOT NULL AND completed_at IS NOT NULL
--    GROUP BY paging_mode;
