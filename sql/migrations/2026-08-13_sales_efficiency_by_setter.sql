-- ════════════════════════════════════════════════════════════════════
-- Sales Efficiency BY SETTER (LP report 137, setter grouping) — 2026-08-13
--
-- Run in: LP MCP Supabase → SQL Editor (or supabase MCP apply_migration).
-- Idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP CONSTRAINT IF
-- EXISTS + re-add); safe to re-run. Applied manually — code ships
-- separately (no migration runner, no boot-time DDL).
--
-- WHY
--   Mark scheduled report 137 filtered BY SETTER to email at 6:00 AM daily
--   from 2026-08-13. I.LPRA already sweeps every LP .csv into the ingest
--   endpoint, so the file arrives with no n8n change.
--
--   137's By Market, By Setter and By Source exports share a BYTE-IDENTICAL
--   header, so REPORT_FINGERPRINTS resolves all three to 'sales_efficiency'.
--   Left alone, a By Setter file would land in lp_sales_efficiency_history
--   with setter names in branch_code_raw and — because content identity is
--   keyed on report_type — could take is_current from the By Market snapshot
--   the Scorecard reads. A market-level revenue number would silently become
--   a setter-level one.
--
--   NOT HYPOTHETICAL. Snapshot fe5df304-2c90-48fe-a8e0-b413acaebcaf
--   (ingested 2026-08-11) is a By SOURCE export that did exactly this: 29
--   rows of lead sources (Bing PPC, HomeBuddy, Modernize …) sitting in the
--   market table, every one of them market='UNRESOLVED'. Cleaned up by
--   2026-08-13c_purge_by_source_snapshot.sql.
--
--   The discriminator is `xGrouper`, a DATA column present on every row and
--   absent from the header — so resolveVariant reads row 1. See
--   REPORT_VARIANTS in src/jobs/lp-report-csv-common.js.
--
-- NO MARKET COLUMN, DELIBERATELY. Setters do not belong to markets. The
-- column is absent rather than nullable so no future reader can find a
-- `market` on a setter row and believe it. resolveMarketFromBranch is never
-- called on this path.
--
-- ══ RETENTION GUARANTEE — DO NOT PRUNE ══
-- Superseded snapshots and their history rows are NEVER deleted;
-- is_current is a pointer, not a retention policy.
-- ════════════════════════════════════════════════════════════════════

-- ── (a) admit the report type ───────────────────────────────────────────────
-- Both tables carry the same list and both must learn the new value:
-- lp_report_facts builds no setter facts today (the projection is grained on
-- market × branch, which a setter row has neither of), but the constraint is
-- kept in step so adding one later is a function change and not a puzzle.
ALTER TABLE scorecard_report_snapshots DROP CONSTRAINT IF EXISTS scorecard_report_snapshots_report_type_check;
ALTER TABLE scorecard_report_snapshots ADD CONSTRAINT scorecard_report_snapshots_report_type_check
  CHECK (report_type IN ('jobs_by_milestone', 'jobs_by_status',
                         'job_status_ytd', 'lead_disposition', 'source_cost',
                         'sales_efficiency', 'appt_stats_by_rep_source',
                         'sales_efficiency_by_setter'));

ALTER TABLE lp_report_facts DROP CONSTRAINT IF EXISTS lp_report_facts_report_type_check;
ALTER TABLE lp_report_facts ADD CONSTRAINT lp_report_facts_report_type_check
  CHECK (report_type IN ('jobs_by_milestone', 'jobs_by_status',
                         'job_status_ytd', 'lead_disposition', 'source_cost',
                         'sales_efficiency', 'appt_stats_by_rep_source',
                         'sales_efficiency_by_setter'));

