-- ════════════════════════════════════════════════════════════════════
-- lp_report_facts: unified tidy/long fact table over the LP report
-- ingestion raw rows — 2026-08-05
--
-- Run in: LP MCP Supabase → SQL Editor. Idempotent (IF NOT EXISTS /
-- CREATE OR REPLACE); safe to re-run. Applied manually — code ships
-- separately (no migration runner, no boot-time DDL; see the 2026-08-04
-- migration header).
--
-- WHY (ruled 2026-08-04): every report run's extracted data must land in
-- queryable tables, history preserved permanently, all sources combinable
-- into ONE table. The raw per-report tables (scorecard_report_rows_a/_b)
-- stay as immutable evidence mirroring the PDF; lp_report_facts is a tidy
-- PROJECTION over them — long format so a new metric or a future report
-- source is new rows, never a migration.
--
-- ══ RETENTION GUARANTEE — DO NOT PRUNE ══
-- Superseded snapshots are NEVER deleted. is_current is a POINTER marking
-- which snapshot the dashboard reads; all prior snapshots, their raw rows,
-- and their facts stay forever. That is what makes point-in-time questions
-- answerable ("what was HOA balance on Aug 12?" is a query over as_of_date,
-- not an archaeology project). Growth is ~150k rows/year — not a problem;
-- if it ever becomes one the fix is PARTITIONING, not deletion.
--
-- FACTS ARE A PROJECTION, NOT A SECOND TRUTH: lp_report_facts must always
-- be derivable from scorecard_report_rows_*. The daily recon asserts fact
-- aggregates equal raw-row aggregates per snapshot; on divergence the raw
-- rows win and facts are rebuilt (scorecard_rebuild_facts).
--
-- GRAIN: one row per (snapshot, market, branch_code_raw, metric, bucket)
-- aggregate. Branch is kept alongside the 6-market roll-up so reports that
-- show BOCA/MIAMI/RFED/LAKE separately reconcile without reopening PDFs.
--
-- METRICS (a full partition of the raw rows, so the recon covers every row):
--   rows_a                        → net_sales (Σ net_cents)   + gross_sold (Σ gross_cents)
--                                    value_count = job count on both
--   rows_b  !dup_review, hoa/
--           other_pending bucket  → good_business_open  (bucket = hoa | other_pending)
--   rows_b  !dup_review, excluded → pipeline_excluded   (bucket = excluded)
--   rows_b  dup_review            → dup_review_pending  (bucket NULL — held for review,
--                                    ruled 2026-08-04: never counted into Good Business)
-- ════════════════════════════════════════════════════════════════════

-- ── (a) as_of_date becomes a snapshot attribute ─────────────────────────────
-- The ET date the report was generated (PDF-printed timestamp when captured,
-- else the ingest date). Stored on the snapshot so fact rebuilds are
-- self-contained; backfilled from ingested_at for pre-existing rows.
ALTER TABLE scorecard_report_snapshots ADD COLUMN IF NOT EXISTS as_of_date date;
UPDATE scorecard_report_snapshots
   SET as_of_date = (ingested_at AT TIME ZONE 'America/New_York')::date
 WHERE as_of_date IS NULL;

COMMENT ON COLUMN scorecard_report_snapshots.is_current IS
  'Pointer to the snapshot the dashboard reads — NOT a retention policy. Superseded snapshots are never deleted.';

