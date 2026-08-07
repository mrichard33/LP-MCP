-- ════════════════════════════════════════════════════════════════════
-- LP report 138 Appointment Stats by Sales Rep with Source — 2026-08-07
--
-- Run in: LP MCP Supabase → SQL Editor (or supabase MCP apply_migration).
-- Idempotent; safe to re-run. Applied manually — no migration runner.
--
-- WHY: 138 is the ONLY LP export carrying both gross and net issued at source
-- grain. 136 has NumIssued with no net-issued column, so a gross-basis sit rate
-- by source — sit_rate = Σ NumSat ÷ Σ NumIssued — is not computable from it and
-- must come from here. Same for sit rate by rep, which no other report carries
-- at all.
--
-- 138 is the canonical Reece-series identifier and the only one used in slugs,
-- tables and logs. LP also exposes this report as ReportView `Rpt=229`; that
-- number exists solely to build an on-demand URL and is deliberately absent
-- from schema, code and prose. (Same two-series arrangement as 134 = `Rpt=140`.)
--
-- NO MARKET DIMENSION, DELIBERATELY. 138 has no branch column, so its rows
-- cannot go through lp_branch_market_map. scorecard_rebuild_facts is therefore
-- NOT touched: it is a sequence of unconditional INSERT…SELECT statements, each
-- keyed to one history table, so a 138 snapshot matches none and yields zero
-- facts. That is correct — lp_report_facts.market is NOT NULL and any market
-- attributed to a 138 row would be invented.
--
-- CONTROL TOTALS WITHOUT A FOOTER. LP CSV exports print no footer, no grand
-- total and no per-band subtotals, so the sum-ties-to-printed-footer gate is
-- unavailable. 138 supplies two exact arithmetic identities instead, verified
-- on all 345 rows of the January 2026 export and enforced in the parser:
--     Σ NumDsp1..NumDsp10  = NumIssued     the dispositions partition issued
--     NumIssued + NumOther = NumSet        NumOther is set-but-not-issued
-- The control_totals asserted below are the column sums, checked here the same
-- way every other CSV report's are.
-- ════════════════════════════════════════════════════════════════════

-- ── (a) admit the new report type ───────────────────────────────────────────
-- Both CHECKs are re-created wholesale; that is the established pattern here
-- (see 2026-08-05_sales_efficiency.sql), since Postgres cannot extend a CHECK.

ALTER TABLE scorecard_report_snapshots DROP CONSTRAINT IF EXISTS scorecard_report_snapshots_report_type_check;
ALTER TABLE scorecard_report_snapshots ADD CONSTRAINT scorecard_report_snapshots_report_type_check
  CHECK (report_type IN ('jobs_by_milestone', 'jobs_by_status',
                         'job_status_ytd', 'lead_disposition', 'source_cost',
                         'sales_efficiency', 'appt_stats_by_rep_source'));

ALTER TABLE lp_report_facts DROP CONSTRAINT IF EXISTS lp_report_facts_report_type_check;
ALTER TABLE lp_report_facts ADD CONSTRAINT lp_report_facts_report_type_check
  CHECK (report_type IN ('jobs_by_milestone', 'jobs_by_status',
                         'job_status_ytd', 'lead_disposition', 'source_cost',
                         'sales_efficiency', 'appt_stats_by_rep_source'));

-- ── (b) lp_appt_stats_history: one row per (rep, source) per import ─────────

CREATE TABLE IF NOT EXISTS lp_appt_stats_history (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  snapshot_id     uuid NOT NULL REFERENCES scorecard_report_snapshots(id) ON DELETE CASCADE,
  row_num         integer NOT NULL,
  salesrep_raw    text NOT NULL,             -- verbatim Salesrep, incl. '(SalesRep Unknown)'
  src_id_raw      text NOT NULL,             -- verbatim Src_id (a source NAME, not an id)
  num_set         integer,
  num_issued      integer,                   -- GROSS issued — the sit-rate denominator
  num_net_issued  integer,                   -- carried for audit; never a denominator
  num_sat         integer,
  num_sale        integer,
  gsa_cents       bigint,
  nsa_cents       bigint,
  num_other       integer,                   -- set-but-not-issued; completes num_set
  num_other2      integer,                   -- second residual bucket, uninterpreted
  dispositions    jsonb NOT NULL DEFAULT '{}'::jsonb   -- {label: count}, decoded BY LABEL
);
CREATE UNIQUE INDEX IF NOT EXISTS lp_appt_stats_history_snap_row_idx
  ON lp_appt_stats_history (snapshot_id, row_num);
CREATE INDEX IF NOT EXISTS lp_appt_stats_history_snap_src_idx
  ON lp_appt_stats_history (snapshot_id, src_id_raw);
CREATE INDEX IF NOT EXISTS lp_appt_stats_history_snap_rep_idx
  ON lp_appt_stats_history (snapshot_id, salesrep_raw);

COMMENT ON TABLE lp_appt_stats_history IS
  'Appointment Stats by Sales Rep with Source (LP report 138) rows per import — the ONLY source of gross-basis sit rate by source or by rep, since 136 carries no net-issued column and no other report reaches rep grain. Grain: one row per (Salesrep, Src_id). Money in CENTS. NO MARKET COLUMN: 138 cannot be mapped through lp_branch_market_map and produces no lp_report_facts. Superseded snapshots retained forever.';
COMMENT ON COLUMN lp_appt_stats_history.salesrep_raw IS
  'Verbatim. LP''s own ''(SalesRep Unknown)'' bucket holds appointments set before a rep was assigned — 12 rows and 1,822 sets in January 2026 — and MUST be displayed rather than dropped or redistributed. Rep-level metrics are reliable from issue onward, not at set.';
COMMENT ON COLUMN lp_appt_stats_history.dispositions IS
  'Disposition label -> count, decoded from the Dsp1..Dsp10 labels rather than the NumDsp1..NumDsp10 positions, so an upstream reordering moves label and count together and cannot silently re-attribute. LP''s fixed-name columns (Num1Leg, NumNoHome, NumCCC, NumNIS, NumOpps, NumNOCOPPRRF) are exact per-row aliases of the positional set and are kept in the app only as a cross-check.';
COMMENT ON COLUMN lp_appt_stats_history.num_other2 IS
  'Second residual bucket. Satisfies no identity derivable from the export (it is NOT NumSet - NumSat: that fails on 123 of January''s 345 rows). Carried verbatim and deliberately not interpreted.';

-- ── (c) lp_csv_ingest_begin: admit appt_stats_by_rep_source ─────────────────
-- Reproduced from 2026-08-06_csv_content_identity.sql; only the allowlist moves.

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

-- ── (d) lp_csv_ingest_rows: fifth branch ────────────────────────────────────
-- Reproduced from 2026-08-05_sales_efficiency.sql, which matches the live
-- definition exactly (verified: branches job_status_ytd, lead_disposition,
-- sales_efficiency, source_cost). NOTE for whoever touches this next: there is
-- still no jobs_by_milestone branch here, so the 134 CSV path cannot load rows.
-- That is a pre-existing gap, out of scope for this change, and left untouched
-- rather than silently altered.

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
$$;

-- ── (e) lp_csv_ingest_finalize: row-count + control-total branches for 138 ──
-- Reproduced from 2026-08-06_csv_content_identity.sql. Only the two dispatch
-- ladders gain a branch; the promotion block is byte-for-byte unchanged.

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
