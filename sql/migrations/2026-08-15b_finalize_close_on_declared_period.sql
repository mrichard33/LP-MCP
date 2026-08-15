-- ─── 2026-08-15b · a period closes when ITS PERIOD ends, not when its file does ─
--
-- WHAT THIS IS. Amendment E5. §H decides when a snapshot's period is CLOSED:
--
--     v_closed := (s.period_end < today_et) AND (s.is_partial_month IS FALSE);
--
-- `period_end` is what the FILE covers, not what the PERIOD is. For a `month`
-- snapshot the two coincide — July's file declares period_end 2026-07-31, which
-- is also July's last day — and the rule is correct. For an `mtd` snapshot they
-- do not: LP sets period_end to the LAST DAY COVERED, so the current month's
-- file declares 2026-08-13 while August runs to the 31st.
--
-- Two days later `period_end < today` is true, `is_partial_month` is false, and
-- August is stamped `period_closed_at` — a month closed while it is still being
-- sold. Verified live on 2026-08-15: all SIX current mtd snapshots carry
-- period_closed_at.
--
-- THE FIX is one comparison: close on the end of the period the snapshot BELONGS
-- to — the declared month end — rather than on the last day its file happens to
-- reach. Measured across every current snapshot, this flips exactly the six mtd
-- rows from closed to open and moves nothing else: all 42 `month` rows keep
-- closing (their period_end IS their month end) and the four `ytd` rows are
-- unaffected (is_partial_month NULL never closed them).
--
-- ══ WHY `is_partial_month` IS NOT TOUCHED ══
--
-- Amendment E5 proposed re-deriving that flag so it compares generation against
-- the declared month end. It must NOT be changed, and the reason is §I.b two
-- screens below:
--
--     v_in_end   := CASE WHEN s.is_partial_month IS FALSE THEN s.period_end END;
--     v_keep_eff := CASE WHEN v_keep_par     IS FALSE THEN v_keep_end  END;
--     IF ... v_keep_eff IS NOT NULL AND (v_in_end IS NULL OR v_keep_eff > v_in_end)
--
-- The flag is the PROVEN-COVERAGE signal that promotion ranks on. Re-derive it
-- against the month end and every mtd file becomes partial, `v_keep_eff` is
-- always NULL for an mtd incumbent, the guard never fires, and promotion reverts
-- to last-writer-wins — reintroducing the exact regression 2026-08-13b was
-- written to fix (job_status_ytd rolled Aug 10 -> Aug 31 -> Aug 10 across three
-- arrivals on 2026-08-10/11).
--
-- The two are DIFFERENT QUESTIONS and both are needed:
--
--   is_partial_month  "does this file cover everything it CLAIMS?"
--                     The honest daily mtd file: YES. The t2=[EOCM] file
--                     claiming 2026-08-31 on the 10th: NO. It fires exactly when
--                     it should, and for mtd files it correctly never fires
--                     because they never overclaim. That is the flag working,
--                     not the flag being inert.
--   §H below          "has the PERIOD this file belongs to ended?"
--
-- Conflating them is what put a month-end question to a file-coverage flag. The
-- month-end comparison E5 asked for is applied HERE, where that question is
-- actually being asked.
--
-- The dashboard needs no change: Amendment E4 already renders an in-flight
-- period as provisional from `periodIncludesToday`, so the chip is correct
-- today regardless of this flag.
--
-- ══ WHAT ELSE MOVES ══
--
-- `period_closed_at` is read in exactly one place — the supersede loop in this
-- function, which logs when a CLOSED snapshot is displaced. Marking August
-- closed meant every daily August re-ingest logged a supersede event for what is
-- an ordinary daily roll. Nothing in Reece-Dashboard reads the column.
--
-- The six wrongly-stamped values are cleared below, scoped to periods that have
-- not actually ended. A closed month's stamp is history and is left alone.
--
-- IDEMPOTENT: CREATE OR REPLACE plus a scoped UPDATE that is a no-op on rerun.
--
-- ROLLBACK: re-apply sql/migrations/2026-08-13b_promotion_proven_coverage.sql.
-- The cleared stamps re-set themselves on the next ingest of a genuinely closed
-- period.
--
-- AFTER RUNNING: node scripts/test-lp-csv-cutover.js, then the verification
-- block at the foot of this file AND queries 2-4 of 2026-08-13b.
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
  -- The last day of the period this snapshot BELONGS to (E5). For a `month`
  -- snapshot this equals period_end; for an `mtd` one it is the month end the
  -- file is working towards.
  v_declared_end date;
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

  -- §H: a period is closed when THE PERIOD has ended AND the file covers all of
  -- it. IS FALSE, not NOT: an unknown coverage (NULL) must not close a period.
  --
  -- ⚠️ E5 (2026-08-15): the first term is the DECLARED PERIOD END, not
  -- `s.period_end`. LP sets an mtd file's period_end to the last day it COVERS,
  -- so the current month's file reads 2026-08-13 while August runs to the 31st —
  -- and two days later the old test closed August mid-sale. All six current mtd
  -- snapshots were stamped that way. A `month` file is unaffected: its
  -- period_end already IS its month end, so this evaluates identically.
  --
  -- Deliberately NOT solved by re-deriving `is_partial_month`: that flag is
  -- §I.b's proven-coverage signal, and flipping every mtd file to partial would
  -- disable the promotion guard entirely. See the header.
  v_declared_end := (date_trunc('month', s.period_end)::date + INTERVAL '1 month - 1 day')::date;
  v_closed := (v_declared_end < (now() AT TIME ZONE 'America/New_York')::date)
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