-- ── (b) the fact table ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lp_report_facts (
  fact_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id     uuid NOT NULL REFERENCES scorecard_report_snapshots(id) ON DELETE CASCADE,
  report_type     text NOT NULL CHECK (report_type IN ('jobs_by_milestone', 'jobs_by_status')),
  period_start    date NOT NULL,
  period_end      date NOT NULL,
  as_of_date      date NOT NULL,
  market          text NOT NULL,
  branch_code_raw text,
  metric          text NOT NULL CHECK (metric IN
    ('net_sales', 'gross_sold', 'good_business_open', 'pipeline_excluded', 'dup_review_pending')),
  bucket          text CHECK (bucket IN ('hoa', 'other_pending', 'excluded')),
  value_cents     bigint,
  value_count     integer NOT NULL,
  is_current      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS lp_report_facts_grain_idx
  ON lp_report_facts (snapshot_id, market, (COALESCE(branch_code_raw, '')), metric, (COALESCE(bucket, '')));
CREATE INDEX IF NOT EXISTS lp_report_facts_market_period_metric_idx
  ON lp_report_facts (market, period_start, metric);
CREATE INDEX IF NOT EXISTS lp_report_facts_asof_metric_idx
  ON lp_report_facts (as_of_date, metric);
CREATE INDEX IF NOT EXISTS lp_report_facts_snapshot_idx
  ON lp_report_facts (snapshot_id);

COMMENT ON TABLE lp_report_facts IS
  'Aggregate facts projected from scorecard_report_rows_a/_b inside scorecard_ingest_snapshot(). '
  'RETENTION: superseded snapshots (and their facts) are NEVER deleted — is_current is a pointer, '
  'not a retention policy; do not prune (partition if size ever matters). Facts are always '
  'rederivable from the raw row tables; on any divergence the raw rows win and facts are rebuilt '
  'via scorecard_rebuild_facts(snapshot_id).';
COMMENT ON COLUMN lp_report_facts.is_current IS
  'Denormalized from scorecard_report_snapshots.is_current, kept in lockstep inside the ingest tx. Pointer only — never a delete cue.';
COMMENT ON COLUMN lp_report_facts.as_of_date IS
  'ET date the report was generated (PDF timestamp when captured, else ingest date). Daily Report B snapshots make this a time series of the open pipeline.';

-- ── (c) rebuild = the ONE projection ────────────────────────────────────────
-- Delete + re-project a snapshot's facts from its raw rows. Called by the
-- ingest RPC (inside the same tx) and by recon/admin on divergence — one
-- code path, so write-time facts and rebuilt facts can never differ.
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

  RETURN v_count;
END;
$$;

-- ── (d) ingest RPC replacement: original behavior + facts, one tx ───────────
-- Adds over the 2026-08-04 version: as_of_date on the snapshot, facts
-- projected after promotion, demoted snapshots' facts flipped in lockstep.
-- p_snapshot gains optional 'as_of_date' (ET date, from the parsed PDF).
CREATE OR REPLACE FUNCTION scorecard_ingest_snapshot(p_snapshot jsonb, p_rows jsonb)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_id       uuid;
  v_type     text  := p_snapshot->>'report_type';
  v_period   date  := (p_snapshot->>'period_start')::date;
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
     (p_snapshot->>'period_end')::date,
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

  -- Demote-then-promote inside this tx: never two current (partial unique
  -- index), never zero current observable after commit. Demotion is a FLAG
  -- FLIP ONLY — superseded snapshots, rows, and facts are never deleted.
  -- Facts is_current flips in lockstep with the snapshots.
  WITH demoted AS (
    UPDATE scorecard_report_snapshots
       SET is_current = false
     WHERE report_type = v_type AND period_start = v_period AND is_current AND id <> v_id
    RETURNING id)
  UPDATE lp_report_facts f SET is_current = false
   WHERE f.snapshot_id IN (SELECT id FROM demoted);
  UPDATE scorecard_report_snapshots SET is_current = true WHERE id = v_id;

  -- Facts projection — same tx: any failure rolls back the whole ingest, so
  -- facts can never disagree with the raw rows they were written with.
  PERFORM scorecard_rebuild_facts(v_id);

  RETURN v_id;
END;
$$;

-- ── (e) convenience view: what the dashboard reads ──────────────────────────
CREATE OR REPLACE VIEW v_scorecard_current AS
  SELECT * FROM lp_report_facts WHERE is_current;

COMMENT ON VIEW v_scorecard_current IS
  'Current-snapshot facts only. Historical/time-series analysis queries lp_report_facts directly across as_of_date.';
