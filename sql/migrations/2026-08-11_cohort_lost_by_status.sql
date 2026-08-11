-- ─── 2026-08-11 · Loss CAUSE from report 133 ────────────────────────────────
--
-- WHAT THIS IS. Report 133's `lost` bucket is 976 jobs across 8 markets, and it
-- is one undifferentiated number. Those 976 are four completely different
-- management conversations:
--
--     Cancelled          520 jobs   $12,647,070
--     Credit Decline     340 jobs    $7,599,089
--     Dead Deal           93 jobs    $2,204,950
--     Cancelled By Mgt    23 jobs      $586,186
--
-- A credit decline is a finance problem. A cancellation is a sales problem. A
-- dead deal is a follow-up problem. Cancelled-by-management is a margin or
-- capacity decision. Reporting them as one figure tells nobody what to do —
-- and Credit Decline alone is 35% of all losses, which is not a rounding
-- detail. (LP itself agrees they are distinct: report 137 subtracts
-- `cd_cents` separately from `cancelled_cents` when it computes NSA.)
--
-- WHAT THIS IS NOT. It is not a new bucket on the cohort, and it does not
-- change what `cohort_lost` means. Loss cause is a `status_raw` GROUPING WITHIN
-- `lost` (ruled 2026-08-07); `cohort_lost` remains the total and every existing
-- reader of it is untouched.
--
-- ⚠️ WHY THE NEW ROWS DO NOT REUSE bucket='lost'. The dashboard's bucket
-- reader (`reportFacts.core.ts` `buildGoodBusiness`) matches on `bucket` ALONE
-- and ignores `metric`. Emitting cause rows under bucket='lost' would make
-- `bucket("lost")` count all 976 twice. The cause rows therefore carry their
-- own bucket slugs, which no existing filter matches.
--
-- ⚠️ SLUGS, NOT RAW LP STRINGS. `status_raw` is free text from an export. It is
-- normalised to a bounded set so a new LP status cannot break ingest with a
-- CHECK violation — anything unrecognised lands in `other_lost` and is visible
-- rather than dropped.
--
-- ROLLBACK:
--   -- restore the prior function from 2026-08-07_job_status_cohort_realign.sql,
--   -- then drop the rows and narrow the CHECKs again:
--   DELETE FROM lp_report_facts WHERE metric = 'cohort_lost_by_status';
--   ALTER TABLE lp_report_facts DROP CONSTRAINT lp_report_facts_metric_check;
--   ALTER TABLE lp_report_facts DROP CONSTRAINT lp_report_facts_bucket_check;
--   -- (re-add the pre-2026-08-11 definitions)
--
-- AFTER RUNNING: the backfill at the bottom re-derives facts for every CURRENT
-- job_status_ytd snapshot. New snapshots pick this up automatically — the
-- chunked finalize already calls scorecard_rebuild_facts().

BEGIN;

-- ── (a) Widen the two CHECKs ────────────────────────────────────────────────
ALTER TABLE lp_report_facts DROP CONSTRAINT IF EXISTS lp_report_facts_metric_check;
ALTER TABLE lp_report_facts ADD CONSTRAINT lp_report_facts_metric_check CHECK (
  metric = ANY (ARRAY[
    'net_sales', 'gross_sold', 'good_business_open', 'pipeline_excluded',
    'dup_review_pending', 'leads', 'sets', 'confirmed', 'issued', 'sat',
    'sold', 'net_sold', 'marketing_cost', 'working_amount', 'cancelled',
    'credit_decline', 'working_open', 'hold', 'cohort_completed', 'cohort_lost',
    -- NEW: the same jobs as cohort_lost, split by why they were lost.
    'cohort_lost_by_status'
  ])
);

ALTER TABLE lp_report_facts DROP CONSTRAINT IF EXISTS lp_report_facts_bucket_check;
ALTER TABLE lp_report_facts ADD CONSTRAINT lp_report_facts_bucket_check CHECK (
  bucket = ANY (ARRAY[
    'hoa', 'permit', 'other_pending', 'excluded', 'in_production',
    'completed', 'lost',
    -- NEW: loss-cause slugs, only ever paired with cohort_lost_by_status.
    'cancelled', 'cancelled_by_mgt', 'credit_decline', 'dead_deal', 'other_lost'
  ])
);

COMMENT ON COLUMN lp_report_facts.bucket IS
  'Sub-division of `metric`. For job_status_ytd cohort metrics this is the job '
  'bucket (hoa/permit/other_pending/in_production/completed/lost). For '
  'metric=''cohort_lost_by_status'' it is instead the normalised loss CAUSE '
  '(cancelled / cancelled_by_mgt / credit_decline / dead_deal / other_lost) — '
  'the same jobs as cohort_lost, grouped by why. Never sum across metrics on '
  'bucket alone.';

-- ── (b) scorecard_rebuild_facts: add the loss-cause block ───────────────────
--
-- Carried forward verbatim from 2026-08-07_job_status_cohort_realign.sql with
-- ONE new INSERT (marked below). Nothing else in the function changes.
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

  -- ★ NEW (2026-08-11) — loss CAUSE within `lost`.
  --
  -- Same jobs as the cohort_lost rows above, grouped by normalised status_raw.
  -- Σ(cohort_lost_by_status) per market MUST equal that market's cohort_lost;
  -- the verification block at the bottom asserts it.
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
           ELSE 'other_lost'   -- a status LP added since; visible, never dropped
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

-- ── (c) Backfill every CURRENT 133 snapshot ─────────────────────────────────
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT id FROM scorecard_report_snapshots
    WHERE report_type = 'job_status_ytd' AND is_current
  LOOP
    PERFORM scorecard_rebuild_facts(r.id);
  END LOOP;
END $$;

COMMIT;

-- ── Verification ────────────────────────────────────────────────────────────
--
-- 1. The split foots to the total, per market. MUST return zero rows.
--    SELECT market, period_start, total, split FROM (
--      SELECT market, period_start,
--             SUM(value_count) FILTER (WHERE metric = 'cohort_lost')            AS total,
--             SUM(value_count) FILTER (WHERE metric = 'cohort_lost_by_status')  AS split
--      FROM lp_report_facts
--      WHERE is_current AND report_type = 'job_status_ytd'
--      GROUP BY 1, 2
--    ) x WHERE COALESCE(total, 0) <> COALESCE(split, 0);
--
-- 2. Company totals — expect 976 jobs: Cancelled 520, Credit Decline 340,
--    Dead Deal 93, Cancelled By Mgt 23.
--    SELECT bucket, SUM(value_count) AS jobs, ROUND(SUM(value_cents)/100.0) AS dollars
--    FROM lp_report_facts
--    WHERE is_current AND metric = 'cohort_lost_by_status'
--    GROUP BY 1 ORDER BY 2 DESC;
--
-- 3. Nothing unrecognised. A non-zero count here means LP added a status and
--    the CASE above needs a new arm.
--    SELECT SUM(value_count) FROM lp_report_facts
--    WHERE is_current AND metric = 'cohort_lost_by_status' AND bucket = 'other_lost';
--
-- 4. The 8th market is present. UNRESOLVED must appear, or per-market
--    cancellation counts will not foot to the company figure.
--    SELECT DISTINCT market FROM lp_report_facts
--    WHERE is_current AND metric = 'cohort_lost_by_status' ORDER BY 1;
