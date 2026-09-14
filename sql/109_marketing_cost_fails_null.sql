-- 109_marketing_cost_fails_null.sql
-- Marketing cost must fail to NULL (unknown), never to 0 (free).
--
-- STATUS: NOT APPLIED. Apply from the Supabase dashboard (LP instance).
-- One CREATE OR REPLACE. Re-running this file is idempotent. Run the
-- verification block in section 2 immediately after applying.
--
-- ══ THE DEFECT ══
-- `lp_report_facts.metric='marketing_cost'` reads $0 for August 2026 and for
-- September MTD, against $117k-$621k/month for January through July. The
-- rollup coalesced a missing cost to zero:
--
--     WHEN 'marketing_cost' THEN COALESCE(SUM(c.mcost_cents), 0)
--
-- So six weeks of cost-per-lead, cost-per-issued, cost-per-sale and marketing
-- %-of-net have been computing against $0 spend. They report "free", not
-- "unknown". A month-over-month view shows marketing cost falling
-- $269,602 -> $0 rather than flagging a gap.
--
-- ══ WHAT THE PREFLIGHT FOUND — THIS CHANGES THE FIX. READ BEFORE APPLYING ══
-- The handoff assumed the zeros came from COALESCE firing on an EMPTY set of
-- contributing rows. They do not. The rows are there and every one of them
-- carries a hard 0 (verified live 2026-09-14, current snapshots):
--
--   period    rows   mcost NULL   mcost = 0   mcost > 0   SUM
--   2026-06     67            0          56          11   $620,967.61
--   2026-07     71            0          66           5   $269,601.81
--   2026-08     68            0          68           0   $0
--   2026-09     47            0          47           0   $0
--
-- August carries Modernize (2,020 leads) and Lead Gurus (1,501 leads) — the
-- two largest paid vendors, $37,132 and $219,290.67 respectively in July — at
-- exactly $0.00. That is not free marketing. It is an unfed cost column.
--
-- CONSEQUENCE: simply deleting the COALESCE is a NO-OP on this data. SUM over
-- 68 zeros is 0, not NULL. The rule below therefore keys on the SUM being
-- zero, not on the row set being empty.
--
-- ══ WHY THE TWO CASES CANNOT BE TOLD APART TODAY ══
-- The handoff asks that "no rows -> NULL" and "rows that genuinely sum to zero
-- -> 0" not collapse. In the stored data they already have, upstream of this
-- function: `money()` in src/jobs/lp-report-parse-source-cost.js returns 0 for
-- any cell it cannot parse — blank included — so a missing figure and a real
-- $0.00 land in lp_source_cost_history identically. Zero rows in the whole
-- table are NULL. The distinction does not exist for this function to read.
--
-- This file does not try to invent it. It chooses the safe side of the
-- collapse and says so:
--
--     SUM is zero or absent  ->  NULL  (unknown)
--     SUM is non-zero        ->  SUM
--
-- WHAT THAT COSTS: a period in which marketing genuinely spent nothing, on
-- every one of ~70 sub-sources including the paid vendors, would publish
-- "unknown" rather than "$0". That has never happened in this dataset and
-- would be indistinguishable from an outage if it did. Reporting unknown when
-- the truth is zero is a suppressed tile. Reporting zero when the truth is
-- unknown is a fabricated cost-per-lead, which is what has been shipping since
-- 2026-08-10.
--
-- RESTORING THE REAL DISTINCTION is a separate, larger change and is
-- deliberately NOT in this PR — see the PR body. It needs `money()` to
-- preserve NULL for an unreadable cell AND a matching change to
-- `lp_csv_ingest_finalize`, whose control-total assertion does
-- `SUM(mcost_cents)` with no COALESCE and raises on a NULL result — an
-- all-blank cost column would abort the daily ingest outright. That function's
-- live definition (md5 b37e3a4ec56d07f02c934de2c065fd65, 9,237 chars) does not
-- match any definition in sql/, so redefining it needs its own preflight.
--
-- ══ WHEN THE ZEROS START, AND WHAT THAT POINTS AT ══
-- Every source_cost snapshot with as_of_date <= 2026-08-10 came from the
-- January-July backfill and carries cost. Every snapshot produced by the
-- scheduled daily MTD pull (as_of_date >= 2026-08-10, 37 snapshots) carries
-- none. The boundary is the pull, not the calendar. The likely cause is the
-- saved configuration of report "136 Mktg Sub-Source Cost Analysis 2" that the
-- scheduled job runs — it is not emitting MCost. This file cannot fix that; it
-- makes the gap visible instead of silently publishing $0.
--
-- ══ WHY THIS IS SELF-MAINTAINING ══
-- The rule lives in the rollup, so it re-applies on every ingest and every
-- rebuild. No row repair is needed and none is done: tomorrow's pull of the
-- same unfed report lands the same zeros and still publishes NULL. When the
-- report is fixed and cost comes back, the same expression publishes the sum
-- with no further change.
--
-- ══ WHAT THIS FILE DOES NOT DO ══
--   * It does not touch gsa_cents, nsa_cents or working_cents. Those carry the
--     same latent COALESCE-to-zero, but they are not currently wrong and each
--     change stays independently revertible.
--   * It does not backfill the missing August/September cost. That figure is
--     not in this database. It has to come from a re-pull of report 136.
--   * It does not change `value_count` for marketing_cost, which remains the
--     contributing row count (the ELSE COUNT(*) branch).
--
-- ══ CONSUMERS OF marketing_cost, AND HOW EACH HANDLES NULL ══
-- Traced 2026-09-14 across the LP database, LP-MCP and Reece-Dashboard:
--
--   pg_views / information_schema.routines
--       No view and no other function reads the metric. scorecard_rebuild_facts
--       is the only routine that mentions it and it is the one below.
--
--   LP-MCP src/jobs/lp-report-facts.js (expectedFacts)
--       The pure JS mirror of this projection. Updated in the same PR so the
--       two stay in agreement; pinned by scripts/test-lp-report-facts.js.
--
--   LP-MCP src/jobs/lp-report-recon.js (facts_vs_raw)
--       Covers reports A and B only — source_cost is out of its scope, so this
--       change cannot trip it.
--
--   Reece-Dashboard lib/scorecard/tiers/tier4.ts — the only rendering consumer
--       sumMetric() accumulates `cents` only for non-NULL value_cents and
--       leaves it null otherwise; dollarsOf(null) is null; buildRow() sees
--       spend == null and returns unmeasured(...) for ALL FOUR derived cost
--       metrics: cost per lead, cost per issue, cost per sale, and marketing %
--       of net revenue. Each renders an em dash with a stated reason. Nothing
--       divides by null, nothing renders 0, nothing renders Infinity.
--       => NULL already degrades safely. No consumer change is required.
--       (Cosmetic follow-up, different repo, not fixed here: the company-row
--       reason string is hard-coded to "no Source & Cost snapshot for this
--       window", which will now show in a case where the snapshot exists and
--       only the cost is unknown.)
--
-- ══ ACCEPTANCE ══
--   These must not move:  July 2026 = 26,960,181c ($269,601.81)
--                         June 2026 = 62,096,761c ($620,967.61)
--   These must become NULL: August 2026, September MTD.
-- Section 2 asserts all four.


