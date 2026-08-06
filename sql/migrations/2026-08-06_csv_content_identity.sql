-- 2026-08-06_csv_content_identity.sql — CSV cutover: coverage, closure, identity
--
-- Run in: LP MCP Supabase → SQL Editor (or supabase MCP apply_migration).
-- Idempotent (ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE / DROP CONSTRAINT
-- IF EXISTS); safe to re-run. There is no migration runner in this repo and NO
-- boot-time DDL mirror in index.js — this file is applied manually, code ships
-- separately.
--
-- WHAT THIS IS. LP now schedules CSV exports, so CSV becomes the go-forward
-- ingest format for all five reports and the PDF parsers become legacy. Three
-- things the PDF pipeline relied on do not exist in a CSV export, and this
-- migration replaces them:
--
--   1. THE FOOTER IS GONE. LP CSV files have no footer and no Grand Total row —
--      they end at the last data row. Nothing can tie out against a printed
--      total, so control_totals becomes the only record of the computed sums.
--      net_total_cents / gross_total_cents stay for the legacy PDF rows.
--
--   2. file_sha256 CANNOT DEDUPE A CSV. Every row embeds CurrentDateTime, so
--      two pulls of an identical period differ byte-for-byte. content_sha256
--      already existed for this — but NO function ever wrote it, so it is NULL
--      on every snapshot in the table and its unique index has never once
--      fired (verified 2026-08-06 against the live database). This
--      migration makes the RPCs persist it, which is what turns the column
--      from decoration into the authoritative CSV dedupe key.
--
--   3. finalized_at DOES NOT MEAN "THE PERIOD IS CLOSED". It means the chunked
--      load committed, and lp_csv_ingest_rows refuses inserts once it is set.
--      137's in-flight August snapshot is already finalized_at non-NULL. So
--      period closure gets its OWN column rather than overloading a working
--      invariant.
--
-- WHAT THIS IS NOT. It does not touch the PDF band parsers, does not backfill
-- any existing row, and deletes nothing. The RETENTION GUARANTEE holds:
-- superseded snapshots demote to non-current history and are never pruned.
-- Mislabeled history (March's 137, where $8,357,993 of net sales sits in
-- hold_cents with nsa_cents NULL) is repaired by re-sending the period as CSV,
-- which supersedes via normal promotion.
--
-- ROLLBACK: the three added columns are additive and unread by old code, so
-- reverting the application alone is sufficient — leave them in place. To undo
-- fully: ALTER TABLE scorecard_report_snapshots DROP COLUMN period_closed_at,
-- DROP COLUMN is_partial_month, DROP COLUMN parser_version; then restore the
-- three functions from 2026-08-05_snapshot_scope.sql. The ingest-log CHECK
-- widening must NOT be rolled back independently — code writes 'succeeded' and
-- 'succeeded_with_warnings' today and narrowing it re-breaks 135/136 logging.
--
-- AFTER RUNNING: deploy the matching application code, then run
-- sql/verify/2026-08-06_csv_content_identity_smoke.sql. Operator remediation
-- steps are in docs/lp-report-csv-cutover-runbook.md.

BEGIN;

-- ── (a) coverage, closure, and parser identity ──────────────────────────────

ALTER TABLE scorecard_report_snapshots
  ADD COLUMN IF NOT EXISTS period_closed_at  timestamptz,
  ADD COLUMN IF NOT EXISTS is_partial_month  boolean,
  ADD COLUMN IF NOT EXISTS parser_version    text;

COMMENT ON COLUMN scorecard_report_snapshots.period_closed_at IS
  'When this snapshot was accepted as the FINAL reading of a closed period. '
  'Distinct from finalized_at, which means "the chunked load committed" and '
  'gates lp_csv_ingest_rows. Set only when period_end has passed AND '
  'is_partial_month is explicitly false.';

COMMENT ON COLUMN scorecard_report_snapshots.is_partial_month IS
  'TRUE when the file was generated BEFORE its period ended, i.e. it does not '
  'cover the whole period it declares. Derived from coverage, never from the '
  'date range: LP schedules [BOCM]-[EOCM], so period_end is the last day of '
  'the month even mid-month and the range can never indicate partial. NULL '
  'means unknown — legacy PDF snapshots carry no reliable generation time.';

