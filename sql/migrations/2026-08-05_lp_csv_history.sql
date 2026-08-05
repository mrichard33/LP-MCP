-- ════════════════════════════════════════════════════════════════════
-- LP CSV history: Job Status / Lead Disposition / Source Cost — 2026-08-05
--
-- Run in: LP MCP Supabase → SQL Editor (or supabase MCP apply_migration).
-- Idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP CONSTRAINT IF
-- EXISTS + re-add); safe to re-run. Applied manually — code ships
-- separately (no migration runner, no boot-time DDL; see the 2026-08-04
-- migration header).
--
-- WHY (handoff 2026-08-05): three ground-truth CSV exports — Job Status
-- Report YTD (940 open jobs), Lead Disposition Detail YTD (78,557 leads),
-- Marketing Sub-Source Cost Analysis 2 YTD (127 sub-sources) — backfill a
-- static historical dataset and repair the Sold This Period / Net (Good
-- Business) Breakdown dashboard sections. Row grain mirrors the source
-- files; the rollup lands in lp_report_facts so the dashboard keeps ONE
-- read surface. Scheduled LP reports remain PDF-only (confirmed
-- 2026-08-05), so these tables also receive future PDF-parsed rows once
-- sample PDFs exist for reports C/D — the load/validate layer is shared.
--
-- REPORT TYPES (period semantics):
--   job_status_ytd    stock snapshot of OPEN jobs — always full YTD,
--                     period_start = Jan 1. Buckets: hoa | permit |
--                     other_pending (pre-release holds) | excluded
--                     (released/production track).
--                     RULING TO CONFIRM (flagged for Mark, 2026-08-05):
--                     'Hold - Permit' exists in this export (18 jobs,
--                     $343,564) — built as its OWN bucket, reversible to
--                     other_pending by a one-line map change. This is a
--                     DIFFERENT export from Report B 'jobs_by_status'
--                     (monthly cohort PDF), whose two-bucket ruling is
--                     unchanged.
--   lead_disposition  one row per lead-disposition record. Lead id is NOT
--                     unique (6,182 ids repeat — Superseded/rehash), so
--                     the grain key is (snapshot_id, row_num).
--   source_cost       one row per marketing sub-source. Sub-source names
--                     repeat (LP prints duplicate descr rows), so the
--                     grain key is (snapshot_id, row_num).
--
-- ══ RETENTION GUARANTEE — DO NOT PRUNE ══
-- Same doctrine as lp_report_facts: superseded snapshots and their history
-- rows are NEVER deleted; is_current is a pointer, not a retention policy.
--
-- FAIL-CLOSED: ingest is chunked (78k rows exceed a single practical jsonb
-- RPC call), so the atomicity boundary is lp_csv_ingest_finalize(): until
-- it commits — row-count assertion, control-total assertions to the cent,
-- demote-then-promote — the snapshot stays is_current=false and is
-- invisible to every current-snapshot reader. A failed finalize leaves an
-- inert, logged, non-current snapshot; nothing downstream reads it.
-- ════════════════════════════════════════════════════════════════════

-- ── (a) snapshot header extensions ──────────────────────────────────────────
ALTER TABLE scorecard_report_snapshots ADD COLUMN IF NOT EXISTS source_format text NOT NULL DEFAULT 'pdf';
ALTER TABLE scorecard_report_snapshots ADD COLUMN IF NOT EXISTS control_totals jsonb;
ALTER TABLE scorecard_report_snapshots ADD COLUMN IF NOT EXISTS finalized_at timestamptz;

COMMENT ON COLUMN scorecard_report_snapshots.source_format IS
  'pdf (scheduled email reports) | csv (manual ground-truth exports). CSVs carry cents; PDFs round to whole dollars.';
COMMENT ON COLUMN scorecard_report_snapshots.control_totals IS
  'Caller-declared expected totals asserted inside lp_csv_ingest_finalize (cents / counts). Stored so every accepted snapshot carries the evidence it was checked against.';
COMMENT ON COLUMN scorecard_report_snapshots.finalized_at IS
  'Chunked (CSV) ingests only: set when lp_csv_ingest_finalize passed all assertions. NULL on PDF snapshots (their RPC is single-tx) and on abandoned chunked ingests.';