-- A recognised-but-unstored variant (By Source today) is archived and logged
-- and nothing more. That log row needs a status, and it is neither a success
-- nor a failure. Without this the insert fails the CHECK and the only record
-- that the file ever arrived is a console line.
ALTER TABLE scorecard_ingest_log DROP CONSTRAINT IF EXISTS scorecard_ingest_log_status_check;
ALTER TABLE scorecard_ingest_log ADD CONSTRAINT scorecard_ingest_log_status_check
  CHECK (status IN ('success', 'succeeded', 'succeeded_with_warnings', 'failed',
                    'duplicate', 'superseded', 'no_text_layer', 'reaped', 'skipped'));

-- ── (b) lp_sales_efficiency_setter_history ──────────────────────────────────
-- Mirrors lp_sales_efficiency_history column for column, with setter_name_raw
-- in place of branch_code_raw and no market. Same MTD guard: cohort columns
-- are blank on MTD pulls, so num_net / nsa_cents are NULL there, never 0.
CREATE TABLE IF NOT EXISTS lp_sales_efficiency_setter_history (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  snapshot_id      uuid NOT NULL REFERENCES scorecard_report_snapshots(id) ON DELETE CASCADE,
  row_num          integer NOT NULL,
  setter_name_raw  text NOT NULL,             -- verbatim Grouper, e.g. 'Deer - LF, Craig'
  num_issued       integer,                   -- NumIssued
  num_net_issued   integer,                   -- NumNetIssued
  num_sat          integer,                   -- NumSat
  num_sold         integer,                   -- NumSale
  gsa_cents        bigint,                    -- GSA
  num_net          integer,                   -- NumNet — NULL on MTD pulls
  nsa_cents        bigint,                    -- NSA — NULL on MTD pulls
  num_working      integer,
  working_cents    bigint,                    -- GSAWorking
  num_cd           integer,
  cd_cents         bigint,                    -- GSACD
  num_cancelled    integer,
  cancelled_cents  bigint,                    -- GSACancelled
  num_hold         integer,
  hold_cents       bigint                     -- GSAHold
);
CREATE UNIQUE INDEX IF NOT EXISTS lp_se_setter_history_snap_row_idx
  ON lp_sales_efficiency_setter_history (snapshot_id, row_num);
CREATE INDEX IF NOT EXISTS lp_se_setter_history_snap_setter_idx
  ON lp_sales_efficiency_setter_history (snapshot_id, setter_name_raw);

COMMENT ON TABLE lp_sales_efficiency_setter_history IS
  'Sales Efficiency BY SETTER (LP report 137, xGrouper="By Setter") rows per import. Money in CENTS. setter_name_raw is the verbatim Grouper label and is NOT stable across exports — LP renames setters in place and not retroactively — so join through lp_setter_roster for anything that counts a person or a partner. No market column by design: setters do not belong to markets. MTD pulls have blank Net columns: num_net/nsa_cents NULL, never 0. Superseded snapshots retained forever.';

-- ── (c) lp_csv_ingest_begin: admit the new type ─────────────────────────────
-- Reproduced from the LIVE definition (2026-08-13) with one value added to
-- the whitelist. Everything else — scope derivation, partial-coverage
-- inference, content_sha256/parser_version/cohort_basis — is unchanged.
CREATE OR REPLACE FUNCTION lp_csv_ingest_begin(p_snapshot jsonb)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_id      uuid;
  v_period  date := (p_snapshot->>'period_start')::date;
  v_pend    date := (p_snapshot->>'period_end')::date;
  v_gen     timestamptz := NULLIF(p_snapshot->>'report_generated_at', '')::timestamptz;
  v_as_of   date := COALESCE(
                      NULLIF(p_snapshot->>'as_of_date', '')::date,
                      (v_gen AT TIME ZONE 'America/New_York')::date,
                      (now() AT TIME ZONE 'America/New_York')::date);
  v_scope   text;
  v_partial boolean;
