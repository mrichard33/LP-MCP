-- 2026-08-06_csv_content_identity_smoke.sql
--
-- Run AFTER applying sql/migrations/2026-08-06_csv_content_identity.sql, in the
-- Supabase SQL editor, as ONE statement batch. Everything happens inside a
-- transaction that ROLLS BACK — nothing persists, no matter what.
--
-- Self-checking: any violated invariant RAISEs and aborts. Success prints one
-- NOTICE at the end. Synthetic snapshots use long-past periods (2019) and
-- sentinel file_sha256 values ('smoke-csvid-%') so they cannot collide with
-- production data even if the rollback were somehow skipped. The periods are
-- PAST, not future: closure is gated on period_end < today, so a future period
-- could never exercise it and checks 4 and 6 would pass vacuously.
--
-- Guards, in order:
--   1. lp_is_partial_coverage — the ET boundary, including the 21:00-on-the-31st
--      case a naive UTC comparison gets wrong.
--   2. content_sha256 is actually PERSISTED (it never was — the whole point).
--   3. A partial-coverage snapshot does NOT close its period.
--   4. A complete snapshot for an ended period DOES close it.
--   5. Unknown coverage (NULL) does NOT close a period — IS FALSE, not NOT.
--   6. The closing pull supersedes the in-month snapshot, logs 'superseded'
--      with both ids, and RETENTION HOLDS: the demoted snapshot and its rows
--      still exist.
--   7. The ingest-log CHECK admits the statuses the code actually writes.

BEGIN;

DO $smoke$
DECLARE
  v_inmonth  uuid;
  v_closing  uuid;
  v_restate  uuid;
  v_unknown  uuid;
  v_partial  boolean;
  v_closed   timestamptz;
  v_content  text;
  v_rows     int;
  v_log      int;
