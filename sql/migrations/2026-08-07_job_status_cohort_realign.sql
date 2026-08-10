-- ════════════════════════════════════════════════════════════════════
-- 2026-08-07 — Report 133 "Jobs by Status": cohort realign
--
-- Applied BY HAND per sql/README.md. Idempotent: safe to re-run.
--
-- WHY. The 133 export LP actually ships is not the report the parser was built
-- against. The old one was a full-YTD stock snapshot of OPEN jobs; the shipped
-- one is scoped by CONTRACT DATE and carries every status, most of them
-- terminal. All 525 rows of the March 2026 file have a March ContractDate:
-- 331 Paid In Full, 167 cancelled/declined/dead, and just 2 open holds.
--
-- Consequences this migration exists to handle:
--
--   1. NEW COLUMNS. The export carries branch natively (District/Market), plus
--      TotalDue, sub-source, product ids and finance sources. lp_id (the LP
--      customer id) replaces cst_id as the join key to 135.
--
--   2. FIVE COLUMNS GO PERMANENTLY NULL. NETDATE, statusdate, FinAmount,
--      RepName and FinCo do not exist in this export. Verified 2026-08-07 to
--      have ZERO readers — not in scorecard_rebuild_facts, not in
--      lp-report-recon.js, not anywhere in Reece-Dashboard, which never
--      references lp_job_status_history at all. cst_id likewise stops being
--      populated, so its NOT NULL has to go or every insert fails.
--
--   3. THE BUCKET VOCABULARY CANNOT EXPRESS TERMINAL OUTCOMES. 'excluded' meant
--      "released to the production track" AND doubled as the dumping ground for
--      everything that was not an open hold. Under a cohort export that
--      conflation swallows every completed and lost job. It is renamed
--      'in_production' (same membership, honest name) and 'completed' / 'lost'
--      are added as separately addressable buckets — cancellation and
--      credit-decline volume by market is the reporting value of this export.
--
--   4. "EVERYTHING NOT EXCLUDED IS GOOD BUSINESS" IS NOW WRONG. That is
--      literally what scorecard_rebuild_facts said. Left alone it would label
--      331 paid and 167 cancelled jobs `good_business_open` and fold them into
--      pending backlog. Section (g) replaces it with an explicit six-way map.
--
-- report_type stays 'job_status_ytd' and the table keeps its name to avoid
-- schema churn. BOTH NAMES ARE NOW MISNOMERS — there is nothing YTD about this
-- file. Read them as "report 133", nothing more.
--
-- SCOPE DISCIPLINE: report B ('jobs_by_status', the PDF-era monthly cohort in
-- scorecard_report_rows_b) has its OWN 'excluded' bucket and is NOT touched
-- here. Every rename below is scoped to job_status_ytd / lp_job_status_history.
--
-- NOT mirrored in runMigrations() — this is a one-time realign of an existing
-- table, not boot-critical DDL a fresh deploy needs to self-heal.
--
-- ══ ORDERING — APPLY THIS BEFORE DEPLOYING THE CODE ══
-- The new parser stops emitting cst_id, which is NOT NULL until section (b)
-- runs. Deploy first and every 133 ingest fails at insert. This migration is
-- backward-compatible with the CURRENT code (it only adds columns and relaxes
-- constraints), so migration-then-deploy is safe in a way the reverse is not.
--
-- ══ CLASS ══ Per sql/README.md this is NOT purely additive: it drops a NOT
-- NULL, drops four CHECK constraints, and backfills `bucket` on two POPULATED
-- tables. Doctrine puts that class in the dashboard with a human watching.
--
-- APPLIED 2026-08-08 via MCP apply_migration on explicit instruction, against
-- rcjcgjlqzepicbwhnnjl, split into five named migrations so the data-changing
-- half stayed in one transaction and the function replacements — each
-- independently idempotent — followed:
--     job_status_cohort_realign_schema              sections (a)-(e) columns
--     job_status_cohort_realign_begin_fn            lp_csv_ingest_begin
--     job_status_cohort_realign_rows_fn             lp_csv_ingest_rows
--     job_status_cohort_realign_rebuild_facts_fn    scorecard_rebuild_facts
--     job_status_cohort_realign_finalize_fn         lp_csv_ingest_finalize
--     job_status_cohort_realign_idempotency_check   re-run, zero rows changed
--
-- RESULT: lp_job_status_history 698 rows excluded → in_production, none left in
-- the dead vocabulary. lp_report_facts job_status_ytd 10 → in_production;
-- jobs_by_status kept all 32 of its own 'excluded' rows, which is the scope
-- assertion. Re-running changed nothing.
--
-- ROLLBACK: the bucket rename is the only data change, and it is reversible —
--   UPDATE lp_job_status_history SET bucket = 'excluded' WHERE bucket = 'in_production';
--   UPDATE lp_report_facts SET bucket = 'excluded'
--    WHERE report_type = 'job_status_ytd' AND bucket = 'in_production';
--   -- then re-add the four-value CHECKs and re-create the three functions from
--   -- sql/migrations/2026-08-07_appt_stats_by_rep_source.sql, which holds the
--   -- immediately-prior definitions of lp_csv_ingest_rows / _finalize / _begin
--   -- and scorecard_rebuild_facts.
--   Rows carrying 'completed' or 'lost' cannot be rolled back into the old
--   vocabulary — it has nowhere to put them. Roll back BEFORE ingesting a
--   cohort file, or not at all.
--
-- AFTER RUNNING: existing job_status_ytd snapshots keep their old five columns
-- and gain NULLs in the new ones; they are NOT retroactively re-derived. Only
-- files ingested after this point carry lp_id / job_id / total_due_cents /
-- cohort_basis. Re-POST any month you want fully populated.
--
-- PRE-STATE (captured 2026-08-08, before this ran) — lp_report_facts by
-- (report_type, bucket):
--     job_status_ytd   excluded 10 | hoa  9 | other_pending  8 | permit 6
--     jobs_by_status   excluded 32 | hoa 16 | other_pending 21
-- The 10 must become in_production. The 32 must NOT.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── (a) new columns on lp_job_status_history ────────────────────────────────
--
-- ⚠️ INCOMPLETE — `city` IS MISSING FROM THIS LIST AND IS ADDED BY
--    sql/migrations/2026-08-10_job_status_city_and_orphan_reaper.sql.
--
-- Section (f) below writes lp_csv_ingest_rows to INSERT `city` into this table
-- and to read it out of the jsonb recordset, and the parser emits it — but the
-- column was never added here. Every chunked 133 ingest therefore failed at
-- chunk 0 ("column \"city\" of relation \"lp_job_status_history\" does not
-- exist") from 2026-08-09 until the 08-10 migration, each failure leaving an
-- orphaned snapshot that blocked its own retry.
--
-- Do NOT add `city` here. This file records what was actually applied on
-- 2026-08-08; the fix belongs to the migration that made it. Anyone rebuilding
-- from migrations in order must apply 2026-08-10 as well, or they recreate the
-- same gap.
--
ALTER TABLE lp_job_status_history
  ADD COLUMN IF NOT EXISTS row_num          integer,
  ADD COLUMN IF NOT EXISTS lp_id            text,
  ADD COLUMN IF NOT EXISTS job_id           text,
  ADD COLUMN IF NOT EXISTS total_due_cents  bigint,
  ADD COLUMN IF NOT EXISTS district_raw     text,
  ADD COLUMN IF NOT EXISTS market_code_raw  text,
  ADD COLUMN IF NOT EXISTS sub_source       text,
  ADD COLUMN IF NOT EXISTS product_ids      text[],
  ADD COLUMN IF NOT EXISTS finance_sources  text[],
  ADD COLUMN IF NOT EXISTS cohort_basis     text;

COMMENT ON COLUMN lp_job_status_history.lp_id IS
  'LP customer id (export column `id`). NOT UNIQUE PER ROW — the March 2026 file has 525 rows and 524 distinct ids (414605 covers two separate jobs). It is a join key to lp_lead_disposition_history.lp_lead_id, never a row identity or an upsert target.';
COMMENT ON COLUMN lp_job_status_history.job_id IS
  'LP job id. The per-row identity key: 525/525 distinct on the March export. Prefer this over lp_id and contract_id (which carries the literal ''NEW'' on 8 rows).';
COMMENT ON COLUMN lp_job_status_history.market_code_raw IS
  'Verbatim `Market` from the export — populated on every row. Resolved to a *_MKT through lp_branch_market_map at ingest.';
COMMENT ON COLUMN lp_job_status_history.district_raw IS
  'Verbatim `District`. Fallback only: blank on 3 of 525 March rows and disagreeing with Market on 4.';
COMMENT ON COLUMN lp_job_status_history.total_due_cents IS
  'TotalDue in CENTS. Legitimately NEGATIVE (18 of 525 March rows) — an overpayment, not corruption. Parsed with parseCsvMoneyCents: LP prints its four-decimal form here on 478 of 525 rows.';
COMMENT ON COLUMN lp_job_status_history.cohort_basis IS
  'How this file was scoped. ''contract_date'' = every job whose contract date falls in the period, at whatever status it now has. NOT a snapshot of what is still open — do not sum it as pending backlog.';

CREATE INDEX IF NOT EXISTS lp_job_status_history_lp_id_idx
  ON lp_job_status_history (lp_id);
CREATE INDEX IF NOT EXISTS lp_job_status_history_snap_job_idx
  ON lp_job_status_history (snapshot_id, job_id);
CREATE INDEX IF NOT EXISTS lp_job_status_history_contract_date_idx
  ON lp_job_status_history (snapshot_id, contract_date);

-- ── (b) columns this export no longer supplies ──────────────────────────────
-- cst_id is the load-bearing one: it is NOT NULL today and the parser has
-- stopped emitting it, so without this every insert fails. The other five are
-- already nullable; the statements are here so the intent is recorded rather
-- than inferred, and they are no-ops on a correct schema.
ALTER TABLE lp_job_status_history ALTER COLUMN cst_id      DROP NOT NULL;
ALTER TABLE lp_job_status_history ALTER COLUMN fin_cents   DROP NOT NULL;
ALTER TABLE lp_job_status_history ALTER COLUMN net_date    DROP NOT NULL;
ALTER TABLE lp_job_status_history ALTER COLUMN status_date DROP NOT NULL;
ALTER TABLE lp_job_status_history ALTER COLUMN rep_name    DROP NOT NULL;
ALTER TABLE lp_job_status_history ALTER COLUMN fin_co      DROP NOT NULL;

COMMENT ON COLUMN lp_job_status_history.cst_id IS
  'DEAD as of 2026-08-07 — the shipped 133 export has no cst_id column. Historical rows keep their values; new rows are NULL. Use lp_id.';
COMMENT ON COLUMN lp_job_status_history.fin_cents IS
  'DEAD as of 2026-08-07 (export dropped FinAmount). Historical rows only. Was the FINANCED amount, never net.';
COMMENT ON COLUMN lp_job_status_history.net_date IS
  'DEAD as of 2026-08-07 (export dropped NETDATE). Historical rows only.';
COMMENT ON COLUMN lp_job_status_history.status_date IS
  'DEAD as of 2026-08-07 (export dropped statusdate). Historical rows only.';
COMMENT ON COLUMN lp_job_status_history.rep_name IS
  'DEAD as of 2026-08-07 (export dropped RepName). Historical rows only.';
COMMENT ON COLUMN lp_job_status_history.fin_co IS
  'DEAD as of 2026-08-07 (export dropped FinCo). Historical rows only.';

-- ── (c) bucket vocabulary: rename excluded → in_production, add the two
--        terminal buckets ────────────────────────────────────────────────────
-- Constraint dropped first so the UPDATE can land, then re-added over the full
-- six-value vocabulary. Both happen in this transaction, so there is no window
-- in which a row could carry an unconstrained bucket.
ALTER TABLE lp_job_status_history DROP CONSTRAINT IF EXISTS lp_job_status_history_bucket_check;
UPDATE lp_job_status_history SET bucket = 'in_production' WHERE bucket = 'excluded';
ALTER TABLE lp_job_status_history ADD CONSTRAINT lp_job_status_history_bucket_check
  CHECK (bucket IN ('hoa', 'permit', 'other_pending', 'in_production', 'completed', 'lost'));

COMMENT ON COLUMN lp_job_status_history.bucket IS
  'hoa | permit | other_pending (all three OPEN — this is Good Business) | in_production (released, was ''excluded'') | completed (Paid In Full, PIF Survey Ready) | lost (Cancelled, Cancelled By Mgt, Credit Decline, Dead Deal). NEVER derive "open" as "not in_production" — completed and lost are the majority of a cohort file.';

COMMENT ON TABLE lp_job_status_history IS
  'Report 133 "Jobs by Status", one row per job per import. A CONTRACT-DATE COHORT, not an open-job snapshot: it carries every status, mostly terminal (March 2026: 331 completed, 167 lost, 25 in production, 2 open). The table name and report_type ''job_status_ytd'' are retained MISNOMERS — nothing about this file is YTD. Money in CENTS. Superseded snapshots retained forever; is_current lives on the snapshot header.';

-- ── (d) the same rename in lp_report_facts ──────────────────────────────────
-- SCOPED TO job_status_ytd. report_type='jobs_by_status' is report B's PDF
-- cohort and keeps its own 'excluded' bucket untouched.
ALTER TABLE lp_report_facts DROP CONSTRAINT IF EXISTS lp_report_facts_bucket_check;
ALTER TABLE lp_report_facts DROP CONSTRAINT IF EXISTS lp_report_facts_metric_check;

UPDATE lp_report_facts SET bucket = 'in_production'
 WHERE report_type = 'job_status_ytd' AND bucket = 'excluded';

ALTER TABLE lp_report_facts ADD CONSTRAINT lp_report_facts_bucket_check
  CHECK (bucket IN ('hoa', 'permit', 'other_pending', 'excluded',
                    'in_production', 'completed', 'lost'));
ALTER TABLE lp_report_facts ADD CONSTRAINT lp_report_facts_metric_check
  CHECK (metric IN ('net_sales', 'gross_sold', 'good_business_open', 'pipeline_excluded',
                    'dup_review_pending', 'leads', 'sets', 'confirmed', 'issued', 'sat',
                    'sold', 'net_sold', 'marketing_cost', 'working_amount', 'cancelled',
                    'credit_decline', 'working_open', 'hold',
                    'cohort_completed', 'cohort_lost'));

-- ── (e) snapshot header: record the cohort basis ────────────────────────────
ALTER TABLE scorecard_report_snapshots ADD COLUMN IF NOT EXISTS cohort_basis text;
COMMENT ON COLUMN scorecard_report_snapshots.cohort_basis IS
  'How the file was scoped, when the report says so. ''contract_date'' (report 133) = a period cohort keyed on contract date, carrying terminal statuses. NULL = unstated. Makes the semantic explicit in the data instead of implied by a report name.';

CREATE OR REPLACE FUNCTION public.lp_csv_ingest_begin(p_snapshot jsonb)
RETURNS uuid LANGUAGE plpgsql AS $function$
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
                                        'appt_stats_by_rep_source') THEN
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
$function$;

