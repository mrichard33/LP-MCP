-- ════════════════════════════════════════════════════════════════════
-- 2026-08-10 — Report 134: the missing lp_csv_ingest_rows branch,
--              and the reaper ladder that also did not know the type
--
-- Applied BY HAND per sql/README.md. Idempotent: safe to re-run.
--
-- ══ WHY ══
--
-- Posting a real 134 export created a snapshot and then died:
--
--   row load failed at chunk 0: lp_csv_ingest_rows: snapshot <id>
--   has non-CSV report_type jobs_by_milestone
--
-- Note WHICH function raised it. This reads as a finalize problem — the JS
-- logs it as `finalize_assertion` — but that label is an artifact of
-- ingestCsv's catch block, which wraps loadChunked and lp_csv_ingest_finalize
-- in ONE try and names every error in it after the latter. The raise is
-- lp_csv_ingest_rows', from its ELSE arm.
--
-- Report 134 was already wired everywhere else:
--
--   CSV_REPORT_TYPES         'jobs-by-milestone' → jobs_by_milestone   ✓
--   ingestCsv                dispatch branch, parser, market resolve   ✓
--   lp_csv_ingest_begin      report_type whitelist                     ✓
--   lp_csv_ingest_finalize   row-count branch (scorecard_report_rows_a)✓
--   lp_csv_ingest_finalize   control-total ladder (gross/net/row_count)✓
--   lp_csv_ingest_rows       — NOTHING —                               ✗
--
-- So begin accepted the snapshot, the row load hit the ELSE and threw, and
-- the snapshot stayed behind holding both unique keys. One missing ELSIF,
-- and the same orphan-per-attempt shape as the 133 `city` defect.
--
-- ══ WHAT IS NOT CHANGED ══
--
-- ONLY lp_csv_ingest_rows is replaced. lp_csv_ingest_finalize already carries
-- its jobs_by_milestone branches and is deliberately left alone — reproducing
-- it here from an older file would REGRESS it.
--
-- No JS change is required, and in particular no new lp_csv_ingest_begin call
-- site and no new probeExistingSnapshot call site: the counts pinned at 4 and
-- 5 in scripts/test-lp-csv-cutover.js are correct as they stand and must NOT
-- be bumped for this.
--
-- ══ SHAPE ══
--
-- The recordset column list mirrors, field for field, the row objects
-- ingestCsv builds for this type, and scorecard_report_rows_a's columns match
-- 1:1. computeMilestoneTotals emits exactly {gross_cents, net_cents,
-- row_count} — precisely the three keys finalize's ladder resolves, so there
-- is no `unknown control key` exposure.
--
-- market is NOT NULL on the target table. That is safe: the 134 branch fails
-- CLOSED on an unmapped branch code (quarantines the rows and rejects the
-- file) before any row reaches here, so market is always resolved.
--
-- ══ CLASS ══ Purely additive — one CREATE OR REPLACE adding a branch. No
-- DDL, no backfill, no constraint change. Eligible for MCP apply_migration.
--
-- ROLLBACK: re-apply the lp_csv_ingest_rows definition from
--   sql/migrations/2026-08-07_job_status_cohort_realign.sql (identical to this
--   one minus the jobs_by_milestone ELSIF). Note that 134 CSV ingests then
--   fail again, each leaving an orphan.
--
-- AFTER RUNNING:
--   1. Re-POST a 134 export; expect success:true and fact rows.
--   2. SELECT lp_csv_reap_orphan_snapshots(0); to clear the CSV orphans the
--      failed attempts left. They are in scope: source_format = 'csv',
--      finalized_at IS NULL, and zero rows loaded. The 10 PDF-era
--      jobs_by_milestone orphans are NOT in scope and stay put.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.lp_csv_ingest_rows(p_snapshot_id uuid, p_rows jsonb)
RETURNS integer LANGUAGE plpgsql AS $function$
DECLARE
  v_type     text;
  v_final    timestamptz;
  v_inserted int;
