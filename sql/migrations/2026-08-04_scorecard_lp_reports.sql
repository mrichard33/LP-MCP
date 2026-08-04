-- ════════════════════════════════════════════════════════════════════
-- LP scheduled-report PDF ingestion (scorecard feeds) — 2026-08-04
--
-- Run in: LP MCP Supabase → SQL Editor (or supabase MCP apply_migration).
-- Idempotent (IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT DO NOTHING);
-- safe to re-run. There is no migration runner in this repo and NO
-- boot-time DDL mirror in index.js (per the exec_sql silent-failure
-- incident) — this file is applied manually, code ships separately.
--
-- WHY: LP cannot schedule Excel exports, so two scorecard feeds arrive as
--   scheduled-email PDFs:
--     Report A  "Jobs by Milestone Date" (milestone=RTP, mode=Actual)
--               → Net Sales by market (NET dollars, by RTP date).
--     Report B  "Jobs By Status" (open pipeline)
--               → Good Business split: Held in HOA vs Other Pending.
--               RULED 2026-08-04: two buckets only — there is NO permit
--               bucket, ever.
--   n8n is thin transport (Gmail → POST raw PDF); ALL parsing, validation
--   and writes happen in LP-MCP (src/jobs/lp-report-*.js).
--
-- FAIL-CLOSED SEMANTICS: a PDF that fails validation writes NOTHING to the
--   snapshot/row tables — no snapshot row, no detail rows, no is_current
--   flip. The scorecard_ingest_log row (+ quarantined rows) ARE the failure
--   record and always write. Stale-but-labeled beats fresh-but-wrong.
--
-- TRANSACTION INTEGRITY: writes go through scorecard_ingest_snapshot()
--   (single plpgsql tx): insert snapshot → bulk rows insert → count
--   assertion → demote-then-promote is_current. The partial unique index
--   guarantees never-two-current at the DB level; demote-then-promote
--   inside one tx guarantees never-zero-current mid-flip. supabase-js has
--   no client-side transactions, hence the RPC.
-- ════════════════════════════════════════════════════════════════════

-- ── (a) snapshot header: one row per accepted PDF ───────────────────────────
CREATE TABLE IF NOT EXISTS scorecard_report_snapshots (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_type          text NOT NULL CHECK (report_type IN ('jobs_by_milestone', 'jobs_by_status')),
  period_start         date NOT NULL,          -- A: PDF's declared range start; B: report date (=end)
  period_end           date NOT NULL,
  report_generated_at  timestamptz,            -- printed on the PDF when present
  file_sha256          text NOT NULL,          -- idempotency key (raw PDF bytes)
  storage_path         text NOT NULL,          -- lp-reports/{type}/{yyyy-mm-dd}/{sha}.pdf
  row_count            integer NOT NULL,
  net_total_cents      bigint,                 -- A only: footer NET total
  gross_total_cents    bigint,                 -- A: gross total; B: sum of Total Gross
  is_current           boolean NOT NULL DEFAULT false,
  ingested_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (report_type, file_sha256)            -- DB-level idempotency backstop
);

-- Never two current snapshots for the same (report_type, period).
CREATE UNIQUE INDEX IF NOT EXISTS scorecard_report_snapshots_current_idx
  ON scorecard_report_snapshots (report_type, period_start) WHERE is_current;

-- ── (b) Report A detail rows (Jobs by Milestone Date / RTP Actual) ──────────
-- All money in CENTS (bigint) — no float drift; ties are asserted to the cent.
CREATE TABLE IF NOT EXISTS scorecard_report_rows_a (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  snapshot_id      uuid NOT NULL REFERENCES scorecard_report_snapshots(id) ON DELETE CASCADE,
  job_number       text NOT NULL,
  customer_name    text,
  address          text,
  city             text,
  contract_date    date,
  rtp_date         date,
  branch_code_raw  text,                       -- verbatim from the PDF (LP pads with spaces)
  market           text NOT NULL,              -- resolved via lp_branch_market_map (UNASSIGNED quarantines upstream)
  product          text,
  gross_cents      bigint,
  net_cents        bigint,
  paid_cents       bigint,
  balance_cents    bigint,
  sales_rep        text                        -- carried from the rep header band, audit only
);
CREATE INDEX IF NOT EXISTS scorecard_report_rows_a_snap_market_idx
  ON scorecard_report_rows_a (snapshot_id, market);
CREATE INDEX IF NOT EXISTS scorecard_report_rows_a_snap_rep_idx
  ON scorecard_report_rows_a (snapshot_id, sales_rep);

