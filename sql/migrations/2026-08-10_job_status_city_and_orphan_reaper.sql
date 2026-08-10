-- ════════════════════════════════════════════════════════════════════
-- 2026-08-10 — Report 133: the missing `city` column, and an orphan reaper
--
-- Applied BY HAND per sql/README.md. Idempotent: safe to re-run.
--
-- ══ WHY (a) — THE 133 BLOCKAGE ══
--
-- Every chunked 133 ingest since 2026-08-09 died at the first chunk:
--
--   row load failed at chunk 0: column "city" of relation
--   "lp_job_status_history" does not exist
--
-- 2026-08-07_job_status_cohort_realign.sql defines lp_csv_ingest_rows to INSERT
-- `city` and to read it out of the jsonb recordset, and the parser emits it
-- (lp-report-parse-job-status.js). But that migration's own ADD COLUMN list adds
-- ten columns and omits `city`. All ten landed; `city` never existed.
--
-- The visible symptom was 17 `orphaned_snapshot` rejections, which is why this
-- looked like an idempotency-probe bug. It is not. `lp_csv_ingest_begin` had
-- already created the snapshot row before the row load failed, so the orphan
-- held the unique key and every retry collided with it. The orphan is the
-- consequence; this one column is the cause. Section (d) clears the wreckage,
-- but WITHOUT (a) a cleared orphan is simply recreated on the next poll.
--
-- ══ WHY (b)-(d) — ORPHANS HAVE NO WAY OUT ══
--
-- `UNIQUE (report_type, file_sha256)` carries no finalized_at filter, and
-- neither does scorecard_report_snapshots_content_uq on (report_type,
-- content_sha256) WHERE content_sha256 IS NOT NULL. A begin that never
-- finalizes therefore holds both keys forever. probeExistingSnapshot names this
-- honestly (`orphaned_snapshot`, HTTP 200 + success:false) rather than
-- disguising it as a duplicate — but nothing ever clears it, and the runbook
-- makes clearing a manual operator action. Under a backfill, which produces more
-- failed loads than normal operation, that does not hold.
--
-- The reaper MARKS rather than deletes: the audit row is the only record of what
-- failed. To release the keys without losing the row it prefixes file_sha256
-- (NOT NULL, so it cannot be nulled) and nulls content_sha256 (whose unique
-- index is partial on IS NOT NULL).
--
-- ══ SAFETY — WHY `source_format = 'csv'` IS LOAD-BEARING ══
--
-- 30 snapshots currently have finalized_at IS NULL. Only 11 are orphans. The
-- other 19 are PDF snapshots, whose RPC is single-tx and for which NULL is
-- correct and permanent — and SIX OF THOSE ARE is_current = true. A reaper
-- predicated on finalized_at IS NULL alone would abandon live current snapshots
-- and blank the dashboard. The source_format filter is not an optimisation.
--
-- A snapshot that loaded rows but failed a finalize assertion is likewise NOT
-- reaped: it holds real data, and discarding it is an operator decision.
--
-- ══ CLASS ══ Per sql/README.md this is purely additive — two nullable columns,
-- one widened CHECK, one new function. No drops, no backfills on populated
-- tables, no CREATE INDEX CONCURRENTLY. Eligible for MCP apply_migration.
--
-- ══ ORDERING ══ Apply BEFORE re-sending any 133 month. Section (a) is
-- backward-compatible with the currently deployed code (lp_csv_ingest_rows
-- already expects the column), so migrate-then-deploy is safe in a way the
-- reverse is not.
--
-- NOT mirrored in runMigrations() — a repair of an existing table plus an
-- operational job, not boot-critical DDL a fresh deploy needs to self-heal.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.lp_csv_reap_orphan_snapshots(integer);
--   ALTER TABLE scorecard_ingest_log DROP CONSTRAINT scorecard_ingest_log_status_check;
--   ALTER TABLE scorecard_ingest_log ADD  CONSTRAINT scorecard_ingest_log_status_check
--     CHECK (status IN ('success','succeeded','succeeded_with_warnings',
--                       'failed','duplicate','superseded','no_text_layer'));
--   ALTER TABLE scorecard_report_snapshots DROP COLUMN IF EXISTS abandoned_reason;
--   ALTER TABLE scorecard_report_snapshots DROP COLUMN IF EXISTS abandoned_at;
--   -- Do NOT drop lp_job_status_history.city: lp_csv_ingest_rows inserts it, so
--   -- dropping it re-breaks every 133 ingest. Rolling (a) back means reverting
--   -- the 2026-08-07 function definition too.
--   -- Reaped snapshots are not automatically restorable: the original
--   -- file_sha256 is recoverable from the 'abandoned:<id>:' prefix, but
--   -- content_sha256 was nulled. Re-ingesting the archived file is the path back.
--
-- AFTER RUNNING:
--   1. Re-POST one 133 month and confirm success:true (section (a) verified).
--   2. Run SELECT lp_csv_reap_orphan_snapshots(0); once to clear the 11 CSV
--      orphans standing today, then leave the scheduled job to the 60-minute
--      default.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── (a) the column 2026-08-07 forgot ────────────────────────────────────────
ALTER TABLE lp_job_status_history ADD COLUMN IF NOT EXISTS city text;