COMMENT ON COLUMN scorecard_report_snapshots.parser_version IS
  'Which reading produced this snapshot. Folded into content_sha256 so that a '
  'parser fix lets the same source content re-land and supersede, instead of '
  'bouncing as a duplicate of the reading it was meant to replace.';

-- ── (b) ingest log: admit the statuses the code already writes ──────────────
--
-- lp-csv-ingest.js writes 'succeeded' and 'succeeded_with_warnings'; the CHECK
-- admitted neither, and logIngest only console.error'd the rejection. Net
-- effect: every successful report-135 and report-136 ingest wrote NO log row at
-- all — the snapshot landed and promoted while the ingest feed and the watchdog
-- saw an empty morning. 'superseded' is new, for the §H demotion record.

ALTER TABLE scorecard_ingest_log
  DROP CONSTRAINT IF EXISTS scorecard_ingest_log_status_check;
ALTER TABLE scorecard_ingest_log
  ADD  CONSTRAINT scorecard_ingest_log_status_check
  CHECK (status IN ('success', 'succeeded', 'succeeded_with_warnings',
                    'failed', 'duplicate', 'superseded', 'no_text_layer'));

-- ── (c) shared helper: is a period closed as of now? ────────────────────────
--
-- ET is load-bearing, not decoration. A 21:00 EDT run on the 31st is 01:00 UTC
-- on the 1st; comparing naive UTC dates would call that file month-complete and
-- finalize a snapshot that is missing the last three hours of the month.

CREATE OR REPLACE FUNCTION public.lp_is_partial_coverage(
  p_generated_at timestamptz, p_period_end date
) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_generated_at IS NULL OR p_period_end IS NULL THEN NULL
    ELSE (p_generated_at AT TIME ZONE 'America/New_York')::date <= p_period_end
  END;
$$;

COMMENT ON FUNCTION public.lp_is_partial_coverage IS
  'Coverage test behind is_partial_month: a run at or before period_end is '
  'still accumulating. NULL when generation time is unknown — never guess.';

-- ── (d) record a closed-period supersede ────────────────────────────────────

CREATE OR REPLACE FUNCTION public.lp_log_supersede(
  p_report_type text, p_old uuid, p_new uuid
) RETURNS void LANGUAGE sql AS $$
  INSERT INTO scorecard_ingest_log (report_type, status, failure_reason, detail, snapshot_id, source)
  VALUES (p_report_type, 'superseded', NULL,
          jsonb_build_object('superseded_snapshot_id', p_old, 'superseding_snapshot_id', p_new),
          p_new, 'promotion');
$$;

-- ── (e) lp_csv_ingest_begin: persist identity + coverage, admit 134 ─────────
--
-- jobs_by_milestone and jobs_by_status join the allowlist because the CSV
-- cutover routes all five reports through this path. Unchanged otherwise.

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
                                        'sales_efficiency', 'jobs_by_milestone', 'jobs_by_status') THEN
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
     source_format, control_totals, scope, is_partial_month, is_current)
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
     false)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;

-- ── (f) lp_csv_ingest_finalize: close the period on promotion ───────────────
--
-- Identical to the 2026-08-05 version through the control-total gate. The only
-- change is the promotion block: period_closed_at is set in the SAME statement
-- as the is_current flip, and a demoted snapshot that had itself been closed is
-- recorded as 'superseded' with both ids.

CREATE OR REPLACE FUNCTION public.lp_csv_ingest_finalize(p_snapshot_id uuid)
RETURNS int LANGUAGE plpgsql AS $function$
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

-- ── (g) scorecard_ingest_snapshot: same treatment for the single-tx path ────
--
-- 133/134 PDFs still land here. Unchanged except that it now persists
-- content_sha256 (the app has been computing it and probing with it since
-- 2026-08-06, against a column nothing wrote), parser_version, coverage, and
-- period closure.

