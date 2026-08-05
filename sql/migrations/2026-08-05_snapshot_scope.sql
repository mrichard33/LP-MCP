-- 2026-08-05_snapshot_scope.sql — scope is part of snapshot identity (handoff §1)
--
-- Regression being fixed: the first real MTD sales_efficiency PDF (Aug 1–31,
-- blank Net column) overlapped the YTD window (Jan 1–Sep 2), and the unscoped
-- overlap-demotion retired the YTD snapshot — blanking Gross / Net /
-- Cancellations on the dashboard while the counts-only MTD snapshot answered
-- nothing it could not source.
--
-- Fix: every snapshot carries a scope (mtd | ytd | month | custom) derived
-- from its declared range vs its generation date, and overlap-demotion applies
-- only within the same (report_type, scope) FAMILY:
--   · ytd  demotes only ytd
--   · mtd and month form one family — a finalized calendar month supersedes
--     the stale in-month MTD snapshot for the same window, but neither ever
--     touches a ytd snapshot (and vice versa)
--   · custom demotes only custom
-- Scope is derived in ONE place (lp_derive_scope, used by both promotion
-- RPCs); JS ingest paths pass nothing and cannot drift from this definition.
-- Idempotent; safe to re-run.

-- 1 ── scope column ---------------------------------------------------------
ALTER TABLE scorecard_report_snapshots
  ADD COLUMN IF NOT EXISTS scope text
  CHECK (scope IN ('mtd', 'ytd', 'month', 'custom'));

COMMENT ON COLUMN scorecard_report_snapshots.scope IS
  'Snapshot scope derived from declared range vs generation date '
  '(lp_derive_scope). Overlap-demotion is confined to the same '
  '(report_type, scope) family; mtd+month are one family, ytd is its own.';

-- 2 ── derivation (single source of truth) ----------------------------------
CREATE OR REPLACE FUNCTION lp_derive_scope(p_start date, p_end date, p_as_of date)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    -- mtd: the month containing the generation date, ending inside that month
    -- (LP prints the scheduled window, e.g. Aug 1–31 generated Aug 5)
    WHEN p_start = date_trunc('month', p_as_of::timestamp)::date
     AND p_end  <= (date_trunc('month', p_as_of::timestamp) + interval '1 month - 1 day')::date
      THEN 'mtd'
    -- ytd: starts Jan 1 of the generation year and runs to (or past) the
    -- generation date — a week's slack tolerates an end pinned to "yesterday"
    -- plus weekend/holiday gaps; LP's future EDate (e.g. Sep 2) also lands here
    WHEN p_start = make_date(extract(year FROM p_as_of)::int, 1, 1)
     AND p_end  >= p_as_of - 7
      THEN 'ytd'
    -- month: a full historical calendar month (monthly backfills)
    WHEN p_start = date_trunc('month', p_start::timestamp)::date
     AND p_end   = (date_trunc('month', p_start::timestamp) + interval '1 month - 1 day')::date
      THEN 'month'
    ELSE 'custom'
  END
$$;

-- 3 ── backfill existing snapshots, then require scope ----------------------
UPDATE scorecard_report_snapshots
   SET scope = lp_derive_scope(
                 period_start, period_end,
                 COALESCE(as_of_date,
                          (ingested_at AT TIME ZONE 'America/New_York')::date))
 WHERE scope IS NULL;

ALTER TABLE scorecard_report_snapshots ALTER COLUMN scope SET NOT NULL;

-- 4 ── one current snapshot per (report_type, scope, period_start) ----------
-- (was (report_type, period_start) — which would forbid a January YTD and a
-- January monthly snapshot from being simultaneously current)
DROP INDEX IF EXISTS scorecard_report_snapshots_current_idx;
CREATE UNIQUE INDEX scorecard_report_snapshots_current_idx
  ON scorecard_report_snapshots (report_type, scope, period_start)
  WHERE is_current;