ALTER TABLE scorecard_report_snapshots DROP CONSTRAINT IF EXISTS scorecard_report_snapshots_report_type_check;
ALTER TABLE scorecard_report_snapshots ADD CONSTRAINT scorecard_report_snapshots_report_type_check
  CHECK (report_type IN ('jobs_by_milestone', 'jobs_by_status',
                         'job_status_ytd', 'lead_disposition', 'source_cost'));

-- ── (b) lp_job_status_history: one row per open job per import ──────────────
-- Job Status Report carries NO branch column; market comes from the
-- cst_id → lead-disposition id join (938/940 on the 2026-08-05 export),
-- method recorded. The 2 unmatched rows import as UNASSIGNED — visible,
-- never dropped.
CREATE TABLE IF NOT EXISTS lp_job_status_history (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  snapshot_id      uuid NOT NULL REFERENCES scorecard_report_snapshots(id) ON DELETE CASCADE,
  cst_id           text NOT NULL,
  lead_id          text,                     -- joined Lead Disposition id (null on the unmatched)
  contract_id      text,
  customer_name    text,
  phone            text,
  contract_date    date,
  net_date         date,
  status_date      date,
  status_raw       text NOT NULL,            -- verbatim LP status (23 known 2026-08-05)
  bucket           text NOT NULL CHECK (bucket IN ('hoa', 'permit', 'other_pending', 'excluded')),
  gross_cents      bigint,
  fin_cents        bigint,                   -- financed amount — NEVER net (standing rule)
  rep_name         text,
  fin_co           text,
  branch_code_raw  text,                     -- brn_id of the joined lead, verbatim
  market           text NOT NULL,
  market_method    text,                     -- 'lead_join' | 'unmatched_lead'
  notes_raw        text
);
CREATE INDEX IF NOT EXISTS lp_job_status_history_snap_market_bucket_idx
  ON lp_job_status_history (snapshot_id, market, bucket);
CREATE INDEX IF NOT EXISTS lp_job_status_history_cst_idx
  ON lp_job_status_history (cst_id);

COMMENT ON TABLE lp_job_status_history IS
  'Open-job stock snapshot per import (Job Status Report YTD). Money in CENTS. Superseded snapshots retained forever; is_current lives on the snapshot header. fin_cents is the FINANCED amount, not net — never use it as net.';

-- ── (c) lp_lead_disposition_history: one row per lead record per import ─────
CREATE TABLE IF NOT EXISTS lp_lead_disposition_history (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  snapshot_id     uuid NOT NULL REFERENCES scorecard_report_snapshots(id) ON DELETE CASCADE,
  row_num         integer NOT NULL,          -- 1-based position in the source file (lead id repeats)
  lp_lead_id      text NOT NULL,
  entry_date      date,
  category        text,
  dsp_descr       text,
  last_result     text,
  src_id          text,
  sub_source      text,
  promoter        text,
  city            text,
  state           text,
  zip             text,
  num_dials       integer,
  num_superseded  integer,
  appt_date       date,                      -- date part only (source prints M/D/YYYY HH:MM)
  job_status      text,
  gsa_cents       bigint,
  net_cents       bigint,
  brn_id_raw      text,                      -- verbatim brn_id ('' and '0' occur)
  market          text NOT NULL,             -- *_MKT | OUT_OF_AREA | UNASSIGNED
  market_method   text                       -- 'brn_map' | 'zip_lookup' | 'zip_out_of_area' | 'no_address'
);
CREATE UNIQUE INDEX IF NOT EXISTS lp_lead_disposition_history_snap_row_idx
  ON lp_lead_disposition_history (snapshot_id, row_num);
CREATE INDEX IF NOT EXISTS lp_lead_disposition_history_snap_market_idx
  ON lp_lead_disposition_history (snapshot_id, market);
CREATE INDEX IF NOT EXISTS lp_lead_disposition_history_snap_source_idx
  ON lp_lead_disposition_history (snapshot_id, sub_source);
CREATE INDEX IF NOT EXISTS lp_lead_disposition_history_snap_entry_idx
  ON lp_lead_disposition_history (snapshot_id, entry_date);