-- ══════════════════════════════════════════════════════════════════════════
-- SECTION 1 — the rollup. CREATE OR REPLACE of the live definition.
--
-- The body below is byte-identical to the currently-live function (verified
-- 2026-09-14: md5(prosrc) = ad4507b1b58563423fc3c73976db219d, matching
-- sql/migrations/2026-08-13d_lead_grain_supersedes.sql) except for the single
-- marketing_cost branch. Nothing else is changed.
-- ══════════════════════════════════════════════════════════════════════════

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
           -- 2026-09-14 · NULLIF, not COALESCE. A cost column that reports
           -- nothing for a whole period must publish NULL (unknown), never 0
           -- (free) — six weeks of cost-per-lead computed against a coalesced
           -- zero before anyone noticed. NULLIF also covers the empty-row-set
           -- case, where SUM is already NULL. See the sql/109 header for why
           -- a genuine all-zero period is indistinguishable here and is
           -- deliberately resolved as unknown.
           WHEN 'marketing_cost' THEN NULLIF(SUM(c.mcost_cents), 0)
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


-- ══════════════════════════════════════════════════════════════════════════
-- SECTION 2 — rebuild and verify. Run immediately after section 1.
-- ══════════════════════════════════════════════════════════════════════════

-- 2a. Republish the current source_cost snapshots through the new rule.
--     Facts are a projection, so nothing changes until they are rebuilt.
--     Expect 9 snapshots (one per current source_cost period).
SELECT count(*) AS snapshots_rebuilt, sum(scorecard_rebuild_facts(id)) AS facts_written
  FROM (SELECT id FROM scorecard_report_snapshots
         WHERE report_type = 'source_cost' AND is_current) t;

-- 2b. ACCEPTANCE 1 + 2. Every row must show ok = true.
--
-- SELECT to_char(period_start, 'YYYY-MM') AS mon, value_cents, expected,
--        value_cents IS NOT DISTINCT FROM expected AS ok
--   FROM lp_report_facts f
--   JOIN (VALUES ('2026-06-01'::date, 62096761::bigint),
--                ('2026-07-01'::date, 26960181::bigint),
--                ('2026-08-01'::date, NULL::bigint),
--                ('2026-09-01'::date, NULL::bigint)) AS e(ps, expected)
--     ON e.ps = f.period_start
--  WHERE f.metric = 'marketing_cost' AND f.is_current
--  ORDER BY f.period_start;

-- 2c. Nothing outside marketing_cost moved. Capture this BEFORE applying
--     section 1 and compare after — every row except marketing_cost must be
--     identical.
--
-- SELECT metric, count(*) AS facts, sum(value_cents) AS cents,
--        sum(value_count) AS counts
--   FROM lp_report_facts
--  WHERE is_current AND report_type = 'source_cost'
--  GROUP BY metric ORDER BY metric;

-- 2d. ACCEPTANCE 3. On the dashboard scorecard, Tier 4 "Marketing
--     efficiency": cost per lead, cost per issue, cost per sale and marketing
--     % of net revenue must each render an em dash with a reason — not $0.00,
--     not Infinity, not NaN.