-- ── (f) lp_csv_ingest_rows: new job_status_ytd column list ──────────────────
-- Only the job_status_ytd branch changes; every other branch is carried
-- forward verbatim from the 2026-08-07 appt-stats version.
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
  ELSE
    RAISE EXCEPTION 'lp_csv_ingest_rows: snapshot % has non-CSV report_type %', p_snapshot_id, v_type;
  END IF;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$function$;

-- ── (g) scorecard_rebuild_facts: an EXPLICIT bucket → metric map for 133 ────
--
-- THE DEFECT THIS FIXES. The 133 block used to read:
--     CASE WHEN j.bucket = 'excluded' THEN 'pipeline_excluded'
--          ELSE 'good_business_open' END
-- i.e. "everything that is not excluded is open Good Business". True of a
-- stock snapshot of open jobs. Catastrophic on a cohort: it would have labelled
-- 331 paid and 167 cancelled March jobs as pending backlog.
--
-- All six buckets are now named explicitly and there is NO `ELSE`. The CHECK
-- constraint in section (c) is what makes the CASE total — a seventh bucket
-- cannot exist in the table, so it cannot slip through as Good Business.
--
-- The scorecard_report_rows_b block below is report B (the PDF-era monthly
-- cohort) and keeps its own 'excluded' bucket. It is carried forward verbatim.
CREATE OR REPLACE FUNCTION public.scorecard_rebuild_facts(p_snapshot_id uuid)
RETURNS integer LANGUAGE plpgsql AS $function$
DECLARE
  v_count int := 0;
  v_part  int;