-- ── (c) Report B detail rows (Jobs By Status / open pipeline) ───────────────
CREATE TABLE IF NOT EXISTS scorecard_report_rows_b (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  snapshot_id       uuid NOT NULL REFERENCES scorecard_report_snapshots(id) ON DELETE CASCADE,
  prosp_number      text NOT NULL,
  customer_name     text,
  phone             text,
  email             text,
  contract_date     date,
  branch_code_raw   text,
  market            text NOT NULL,
  status_raw        text NOT NULL,             -- verbatim LP status (one of the 21 known)
  bucket            text NOT NULL CHECK (bucket IN ('hoa', 'excluded', 'other_pending')),
  total_gross_cents bigint,                    -- $0 is a valid value
  lender            text,                      -- blank is valid
  notes_raw         text,                      -- free-text lines between detail anchors, verbatim
  dup_review        boolean NOT NULL DEFAULT false  -- same Prosp# + same contract date appears twice
);
CREATE INDEX IF NOT EXISTS scorecard_report_rows_b_snap_market_bucket_idx
  ON scorecard_report_rows_b (snapshot_id, market, bucket);
CREATE INDEX IF NOT EXISTS scorecard_report_rows_b_prosp_idx
  ON scorecard_report_rows_b (prosp_number, contract_date);

-- ── (d) ingest log: EVERY attempt, success or not ───────────────────────────
CREATE TABLE IF NOT EXISTS scorecard_ingest_log (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  report_type    text NOT NULL,
  file_sha256    text,
  status         text NOT NULL CHECK (status IN ('success', 'failed', 'duplicate', 'no_text_layer')),
  failure_reason text,                          -- machine key, e.g. 'footer_total_mismatch'
  detail         jsonb,                         -- BOTH sides of every failed comparison
  snapshot_id    uuid,                          -- set on success
  source         text,                          -- 'n8n' | 'manual'
  duration_ms    integer,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scorecard_ingest_log_type_created_idx
  ON scorecard_ingest_log (report_type, created_at DESC);

-- ── (e) quarantine: rows the parser refused to classify ─────────────────────
CREATE TABLE IF NOT EXISTS scorecard_ingest_quarantine (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  report_type text NOT NULL,
  file_sha256 text,
  reason      text NOT NULL,                    -- 'unmapped_status' | 'unmapped_branch' | ...
  row_raw     text,                             -- the PDF line(s), verbatim
  parsed      jsonb,                            -- whatever partial parse existed
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── (f) daily reconciliation results ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scorecard_recon_results (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recon_date       date NOT NULL,
  recon_type       text NOT NULL,               -- 'b_internal' | 'b_vs_warehouse_status' | 'a_vs_warehouse_rtp_gross' | 'a_vs_net_report'
  status           text NOT NULL CHECK (status IN ('pass', 'warn', 'fail', 'skipped')),
  comparison       jsonb,                       -- both sides, deltas, tolerance used
  named_exceptions jsonb,                       -- accepted known residuals (e.g. SE $14,957 / 2 records, 2026-07)
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recon_date, recon_type)
);

-- ── (g) atomic ingest write: snapshot + rows + is_current flip, one tx ──────
-- p_snapshot: {report_type, period_start, period_end, report_generated_at,
--              file_sha256, storage_path, row_count, net_total_cents,
--              gross_total_cents}
-- p_rows: jsonb array shaped for rows_a or rows_b depending on report_type.
-- Raises (→ full rollback) on row-count mismatch, so a partial insert can
-- never be promoted to current.
CREATE OR REPLACE FUNCTION scorecard_ingest_snapshot(p_snapshot jsonb, p_rows jsonb)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_id       uuid;
  v_type     text  := p_snapshot->>'report_type';
  v_period   date  := (p_snapshot->>'period_start')::date;
  v_expected int   := (p_snapshot->>'row_count')::int;
  v_inserted int;
BEGIN
  INSERT INTO scorecard_report_snapshots
    (report_type, period_start, period_end, report_generated_at, file_sha256,
     storage_path, row_count, net_total_cents, gross_total_cents, is_current)
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
  -- index), never zero current observable after commit.
  UPDATE scorecard_report_snapshots
     SET is_current = false
   WHERE report_type = v_type AND period_start = v_period AND is_current AND id <> v_id;
  UPDATE scorecard_report_snapshots SET is_current = true WHERE id = v_id;

  RETURN v_id;
END;
$$;

-- ── (h) private storage bucket for archived PDFs ────────────────────────────
-- If this INSERT is denied for the SQL role, create the bucket once in the
-- Supabase dashboard (Storage → New bucket → 'lp-reports', private).
INSERT INTO storage.buckets (id, name, public)
VALUES ('lp-reports', 'lp-reports', false)
ON CONFLICT (id) DO NOTHING;