COMMENT ON COLUMN lp_job_status_history.city IS
  'Verbatim `city` from the 133 export. Omitted from the ADD COLUMN list in 2026-08-07_job_status_cohort_realign.sql while that same migration wrote lp_csv_ingest_rows to INSERT it — so every chunked 133 load failed at chunk 0 from 2026-08-09 until this migration. Nullable: the parser emits NULL for a blank cell.';

-- ── (b) somewhere to record an abandonment ──────────────────────────────────
ALTER TABLE scorecard_report_snapshots
  ADD COLUMN IF NOT EXISTS abandoned_at     timestamptz,
  ADD COLUMN IF NOT EXISTS abandoned_reason text;

COMMENT ON COLUMN scorecard_report_snapshots.abandoned_at IS
  'Set by lp_csv_reap_orphan_snapshots when a chunked ingest began, never finalized, and loaded no rows. The row is kept for audit; its file_sha256 is prefixed and its content_sha256 nulled so both unique keys are released and a corrected re-send can land. Distinct from finalized_at IS NULL, which is also the permanent resting state of every PDF snapshot.';
COMMENT ON COLUMN scorecard_report_snapshots.abandoned_reason IS
  'Free text describing why the snapshot was reaped. Never parsed.';

-- ── (c) a log status for it ─────────────────────────────────────────────────
-- Postgres cannot extend a CHECK; re-create it wholesale, the established
-- pattern here. logIngest() swallows write errors to console, so a status the
-- CHECK rejects would vanish silently rather than fail loudly.
ALTER TABLE scorecard_ingest_log DROP CONSTRAINT IF EXISTS scorecard_ingest_log_status_check;
ALTER TABLE scorecard_ingest_log ADD CONSTRAINT scorecard_ingest_log_status_check
  CHECK (status IN ('success', 'succeeded', 'succeeded_with_warnings',
                    'failed', 'duplicate', 'superseded', 'no_text_layer', 'reaped'));

-- ── (d) the reaper ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.lp_csv_reap_orphan_snapshots(p_age_minutes integer DEFAULT 60)
RETURNS integer LANGUAGE plpgsql AS $function$
DECLARE
  r        record;
  v_rows   bigint;
  v_reaped integer := 0;
  v_cutoff timestamptz := now() - make_interval(mins => GREATEST(p_age_minutes, 0));