CREATE INDEX IF NOT EXISTS lp_lead_disposition_history_lead_idx
  ON lp_lead_disposition_history (lp_lead_id);

COMMENT ON TABLE lp_lead_disposition_history IS
  'Lead Disposition Detail rows per import. Money in CENTS. Lead-attributed GSA/Net do NOT tie to the Marketing report''s company totals (verified 2026-08-05: +$222,801 GSA / −$3,395,938 net) — company Sold figures come from source_cost facts; these rows are the per-market/per-source basis and are labeled as such. UNASSIGNED/OUT_OF_AREA are retained visibly, never dropped or folded.';

-- ── (d) lp_source_cost_history: one row per sub-source per import ───────────
CREATE TABLE IF NOT EXISTS lp_source_cost_history (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  snapshot_id    uuid NOT NULL REFERENCES scorecard_report_snapshots(id) ON DELETE CASCADE,
  row_num        integer NOT NULL,           -- source order (duplicate descr rows occur)
  sub_source     text,                       -- verbatim descr (blank rows occur and are retained)
  num_raw        integer,
  num_set        integer,
  num_cnf        integer,
  num_issued     integer,
  num_sat        integer,
  num_sold       integer,
  num_net_sold   integer,
  gsa_cents      bigint,
  nsa_cents      bigint,
  mcost_cents    bigint,
  working_cents  bigint
);
CREATE UNIQUE INDEX IF NOT EXISTS lp_source_cost_history_snap_row_idx
  ON lp_source_cost_history (snapshot_id, row_num);
CREATE INDEX IF NOT EXISTS lp_source_cost_history_snap_idx
  ON lp_source_cost_history (snapshot_id);

COMMENT ON TABLE lp_source_cost_history IS
  'Marketing Sub-Source Cost Analysis 2 rows per import. Money in CENTS. This report is the company control-total authority (its sums tie the LP footer to the cent); the finalize RPC asserts all ten totals before the snapshot can become current.';

-- ── (e) lp_report_facts: admit the new report types / metrics / buckets ─────
ALTER TABLE lp_report_facts DROP CONSTRAINT IF EXISTS lp_report_facts_report_type_check;
ALTER TABLE lp_report_facts ADD CONSTRAINT lp_report_facts_report_type_check
  CHECK (report_type IN ('jobs_by_milestone', 'jobs_by_status',
                         'job_status_ytd', 'lead_disposition', 'source_cost'));

ALTER TABLE lp_report_facts DROP CONSTRAINT IF EXISTS lp_report_facts_metric_check;
ALTER TABLE lp_report_facts ADD CONSTRAINT lp_report_facts_metric_check
  CHECK (metric IN ('net_sales', 'gross_sold', 'good_business_open', 'pipeline_excluded',
                    'dup_review_pending',
                    -- CSV-era funnel counts (value_count carries the number; value_cents
                    -- NULL for pure counts, Σ cents where a dollar figure rides along):
                    'leads', 'sets', 'confirmed', 'issued', 'sat', 'sold', 'net_sold',
                    'marketing_cost', 'working_amount'));

ALTER TABLE lp_report_facts DROP CONSTRAINT IF EXISTS lp_report_facts_bucket_check;
ALTER TABLE lp_report_facts ADD CONSTRAINT lp_report_facts_bucket_check
  CHECK (bucket IN ('hoa', 'permit', 'other_pending', 'excluded'));

-- Dashboard read access: lp_report_facts is the scorecard's read surface for
-- the CSV-era metrics, and the dashboard reads through the RLS-respecting
-- anon client with a logged-in (authenticated) session — the same shape as
-- lp_market_scorecard_daily's scorecard_daily_read policy. Read-only;
-- writes stay service-role.
DO $policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'lp_report_facts' AND policyname = 'lp_report_facts_read') THEN
    CREATE POLICY lp_report_facts_read ON lp_report_facts FOR SELECT TO authenticated USING (true);
  END IF;
END $policy$;

