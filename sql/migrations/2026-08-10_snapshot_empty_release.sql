-- ════════════════════════════════════════════════════════════════════
-- 2026-08-10 — An EMPTY snapshot is not a duplicate, and the reaper was
--              predicated on the wrong thing
--
-- Applied BY HAND per sql/README.md. Idempotent: safe to re-run.
--
-- ══ WHY (the finding that outranked everything else) ══
--
-- During the 2026-08-10 manual backfill, POSTing report 138 January and
-- February returned:
--
--   { success: true, duplicate: true, matched_on: "content_sha256" }
--
-- against snapshots f9a833ad-2070-4ea3-88b7-73ef56841f8f and
-- 08b785f3-488f-47a6-8873-4bbfe15c2a74 — both holding ZERO rows. Eight
-- consecutive uploads reported success while nothing landed. That is the worst
-- available failure mode, because it is indistinguishable from working.
--
-- Cause: the disposition gate rejected AFTER lp_csv_ingest_begin had committed
-- the snapshot, so the row survived holding content_sha256, and every later
-- post matched it. A duplicate response asserts "these bytes are already
-- stored"; against a zero-row snapshot that assertion is simply false.
--
-- ══ WHY THE REAPER WOULD NOT HAVE CAUGHT THEM ══
--
-- The reaper shipped earlier today scoped on
-- `finalized_at IS NULL AND source_format = 'csv'`. Both filters are wrong:
--
--   • Both blocking snapshots were FINALIZED (2026-08-07 22:03, 2026-08-08
--     00:00) and empty. `finalized_at IS NULL` walks straight past them.
--   • Four empty snapshots are PDF (lead_disposition). That path writes rows
--     via lp_lead_disposition_pdf_rows, so empty is a genuine failure there
--     too — `source_format = 'csv'` excluded real cases.
--
-- The defect was never "unfinalized" or "CSV". It is ZERO ROWS IN THE MATCHING
-- HISTORY TABLE. Predicating on that is also SAFER than the old filter, not
-- looser: of the 19 PDF snapshots with finalized_at IS NULL that the old
-- carve-out existed to protect, 15 hold rows and are protected by the row check
-- itself, and none of the 6 is_current ones is empty.
--
-- ══ WHAT IS DELIBERATELY NOT A FORMAT FILTER ══
--
-- v_rowless_ok enumerates report types that legitimately store no per-row
-- detail. It is EMPTY today — all seven types write rows somewhere — and it
-- exists as a named list so a future aggregate-only report is added on purpose
-- rather than by re-introducing a blunt source_format filter.
--
-- lp_snapshot_row_count returns NULL for a type it cannot count. Every caller
-- must read NULL as "assume populated". Guessing zero is how a snapshot holding
-- real data would get released.
--
-- ══ CLASS ══ Purely additive: two new functions, one CREATE OR REPLACE of an
-- existing one. No DDL, no backfill. Eligible for MCP apply_migration.
--
-- ROLLBACK:
--   Re-apply lp_csv_reap_orphan_snapshots from
--   sql/migrations/2026-08-10_jobs_by_milestone_csv_rows.sql (the finalized_at
--   + source_format version), then:
--     DROP FUNCTION IF EXISTS public.lp_csv_release_snapshot(uuid, text);
--     DROP FUNCTION IF EXISTS public.lp_snapshot_row_count(uuid);
--   Note the JS in src/jobs/lp-report-ingest.js calls both; roll that back too
--   or the probe path errors on every duplicate.
--
-- AFTER RUNNING:
--   SELECT lp_csv_reap_orphan_snapshots(0);   -- clears empties the old
--                                             -- predicate could not see
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── (a) how many rows a snapshot actually holds ─────────────────────────────
CREATE OR REPLACE FUNCTION public.lp_snapshot_row_count(p_snapshot_id uuid)
RETURNS bigint LANGUAGE plpgsql STABLE AS $function$
DECLARE v_type text; v_rows bigint;
BEGIN
  SELECT report_type INTO v_type FROM scorecard_report_snapshots WHERE id = p_snapshot_id;
  IF v_type IS NULL THEN RETURN NULL; END IF;

  IF    v_type = 'job_status_ytd'           THEN SELECT count(*) INTO v_rows FROM lp_job_status_history       WHERE snapshot_id = p_snapshot_id;
  ELSIF v_type = 'lead_disposition'         THEN SELECT count(*) INTO v_rows FROM lp_lead_disposition_history WHERE snapshot_id = p_snapshot_id;
  ELSIF v_type = 'source_cost'              THEN SELECT count(*) INTO v_rows FROM lp_source_cost_history      WHERE snapshot_id = p_snapshot_id;
  ELSIF v_type = 'sales_efficiency'         THEN SELECT count(*) INTO v_rows FROM lp_sales_efficiency_history WHERE snapshot_id = p_snapshot_id;
  ELSIF v_type = 'appt_stats_by_rep_source' THEN SELECT count(*) INTO v_rows FROM lp_appt_stats_history       WHERE snapshot_id = p_snapshot_id;
  ELSIF v_type = 'jobs_by_milestone'        THEN SELECT count(*) INTO v_rows FROM scorecard_report_rows_a     WHERE snapshot_id = p_snapshot_id;
  ELSIF v_type = 'jobs_by_status'           THEN SELECT count(*) INTO v_rows FROM scorecard_report_rows_b     WHERE snapshot_id = p_snapshot_id;
  ELSE  RETURN NULL;
  END IF;
  RETURN v_rows;