BEGIN
  FOR r IN
    SELECT id, report_type, file_sha256, ingested_at, storage_path
      FROM scorecard_report_snapshots
     WHERE source_format = 'csv'     -- ← see the SAFETY note in this file's header
       AND finalized_at IS NULL
       AND abandoned_at IS NULL
       AND ingested_at < v_cutoff
     ORDER BY ingested_at
     FOR UPDATE
  LOOP
    -- A snapshot that loaded rows is not an orphan this function may clear.
    IF    r.report_type = 'job_status_ytd'           THEN
      SELECT count(*) INTO v_rows FROM lp_job_status_history       WHERE snapshot_id = r.id;
    ELSIF r.report_type = 'lead_disposition'         THEN
      SELECT count(*) INTO v_rows FROM lp_lead_disposition_history WHERE snapshot_id = r.id;
    ELSIF r.report_type = 'source_cost'              THEN
      SELECT count(*) INTO v_rows FROM lp_source_cost_history      WHERE snapshot_id = r.id;
    ELSIF r.report_type = 'sales_efficiency'         THEN
      SELECT count(*) INTO v_rows FROM lp_sales_efficiency_history WHERE snapshot_id = r.id;
    ELSIF r.report_type = 'appt_stats_by_rep_source' THEN
      SELECT count(*) INTO v_rows FROM lp_appt_stats_history       WHERE snapshot_id = r.id;
    ELSE
      -- An unrecognised chunked type: leave it alone rather than guess.
      CONTINUE;
    END IF;

    IF v_rows > 0 THEN
      CONTINUE;
    END IF;

    UPDATE scorecard_report_snapshots
       SET abandoned_at     = now(),
           abandoned_reason = format(
             'reaped after %s min: began %s, never finalized, zero rows loaded',
             p_age_minutes, r.ingested_at),
           -- Release BOTH unique keys while keeping the row. file_sha256 is
           -- NOT NULL so it is prefixed; content_sha256's index is partial on
           -- IS NOT NULL so nulling it is enough.
           file_sha256      = 'abandoned:' || r.id::text || ':' || r.file_sha256,
           content_sha256   = NULL,
           is_current       = false
     WHERE id = r.id;

    INSERT INTO scorecard_ingest_log
      (report_type, file_sha256, status, failure_reason, detail, snapshot_id, source)
    VALUES
      (r.report_type, r.file_sha256, 'reaped', NULL,
       jsonb_build_object(
         'snapshot_id',   r.id,
         'ingested_at',   r.ingested_at,
         'storage_path',  r.storage_path,
         'age_minutes',   p_age_minutes,
         'released_keys', jsonb_build_array('file_sha256', 'content_sha256'),
         'message',       'orphaned chunked ingest marked abandoned; both unique keys released so a corrected re-send can land'),
       r.id, 'reaper');

    v_reaped := v_reaped + 1;
  END LOOP;

  RETURN v_reaped;
END;
$function$;

COMMENT ON FUNCTION public.lp_csv_reap_orphan_snapshots(integer) IS
  'Marks chunked (CSV) snapshots that began, never finalized, and loaded no rows as abandoned, releasing both unique keys so a corrected re-send can land. Scoped to source_format = ''csv'': PDF snapshots rest at finalized_at IS NULL permanently and six are is_current, so a wider predicate would blank the dashboard. Returns the number reaped.';

COMMIT;

-- ── Verification ────────────────────────────────────────────────────────────
-- 1. The column exists and nothing else moved:
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'lp_job_status_history' AND column_name = 'city';
--
-- 2. What the reaper WOULD take, before taking it (expect 11 job_status_ytd):
-- SELECT report_type, source_format, count(*)
--   FROM scorecard_report_snapshots
--  WHERE source_format = 'csv' AND finalized_at IS NULL AND abandoned_at IS NULL
--  GROUP BY 1,2;
--
-- 3. What it must NEVER take (expect 19 rows, 6 of them is_current):
-- SELECT report_type, count(*), count(*) FILTER (WHERE is_current) AS current_n
--   FROM scorecard_report_snapshots
--  WHERE source_format = 'pdf' AND finalized_at IS NULL
--  GROUP BY 1;
--
-- 4. Reap, then confirm no CSV orphan remains and the PDF count is unchanged:
-- SELECT lp_csv_reap_orphan_snapshots(0);
-- SELECT status, count(*) FROM scorecard_ingest_log WHERE source = 'reaper' GROUP BY 1;