BEGIN
  SELECT report_type, finalized_at INTO v_type, v_final
  FROM scorecard_report_snapshots WHERE id = p_snapshot_id;
  IF v_type IS NULL THEN
    RAISE EXCEPTION 'lp_csv_ingest_rows: snapshot % not found', p_snapshot_id;
  END IF;
  IF v_final IS NOT NULL THEN
    RAISE EXCEPTION 'lp_csv_ingest_rows: snapshot % already finalized — rows are immutable', p_snapshot_id;
  END IF;

  IF v_type = 'job_status_ytd' THEN
    INSERT INTO lp_job_status_history
      (snapshot_id, row_num, lp_id, job_id, contract_id, customer_name, phone, city,
       contract_date, status_raw, bucket, gross_cents, total_due_cents,
       sub_source, product_ids, finance_sources, district_raw, market_code_raw,
       branch_code_raw, market, market_method, notes_raw, cohort_basis)
    SELECT p_snapshot_id, r.row_num, r.lp_id, r.job_id, r.contract_id, r.customer_name, r.phone, r.city,
           r.contract_date, r.status_raw, r.bucket, r.gross_cents, r.total_due_cents,
           r.sub_source, r.product_ids, r.finance_sources, r.district_raw, r.market_code_raw,
           r.branch_code_raw, r.market, r.market_method, r.notes_raw, r.cohort_basis
    FROM jsonb_to_recordset(p_rows) AS r(
      row_num integer, lp_id text, job_id text, contract_id text, customer_name text,
      phone text, city text, contract_date date, status_raw text, bucket text,
      gross_cents bigint, total_due_cents bigint, sub_source text,
      product_ids text[], finance_sources text[], district_raw text, market_code_raw text,
      branch_code_raw text, market text, market_method text, notes_raw text, cohort_basis text);
  ELSIF v_type = 'lead_disposition' THEN
    INSERT INTO lp_lead_disposition_history
      (snapshot_id, row_num, lp_lead_id, entry_date, category, dsp_descr, last_result,
       src_id, sub_source, promoter, city, state, zip, num_dials, num_superseded,
       appt_date, job_status, gsa_cents, net_cents, brn_id_raw, market, market_method)
    SELECT p_snapshot_id, r.row_num, r.lp_lead_id, r.entry_date, r.category, r.dsp_descr, r.last_result,
           r.src_id, r.sub_source, r.promoter, r.city, r.state, r.zip, r.num_dials, r.num_superseded,
           r.appt_date, r.job_status, r.gsa_cents, r.net_cents, r.brn_id_raw, r.market, r.market_method
    FROM jsonb_to_recordset(p_rows) AS r(
      row_num integer, lp_lead_id text, entry_date date, category text, dsp_descr text,
      last_result text, src_id text, sub_source text, promoter text, city text, state text,
      zip text, num_dials integer, num_superseded integer, appt_date date, job_status text,
      gsa_cents bigint, net_cents bigint, brn_id_raw text, market text, market_method text);
  ELSIF v_type = 'source_cost' THEN
    INSERT INTO lp_source_cost_history
      (snapshot_id, row_num, sub_source, num_raw, num_set, num_cnf, num_issued,
       num_sat, num_sold, num_net_sold, gsa_cents, nsa_cents, mcost_cents, working_cents)
    SELECT p_snapshot_id, r.row_num, r.sub_source, r.num_raw, r.num_set, r.num_cnf, r.num_issued,
           r.num_sat, r.num_sold, r.num_net_sold, r.gsa_cents, r.nsa_cents, r.mcost_cents, r.working_cents
    FROM jsonb_to_recordset(p_rows) AS r(
      row_num integer, sub_source text, num_raw integer, num_set integer, num_cnf integer,
      num_issued integer, num_sat integer, num_sold integer, num_net_sold integer,
      gsa_cents bigint, nsa_cents bigint, mcost_cents bigint, working_cents bigint);
  ELSIF v_type = 'sales_efficiency' THEN
    INSERT INTO lp_sales_efficiency_history
      (snapshot_id, row_num, branch_code_raw, market, num_issued, num_net_issued,
       num_sat, num_sold, gsa_cents, num_net, nsa_cents, num_working, working_cents,
       num_cd, cd_cents, num_cancelled, cancelled_cents, num_hold, hold_cents)
    SELECT p_snapshot_id, r.row_num, r.branch_code_raw, r.market, r.num_issued, r.num_net_issued,
           r.num_sat, r.num_sold, r.gsa_cents, r.num_net, r.nsa_cents, r.num_working, r.working_cents,
           r.num_cd, r.cd_cents, r.num_cancelled, r.cancelled_cents, r.num_hold, r.hold_cents
    FROM jsonb_to_recordset(p_rows) AS r(
      row_num integer, branch_code_raw text, market text, num_issued integer,
      num_net_issued integer, num_sat integer, num_sold integer, gsa_cents bigint,
      num_net integer, nsa_cents bigint, num_working integer, working_cents bigint,
      num_cd integer, cd_cents bigint, num_cancelled integer, cancelled_cents bigint,
      num_hold integer, hold_cents bigint);
  ELSIF v_type = 'appt_stats_by_rep_source' THEN
    INSERT INTO lp_appt_stats_history
      (snapshot_id, row_num, salesrep_raw, src_id_raw, num_set, num_issued,
       num_net_issued, num_sat, num_sale, gsa_cents, nsa_cents,
       num_other, num_other2, dispositions)
    SELECT p_snapshot_id, r.row_num, r.salesrep_raw, r.src_id_raw, r.num_set, r.num_issued,
           r.num_net_issued, r.num_sat, r.num_sale, r.gsa_cents, r.nsa_cents,
           r.num_other, r.num_other2, COALESCE(r.dispositions, '{}'::jsonb)
    FROM jsonb_to_recordset(p_rows) AS r(
      row_num integer, salesrep_raw text, src_id_raw text, num_set integer,
      num_issued integer, num_net_issued integer, num_sat integer, num_sale integer,
      gsa_cents bigint, nsa_cents bigint, num_other integer, num_other2 integer,
      dispositions jsonb);
  ELSIF v_type = 'jobs_by_milestone' THEN
    INSERT INTO scorecard_report_rows_a
      (snapshot_id, job_number, customer_name, address, city, contract_date, rtp_date,
       branch_code_raw, market, product, gross_cents, net_cents,
       paid_cents, balance_cents, sales_rep)
    SELECT p_snapshot_id, r.job_number, r.customer_name, r.address, r.city, r.contract_date, r.rtp_date,
           r.branch_code_raw, r.market, r.product, r.gross_cents, r.net_cents,
           r.paid_cents, r.balance_cents, r.sales_rep
    FROM jsonb_to_recordset(p_rows) AS r(
      job_number text, customer_name text, address text, city text,
      contract_date date, rtp_date date, branch_code_raw text, market text,
      product text, gross_cents bigint, net_cents bigint,
      paid_cents bigint, balance_cents bigint, sales_rep text);
  ELSE
    RAISE EXCEPTION 'lp_csv_ingest_rows: snapshot % has non-CSV report_type %', p_snapshot_id, v_type;
  END IF;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$function$;