END;
$function$;

COMMENT ON FUNCTION public.lp_snapshot_row_count(uuid) IS
  'Rows loaded for a snapshot, by report_type. NULL when the type is unknown — callers must treat NULL as "leave it alone", never as zero.';

-- ── (b) abandon + release both unique keys, keeping the row for audit ───────
-- Extracted so the reaper and the JS duplicate-probe path cannot diverge on
-- what "released" means.
CREATE OR REPLACE FUNCTION public.lp_csv_release_snapshot(p_snapshot_id uuid, p_reason text)
RETURNS boolean LANGUAGE plpgsql AS $function$
DECLARE s record;
BEGIN
  SELECT * INTO s FROM scorecard_report_snapshots WHERE id = p_snapshot_id FOR UPDATE;
  IF s.id IS NULL OR s.abandoned_at IS NOT NULL THEN RETURN false; END IF;

  UPDATE scorecard_report_snapshots
     SET abandoned_at     = now(),
         abandoned_reason = p_reason,
         file_sha256      = 'abandoned:' || s.id::text || ':' || s.file_sha256,
         content_sha256   = NULL,
         is_current       = false
   WHERE id = p_snapshot_id;

  INSERT INTO scorecard_ingest_log
    (report_type, file_sha256, status, failure_reason, detail, snapshot_id, source)
  VALUES
    (s.report_type, s.file_sha256, 'reaped', NULL,
     jsonb_build_object(
       'snapshot_id', s.id, 'ingested_at', s.ingested_at, 'storage_path', s.storage_path,
       'was_finalized', (s.finalized_at IS NOT NULL), 'was_current', s.is_current,
       'source_format', s.source_format, 'reason', p_reason,
       'released_keys', jsonb_build_array('file_sha256', 'content_sha256')),
     s.id, 'reaper');
  RETURN true;
END;
$function$;

-- ── (c) the reaper, re-predicated on the actual defect ──────────────────────
CREATE OR REPLACE FUNCTION public.lp_csv_reap_orphan_snapshots(p_age_minutes integer DEFAULT 60)
RETURNS integer LANGUAGE plpgsql AS $function$
DECLARE
  r        record;
  v_rows   bigint;
  v_reaped integer := 0;
  v_cutoff timestamptz := now() - make_interval(mins => GREATEST(p_age_minutes, 0));
  -- Report types that legitimately store no per-row detail. Empty by design —
  -- see this file's header before adding to it.
  v_rowless_ok text[] := ARRAY[]::text[];
BEGIN
  FOR r IN
    SELECT id, report_type, finalized_at, is_current, source_format
      FROM scorecard_report_snapshots
     WHERE abandoned_at IS NULL
       AND ingested_at < v_cutoff
     ORDER BY ingested_at
     FOR UPDATE
  LOOP
    IF r.report_type = ANY (v_rowless_ok) THEN CONTINUE; END IF;

    v_rows := lp_snapshot_row_count(r.id);
    -- NULL = unknown type. Skip loudly rather than assume zero.
    IF v_rows IS NULL THEN
      RAISE WARNING 'lp_csv_reap_orphan_snapshots: cannot count rows for report_type % (snapshot %) — skipped, not reaped', r.report_type, r.id;
      CONTINUE;
    END IF;
    IF v_rows > 0 THEN CONTINUE; END IF;

    -- A CURRENT snapshot with zero rows is a false current: it contributes
    -- nothing and shadows whatever it superseded. Worth a WARNING because it
    -- means a promotion happened over an empty load.
    IF r.is_current THEN
      RAISE WARNING 'lp_csv_reap_orphan_snapshots: snapshot % (%) was is_current with ZERO rows — demoting', r.id, r.report_type;
    END IF;

    PERFORM lp_csv_release_snapshot(
      r.id,
      format('reaped after %s min: zero rows loaded (finalized=%s, current=%s, format=%s)',
             p_age_minutes, (r.finalized_at IS NOT NULL), r.is_current, r.source_format));
    v_reaped := v_reaped + 1;
  END LOOP;

  RETURN v_reaped;
END;
$function$;

COMMENT ON FUNCTION public.lp_csv_reap_orphan_snapshots(integer) IS
  'Releases snapshots holding ZERO rows in their history table, regardless of finalized_at or source_format — those filters missed the finalized-and-empty snapshots that blocked the 2026-08-10 backfill. Keeps the row for audit and frees both unique keys so a re-send can land.';

COMMIT;

-- ── Verification ────────────────────────────────────────────────────────────
-- 1. Nothing current is empty (expect 0):
-- SELECT count(*) FROM scorecard_report_snapshots
--  WHERE is_current AND COALESCE(lp_snapshot_row_count(id), 1) = 0;
--
-- 2. Populated snapshots were untouched — spot-check the 6 is_current PDF ones:
-- SELECT id, report_type, lp_snapshot_row_count(id) AS rows
--   FROM scorecard_report_snapshots
--  WHERE source_format = 'pdf' AND finalized_at IS NULL AND is_current;
--
-- 3. What the reaper released, and why:
-- SELECT report_type, detail->>'reason', detail->>'was_finalized', detail->>'source_format'
--   FROM scorecard_ingest_log WHERE source = 'reaper' ORDER BY created_at DESC LIMIT 10;