BEGIN
  DELETE FROM lp_report_facts WHERE snapshot_id = p_snapshot_id;

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

  INSERT INTO lp_report_facts
    (snapshot_id, report_type, period_start, period_end, as_of_date,
     market, branch_code_raw, metric, bucket, value_cents, value_count, is_current)
  SELECT s.id, s.report_type, s.period_start, s.period_end,
         COALESCE(s.as_of_date, (s.ingested_at AT TIME ZONE 'America/New_York')::date),
         j.market, j.branch_code_raw,
         CASE j.bucket
           WHEN 'hoa'           THEN 'good_business_open'
           WHEN 'permit'        THEN 'good_business_open'
           WHEN 'other_pending' THEN 'good_business_open'
           WHEN 'in_production' THEN 'pipeline_excluded'
           WHEN 'completed'     THEN 'cohort_completed'
           WHEN 'lost'          THEN 'cohort_lost'
         END,
         j.bucket,
         COALESCE(SUM(j.gross_cents), 0), COUNT(*)::int, s.is_current
  FROM scorecard_report_snapshots s
  JOIN lp_job_status_history j ON j.snapshot_id = s.id
  WHERE s.id = p_snapshot_id
  GROUP BY s.id, s.report_type, s.period_start, s.period_end, s.as_of_date,
           s.ingested_at, s.is_current, j.market, j.branch_code_raw, j.bucket;
  GET DIAGNOSTICS v_part = ROW_COUNT;
  v_count := v_count + v_part;

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
$function$;

