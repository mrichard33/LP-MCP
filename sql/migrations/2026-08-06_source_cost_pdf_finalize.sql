-- 2026-08-06_source_cost_pdf_finalize.sql — promote a report 136 PDF snapshot
--
-- Report 136 is the COMPANY CONTROL-TOTAL AUTHORITY, and lp_csv_ingest_finalize
-- guards that title hard: for source_cost it requires ALL ELEVEN control totals
-- and raises 'refusing to promote unchecked data' if any is missing. That guard
-- is correct for the CSV and must not be weakened.
--
-- The PDF is a LOWER-PRECISION VIEW of the same report and cannot satisfy it:
--
--   · It prints NO cents. `$714,138`, never `$714,138.29`. The CSV path stays
--     the cents-exact authority; a PDF snapshot ties only to the dollar.
--   · It has NO `# Cnf` and NO `# Net Sold` column at all — only Raw, Set,
--     Issue, Demo, Sold and the money columns.
--
-- Those two columns are therefore written NULL, not 0. Zero would be a lie
-- about the control-total authority: a reader summing num_net_sold across the
-- current snapshot would take it as "nothing has netted" rather than "this
-- source cannot say".
--
-- So the PDF gets its own finalize, asserting the NINE columns it actually
-- carries. Consumers tell the two apart by scorecard_report_snapshots
-- .source_format ('pdf' vs 'csv'); the scope families already keep an MTD PDF
-- pull and a YTD CSV backfill from demoting each other.

BEGIN;

CREATE OR REPLACE FUNCTION lp_source_cost_pdf_finalize(p_snapshot_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  s        scorecard_report_snapshots%ROWTYPE;
  v_rows   bigint;
  v_key    text;
  v_actual bigint;
  v_want   bigint;
BEGIN
  SELECT * INTO s FROM scorecard_report_snapshots WHERE id = p_snapshot_id FOR UPDATE;
  IF s.id IS NULL THEN
    RAISE EXCEPTION 'lp_source_cost_pdf_finalize: snapshot % not found', p_snapshot_id;
  END IF;
  IF s.report_type <> 'source_cost' THEN
    RAISE EXCEPTION 'lp_source_cost_pdf_finalize: snapshot % is %, not source_cost', p_snapshot_id, s.report_type;
  END IF;
  IF s.source_format IS DISTINCT FROM 'pdf' THEN
    RAISE EXCEPTION 'lp_source_cost_pdf_finalize: snapshot % is source_format % — the CSV path must use lp_csv_ingest_finalize, which asserts all eleven totals',
      p_snapshot_id, s.source_format;
  END IF;
  IF s.finalized_at IS NOT NULL THEN
    RAISE EXCEPTION 'lp_source_cost_pdf_finalize: snapshot % already finalized', p_snapshot_id;
  END IF;

  SELECT COUNT(*) INTO v_rows FROM lp_source_cost_history WHERE snapshot_id = p_snapshot_id;
  IF v_rows <> s.row_count THEN
    RAISE EXCEPTION 'lp_source_cost_pdf_finalize: % rows loaded, snapshot declares % — aborting', v_rows, s.row_count;
  END IF;

  -- The nine columns the PDF prints. num_cnf and num_net_sold are absent from
  -- the report and stay NULL — they are deliberately NOT asserted here.
  FOREACH v_key IN ARRAY ARRAY['num_raw','num_set','num_issued','num_sat','num_sold',
                               'gsa_cents','nsa_cents','mcost_cents','working_cents'] LOOP
    IF s.control_totals IS NULL OR s.control_totals->>v_key IS NULL THEN
      RAISE EXCEPTION 'lp_source_cost_pdf_finalize: requires control_totals.% — refusing to promote unchecked data', v_key;
    END IF;
    SELECT CASE v_key
      WHEN 'num_raw'       THEN SUM(num_raw)      WHEN 'num_set'      THEN SUM(num_set)
      WHEN 'num_issued'    THEN SUM(num_issued)   WHEN 'num_sat'      THEN SUM(num_sat)
      WHEN 'num_sold'      THEN SUM(num_sold)     WHEN 'gsa_cents'    THEN SUM(gsa_cents)
      WHEN 'nsa_cents'     THEN SUM(nsa_cents)    WHEN 'mcost_cents'  THEN SUM(mcost_cents)
      WHEN 'working_cents' THEN SUM(working_cents) END
    INTO v_actual FROM lp_source_cost_history WHERE snapshot_id = p_snapshot_id;
    v_want := (s.control_totals->>v_key)::bigint;
    IF coalesce(v_actual, 0) <> v_want THEN
      RAISE EXCEPTION 'lp_source_cost_pdf_finalize: % is % in the rows but % in control_totals — aborting',
        v_key, coalesce(v_actual, 0), v_want;
    END IF;
  END LOOP;

  -- Promotion demotes only within the same (report_type, scope) family: an MTD
  -- PDF pull and a YTD CSV backfill answer different windows and must coexist
  -- (2026-08-05 snapshot-scope ruling).
  UPDATE scorecard_report_snapshots
     SET is_current = false
   WHERE report_type = s.report_type
     AND coalesce(scope, '') = coalesce(s.scope, '')
     AND id <> s.id
     AND is_current;

  UPDATE scorecard_report_snapshots
     SET finalized_at = now(), is_current = true
   WHERE id = s.id;

  RETURN v_rows::int;
END $$;

COMMENT ON FUNCTION lp_source_cost_pdf_finalize(uuid) IS
  'Promotes a report 136 PDF snapshot, asserting the NINE columns the PDF '
  'prints. The PDF has no Cnf/NetSold columns and no cents; those stay NULL '
  'rather than 0. The CSV path keeps lp_csv_ingest_finalize and its eleven '
  'cents-exact assertions.';

COMMIT;
