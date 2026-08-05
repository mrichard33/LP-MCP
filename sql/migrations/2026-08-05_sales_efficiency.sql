-- ════════════════════════════════════════════════════════════════════
-- Sales Efficiency By Market (LP report 137) + overlap-demotion — 2026-08-05
--
-- Run in: LP MCP Supabase → SQL Editor (or supabase MCP apply_migration).
-- Idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP CONSTRAINT IF
-- EXISTS + re-add); safe to re-run. Applied manually — code ships
-- separately (no migration runner, no boot-time DDL).
--
-- WHY (handoff 2026-08-05 "five-report automation"):
--   1. Report 137 is the ONLY per-market source of Issued / Sat / Sold /
--      Cancelled / NSA — the metrics behind most blank dashboard fields.
--      New report_type 'sales_efficiency' + lp_sales_efficiency_history
--      (one row per branch per import) + a sixth facts projection branch.
--      The printed NSLI column is NEVER stored (not reproducible from the
--      report's own columns); NSLI is always computed as NSA ÷ Issued.
--   2. OVERLAP-DEMOTION: jobs_by_milestone reached TWO current snapshots
--      (Aug 1–31 and Aug 4–4) because demotion matched period_start
--      equality. The correct invariant is NON-OVERLAP: promotion now
--      demotes any current snapshot of the same report_type whose
--      [period_start, period_end] range overlaps the incoming one.
--      Deliberately NOT a hard EXCLUDE constraint — planned YTD
--      validation pulls overlap MTD dailies by design and must supersede,
--      not error. Backfill-safe: distinct historical months don't overlap.
--
-- ══ RETENTION GUARANTEE — DO NOT PRUNE ══
-- Superseded snapshots and their history rows are NEVER deleted;
-- is_current is a pointer, not a retention policy.
-- ════════════════════════════════════════════════════════════════════

-- ── (a) admit the report type ───────────────────────────────────────────────
ALTER TABLE scorecard_report_snapshots DROP CONSTRAINT IF EXISTS scorecard_report_snapshots_report_type_check;
ALTER TABLE scorecard_report_snapshots ADD CONSTRAINT scorecard_report_snapshots_report_type_check
  CHECK (report_type IN ('jobs_by_milestone', 'jobs_by_status',
                         'job_status_ytd', 'lead_disposition', 'source_cost',
                         'sales_efficiency'));

ALTER TABLE lp_report_facts DROP CONSTRAINT IF EXISTS lp_report_facts_report_type_check;
ALTER TABLE lp_report_facts ADD CONSTRAINT lp_report_facts_report_type_check
  CHECK (report_type IN ('jobs_by_milestone', 'jobs_by_status',
                         'job_status_ytd', 'lead_disposition', 'source_cost',
                         'sales_efficiency'));

ALTER TABLE lp_report_facts DROP CONSTRAINT IF EXISTS lp_report_facts_metric_check;
ALTER TABLE lp_report_facts ADD CONSTRAINT lp_report_facts_metric_check
  CHECK (metric IN ('net_sales', 'gross_sold', 'good_business_open', 'pipeline_excluded',
                    'dup_review_pending',
                    'leads', 'sets', 'confirmed', 'issued', 'sat', 'sold', 'net_sold',
                    'marketing_cost', 'working_amount',
                    -- sales_efficiency (137) per-market buckets:
                    'cancelled', 'credit_decline', 'working_open', 'hold'));

-- ── (b) lp_sales_efficiency_history: one row per branch per import ──────────
-- Superset of the CSV export and the PDF grid; columns a format lacks stay
-- NULL. MTD pulls carry NO net figures (cohort columns blank) — num_net /
-- nsa_cents are NULL there and the facts projection emits no net_sold.
CREATE TABLE IF NOT EXISTS lp_sales_efficiency_history (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  snapshot_id      uuid NOT NULL REFERENCES scorecard_report_snapshots(id) ON DELETE CASCADE,
  row_num          integer NOT NULL,
  branch_code_raw  text NOT NULL,             -- verbatim Grouper / row label
  market           text NOT NULL,             -- via lp_branch_market_map
  num_issued       integer,                   -- CSV NumIssued / PDF Gross Iss
  num_net_issued   integer,                   -- CSV NumNetIssued / PDF Net Iss
  num_sat          integer,                   -- CSV NumSat / PDF Demo
  num_sold         integer,                   -- CSV NumSale / PDF Close count
  gsa_cents        bigint,                    -- CSV GSA / PDF Close volume
  num_net          integer,                   -- CSV NumNet / PDF Net count — NULL on MTD pulls
  nsa_cents        bigint,                    -- CSV NSA / PDF Net volume — NULL on MTD pulls
  num_working      integer,
  working_cents    bigint,
  num_cd           integer,
  cd_cents         bigint,
  num_cancelled    integer,
  cancelled_cents  bigint,
  num_hold         integer,
  hold_cents       bigint
);
CREATE UNIQUE INDEX IF NOT EXISTS lp_sales_efficiency_history_snap_row_idx
  ON lp_sales_efficiency_history (snapshot_id, row_num);
CREATE INDEX IF NOT EXISTS lp_sales_efficiency_history_snap_market_idx
  ON lp_sales_efficiency_history (snapshot_id, market);

COMMENT ON TABLE lp_sales_efficiency_history IS
  'Sales Efficiency By Market (LP report 137) rows per import — the only per-market source of Issued/Sat/Sold/Cancelled/NSA. Money in CENTS. The report''s printed NSLI column is NEVER stored (not reproducible from its own columns); NSLI = NSA ÷ Issued, computed downstream. MTD pulls have blank Net columns: num_net/nsa_cents NULL, never 0. Superseded snapshots retained forever.';

-- ── (c) scorecard_rebuild_facts: six projection branches ────────────────────
-- Same contract: delete + re-project one snapshot's facts; the ONE path.
-- New sixth branch (sales_efficiency, per market × branch):
--   issued/sat counts (value_cents NULL) · sold (count + Σ GSA cents) ·
--   net_sold (count + Σ NSA cents; omitted entirely when the snapshot has
--   no net figures — the MTD guard) · cancelled / credit_decline /
--   working_open / hold (count + Σ cents).
CREATE OR REPLACE FUNCTION scorecard_rebuild_facts(p_snapshot_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_count int := 0;
  v_part  int;
BEGIN
  DELETE FROM lp_report_facts WHERE snapshot_id = p_snapshot_id;

  -- Report A: net_sales + gross_sold per (market, branch).
  INSERT INTO lp_report_facts
    (snapshot_id, report_type, period_start, period_end, as_of_date,
     market, branch_code_raw, metric, bucket, value_cents, value_count, is_current)
  SELECT s.id, s.report_type, s.period_start, s.period_end,
         COALESCE(s.as_of_date, (s.ingested_at AT TIME ZONE 'America/New_York')::date),
         r.market, r.branch_code_raw, m.metric, NULL,
         CASE m.metric WHEN 'net_sales' THEN COALESCE(SUM(r.net_cents), 0)
                       ELSE COALESCE(SUM(r.gross_cents), 0) END,
         COUNT(*)::int, s.is_current
  FROM scorecard_report_snapshots s
  JOIN scorecard_report_rows_a r ON r.snapshot_id = s.id
  CROSS JOIN (VALUES ('net_sales'), ('gross_sold')) AS m(metric)
  WHERE s.id = p_snapshot_id
  GROUP BY s.id, s.report_type, s.period_start, s.period_end, s.as_of_date,
           s.ingested_at, s.is_current, r.market, r.branch_code_raw, m.metric;
  GET DIAGNOSTICS v_part = ROW_COUNT;
  v_count := v_count + v_part;

  -- Report B: good_business_open / pipeline_excluded / dup_review_pending.
  INSERT INTO lp_report_facts
    (snapshot_id, report_type, period_start, period_end, as_of_date,
     market, branch_code_raw, metric, bucket, value_cents, value_count, is_current)
  SELECT s.id, s.report_type, s.period_start, s.period_end,
         COALESCE(s.as_of_date, (s.ingested_at AT TIME ZONE 'America/New_York')::date),
         b.market, b.branch_code_raw, b.metric, b.fact_bucket,
         COALESCE(SUM(b.total_gross_cents), 0), COUNT(*)::int, s.is_current
  FROM scorecard_report_snapshots s
  JOIN (
    SELECT snapshot_id, market, branch_code_raw, total_gross_cents,
           CASE WHEN dup_review THEN 'dup_review_pending'
                WHEN bucket = 'excluded' THEN 'pipeline_excluded'
                ELSE 'good_business_open' END AS metric,
           CASE WHEN dup_review THEN NULL ELSE bucket END AS fact_bucket
    FROM scorecard_report_rows_b
    WHERE snapshot_id = p_snapshot_id
  ) b ON b.snapshot_id = s.id
  WHERE s.id = p_snapshot_id
  GROUP BY s.id, s.report_type, s.period_start, s.period_end, s.as_of_date,
           s.ingested_at, s.is_current, b.market, b.branch_code_raw, b.metric, b.fact_bucket;
  GET DIAGNOSTICS v_part = ROW_COUNT;
  v_count := v_count + v_part;

  -- job_status_ytd: open-pipeline stock by bucket per (market, branch).
  INSERT INTO lp_report_facts
    (snapshot_id, report_type, period_start, period_end, as_of_date,
     market, branch_code_raw, metric, bucket, value_cents, value_count, is_current)
  SELECT s.id, s.report_type, s.period_start, s.period_end,
         COALESCE(s.as_of_date, (s.ingested_at AT TIME ZONE 'America/New_York')::date),
         j.market, j.branch_code_raw,
         CASE WHEN j.bucket = 'excluded' THEN 'pipeline_excluded' ELSE 'good_business_open' END,
         j.bucket,
         COALESCE(SUM(j.gross_cents), 0), COUNT(*)::int, s.is_current
  FROM scorecard_report_snapshots s
  JOIN lp_job_status_history j ON j.snapshot_id = s.id
  WHERE s.id = p_snapshot_id
  GROUP BY s.id, s.report_type, s.period_start, s.period_end, s.as_of_date,
           s.ingested_at, s.is_current, j.market, j.branch_code_raw, j.bucket;
  GET DIAGNOSTICS v_part = ROW_COUNT;
  v_count := v_count + v_part;

  -- lead_disposition: funnel counts per (market, brn_id_raw).
  INSERT INTO lp_report_facts
    (snapshot_id, report_type, period_start, period_end, as_of_date,
     market, branch_code_raw, metric, bucket, value_cents, value_count, is_current)
  SELECT s.id, s.report_type, s.period_start, s.period_end,
         COALESCE(s.as_of_date, (s.ingested_at AT TIME ZONE 'America/New_York')::date),
         l.market, l.brn_id_raw, m.metric, NULL,
         CASE m.metric
           WHEN 'sold'     THEN SUM(l.gsa_cents) FILTER (WHERE l.gsa_cents > 0)
           WHEN 'net_sold' THEN SUM(l.net_cents) FILTER (WHERE l.net_cents > 0)
           ELSE NULL END,
         CASE m.metric
           WHEN 'leads'    THEN COUNT(*)
           WHEN 'sets'     THEN COUNT(*) FILTER (WHERE l.appt_date IS NOT NULL)
           WHEN 'sold'     THEN COUNT(*) FILTER (WHERE l.gsa_cents > 0)
           WHEN 'net_sold' THEN COUNT(*) FILTER (WHERE l.net_cents > 0)
         END::int,
         s.is_current
  FROM scorecard_report_snapshots s
  JOIN lp_lead_disposition_history l ON l.snapshot_id = s.id
  CROSS JOIN (VALUES ('leads'), ('sets'), ('sold'), ('net_sold')) AS m(metric)
  WHERE s.id = p_snapshot_id
  GROUP BY s.id, s.report_type, s.period_start, s.period_end, s.as_of_date,
           s.ingested_at, s.is_current, l.market, l.brn_id_raw, m.metric;
  GET DIAGNOSTICS v_part = ROW_COUNT;
  v_count := v_count + v_part;

  -- source_cost: company-level control-total facts (market 'REECE').
  INSERT INTO lp_report_facts
    (snapshot_id, report_type, period_start, period_end, as_of_date,
     market, branch_code_raw, metric, bucket, value_cents, value_count, is_current)
  SELECT s.id, s.report_type, s.period_start, s.period_end,
         COALESCE(s.as_of_date, (s.ingested_at AT TIME ZONE 'America/New_York')::date),
         'REECE', NULL, m.metric, NULL,
         CASE m.metric
           WHEN 'gross_sold'     THEN COALESCE(SUM(c.gsa_cents), 0)
           WHEN 'net_sales'      THEN COALESCE(SUM(c.nsa_cents), 0)
           WHEN 'marketing_cost' THEN COALESCE(SUM(c.mcost_cents), 0)
           WHEN 'working_amount' THEN COALESCE(SUM(c.working_cents), 0)
           ELSE NULL END,
         CASE m.metric
           WHEN 'leads'     THEN COALESCE(SUM(c.num_raw), 0)
           WHEN 'sets'      THEN COALESCE(SUM(c.num_set), 0)
           WHEN 'confirmed' THEN COALESCE(SUM(c.num_cnf), 0)
           WHEN 'issued'    THEN COALESCE(SUM(c.num_issued), 0)
           WHEN 'sat'       THEN COALESCE(SUM(c.num_sat), 0)
           WHEN 'sold'      THEN COALESCE(SUM(c.num_sold), 0)
           WHEN 'net_sold'  THEN COALESCE(SUM(c.num_net_sold), 0)
           ELSE COUNT(*) END::int,
         s.is_current
  FROM scorecard_report_snapshots s
  JOIN lp_source_cost_history c ON c.snapshot_id = s.id
  CROSS JOIN (VALUES ('leads'), ('sets'), ('confirmed'), ('issued'), ('sat'),
                     ('sold'), ('net_sold'),
                     ('gross_sold'), ('net_sales'), ('marketing_cost'), ('working_amount')
             ) AS m(metric)
  WHERE s.id = p_snapshot_id
  GROUP BY s.id, s.report_type, s.period_start, s.period_end, s.as_of_date,
           s.ingested_at, s.is_current, m.metric;
  GET DIAGNOSTICS v_part = ROW_COUNT;
  v_count := v_count + v_part;

  -- sales_efficiency (137): per-market funnel + bucket facts. net_sold is
  -- emitted ONLY when the snapshot carries net figures (MTD pulls do not).
  INSERT INTO lp_report_facts
    (snapshot_id, report_type, period_start, period_end, as_of_date,
     market, branch_code_raw, metric, bucket, value_cents, value_count, is_current)
  SELECT s.id, s.report_type, s.period_start, s.period_end,
         COALESCE(s.as_of_date, (s.ingested_at AT TIME ZONE 'America/New_York')::date),
         e.market, e.branch_code_raw, m.metric, NULL,
         CASE m.metric
           WHEN 'sold'           THEN COALESCE(SUM(e.gsa_cents), 0)
           WHEN 'net_sold'       THEN COALESCE(SUM(e.nsa_cents), 0)
           WHEN 'cancelled'      THEN COALESCE(SUM(e.cancelled_cents), 0)
           WHEN 'credit_decline' THEN COALESCE(SUM(e.cd_cents), 0)
           WHEN 'working_open'   THEN COALESCE(SUM(e.working_cents), 0)
           WHEN 'hold'           THEN COALESCE(SUM(e.hold_cents), 0)
           ELSE NULL END,
         CASE m.metric
           WHEN 'issued'         THEN COALESCE(SUM(e.num_issued), 0)
           WHEN 'sat'            THEN COALESCE(SUM(e.num_sat), 0)
           WHEN 'sold'           THEN COALESCE(SUM(e.num_sold), 0)
           WHEN 'net_sold'       THEN COALESCE(SUM(e.num_net), 0)
           WHEN 'cancelled'      THEN COALESCE(SUM(e.num_cancelled), 0)
           WHEN 'credit_decline' THEN COALESCE(SUM(e.num_cd), 0)
           WHEN 'working_open'   THEN COALESCE(SUM(e.num_working), 0)
           WHEN 'hold'           THEN COALESCE(SUM(e.num_hold), 0)
         END::int,
         s.is_current
  FROM scorecard_report_snapshots s
  JOIN lp_sales_efficiency_history e ON e.snapshot_id = s.id
  CROSS JOIN (VALUES ('issued'), ('sat'), ('sold'), ('net_sold'),
                     ('cancelled'), ('credit_decline'), ('working_open'), ('hold')
             ) AS m(metric)
  WHERE s.id = p_snapshot_id
  GROUP BY s.id, s.report_type, s.period_start, s.period_end, s.as_of_date,
           s.ingested_at, s.is_current, e.market, e.branch_code_raw, m.metric
  HAVING NOT (m.metric = 'net_sold' AND SUM(e.num_net) IS NULL);
  GET DIAGNOSTICS v_part = ROW_COUNT;
  v_count := v_count + v_part;

  RETURN v_count;
END;
$$;

-- ── (d) overlap-demotion: scorecard_ingest_snapshot (PDF single-tx path) ────
-- Change vs the 2026-08-05 version: demotion predicate is RANGE OVERLAP on
-- [period_start, period_end], not period_start equality. Everything else
-- identical.
CREATE OR REPLACE FUNCTION scorecard_ingest_snapshot(p_snapshot jsonb, p_rows jsonb)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_id       uuid;
  v_type     text  := p_snapshot->>'report_type';
  v_period   date  := (p_snapshot->>'period_start')::date;
  v_pend     date  := (p_snapshot->>'period_end')::date;
  v_expected int   := (p_snapshot->>'row_count')::int;
  v_as_of    date  := COALESCE(
                        NULLIF(p_snapshot->>'as_of_date', '')::date,
                        (NULLIF(p_snapshot->>'report_generated_at', '')::timestamptz
                           AT TIME ZONE 'America/New_York')::date,
                        (now() AT TIME ZONE 'America/New_York')::date);
  v_inserted int;
BEGIN
  INSERT INTO scorecard_report_snapshots
    (report_type, period_start, period_end, report_generated_at, file_sha256,
     storage_path, row_count, net_total_cents, gross_total_cents, as_of_date, is_current)
  VALUES
    (v_type,
     v_period,
     v_pend,
     NULLIF(p_snapshot->>'report_generated_at', '')::timestamptz,
     p_snapshot->>'file_sha256',
     p_snapshot->>'storage_path',
     v_expected,
     NULLIF(p_snapshot->>'net_total_cents', '')::bigint,
     NULLIF(p_snapshot->>'gross_total_cents', '')::bigint,
     v_as_of,
     false)
  RETURNING id INTO v_id;

  IF v_type = 'jobs_by_milestone' THEN
    INSERT INTO scorecard_report_rows_a
      (snapshot_id, job_number, customer_name, address, city, contract_date,
       rtp_date, branch_code_raw, market, product, gross_cents, net_cents,
       paid_cents, balance_cents, sales_rep)
    SELECT v_id, r.job_number, r.customer_name, r.address, r.city,
           r.contract_date, r.rtp_date, r.branch_code_raw, r.market, r.product,
           r.gross_cents, r.net_cents, r.paid_cents, r.balance_cents, r.sales_rep
    FROM jsonb_to_recordset(p_rows) AS r(
      job_number text, customer_name text, address text, city text,
      contract_date date, rtp_date date, branch_code_raw text, market text,
      product text, gross_cents bigint, net_cents bigint, paid_cents bigint,
      balance_cents bigint, sales_rep text);
  ELSIF v_type = 'jobs_by_status' THEN
    INSERT INTO scorecard_report_rows_b
      (snapshot_id, prosp_number, customer_name, phone, email, contract_date,
       branch_code_raw, market, status_raw, bucket, total_gross_cents, lender,
       notes_raw, dup_review)
    SELECT v_id, r.prosp_number, r.customer_name, r.phone, r.email,
           r.contract_date, r.branch_code_raw, r.market, r.status_raw, r.bucket,
           r.total_gross_cents, r.lender, r.notes_raw, COALESCE(r.dup_review, false)
    FROM jsonb_to_recordset(p_rows) AS r(
      prosp_number text, customer_name text, phone text, email text,
      contract_date date, branch_code_raw text, market text, status_raw text,
      bucket text, total_gross_cents bigint, lender text, notes_raw text,
      dup_review boolean);
  ELSE
    RAISE EXCEPTION 'scorecard_ingest_snapshot: unknown report_type %', v_type;
  END IF;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted <> v_expected THEN
    RAISE EXCEPTION
      'scorecard_ingest_snapshot: inserted % rows, snapshot declares % — aborting',
      v_inserted, v_expected;
  END IF;

  -- Demote-then-promote inside this tx. NON-OVERLAP invariant: any current
  -- snapshot of the same report_type whose period range overlaps the
  -- incoming range is demoted (flag flip only — nothing is ever deleted).
  -- Facts is_current flips in lockstep.
  WITH demoted AS (
    UPDATE scorecard_report_snapshots
       SET is_current = false
     WHERE report_type = v_type
       AND daterange(period_start, period_end, '[]') && daterange(v_period, v_pend, '[]')
       AND is_current AND id <> v_id
    RETURNING id)
  UPDATE lp_report_facts f SET is_current = false
   WHERE f.snapshot_id IN (SELECT id FROM demoted);
  UPDATE scorecard_report_snapshots SET is_current = true WHERE id = v_id;

  PERFORM scorecard_rebuild_facts(v_id);

  RETURN v_id;
END;
$$;

-- ── (e) CSV ingest RPCs: admit sales_efficiency + overlap-demotion ──────────
CREATE OR REPLACE FUNCTION lp_csv_ingest_begin(p_snapshot jsonb)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_snapshot->>'report_type' NOT IN ('job_status_ytd', 'lead_disposition', 'source_cost', 'sales_efficiency') THEN
    RAISE EXCEPTION 'lp_csv_ingest_begin: unknown report_type %', p_snapshot->>'report_type';
  END IF;
  INSERT INTO scorecard_report_snapshots
    (report_type, period_start, period_end, report_generated_at, file_sha256,
     storage_path, row_count, as_of_date, source_format, control_totals, is_current)
  VALUES
    (p_snapshot->>'report_type',
     (p_snapshot->>'period_start')::date,
     (p_snapshot->>'period_end')::date,
     NULLIF(p_snapshot->>'report_generated_at', '')::timestamptz,
     p_snapshot->>'file_sha256',
     p_snapshot->>'storage_path',
     (p_snapshot->>'row_count')::int,
     NULLIF(p_snapshot->>'as_of_date', '')::date,
     COALESCE(NULLIF(p_snapshot->>'source_format', ''), 'csv'),
     p_snapshot->'control_totals',
     false)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

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
      (snapshot_id, cst_id, lead_id, contract_id, customer_name, phone,
       contract_date, net_date, status_date, status_raw, bucket, gross_cents,
       fin_cents, rep_name, fin_co, branch_code_raw, market, market_method, notes_raw)
    SELECT p_snapshot_id, r.cst_id, r.lead_id, r.contract_id, r.customer_name, r.phone,
           r.contract_date, r.net_date, r.status_date, r.status_raw, r.bucket, r.gross_cents,
           r.fin_cents, r.rep_name, r.fin_co, r.branch_code_raw, r.market, r.market_method, r.notes_raw
    FROM jsonb_to_recordset(p_rows) AS r(
      cst_id text, lead_id text, contract_id text, customer_name text, phone text,
      contract_date date, net_date date, status_date date, status_raw text, bucket text,
      gross_cents bigint, fin_cents bigint, rep_name text, fin_co text,
      branch_code_raw text, market text, market_method text, notes_raw text);
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
  ELSE
    RAISE EXCEPTION 'lp_csv_ingest_rows: snapshot % has non-CSV report_type %', p_snapshot_id, v_type;
  END IF;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

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
BEGIN
  SELECT * INTO s FROM scorecard_report_snapshots WHERE id = p_snapshot_id FOR UPDATE;
  IF s.id IS NULL THEN
    RAISE EXCEPTION 'lp_csv_ingest_finalize: snapshot % not found', p_snapshot_id;
  END IF;
  IF s.finalized_at IS NOT NULL THEN
    RAISE EXCEPTION 'lp_csv_ingest_finalize: snapshot % already finalized', p_snapshot_id;
  END IF;

  IF s.report_type = 'job_status_ytd' THEN
    SELECT COUNT(*) INTO v_rows FROM lp_job_status_history WHERE snapshot_id = p_snapshot_id;
  ELSIF s.report_type = 'lead_disposition' THEN
    SELECT COUNT(*) INTO v_rows FROM lp_lead_disposition_history WHERE snapshot_id = p_snapshot_id;
  ELSIF s.report_type = 'source_cost' THEN
    SELECT COUNT(*) INTO v_rows FROM lp_source_cost_history WHERE snapshot_id = p_snapshot_id;
  ELSIF s.report_type = 'sales_efficiency' THEN
    SELECT COUNT(*) INTO v_rows FROM lp_sales_efficiency_history WHERE snapshot_id = p_snapshot_id;
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
        WHEN 'gross_cents'   THEN SUM(gross_cents)
        WHEN 'hoa_count'     THEN COUNT(*) FILTER (WHERE bucket = 'hoa')
        WHEN 'permit_count'  THEN COUNT(*) FILTER (WHERE bucket = 'permit') END
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

  -- Promote with the NON-OVERLAP invariant (see header): demote any current
  -- snapshot of the same type whose range overlaps; facts in lockstep.
  UPDATE scorecard_report_snapshots SET finalized_at = now() WHERE id = p_snapshot_id;
  WITH demoted AS (
    UPDATE scorecard_report_snapshots
       SET is_current = false
     WHERE report_type = s.report_type
       AND daterange(period_start, period_end, '[]') && daterange(s.period_start, s.period_end, '[]')
       AND is_current AND id <> p_snapshot_id
    RETURNING id)
  UPDATE lp_report_facts f SET is_current = false
   WHERE f.snapshot_id IN (SELECT id FROM demoted);
  UPDATE scorecard_report_snapshots SET is_current = true WHERE id = p_snapshot_id;

  SELECT scorecard_rebuild_facts(p_snapshot_id) INTO v_facts;
  RETURN v_facts;
END;
$$;