-- ── (h) lp_csv_ingest_finalize: assert every bucket, not just the open two ──
-- Under a cohort export the terminal buckets carry most of the file, so leaving
-- them unasserted would let the largest counts drift silently. An unknown key
-- still aborts — that gate is unchanged.
CREATE OR REPLACE FUNCTION public.lp_csv_ingest_finalize(p_snapshot_id uuid)
RETURNS integer LANGUAGE plpgsql AS $function$
DECLARE
  s          scorecard_report_snapshots%ROWTYPE;
  v_rows     bigint;
  v_expected bigint;
  v_actual   bigint;
  v_key      text;
  v_facts    int;
  v_closed   boolean;
  d          record;
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
$function$;

COMMIT;

-- ── Verification — run after applying, and again after a second apply ───────
--
-- 1. The rename landed on 133 and NOT on report B. Expect exactly:
--      job_status_ytd  in_production 10 | hoa  9 | other_pending  8 | permit 6
--      jobs_by_status  excluded     32 | hoa 16 | other_pending 21
--    Any 'excluded' row under job_status_ytd, or any 'in_production' row under
--    jobs_by_status, means the UPDATE in (d) lost its report_type scope.
--
-- SELECT report_type, bucket, count(*) AS n
--   FROM lp_report_facts
--  WHERE report_type IN ('job_status_ytd', 'jobs_by_status')
--  GROUP BY 1, 2 ORDER BY 1, 2;
--
-- 2. No history row is left in the dead vocabulary, and the CHECK admits six.
--
-- SELECT bucket, count(*) FROM lp_job_status_history GROUP BY 1 ORDER BY 1;
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conname = 'lp_job_status_history_bucket_check';
--
-- 3. Every new column exists and cst_id is nullable.
--
-- SELECT column_name, is_nullable FROM information_schema.columns
--  WHERE table_name = 'lp_job_status_history'
--    AND column_name IN ('row_num','lp_id','job_id','total_due_cents','district_raw',
--                        'market_code_raw','sub_source','product_ids','finance_sources',
--                        'cohort_basis','cst_id')
--  ORDER BY column_name;
--
-- 4. The four functions are the new ones. lp_csv_ingest_rows must mention
--    total_due_cents; scorecard_rebuild_facts must mention cohort_lost and must
--    NOT contain the old two-way job-status CASE.
--
-- SELECT p.proname,
--        pg_get_functiondef(p.oid) LIKE '%total_due_cents%'  AS has_total_due,
--        pg_get_functiondef(p.oid) LIKE '%cohort_lost%'      AS has_cohort_lost
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public'
--    AND p.proname IN ('lp_csv_ingest_rows','lp_csv_ingest_finalize',
--                      'lp_csv_ingest_begin','scorecard_rebuild_facts')
--  ORDER BY p.proname;
