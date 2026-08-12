-- ─── 2026-08-13b · promotion by PROVEN coverage, not by declared period_end ──
--
-- WHAT THIS IS. The definitive rewrite of lp_csv_ingest_finalize. It supersedes
-- sql/migrations/2026-08-11_rolling_window_promotion.sql, which was written and
-- reviewed but NEVER APPLIED — verified 2026-08-13 against the live database:
--
--   SELECT position('v_keep_end' in pg_get_functiondef(p.oid)) > 0, ...
--   → has_recency_guard = false, has_inverted_guard = false
--
-- So the live function was still last-writer-wins, and the trace shows it:
-- c1fc176f (period_end 2026-08-31) was demoted by fe5df304 (period_end
-- 2026-08-10). Everything the 08-11 migration described as current behaviour
-- was in fact aspirational. This migration is what actually goes on.
--
-- WHAT IT CARRIES FORWARD, unchanged from the 08-11 draft:
--   • the inverted-period guard — LP is moving to t1=[BOCM]&t2=[DAYOFFSET(-1)],
--     which on the 1st of a month yields 2026-09-01..2026-08-31. daterange()
--     raises on that AFTER the rows are loaded: a 500 rather than a diagnosis.
--     This breaks on a known date and the guard turns it into a clear refusal.
--   • §I coverage recency — promotion ordered by how much of the period a file
--     covers, not by which file arrived last, so a re-send or out-of-order
--     delivery cannot silently roll the dashboard backwards.
--   • control totals and row counts — byte-identical to the 2026-08-07
--     definition. Nothing about validation changes here.
--
-- WHAT IT CHANGES (§I.b, and the reason this is a new migration rather than the
-- old one applied as-is): coverage is measured by PROVEN period_end, not
-- declared period_end. See the inline comment at §I.b — applying §I in its
-- original form would have turned a self-healing mistake into a month-long
-- freeze of the current month.
--
-- IDEMPOTENT: CREATE OR REPLACE only. No DDL, no data change.
--
-- ROLLBACK: re-apply lp_csv_ingest_finalize from
-- sql/migrations/2026-08-07_job_status_cohort_realign.sql — that is the
-- definition currently live. Snapshots demoted or kept by §I stay valid history
-- either way.
--
-- AFTER RUNNING: node scripts/test-lp-csv-cutover.js
--
-- SCOPE: the CSV path only. scorecard_ingest_snapshot (the legacy PDF single-tx
-- path) carries the same daterange-overlap block and is deliberately untouched.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;


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
$function$;
COMMIT;

-- ── Verification ────────────────────────────────────────────────────────────
--
-- 1. Both guards are present on the LIVE definition. Both must be true — they
--    were both false before this migration.
--
-- SELECT position('v_keep_eff' in pg_get_functiondef(p.oid)) > 0 AS has_recency_guard,
--        position('inverted period' in pg_get_functiondef(p.oid)) > 0 AS has_inverted_guard
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public' AND p.proname = 'lp_csv_ingest_finalize';
--
-- 2. Still exactly one current snapshot per (report_type, scope, period_start).
--    Any row here is a bug — the partial unique index should make it impossible:
--
-- SELECT report_type, scope, period_start, count(*)
--   FROM scorecard_report_snapshots WHERE is_current
--  GROUP BY 1,2,3 HAVING count(*) > 1;
--
-- 3. No PARTIAL snapshot is current while a complete one covering the same
--    period exists as history. MUST return zero rows.
--
-- SELECT cur.id, cur.period_start, cur.period_end, cur.is_partial_month
--   FROM scorecard_report_snapshots cur
--   JOIN scorecard_report_snapshots hist
--     ON hist.report_type = cur.report_type
--    AND hist.period_start = cur.period_start
--    AND hist.is_partial_month IS FALSE
--    AND NOT hist.is_current
--  WHERE cur.is_current AND cur.is_partial_month IS NOT FALSE
--    AND hist.period_end >= cur.period_end;
--
-- 4. The current MTD snapshot is the widest PROVEN-covering one:
--
-- SELECT report_type, period_end, is_partial_month, is_current, ingested_at
--   FROM scorecard_report_snapshots
--  WHERE scope = 'mtd' AND period_start = date_trunc('month', now())::date
--  ORDER BY report_type, ingested_at;