-- ── Clear the stamps the old rule set on periods that have NOT ended ────────
--
-- Scoped by the SAME predicate the fixed §H uses, so this can only touch rows
-- the new rule would not have stamped. A genuinely closed month keeps its stamp:
-- that is history, and re-deriving it would rewrite when a period actually
-- closed.
--
-- Expected: 6 rows (the current mtd snapshots for 2026-08). No-op on rerun.
UPDATE scorecard_report_snapshots
   SET period_closed_at = NULL
 WHERE period_closed_at IS NOT NULL
   AND (date_trunc('month', period_end)::date + INTERVAL '1 month - 1 day')::date
       >= (now() AT TIME ZONE 'America/New_York')::date;

COMMIT;

-- ── Verification ────────────────────────────────────────────────────────────
--
-- 1. No period is marked closed before it has ended. MUST return zero rows.
--
-- SELECT id, report_type, scope, period_start, period_end, period_closed_at
--   FROM scorecard_report_snapshots
--  WHERE period_closed_at IS NOT NULL
--    AND (date_trunc('month', period_end)::date + INTERVAL '1 month - 1 day')::date
--        >= (now() AT TIME ZONE 'America/New_York')::date;
--
-- 2. Closed months still close, in-flight months do not. `month` rows should
--    all read true; the current `mtd` rows should all read false.
--
-- SELECT scope, period_start, period_end, is_partial_month,
--        ((date_trunc('month', period_end)::date + INTERVAL '1 month - 1 day')::date
--           < (now() AT TIME ZONE 'America/New_York')::date
--          AND is_partial_month IS FALSE) AS would_close
--   FROM scorecard_report_snapshots WHERE is_current
--  ORDER BY scope, period_start;
--
-- 3. §I.b IS UNCHANGED — the promotion guard still reads is_partial_month, and
--    both 2026-08-13b guards are still on the live definition. Both must be true.
--
-- SELECT position('v_keep_eff' in pg_get_functiondef(p.oid)) > 0 AS has_recency_guard,
--        position('inverted period' in pg_get_functiondef(p.oid)) > 0 AS has_inverted_guard
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public' AND p.proname = 'lp_csv_ingest_finalize';
--
-- 4. AND re-run queries 2-4 at the foot of 2026-08-13b_promotion_proven_coverage.sql.
--    In particular #2 (one current snapshot per report_type/scope/period_start)
--    and #3 (no partial snapshot current while a complete one exists as history)
--    must still return zero rows — those are what a broken promotion guard would
--    show up as.

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