BEGIN
  IF p_snapshot->>'report_type' NOT IN ('job_status_ytd', 'lead_disposition', 'source_cost',
                                        'sales_efficiency', 'jobs_by_milestone', 'jobs_by_status',
                                        'appt_stats_by_rep_source', 'sales_efficiency_by_setter') THEN
    RAISE EXCEPTION 'lp_csv_ingest_begin: unknown report_type %', p_snapshot->>'report_type';
  END IF;
  v_scope := COALESCE(NULLIF(p_snapshot->>'scope', ''),
                      lp_derive_scope(v_period, v_pend, v_as_of));
  -- Caller may state coverage explicitly; otherwise derive it from the file's
  -- own generation time. NULL stays NULL — an unknown is not a false.
  v_partial := COALESCE((p_snapshot->>'is_partial_month')::boolean,
                        lp_is_partial_coverage(v_gen, v_pend));

  INSERT INTO scorecard_report_snapshots
    (report_type, period_start, period_end, report_generated_at, file_sha256,
     content_sha256, parser_version, storage_path, row_count, as_of_date,
     source_format, control_totals, scope, is_partial_month, cohort_basis, is_current)
  VALUES
    (p_snapshot->>'report_type',
     v_period,
     v_pend,
     v_gen,
     p_snapshot->>'file_sha256',
     NULLIF(p_snapshot->>'content_sha256', ''),
     NULLIF(p_snapshot->>'parser_version', ''),
     p_snapshot->>'storage_path',
     (p_snapshot->>'row_count')::int,
     NULLIF(p_snapshot->>'as_of_date', '')::date,
     COALESCE(NULLIF(p_snapshot->>'source_format', ''), 'csv'),
     p_snapshot->'control_totals',
     v_scope,
     v_partial,
     NULLIF(p_snapshot->>'cohort_basis', ''),
     false)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- ── (d) lp_csv_ingest_rows: route setter rows to their own table ────────────