-- ── (b) the reaper must learn the new type as well ──────────────────────────
--
-- SUPERSEDED-BY(lp_csv_reap_orphan_snapshots): 2026-08-10_snapshot_empty_release.sql
--
-- The version below is kept as the record of what was applied at this point in
-- the day, but it is NOT the definition in force. Its predicate
-- (finalized_at IS NULL AND source_format = 'csv') was wrong on both counts and
-- was replaced hours later — see the newer file. Do not read this as current.
--
-- Found the hard way, minutes after (a) was applied: the orphan left by the
-- failed 134 attempts passed lp_csv_reap_orphan_snapshots' source_format='csv'
-- predicate and was STILL skipped, because that function decides "did this
-- snapshot load rows?" from its own per-type ladder — which knew only the five
-- types lp_csv_ingest_rows handled when it was written. A sixth type fell to
-- the ELSE and was silently passed over.
--
-- So a chunked report type must be added in THREE places, not two:
--   lp_csv_ingest_rows · lp_csv_ingest_finalize · lp_csv_reap_orphan_snapshots
--
-- The ELSE now RAISEs a WARNING rather than skipping mutely, so the next
-- omission announces itself in the logs instead of presenting as "the reaper
-- ran and found nothing".
--
-- jobs_by_status is added at the same time. It is in lp_csv_ingest_begin's
-- whitelist and has a finalize branch, so a CSV of that type can reach the same
-- dead end; giving the reaper a branch for it costs nothing and closes it.

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
     WHERE source_format = 'csv'
       AND finalized_at IS NULL
       AND abandoned_at IS NULL
       AND ingested_at < v_cutoff
     ORDER BY ingested_at
     FOR UPDATE
  LOOP
    -- Every report_type lp_csv_ingest_begin will accept must appear here, or an
    -- orphan of that type falls to the ELSE and is silently never reaped.
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
    ELSIF r.report_type = 'jobs_by_milestone'        THEN
      SELECT count(*) INTO v_rows FROM scorecard_report_rows_a     WHERE snapshot_id = r.id;
    ELSIF r.report_type = 'jobs_by_status'           THEN
      SELECT count(*) INTO v_rows FROM scorecard_report_rows_b     WHERE snapshot_id = r.id;
    ELSE
      -- Still fail safe rather than guess: skip, do not assume zero rows.
      RAISE WARNING 'lp_csv_reap_orphan_snapshots: no row-count branch for report_type % (snapshot %) — skipped, not reaped', r.report_type, r.id;
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

COMMIT;

-- ── Verification ────────────────────────────────────────────────────────────
-- 1. The branch exists (expect 1):
-- SELECT count(*) FROM regexp_matches(
--   pg_get_functiondef('public.lp_csv_ingest_rows(uuid,jsonb)'::regprocedure),
--   'jobs_by_milestone', 'g');
--
-- 2. After a re-POST, rows actually landed:
-- SELECT s.id, s.row_count, count(a.*) AS loaded, s.finalized_at
--   FROM scorecard_report_snapshots s
--   LEFT JOIN scorecard_report_rows_a a ON a.snapshot_id = s.id
--  WHERE s.report_type = 'jobs_by_milestone' AND s.source_format = 'csv'
--  GROUP BY s.id, s.row_count, s.finalized_at ORDER BY s.ingested_at DESC LIMIT 3;
--
-- 3. No CSV orphan left behind, and the 10 PDF ones untouched:
-- SELECT source_format, count(*) FILTER (WHERE finalized_at IS NULL AND abandoned_at IS NULL)
--   FROM scorecard_report_snapshots WHERE report_type = 'jobs_by_milestone' GROUP BY 1;