CREATE OR REPLACE FUNCTION public.scorecard_ingest_snapshot(p_snapshot jsonb, p_rows jsonb)
RETURNS uuid LANGUAGE plpgsql AS $function$
DECLARE
  v_id       uuid;
  v_type     text  := p_snapshot->>'report_type';
  v_period   date  := (p_snapshot->>'period_start')::date;
  v_pend     date  := (p_snapshot->>'period_end')::date;
  v_expected int   := (p_snapshot->>'row_count')::int;
  v_gen      timestamptz := NULLIF(p_snapshot->>'report_generated_at', '')::timestamptz;
  v_as_of    date  := COALESCE(
                        NULLIF(p_snapshot->>'as_of_date', '')::date,
                        (v_gen AT TIME ZONE 'America/New_York')::date,
                        (now() AT TIME ZONE 'America/New_York')::date);
  v_scope    text;
  v_inserted int;
  v_partial  boolean;
  v_closed   boolean;
  d          record;
BEGIN
  v_scope := COALESCE(NULLIF(p_snapshot->>'scope', ''),
                      lp_derive_scope(v_period, v_pend, v_as_of));
  v_partial := COALESCE((p_snapshot->>'is_partial_month')::boolean,
                        lp_is_partial_coverage(v_gen, v_pend));

  INSERT INTO scorecard_report_snapshots
    (report_type, period_start, period_end, report_generated_at, file_sha256,
     content_sha256, parser_version, storage_path, row_count, net_total_cents,
     gross_total_cents, as_of_date, scope, is_partial_month, is_current)
  VALUES
    (v_type,
     v_period,
     v_pend,
     v_gen,
     p_snapshot->>'file_sha256',
     NULLIF(p_snapshot->>'content_sha256', ''),
     NULLIF(p_snapshot->>'parser_version', ''),
     p_snapshot->>'storage_path',
     v_expected,
     NULLIF(p_snapshot->>'net_total_cents', '')::bigint,
     NULLIF(p_snapshot->>'gross_total_cents', '')::bigint,
     v_as_of,
     v_scope,
     v_partial,
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

  v_closed := (v_pend < (now() AT TIME ZONE 'America/New_York')::date)
              AND (v_partial IS FALSE);

  FOR d IN
    SELECT id FROM scorecard_report_snapshots
     WHERE report_type = v_type
       AND daterange(period_start, period_end, '[]') && daterange(v_period, v_pend, '[]')
       AND (scope = v_scope OR (scope IN ('mtd', 'month') AND v_scope IN ('mtd', 'month')))
       AND is_current AND id <> v_id
       AND period_closed_at IS NOT NULL
  LOOP
    PERFORM lp_log_supersede(v_type, d.id, v_id);
  END LOOP;

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

  UPDATE scorecard_report_snapshots
     SET is_current = true,
         period_closed_at = CASE WHEN v_closed THEN now() ELSE period_closed_at END
   WHERE id = v_id;

  PERFORM scorecard_rebuild_facts(v_id);

  RETURN v_id;
END;
$function$;

COMMIT;

-- ── Verification ────────────────────────────────────────────────────────────
-- Expect: three new columns present, seven admitted statuses, both helper
-- functions defined, and every rewritten function naming content_sha256.
--
-- SELECT column_name, data_type
--   FROM information_schema.columns
--  WHERE table_name = 'scorecard_report_snapshots'
--    AND column_name IN ('period_closed_at', 'is_partial_month', 'parser_version')
--  ORDER BY column_name;
--
-- SELECT pg_get_constraintdef(oid)
--   FROM pg_constraint
--  WHERE conname = 'scorecard_ingest_log_status_check';
--
-- SELECT p.proname, (p.prosrc LIKE '%content_sha256%') AS persists_content_sha
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public'
--    AND p.proname IN ('lp_csv_ingest_begin', 'scorecard_ingest_snapshot',
--                      'lp_csv_ingest_finalize', 'lp_is_partial_coverage',
--                      'lp_log_supersede')
--  ORDER BY p.proname;
--
-- Coverage boundary — the 21:00-EDT-on-the-31st case that a naive UTC date
-- comparison gets wrong. Expect t, f:
-- SELECT lp_is_partial_coverage('2026-09-01T01:00:00Z', '2026-08-31') AS should_be_true,
--        lp_is_partial_coverage('2026-09-03T22:00:00Z', '2026-08-31') AS should_be_false;