-- Reproduced from the LIVE definition (2026-08-13) with one ELSIF added.
CREATE OR REPLACE FUNCTION lp_csv_ingest_rows(p_snapshot_id uuid, p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
AS $$
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
  -- 137 BY SETTER. Same columns as By Market minus the market: the parser
  -- emits setter_name_raw and never resolves a market, so there is nothing
  -- here to resolve one from.
  ELSIF v_type = 'sales_efficiency_by_setter' THEN
    INSERT INTO lp_sales_efficiency_setter_history
      (snapshot_id, row_num, setter_name_raw, num_issued, num_net_issued,
       num_sat, num_sold, gsa_cents, num_net, nsa_cents, num_working, working_cents,
       num_cd, cd_cents, num_cancelled, cancelled_cents, num_hold, hold_cents)
    SELECT p_snapshot_id, r.row_num, r.setter_name_raw, r.num_issued, r.num_net_issued,
           r.num_sat, r.num_sold, r.gsa_cents, r.num_net, r.nsa_cents, r.num_working, r.working_cents,
           r.num_cd, r.cd_cents, r.num_cancelled, r.cancelled_cents, r.num_hold, r.hold_cents
    FROM jsonb_to_recordset(p_rows) AS r(
      row_num integer, setter_name_raw text, num_issued integer,
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
$$;

-- ── (e) lp_csv_ingest_finalize: count + control-check setter snapshots ──────
-- Reproduced from the LIVE definition (2026-08-13) with two ELSIF branches
-- added — the row-count dispatch and the control-total dispatch. The §I/§I.b
-- promotion logic below is UNCHANGED and is what makes this whole change
-- work: it demotes only within `report_type = s.report_type`, so a By Setter
-- snapshot and a By Market snapshot covering the same period no longer
-- contend for is_current at all.
CREATE OR REPLACE FUNCTION lp_csv_ingest_finalize(p_snapshot_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  s          scorecard_report_snapshots%ROWTYPE;
  v_rows     bigint;
  v_expected bigint;
  v_actual   bigint;
  v_key      text;
  v_facts    int;
  v_closed   boolean;
  v_keep_id  uuid;
  v_keep_end date;
  v_keep_par boolean;
  v_in_end   date;
  v_keep_eff date;
  d          record;
BEGIN
  SELECT * INTO s FROM scorecard_report_snapshots WHERE id = p_snapshot_id FOR UPDATE;
  IF s.id IS NULL THEN
    RAISE EXCEPTION 'lp_csv_ingest_finalize: snapshot % not found', p_snapshot_id;
  END IF;
  IF s.finalized_at IS NOT NULL THEN
    RAISE EXCEPTION 'lp_csv_ingest_finalize: snapshot % already finalized', p_snapshot_id;
  END IF;

  -- An end before its start is not a period. The promotion step below builds
  -- daterange(period_start, period_end) to find what this snapshot displaces,
  -- and an inverted range raises "range lower bound must be less than or equal
  -- to range upper bound" AFTER the rows are loaded. LP is moving to
  -- t1=[BOCM]&t2=[DAYOFFSET(-1)], which on the 1st of a month yields
  -- 2026-09-01..2026-08-31 — so this fires on a known date. lp-csv-ingest.js
  -- rejects the shape earlier and more cheaply (failure_reason
  -- 'inverted_period'); this is the backstop for any other caller.
  IF s.period_end < s.period_start THEN
    RAISE EXCEPTION 'lp_csv_ingest_finalize: snapshot % declares an inverted period % .. % — refusing to promote',
      p_snapshot_id, s.period_start, s.period_end;
  END IF;

  IF s.report_type = 'job_status_ytd' THEN
    SELECT COUNT(*) INTO v_rows FROM lp_job_status_history WHERE snapshot_id = p_snapshot_id;
  ELSIF s.report_type = 'lead_disposition' THEN
    SELECT COUNT(*) INTO v_rows FROM lp_lead_disposition_history WHERE snapshot_id = p_snapshot_id;
  ELSIF s.report_type = 'source_cost' THEN
    SELECT COUNT(*) INTO v_rows FROM lp_source_cost_history WHERE snapshot_id = p_snapshot_id;
  ELSIF s.report_type = 'sales_efficiency' THEN
    SELECT COUNT(*) INTO v_rows FROM lp_sales_efficiency_history WHERE snapshot_id = p_snapshot_id;
  ELSIF s.report_type = 'sales_efficiency_by_setter' THEN
    SELECT COUNT(*) INTO v_rows FROM lp_sales_efficiency_setter_history WHERE snapshot_id = p_snapshot_id;
  ELSIF s.report_type = 'appt_stats_by_rep_source' THEN
    SELECT COUNT(*) INTO v_rows FROM lp_appt_stats_history WHERE snapshot_id = p_snapshot_id;
  ELSIF s.report_type = 'jobs_by_milestone' THEN
    SELECT COUNT(*) INTO v_rows FROM scorecard_report_rows_a WHERE snapshot_id = p_snapshot_id;
  ELSIF s.report_type = 'jobs_by_status' THEN
    SELECT COUNT(*) INTO v_rows FROM scorecard_report_rows_b WHERE snapshot_id = p_snapshot_id;
  ELSE
    RAISE EXCEPTION 'lp_csv_ingest_finalize: snapshot % has non-CSV report_type %', p_snapshot_id, s.report_type;
  END IF;
  IF v_rows <> s.row_count THEN
    RAISE EXCEPTION 'lp_csv_ingest_finalize: % rows loaded, snapshot declares % — aborting', v_rows, s.row_count;
  END IF;

  IF s.report_type = 'source_cost' THEN
    FOREACH v_key IN ARRAY ARRAY['num_raw','num_set','num_cnf','num_issued','num_sat','num_sold','num_net_sold',
                                 'gsa_cents','nsa_cents','mcost_cents','working_cents'] LOOP
      IF s.control_totals IS NULL OR s.control_totals->>v_key IS NULL THEN
        RAISE EXCEPTION 'lp_csv_ingest_finalize: source_cost requires control_totals.% — refusing to promote unchecked data', v_key;
      END IF;
    END LOOP;
  END IF;
  FOR v_key, v_expected IN
    SELECT key, value::bigint FROM jsonb_each_text(COALESCE(s.control_totals, '{}'::jsonb))
  LOOP
    IF s.report_type = 'source_cost' THEN
      SELECT CASE v_key
        WHEN 'num_raw'       THEN SUM(num_raw)      WHEN 'num_set'      THEN SUM(num_set)
        WHEN 'num_cnf'       THEN SUM(num_cnf)      WHEN 'num_issued'   THEN SUM(num_issued)
        WHEN 'num_sat'       THEN SUM(num_sat)      WHEN 'num_sold'     THEN SUM(num_sold)
        WHEN 'num_net_sold'  THEN SUM(num_net_sold) WHEN 'gsa_cents'    THEN SUM(gsa_cents)
        WHEN 'nsa_cents'     THEN SUM(nsa_cents)    WHEN 'mcost_cents'  THEN SUM(mcost_cents)
        WHEN 'working_cents' THEN SUM(working_cents) END
      INTO v_actual FROM lp_source_cost_history WHERE snapshot_id = p_snapshot_id;
    ELSIF s.report_type = 'job_status_ytd' THEN
      SELECT CASE v_key
        WHEN 'gross_cents'         THEN SUM(gross_cents)
        WHEN 'total_due_cents'     THEN SUM(total_due_cents)
        WHEN 'hoa_count'           THEN COUNT(*) FILTER (WHERE bucket = 'hoa')
        WHEN 'permit_count'        THEN COUNT(*) FILTER (WHERE bucket = 'permit')
        WHEN 'other_pending_count' THEN COUNT(*) FILTER (WHERE bucket = 'other_pending')
        WHEN 'in_production_count' THEN COUNT(*) FILTER (WHERE bucket = 'in_production')
        WHEN 'completed_count'     THEN COUNT(*) FILTER (WHERE bucket = 'completed')
        WHEN 'lost_count'          THEN COUNT(*) FILTER (WHERE bucket = 'lost') END
      INTO v_actual FROM lp_job_status_history WHERE snapshot_id = p_snapshot_id;
    ELSIF s.report_type = 'sales_efficiency' THEN
      SELECT CASE v_key
        WHEN 'num_issued'      THEN SUM(num_issued)
        WHEN 'num_sat'         THEN SUM(num_sat)
        WHEN 'num_sold'        THEN SUM(num_sold)
        WHEN 'num_net'         THEN SUM(num_net)
        WHEN 'num_cancelled'   THEN SUM(num_cancelled)
        WHEN 'gsa_cents'       THEN SUM(gsa_cents)
        WHEN 'nsa_cents'       THEN SUM(nsa_cents)
        WHEN 'cancelled_cents' THEN SUM(cancelled_cents) END
      INTO v_actual FROM lp_sales_efficiency_history WHERE snapshot_id = p_snapshot_id;
    -- Same control keys as By Market: computeSalesEfficiencyTotals is shared
    -- by both variants, so the two dispatches must stay in step.
    ELSIF s.report_type = 'sales_efficiency_by_setter' THEN
      SELECT CASE v_key
        WHEN 'num_issued'      THEN SUM(num_issued)
        WHEN 'num_sat'         THEN SUM(num_sat)
        WHEN 'num_sold'        THEN SUM(num_sold)
        WHEN 'num_net'         THEN SUM(num_net)
        WHEN 'num_cancelled'   THEN SUM(num_cancelled)
        WHEN 'gsa_cents'       THEN SUM(gsa_cents)
        WHEN 'nsa_cents'       THEN SUM(nsa_cents)
        WHEN 'cancelled_cents' THEN SUM(cancelled_cents) END
      INTO v_actual FROM lp_sales_efficiency_setter_history WHERE snapshot_id = p_snapshot_id;
    ELSIF s.report_type = 'appt_stats_by_rep_source' THEN
      SELECT CASE v_key
        WHEN 'num_set'        THEN SUM(num_set)
        WHEN 'num_issued'     THEN SUM(num_issued)
        WHEN 'num_net_issued' THEN SUM(num_net_issued)
        WHEN 'num_sat'        THEN SUM(num_sat)
        WHEN 'num_sale'       THEN SUM(num_sale)
        WHEN 'gsa_cents'      THEN SUM(gsa_cents)
        WHEN 'nsa_cents'      THEN SUM(nsa_cents)
        WHEN 'num_other'      THEN SUM(num_other)
        WHEN 'num_other2'     THEN SUM(num_other2) END
      INTO v_actual FROM lp_appt_stats_history WHERE snapshot_id = p_snapshot_id;
    ELSIF s.report_type = 'jobs_by_milestone' THEN
      SELECT CASE v_key
        WHEN 'gross_cents' THEN SUM(gross_cents)
        WHEN 'net_cents'   THEN SUM(net_cents)
        WHEN 'row_count'   THEN COUNT(*) END
      INTO v_actual FROM scorecard_report_rows_a WHERE snapshot_id = p_snapshot_id;
    ELSIF s.report_type = 'jobs_by_status' THEN
      SELECT CASE v_key
        WHEN 'gross_cents'  THEN SUM(total_gross_cents)
        WHEN 'hoa_count'    THEN COUNT(*) FILTER (WHERE bucket = 'hoa')
        WHEN 'row_count'    THEN COUNT(*) END
      INTO v_actual FROM scorecard_report_rows_b WHERE snapshot_id = p_snapshot_id;
    ELSE
      SELECT CASE v_key
        WHEN 'gsa_cents'  THEN SUM(gsa_cents)
        WHEN 'net_cents'  THEN SUM(net_cents)
        WHEN 'sets_count' THEN COUNT(*) FILTER (WHERE appt_date IS NOT NULL) END
      INTO v_actual FROM lp_lead_disposition_history WHERE snapshot_id = p_snapshot_id;
    END IF;
    IF v_actual IS NULL THEN
      RAISE EXCEPTION 'lp_csv_ingest_finalize: unknown control key % for % — aborting', v_key, s.report_type;
    END IF;
    IF v_actual <> v_expected THEN
      RAISE EXCEPTION 'lp_csv_ingest_finalize: control total % mismatch — loaded %, expected % — aborting',
        v_key, v_actual, v_expected;
    END IF;
  END LOOP;

  -- §H: a period is closed when it has ended AND the file covers all of it.
  -- IS FALSE, not NOT: an unknown coverage (NULL) must not close a period.
  v_closed := (s.period_end < (now() AT TIME ZONE 'America/New_York')::date)
              AND (s.is_partial_month IS FALSE);

  UPDATE scorecard_report_snapshots SET finalized_at = now() WHERE id = p_snapshot_id;

  -- §I: the current snapshot is the one that covers the MOST of the period, not
  -- the one that arrived last. Promotion was last-writer-wins, which was
  -- harmless while LP sent one file per period. The daily rolling schedule
  -- sends ~30 files per report per month, all sharing a period_start and
  -- differing only in period_end, so any re-send or out-of-order delivery
  -- silently rolled the dashboard backwards. Observed: job_status_ytd went
  -- period_end Aug 10 -> Aug 31 -> Aug 10 across three arrivals on 2026-08-10/11.
  --
  -- §I.b (2026-08-13): only PROVEN coverage may block a promotion.
  --
  -- period_end alone is not coverage. A file generated on the 10th with
  -- t2=[EOCM] declares period_end 2026-08-31 and is flagged is_partial_month —
  -- it claims three weeks it cannot contain. Ranking on the raw period_end
  -- would let that file win, and then every honest daily file (Aug 1..12,
  -- Aug 1..13, ...) covers "strictly less" and is refused for the rest of the
  -- month, converting a self-healing mistake into a month-long freeze. Live
  -- example: snapshot c1fc176f, period_end 2026-08-31, is_partial_month true,
  -- generated 2026-08-10.
  --
  -- So an incumbent blocks only if its coverage is PROVEN and strictly exceeds
  -- the incoming file's proven coverage. A partial incumbent never blocks; a
  -- partial newcomer never displaces a complete incumbent that already reaches
  -- as far. Preferring proven-less over unproven-more is the conservative
  -- direction and the one that cannot stall. Equal coverage still wins, so a
  -- same-day corrected re-send can replace its predecessor.
  SELECT id, period_end, is_partial_month INTO v_keep_id, v_keep_end, v_keep_par
    FROM scorecard_report_snapshots
   WHERE report_type = s.report_type
     AND daterange(period_start, period_end, '[]') && daterange(s.period_start, s.period_end, '[]')
     AND (scope = s.scope OR (scope IN ('mtd', 'month') AND s.scope IN ('mtd', 'month')))
     AND is_current AND id <> p_snapshot_id
   ORDER BY (is_partial_month IS FALSE) DESC, period_end DESC,
            report_generated_at DESC NULLS LAST, ingested_at DESC
   LIMIT 1;

  -- IS FALSE, not NOT: unknown coverage (NULL) is not proven coverage.
  v_in_end   := CASE WHEN s.is_partial_month IS FALSE THEN s.period_end END;
  v_keep_eff := CASE WHEN v_keep_par IS FALSE THEN v_keep_end END;

  IF v_keep_id IS NOT NULL
     AND v_keep_eff IS NOT NULL
     AND (v_in_end IS NULL OR v_keep_eff > v_in_end) THEN
    -- Keep it as history, exactly like a demoted prior day: the rows stay, the
    -- facts are built, and is_current stays false so nothing reads it as live.
    -- scorecard_rebuild_facts copies s.is_current onto every fact it writes, so
    -- returning before the promotion UPDATE is what makes them history rows.
    PERFORM lp_log_supersede(s.report_type, p_snapshot_id, v_keep_id);
    SELECT scorecard_rebuild_facts(p_snapshot_id) INTO v_facts;
    RETURN v_facts;
  END IF;

  -- Record every closed snapshot this one displaces, before it is demoted.
  FOR d IN
    SELECT id FROM scorecard_report_snapshots
     WHERE report_type = s.report_type
       AND daterange(period_start, period_end, '[]') && daterange(s.period_start, s.period_end, '[]')
       AND (scope = s.scope OR (scope IN ('mtd', 'month') AND s.scope IN ('mtd', 'month')))
       AND is_current AND id <> p_snapshot_id
       AND period_closed_at IS NOT NULL
  LOOP
    PERFORM lp_log_supersede(s.report_type, d.id, p_snapshot_id);
  END LOOP;

  WITH demoted AS (
    UPDATE scorecard_report_snapshots
       SET is_current = false
     WHERE report_type = s.report_type
       AND daterange(period_start, period_end, '[]') && daterange(s.period_start, s.period_end, '[]')
       AND (scope = s.scope
            OR (scope IN ('mtd', 'month') AND s.scope IN ('mtd', 'month')))
       AND is_current AND id <> p_snapshot_id
    RETURNING id)
  UPDATE lp_report_facts f SET is_current = false
   WHERE f.snapshot_id IN (SELECT id FROM demoted);

  UPDATE scorecard_report_snapshots
     SET is_current = true,
         period_closed_at = CASE WHEN v_closed THEN now() ELSE period_closed_at END
   WHERE id = p_snapshot_id;

  SELECT scorecard_rebuild_facts(p_snapshot_id) INTO v_facts;
  RETURN v_facts;
END;
$$;

-- ── (f) verification ────────────────────────────────────────────────────────
-- Expect: the new table exists, both CHECKs carry the new value, and the
-- three functions accept it.
--
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conname IN ('scorecard_report_snapshots_report_type_check',
--                      'lp_report_facts_report_type_check',
--                      'scorecard_ingest_log_status_check');
--
--   SELECT count(*) FROM lp_sales_efficiency_setter_history;  -- 0 until 6 AM