BEGIN
  -- ── 1. coverage boundary ─────────────────────────────────────────────────
  IF lp_is_partial_coverage('2026-09-01T01:00:00Z'::timestamptz, '2026-08-31'::date) IS NOT TRUE THEN
    RAISE EXCEPTION 'coverage: 21:00 EDT on the 31st (01:00Z on the 1st) must read as PARTIAL';
  END IF;
  IF lp_is_partial_coverage('2026-09-03T22:00:00Z'::timestamptz, '2026-08-31'::date) IS NOT FALSE THEN
    RAISE EXCEPTION 'coverage: a run after period_end must read as COMPLETE';
  END IF;
  IF lp_is_partial_coverage(NULL, '2026-08-31'::date) IS NOT NULL THEN
    RAISE EXCEPTION 'coverage: unknown generation time must stay NULL, never guess';
  END IF;

  -- ── 2-3. in-month pull: identity persisted, period NOT closed ────────────
  v_inmonth := lp_csv_ingest_begin(jsonb_build_object(
    'report_type', 'sales_efficiency',
    'period_start', '2019-08-01', 'period_end', '2019-08-31',
    'report_generated_at', '2019-08-31T21:00:00-04:00',
    'file_sha256', 'smoke-csvid-inmonth', 'content_sha256', 'smoke-content-aug',
    'parser_version', 'csv-v1', 'storage_path', 'smoke/inmonth.csv',
    'row_count', 1, 'scope', 'month', 'source_format', 'csv',
    'control_totals', jsonb_build_object('num_issued', 5)));

  SELECT content_sha256, is_partial_month INTO v_content, v_partial
    FROM scorecard_report_snapshots WHERE id = v_inmonth;
  IF v_content IS DISTINCT FROM 'smoke-content-aug' THEN
    RAISE EXCEPTION 'identity: content_sha256 not persisted (got %) — the column was inert before this migration', v_content;
  END IF;
  IF v_partial IS NOT TRUE THEN
    RAISE EXCEPTION 'coverage: a 21:00-on-the-31st run must store is_partial_month = true, got %', v_partial;
  END IF;

  INSERT INTO lp_sales_efficiency_history (snapshot_id, row_num, branch_code_raw, market, num_issued)
  VALUES (v_inmonth, 1, 'BOCA', 'FTLAU_MKT', 5);
  PERFORM lp_csv_ingest_finalize(v_inmonth);

  SELECT period_closed_at INTO v_closed FROM scorecard_report_snapshots WHERE id = v_inmonth;
  IF v_closed IS NOT NULL THEN
    RAISE EXCEPTION 'closure: a PARTIAL snapshot must never close its period';
  END IF;

  -- ── 4/6. the [BOPM]/[EOPM] closing pull ──────────────────────────────────
  -- Same period key, generated after the month ended. It must supersede the
  -- in-month snapshot and be the one that closes.
  v_closing := lp_csv_ingest_begin(jsonb_build_object(
    'report_type', 'sales_efficiency',
    'period_start', '2019-08-01', 'period_end', '2019-08-31',
    'report_generated_at', '2019-09-03T18:00:00-04:00',
    'file_sha256', 'smoke-csvid-closing', 'content_sha256', 'smoke-content-sep',
    'parser_version', 'csv-v1', 'storage_path', 'smoke/closing.csv',
    'row_count', 1, 'scope', 'month', 'source_format', 'csv',
    'control_totals', jsonb_build_object('num_issued', 7)));

  INSERT INTO lp_sales_efficiency_history (snapshot_id, row_num, branch_code_raw, market, num_issued)
  VALUES (v_closing, 1, 'BOCA', 'FTLAU_MKT', 7);
  PERFORM lp_csv_ingest_finalize(v_closing);

  SELECT period_closed_at INTO v_closed FROM scorecard_report_snapshots WHERE id = v_closing;
  IF v_closed IS NULL THEN
    RAISE EXCEPTION 'closure: a COMPLETE snapshot of an ended period must close it';
  END IF;
  IF (SELECT is_current FROM scorecard_report_snapshots WHERE id = v_closing) IS NOT TRUE THEN
    RAISE EXCEPTION 'promotion: the closing pull must become current';
  END IF;
  IF (SELECT is_current FROM scorecard_report_snapshots WHERE id = v_inmonth) IS NOT FALSE THEN
    RAISE EXCEPTION 'promotion: the in-month snapshot must be demoted by the closing pull';
  END IF;

  -- RETENTION GUARANTEE — demoted is not deleted.
  SELECT COUNT(*) INTO v_rows FROM lp_sales_efficiency_history WHERE snapshot_id = v_inmonth;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'retention: superseded snapshot lost its rows (found %)', v_rows;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM scorecard_report_snapshots WHERE id = v_inmonth) THEN
    RAISE EXCEPTION 'retention: superseded snapshot was deleted';
  END IF;

  -- ── 5. unknown coverage must not close ───────────────────────────────────
  v_unknown := lp_csv_ingest_begin(jsonb_build_object(
    'report_type', 'sales_efficiency',
    'period_start', '2019-06-01', 'period_end', '2019-06-30',
    'file_sha256', 'smoke-csvid-unknown', 'storage_path', 'smoke/unknown.csv',
    'row_count', 1, 'scope', 'month', 'source_format', 'pdf',
    'control_totals', jsonb_build_object('num_issued', 1)));
  IF (SELECT is_partial_month FROM scorecard_report_snapshots WHERE id = v_unknown) IS NOT NULL THEN
    RAISE EXCEPTION 'coverage: no generation time must leave is_partial_month NULL';
  END IF;
  INSERT INTO lp_sales_efficiency_history (snapshot_id, row_num, branch_code_raw, market, num_issued)
  VALUES (v_unknown, 1, 'BOCA', 'FTLAU_MKT', 1);
  PERFORM lp_csv_ingest_finalize(v_unknown);
  IF (SELECT period_closed_at FROM scorecard_report_snapshots WHERE id = v_unknown) IS NOT NULL THEN
    RAISE EXCEPTION 'closure: UNKNOWN coverage must not close a period (IS FALSE, not NOT)';
  END IF;

  -- ── 6b. displacing an IN-FLIGHT snapshot is routine — no supersede row ───
  -- This happens on every daily pull. Logging it would bury the one event that
  -- actually matters below hundreds that do not.
  SELECT COUNT(*) INTO v_log FROM scorecard_ingest_log
   WHERE status = 'superseded' AND detail->>'superseded_snapshot_id' = v_inmonth::text;
  IF v_log <> 0 THEN
    RAISE EXCEPTION 'supersede: demoting an unclosed snapshot must not log superseded (found %)', v_log;
  END IF;

  -- ── 6c. displacing a CLOSED snapshot IS recorded, with both ids ──────────
  -- A restated closed month is the notable event: the number someone already
  -- reported has changed.
  v_restate := lp_csv_ingest_begin(jsonb_build_object(
    'report_type', 'sales_efficiency',
    'period_start', '2019-08-01', 'period_end', '2019-08-31',
    'report_generated_at', '2019-09-10T18:00:00-04:00',
    'file_sha256', 'smoke-csvid-restate', 'content_sha256', 'smoke-content-restated',
    'parser_version', 'csv-v1', 'storage_path', 'smoke/restate.csv',
    'row_count', 1, 'scope', 'month', 'source_format', 'csv',
    'control_totals', jsonb_build_object('num_issued', 9)));

  INSERT INTO lp_sales_efficiency_history (snapshot_id, row_num, branch_code_raw, market, num_issued)
  VALUES (v_restate, 1, 'BOCA', 'FTLAU_MKT', 9);
  PERFORM lp_csv_ingest_finalize(v_restate);

  SELECT COUNT(*) INTO v_log FROM scorecard_ingest_log
   WHERE status = 'superseded'
     AND detail->>'superseded_snapshot_id' = v_closing::text
     AND detail->>'superseding_snapshot_id' = v_restate::text;
  IF v_log <> 1 THEN
    RAISE EXCEPTION 'supersede: restating a CLOSED period must log exactly one row naming both snapshots, found %', v_log;
  END IF;
  IF (SELECT period_closed_at FROM scorecard_report_snapshots WHERE id = v_restate) IS NULL THEN
    RAISE EXCEPTION 'closure: the restating snapshot must itself close the period';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM scorecard_report_snapshots
                  WHERE id = v_closing AND period_closed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'retention: a superseded snapshot keeps its own closure record';
  END IF;

  -- ── 7. the ingest-log CHECK admits what the code writes ──────────────────
  INSERT INTO scorecard_ingest_log (report_type, status, source)
  VALUES ('sales_efficiency', 'succeeded', 'smoke'),
         ('sales_efficiency', 'succeeded_with_warnings', 'smoke'),
         ('sales_efficiency', 'superseded', 'smoke');

  RAISE NOTICE 'csv_content_identity smoke: ALL CHECKS PASSED (rolling back)';
END;
$smoke$;

ROLLBACK;