-- ── (f) rebuild = the ONE projection, now over five sources ─────────────────
-- Same contract as before: delete + re-project a snapshot's facts from its
-- raw rows; called by both ingest paths inside their promoting tx and by
-- recon/admin on divergence.
--
-- New projections (metrics partition the raw rows so recon covers every row):
--   job_status_ytd    → good_business_open (bucket hoa|permit|other_pending)
--                       + pipeline_excluded (bucket excluded); value = Σ gross_cents.
--   lead_disposition  → per (market, brn_id_raw):
--                         leads    count(*)                       value_cents NULL
--                         sets     count(appt_date IS NOT NULL)   value_cents NULL
--                         sold     count(gsa_cents  > 0)          value_cents Σ gsa_cents  (those rows)
--                         net_sold count(net_cents  > 0)          value_cents Σ net_cents  (those rows)
--                       (no negative amounts exist; issued/sat are NOT derivable
--                       per-row from this file — company-level only, from source_cost)
--   source_cost       → market 'REECE', branch NULL:
--                         leads/sets/confirmed/issued/sat/sold/net_sold: value_count = Σ Num*,
--                         value_cents NULL; gross_sold/net_sales/marketing_cost/
--                         working_amount: value_cents = Σ cents, value_count = row count.
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

  RETURN v_count;
END;
$$;

-- ── (g) chunked CSV ingest: begin → rows×N → finalize ───────────────────────
-- supabase-js has no client-side transactions and 78k rows exceed one
-- practical jsonb payload, so the CSV path is three RPCs. Atomicity holds
-- at the is_current boundary: nothing is promoted (or asserted) until
-- finalize, which is a single tx.

CREATE OR REPLACE FUNCTION lp_csv_ingest_begin(p_snapshot jsonb)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_snapshot->>'report_type' NOT IN ('job_status_ytd', 'lead_disposition', 'source_cost') THEN
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
  ELSE
    RAISE EXCEPTION 'lp_csv_ingest_rows: snapshot % has non-CSV report_type %', p_snapshot_id, v_type;
  END IF;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

-- Finalize: the fail-closed gate. One tx — row-count assertion, control-total
-- assertions (to the cent), demote-then-promote is_current with facts in
-- lockstep, facts projection. Any RAISE rolls this tx back and the snapshot
-- stays non-current (inert, logged by the caller).
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

  -- 1. Row-count assertion (chunked inserts must add up exactly).
  IF s.report_type = 'job_status_ytd' THEN
    SELECT COUNT(*) INTO v_rows FROM lp_job_status_history WHERE snapshot_id = p_snapshot_id;
  ELSIF s.report_type = 'lead_disposition' THEN
    SELECT COUNT(*) INTO v_rows FROM lp_lead_disposition_history WHERE snapshot_id = p_snapshot_id;
  ELSIF s.report_type = 'source_cost' THEN
    SELECT COUNT(*) INTO v_rows FROM lp_source_cost_history WHERE snapshot_id = p_snapshot_id;
  ELSE
    RAISE EXCEPTION 'lp_csv_ingest_finalize: snapshot % has non-CSV report_type %', p_snapshot_id, s.report_type;
  END IF;
  IF v_rows <> s.row_count THEN
    RAISE EXCEPTION 'lp_csv_ingest_finalize: % rows loaded, snapshot declares % — aborting', v_rows, s.row_count;
  END IF;

  -- 2. Control-total assertions. source_cost asserts ALL ten (it is the
  --    control-total authority); the others assert every key present.
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

  -- 3. Promote: demote-then-promote inside this tx, facts in lockstep —
  --    never two current, never zero current observable. Demotion is a FLAG
  --    FLIP ONLY; superseded snapshots/rows/facts are never deleted.
  UPDATE scorecard_report_snapshots SET finalized_at = now() WHERE id = p_snapshot_id;
  WITH demoted AS (
    UPDATE scorecard_report_snapshots
       SET is_current = false
     WHERE report_type = s.report_type AND period_start = s.period_start
       AND is_current AND id <> p_snapshot_id
    RETURNING id)
  UPDATE lp_report_facts f SET is_current = false
   WHERE f.snapshot_id IN (SELECT id FROM demoted);
  UPDATE scorecard_report_snapshots SET is_current = true WHERE id = p_snapshot_id;

  -- 4. Facts projection — same tx: failure rolls back the promotion too.
  SELECT scorecard_rebuild_facts(p_snapshot_id) INTO v_facts;
  RETURN v_facts;
END;
$$;