-- 5 ── scope mirrored onto lp_report_facts (the dashboard's read surface) ---
-- The dashboard picks a snapshot per metric need (cohort-mature Net/NSA/
-- cancellations from ytd; flow counts from mtd) and reads only
-- lp_report_facts, so scope must travel with the facts. It is filled by
-- trigger rather than inside scorecard_rebuild_facts on purpose: the
-- projection stays the one place metrics are computed, and every present and
-- future branch of it inherits a correct scope without a 200-line restatement
-- that could drift.
ALTER TABLE lp_report_facts
  ADD COLUMN IF NOT EXISTS scope text
  CHECK (scope IN ('mtd', 'ytd', 'month', 'custom'));

COMMENT ON COLUMN lp_report_facts.scope IS
  'Mirrors scorecard_report_snapshots.scope for the snapshot that produced '
  'this fact (filled by lp_report_facts_scope_trg).';

CREATE OR REPLACE FUNCTION lp_report_facts_fill_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.scope IS NULL THEN
    SELECT s.scope INTO NEW.scope
      FROM scorecard_report_snapshots s
     WHERE s.id = NEW.snapshot_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lp_report_facts_scope_trg ON lp_report_facts;
CREATE TRIGGER lp_report_facts_scope_trg
  BEFORE INSERT ON lp_report_facts
  FOR EACH ROW EXECUTE FUNCTION lp_report_facts_fill_scope();

UPDATE lp_report_facts f
   SET scope = s.scope
  FROM scorecard_report_snapshots s
 WHERE s.id = f.snapshot_id AND f.scope IS DISTINCT FROM s.scope;

CREATE INDEX IF NOT EXISTS lp_report_facts_current_scope_idx
  ON lp_report_facts (report_type, scope, metric)
  WHERE is_current;

-- 6 ── scorecard_ingest_snapshot: scope-aware promotion ---------------------
CREATE OR REPLACE FUNCTION public.scorecard_ingest_snapshot(p_snapshot jsonb, p_rows jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
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
  v_scope    text;
  v_inserted int;
BEGIN
  v_scope := COALESCE(NULLIF(p_snapshot->>'scope', ''),
                      lp_derive_scope(v_period, v_pend, v_as_of));

  INSERT INTO scorecard_report_snapshots
    (report_type, period_start, period_end, report_generated_at, file_sha256,
     storage_path, row_count, net_total_cents, gross_total_cents, as_of_date,
     scope, is_current)
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
     v_scope,
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

  -- Demote only within the same (report_type, scope) family: ytd↔ytd,
  -- custom↔custom, and {mtd, month} as one family. An MTD arrival can never
  -- retire a YTD snapshot again (the 2026-08-05 §1 regression).
  WITH demoted AS (
    UPDATE scorecard_report_snapshots
       SET is_current = false
     WHERE report_type = v_type
       AND daterange(period_start, period_end, '[]') && daterange(v_period, v_pend, '[]')
       AND (scope = v_scope
            OR (scope IN ('mtd', 'month') AND v_scope IN ('mtd', 'month')))
       AND is_current AND id <> v_id
    RETURNING id)
  UPDATE lp_report_facts f SET is_current = false
   WHERE f.snapshot_id IN (SELECT id FROM demoted);
  UPDATE scorecard_report_snapshots SET is_current = true WHERE id = v_id;

  PERFORM scorecard_rebuild_facts(v_id);

  RETURN v_id;
END;
$function$;

-- 7 ── lp_csv_ingest_begin: stamp scope at insert ---------------------------
CREATE OR REPLACE FUNCTION public.lp_csv_ingest_begin(p_snapshot jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_id     uuid;
  v_period date := (p_snapshot->>'period_start')::date;
  v_pend   date := (p_snapshot->>'period_end')::date;
  v_as_of  date := COALESCE(
                     NULLIF(p_snapshot->>'as_of_date', '')::date,
                     (NULLIF(p_snapshot->>'report_generated_at', '')::timestamptz
                        AT TIME ZONE 'America/New_York')::date,
                     (now() AT TIME ZONE 'America/New_York')::date);
  v_scope  text;
BEGIN
  IF p_snapshot->>'report_type' NOT IN ('job_status_ytd', 'lead_disposition', 'source_cost', 'sales_efficiency') THEN
    RAISE EXCEPTION 'lp_csv_ingest_begin: unknown report_type %', p_snapshot->>'report_type';
  END IF;
  v_scope := COALESCE(NULLIF(p_snapshot->>'scope', ''),
                      lp_derive_scope(v_period, v_pend, v_as_of));
  INSERT INTO scorecard_report_snapshots
    (report_type, period_start, period_end, report_generated_at, file_sha256,
     storage_path, row_count, as_of_date, source_format, control_totals,
     scope, is_current)
  VALUES
    (p_snapshot->>'report_type',
     v_period,
     v_pend,
     NULLIF(p_snapshot->>'report_generated_at', '')::timestamptz,
     p_snapshot->>'file_sha256',
     p_snapshot->>'storage_path',
     (p_snapshot->>'row_count')::int,
     NULLIF(p_snapshot->>'as_of_date', '')::date,
     COALESCE(NULLIF(p_snapshot->>'source_format', ''), 'csv'),
     p_snapshot->'control_totals',
     v_scope,
     false)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;

-- 8 ── lp_csv_ingest_finalize: scope-aware demotion at promotion ------------
CREATE OR REPLACE FUNCTION public.lp_csv_ingest_finalize(p_snapshot_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
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

  UPDATE scorecard_report_snapshots SET finalized_at = now() WHERE id = p_snapshot_id;
  -- Same scope-family confinement as scorecard_ingest_snapshot.
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
  UPDATE scorecard_report_snapshots SET is_current = true WHERE id = p_snapshot_id;

  SELECT scorecard_rebuild_facts(p_snapshot_id) INTO v_facts;
  RETURN v_facts;
END;
$function$;
