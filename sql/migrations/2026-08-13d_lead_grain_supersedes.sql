-- ─── 2026-08-13d · Report 135 at LEAD grain — distinct leads and supersedes ──
--
-- WHAT THIS IS. `lp_report_facts` publishes `leads` for report 135 as a ROW
-- count. Report 135 is emitted at lead × disposition-state grain, so that is
-- not a count of leads: history holds 243,917 rows over 72,570 distinct leads,
-- and a single lead's rows can carry different entry_dates (5,464 leads do, up
-- to 12 distinct values — the date rides the disposition row, so it is not a
-- stable "lead received" date and nothing here buckets by it).
--
-- LP already records its own duplicate merges in NumSuperseded: when LP folds a
-- duplicate lead record into a surviving one, the survivor's counter goes up.
-- Across history that is 4,347 duplicate records absorbed over 3,781 leads
-- (5.21%). The dashboard renders it beside Leads so the duplicate volume is
-- visible instead of silently baked into a number nobody can decompose.
--
-- This is a SECOND grain over the same rows, added alongside `leads`.
-- `leads` itself is untouched: changing the published Leads basis from rows to
-- distinct leads has downstream consumers and is a separate decision. Surfaced,
-- not silently rescaled.
--
-- ══ THE TWO FOLDS, and what each one costs if you get it wrong ══
--
--  1. MAX per lead, NOT Σ over rows. NumSuperseded repeats on every row of a
--     lead. Summing it over rows gives ~15,670 against a true 4,347 — a 3.6×
--     inflation that looks entirely plausible on a screen.
--
--  2. ONE OWNING BRANCH per lead. These facts are consumed ADDITIVELY — the
--     dashboard sums a market's branch rows (buildLeads → sumMetric) — and a
--     DISTINCT count is not additive when the entity spans the grain. 429
--     leads appear under more than one (market, brn_id_raw) inside a snapshot.
--     Folding per branch counts them once per branch:
--
--         per-branch fold, summed   72,862 distinct · 4,370 superseded
--         lowest-row_num owner      72,570 distinct · 4,347 superseded  ✅
--         company truth             72,570 distinct · 4,347 superseded
--
--     Each lead is therefore assigned to the branch of its LOWEST row_num —
--     its first appearance in the file, deterministic and stable across
--     re-ingest of the same file — which makes both metrics sum EXACTLY to the
--     company figure at every rollup.
--
-- The JS mirror is src/jobs/lp-report-facts.js (expectedFacts). The two are
-- kept in agreement by the daily facts_vs_raw recon; note that recon covers
-- reports A and B only, so the guard for THIS projection is the unit test in
-- scripts/test-lp-report-facts.js, which pins both folds directly.
--
-- IDEMPOTENT. The constraint is dropped and re-added; the function is CREATE OR
-- REPLACE. Re-running changes nothing.

BEGIN;

-- ── 1. Allow the two new metric names ────────────────────────────────────────
ALTER TABLE lp_report_facts DROP CONSTRAINT IF EXISTS lp_report_facts_metric_check;
ALTER TABLE lp_report_facts ADD CONSTRAINT lp_report_facts_metric_check
  CHECK (metric = ANY (ARRAY[
    'net_sales', 'gross_sold', 'good_business_open', 'pipeline_excluded',
    'dup_review_pending', 'leads', 'sets', 'confirmed', 'issued', 'sat',
    'sold', 'net_sold', 'marketing_cost', 'working_amount', 'cancelled',
    'credit_decline', 'working_open', 'hold', 'cohort_completed',
    'cohort_lost', 'cohort_lost_by_status',
    -- 2026-08-13d — report 135 at lead grain
    'leads_distinct', 'leads_superseded'
  ]));

-- ── 2. Republish the projection with the lead-grain block ────────────────────
CREATE OR REPLACE FUNCTION public.scorecard_rebuild_facts(p_snapshot_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
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
         j.market, j.branch_code_raw,
         'cohort_lost_by_status',
         CASE lower(btrim(j.status_raw))
           WHEN 'cancelled'        THEN 'cancelled'
           WHEN 'cancelled by mgt' THEN 'cancelled_by_mgt'
           WHEN 'credit decline'   THEN 'credit_decline'
           WHEN 'dead deal'        THEN 'dead_deal'
           ELSE 'other_lost'
         END,
         COALESCE(SUM(j.gross_cents), 0), COUNT(*)::int, s.is_current
  FROM scorecard_report_snapshots s
  JOIN lp_job_status_history j ON j.snapshot_id = s.id
  WHERE s.id = p_snapshot_id
    AND j.bucket = 'lost'
  GROUP BY s.id, s.report_type, s.period_start, s.period_end, s.as_of_date,
           s.ingested_at, s.is_current, j.market, j.branch_code_raw,
           CASE lower(btrim(j.status_raw))
             WHEN 'cancelled'        THEN 'cancelled'
             WHEN 'cancelled by mgt' THEN 'cancelled_by_mgt'
             WHEN 'credit decline'   THEN 'credit_decline'
             WHEN 'dead deal'        THEN 'dead_deal'
             ELSE 'other_lost'
           END;
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

  -- ── Report 135, LEAD grain (2026-08-13d) ───────────────────────────────────
  -- One row per lead, owned by the branch of its LOWEST row_num, carrying the
  -- MAX NumSuperseded across all of that lead's rows. Both folds are load-
  -- bearing — see the migration header for what each one costs if dropped.
  -- The window function is evaluated before DISTINCT ON, so `sup` is the max
  -- over the whole lead even though only the first row survives.
  INSERT INTO lp_report_facts
    (snapshot_id, report_type, period_start, period_end, as_of_date,
     market, branch_code_raw, metric, bucket, value_cents, value_count, is_current)
  SELECT s.id, s.report_type, s.period_start, s.period_end,
         COALESCE(s.as_of_date, (s.ingested_at AT TIME ZONE 'America/New_York')::date),
         o.market, o.brn_id_raw, m.metric, NULL,
         NULL,
         CASE m.metric
           WHEN 'leads_distinct'   THEN COUNT(*)
           WHEN 'leads_superseded' THEN COALESCE(SUM(o.sup), 0)
         END::int,
         s.is_current
  FROM scorecard_report_snapshots s
  JOIN (
    SELECT DISTINCT ON (l.lp_lead_id)
           l.snapshot_id, l.lp_lead_id, l.market, l.brn_id_raw,
           MAX(l.num_superseded) OVER (PARTITION BY l.lp_lead_id) AS sup
    FROM lp_lead_disposition_history l
    WHERE l.snapshot_id = p_snapshot_id
      AND l.lp_lead_id IS NOT NULL
      AND btrim(l.lp_lead_id) <> ''
    ORDER BY l.lp_lead_id, l.row_num
  ) o ON o.snapshot_id = s.id
  CROSS JOIN (VALUES ('leads_distinct'), ('leads_superseded')) AS m(metric)
  WHERE s.id = p_snapshot_id
  GROUP BY s.id, s.report_type, s.period_start, s.period_end, s.as_of_date,
           s.ingested_at, s.is_current, o.market, o.brn_id_raw, m.metric;
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

COMMIT;
