-- 2026-08-06_snapshot_content_identity.sql — dedupe on CONTENT, not just bytes
--
-- THE HANDOFF'S DIAGNOSIS WAS WRONG, AND THE EVIDENCE SAYS SO.
--
-- §7 read: "Eight jobs_by_milestone snapshots exist for one period with
-- identical row counts; the SHA-256 check is not short-circuiting." The byte
-- check is in fact working — scorecard_ingest_log carries four rows with
-- status 'duplicate' for that report type, which is the gate firing. All eight
-- snapshots have DISTINCT file_sha256 values:
--
--   scope  rows  net_total_cents  ingested_at                  file_sha256
--   mtd    30    70250600         2026-08-05 17:00:53.360      656e15f6…
--   mtd    30    70250600         2026-08-05 17:00:59.061      3944e6d1…
--   mtd    30    70250600         2026-08-05 17:00:59.104      82f5cdd4…
--   mtd    30    70250600         2026-08-05 21:52:36.346      37ff8441…
--   mtd    30    70250600         2026-08-05 21:52:36.366      591f5cf2…
--   mtd    30    70250600         2026-08-05 22:05:54.801      a9842b0e…
--   mtd    30    70250600         2026-08-05 22:40:59.308      ded19891…
--   mtd    30    70250600         2026-08-06 11:00:27.273      6bdc9fa3…
--
-- Note the pairs 43ms and 20ms apart. LP regenerates the PDF on each fetch, so
-- the same logical report arrives as different BYTES every time it is pulled.
-- No byte hash can dedupe that, however correct it is.
--
-- FIX: a second identity, over the report's CONTENT — a canonical hash of the
-- parsed rows plus the window they describe (see contentSha256 in
-- lp-report-common.js). Rows, not just control totals: totals alone would treat
-- a Jobs By Status file whose bucket mix shifted while its row count and gross
-- held steady as a duplicate, silently dropping a real update.
--
-- report_generated_at was also hardcoded null on every snapshot, so nothing
-- could tell a genuine re-run from a redundant re-fetch. The ingest now writes
-- the PDF's printed run date.

BEGIN;

ALTER TABLE scorecard_report_snapshots
  ADD COLUMN IF NOT EXISTS content_sha256 text;

COMMENT ON COLUMN scorecard_report_snapshots.content_sha256 IS
  'Identity of the report CONTENT (canonical hash of parsed rows + window), '
  'independent of the bytes carrying it. file_sha256 catches a literal re-POST; '
  'this catches the same report re-rendered by LP into different bytes.';

-- Backstop. The application checks before insert; this makes a concurrent pair
-- (the 20ms case above) impossible rather than merely unlikely. Partial, so the
-- pre-existing rows with a NULL content hash do not block it.
CREATE UNIQUE INDEX IF NOT EXISTS scorecard_report_snapshots_content_uq
  ON scorecard_report_snapshots (report_type, content_sha256)
  WHERE content_sha256 IS NOT NULL;

-- The byte-level backstop the handoff asked to "verify". It was never declared,
-- only enforced in application code — so a concurrent pair could race past it.
CREATE UNIQUE INDEX IF NOT EXISTS scorecard_report_snapshots_file_uq
  ON scorecard_report_snapshots (report_type, file_sha256)
  WHERE file_sha256 IS NOT NULL;

COMMIT;

-- ── ONE-TIME CLEANUP — run separately, and read this first ───────────────────
--
-- This is NOT a change to the "superseded snapshots are never deleted" policy.
-- It removes failed-run junk from 2026-08-05: seven redundant re-renders that
-- the content check would have rejected had it existed, and one stale
-- single-day 'custom' snapshot (period 2026-08-04, 4 rows) that was never
-- promoted. Every one is already is_current = false, so nothing the dashboard
-- reads changes. The is_current row is kept, as is every genuinely superseded
-- snapshot of a DIFFERENT content.
--
-- Deliberately left commented: deleting production rows is Mark's call, and the
-- SELECT below shows exactly what would go before anything does.
--
--   SELECT id, scope, period_start, period_end, as_of_date, row_count,
--          net_total_cents, is_current, ingested_at
--   FROM scorecard_report_snapshots
--   WHERE report_type = 'jobs_by_milestone'
--     AND is_current = false
--     AND ingested_at < '2026-08-06'
--   ORDER BY ingested_at;
--
--   -- Rows first (FK), then the snapshots.
--   DELETE FROM scorecard_report_rows_a
--    WHERE snapshot_id IN (
--      SELECT id FROM scorecard_report_snapshots
--       WHERE report_type = 'jobs_by_milestone' AND is_current = false
--         AND ingested_at < '2026-08-06');
--   DELETE FROM lp_report_facts
--    WHERE snapshot_id IN (
--      SELECT id FROM scorecard_report_snapshots
--       WHERE report_type = 'jobs_by_milestone' AND is_current = false
--         AND ingested_at < '2026-08-06');
--   DELETE FROM scorecard_report_snapshots
--    WHERE report_type = 'jobs_by_milestone' AND is_current = false
--      AND ingested_at < '2026-08-06';
