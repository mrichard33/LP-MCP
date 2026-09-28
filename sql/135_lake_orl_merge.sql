-- 135 — Merge Lakeland into Orlando (2026-09-28)
--
-- WHAT: Lakeland stops being its own market. Every LAKE_MKT figure — past and
-- future — counts as Orlando (ORL_MKT / short code ORL). Same shape as the Fort
-- Lauderdale merge (FTLAU + BOCA + MIAMI + RFED → FTLAU_MKT): the raw LP branch
-- stays 'LAKE' everywhere it is stored raw, and lp_branch_market_map folds it.
--
-- SUPERSEDES decisions 467 / 468 (2026-08-06, Lakeland split out + goal carve-out),
-- 521 (seven dial markets) and 2579 (Lakeland service cards → #service-lakeland;
-- ruled 2026-09-28: they go to #service-orlando).
--
-- PREREQUISITE: sql/backup/2026-09-28_lake_orl_merge_backup.sql has run.
-- ROLLBACK:     sql/rollback/2026-09-28_lake_orl_merge_rollback.sql
--
-- ONE TRANSACTION: a DO block is atomic — any failure rolls the whole merge back.
--
-- IDEMPOTENT, AND MEANT TO BE RE-RUN ONCE. LP-MCP caches lp_branch_market_map
-- and service_area_zips for up to an hour (MARKET_MAP_TTL_MS), so a writer can
-- still stamp a fresh LAKE_MKT row shortly after the first run. Re-run this file
-- after the LP-MCP PR deploys (which restarts the process and drops the cache);
-- with nothing left under LAKE_MKT every statement below is a no-op.
--
-- ROW-LEVEL vs AGGREGATE. Relabelling an aggregate row (one per date + market)
-- would collide with Orlando's row on the unique key, so aggregates ADD
-- Lakeland's numbers into Orlando's row, delete the Lakeland row, and relabel
-- only the Lakeland rows with no Orlando twin. Rates are recomputed from the
-- summed counts with the same formulas as src/jobs/scorecard-metrics.js
-- (rate = one-decimal percent, money = whole dollars) — never averaged.
--
-- GOALS (ruled 2026-09-28): Lakeland's monthly goal is added into Orlando's for
-- every month EXCEPT August 2026, whose $1,000,000 Lakeland goal (set 2026-08-18,
-- 7× any other Lakeland month) is dropped, not added. The live scorecard_goals
-- row is the same $1,000,000 and is dropped the same way. REECE (Σ offices) is
-- reduced by exactly the dropped amount, so every other month's company total
-- is unchanged. Percent columns are identical for both markets where set, and
-- trailing_nsli is a per-lead rate, so Orlando's values are kept.
--
-- NOT TOUCHED (raw LP / vendor codes, same as BOCA/MIAMI for Fort Lauderdale):
-- branch_code_raw, market_code_raw, brn_id_raw, raw_brn_id, lp_leads.lp_branch_id,
-- lp_jobs.branch_code, lp_capacity_slots.rep_home_market (board views map it live
-- through lp_branch_market_map), ci_canvassers.market, ft_leads / ft_summary_territory.

DO $merge$
DECLARE
  n int;
BEGIN
  -- ── 1. The switch every writer reads ──────────────────────────────────────
  UPDATE lp_branch_market_map
     SET market_code = 'ORL_MKT', market_label = 'Orlando'
   WHERE brn_id = 'LAKE' AND market_code IS DISTINCT FROM 'ORL_MKT';

  -- ── 2. Zip authority: check_service_area on a Lakeland zip now says Orlando.
  -- Same service phone either way: (407) 604-7114.
  UPDATE service_area_zips SET market_code = 'ORL' WHERE market_code = 'LAKE';

  -- ── 3. service_markets: deactivate, don't delete (service_area_zips FK, and
  -- enrichment still resolves a raw lp_branch_id 'LAKE' to its name).
  UPDATE service_markets
     SET enabled = false,
         notes = concat_ws(' ', notes, 'Merged into ORL 2026-09-28 (sql/135).'),
         updated_at = now()
   WHERE market_code = 'LAKE' AND enabled;

  -- ── 4. Row-level facts: relabel ───────────────────────────────────────────
  UPDATE lp_lead_market_assignments  SET resolved_market_code = 'ORL_MKT' WHERE resolved_market_code = 'LAKE_MKT';
  UPDATE lp_lead_disposition_history SET market = 'ORL_MKT' WHERE market = 'LAKE_MKT';
  UPDATE lp_job_status_history       SET market = 'ORL_MKT' WHERE market = 'LAKE_MKT';
  UPDATE lp_sales_efficiency_history SET market = 'ORL_MKT' WHERE market = 'LAKE_MKT';
  UPDATE scorecard_report_rows_a     SET market = 'ORL_MKT' WHERE market = 'LAKE_MKT';
  UPDATE scorecard_report_rows_b     SET market = 'ORL_MKT' WHERE market = 'LAKE_MKT';

  -- ── 5. Aggregates: add into Orlando, drop Lakeland, relabel the rest ──────

  -- 5a. lp_appt_fill_hourly (snapshot_hour, slot_date, market)
  UPDATE lp_appt_fill_hourly o
     SET requested   = coalesce(o.requested, 0)   + coalesce(l.requested, 0),
         confirmed   = coalesce(o.confirmed, 0)   + coalesce(l.confirmed, 0),
         set_pending = coalesce(o.set_pending, 0) + coalesce(l.set_pending, 0)
    FROM lp_appt_fill_hourly l
   WHERE o.market = 'ORL_MKT' AND l.market = 'LAKE_MKT'
     AND o.snapshot_hour = l.snapshot_hour AND o.slot_date = l.slot_date;
  DELETE FROM lp_appt_fill_hourly l
   WHERE l.market = 'LAKE_MKT'
     AND EXISTS (SELECT 1 FROM lp_appt_fill_hourly o
                  WHERE o.market = 'ORL_MKT' AND o.snapshot_hour = l.snapshot_hour AND o.slot_date = l.slot_date);
  UPDATE lp_appt_fill_hourly SET market = 'ORL_MKT' WHERE market = 'LAKE_MKT';

  -- 5b. lp_appt_fill_snapshot (snapshot_date, slot_date, market)
  UPDATE lp_appt_fill_snapshot o
     SET requested   = coalesce(o.requested, 0)   + coalesce(l.requested, 0),
         confirmed   = coalesce(o.confirmed, 0)   + coalesce(l.confirmed, 0),
         set_pending = coalesce(o.set_pending, 0) + coalesce(l.set_pending, 0)
    FROM lp_appt_fill_snapshot l
   WHERE o.market = 'ORL_MKT' AND l.market = 'LAKE_MKT'
     AND o.snapshot_date = l.snapshot_date AND o.slot_date = l.slot_date;
  DELETE FROM lp_appt_fill_snapshot l
   WHERE l.market = 'LAKE_MKT'
     AND EXISTS (SELECT 1 FROM lp_appt_fill_snapshot o
                  WHERE o.market = 'ORL_MKT' AND o.snapshot_date = l.snapshot_date AND o.slot_date = l.slot_date);
  UPDATE lp_appt_fill_snapshot SET market = 'ORL_MKT' WHERE market = 'LAKE_MKT';

  -- 5c. lp_net_report_rtp (market, report_month, report_as_of)
  UPDATE lp_net_report_rtp o
     SET released_net = CASE WHEN o.released_net IS NULL AND l.released_net IS NULL THEN NULL
                             ELSE coalesce(o.released_net, 0) + coalesce(l.released_net, 0) END,
         rows_counted = coalesce(o.rows_counted, 0) + coalesce(l.rows_counted, 0),
         ingested_at  = greatest(o.ingested_at, l.ingested_at)
    FROM lp_net_report_rtp l
   WHERE o.market = 'ORL_MKT' AND l.market = 'LAKE_MKT'
     AND o.report_month = l.report_month AND o.report_as_of = l.report_as_of;
  DELETE FROM lp_net_report_rtp l
   WHERE l.market = 'LAKE_MKT'
     AND EXISTS (SELECT 1 FROM lp_net_report_rtp o
                  WHERE o.market = 'ORL_MKT' AND o.report_month = l.report_month AND o.report_as_of = l.report_as_of);
  UPDATE lp_net_report_rtp SET market = 'ORL_MKT' WHERE market = 'LAKE_MKT';

  -- 5d. lp_report_facts (snapshot_id, market, branch_code_raw, metric, bucket).
  -- Rows that keep branch_code_raw='LAKE' never collide (Orlando's are 'ORL');
  -- only the market-level rollups (branch NULL) do, and every colliding metric
  -- is a count or a dollar amount (leads, leads_distinct, leads_superseded,
  -- sets, sold, net_sold — checked 2026-09-28), so they add.
  UPDATE lp_report_facts o
     SET value_cents = CASE WHEN o.value_cents IS NULL AND l.value_cents IS NULL THEN NULL
                            ELSE coalesce(o.value_cents, 0) + coalesce(l.value_cents, 0) END,
         value_count = CASE WHEN o.value_count IS NULL AND l.value_count IS NULL THEN NULL
                            ELSE coalesce(o.value_count, 0) + coalesce(l.value_count, 0) END
    FROM lp_report_facts l
   WHERE o.market = 'ORL_MKT' AND l.market = 'LAKE_MKT'
     AND o.snapshot_id = l.snapshot_id
     AND coalesce(o.branch_code_raw, '') = coalesce(l.branch_code_raw, '')
     AND o.metric = l.metric
     AND coalesce(o.bucket, '') = coalesce(l.bucket, '');
  DELETE FROM lp_report_facts l
   WHERE l.market = 'LAKE_MKT'
     AND EXISTS (SELECT 1 FROM lp_report_facts o
                  WHERE o.market = 'ORL_MKT' AND o.snapshot_id = l.snapshot_id
                    AND coalesce(o.branch_code_raw, '') = coalesce(l.branch_code_raw, '')
                    AND o.metric = l.metric AND coalesce(o.bucket, '') = coalesce(l.bucket, ''));
  UPDATE lp_report_facts SET market = 'ORL_MKT' WHERE market = 'LAKE_MKT';

  -- 5e. lp_market_scorecard_daily (market, as_of_date). Counts and dollars add;
  -- ratios are recomputed from the sums (scorecard-metrics.js). good_rate_pct's
  -- live-month numerator (sold-basis net) is not stored, so it is the
  -- gross-weighted mean of the two rows' rates — which is the same thing as the
  -- summed numerator over the summed gross.
  UPDATE lp_market_scorecard_daily o
     SET leads          = coalesce(o.leads, 0)        + coalesce(l.leads, 0),
         issued         = coalesce(o.issued, 0)       + coalesce(l.issued, 0),
         sets           = coalesce(o.sets, 0)         + coalesce(l.sets, 0),
         demos          = coalesce(o.demos, 0)        + coalesce(l.demos, 0),
         sales          = coalesce(o.sales, 0)        + coalesce(l.sales, 0),
         ko_count       = coalesce(o.ko_count, 0)     + coalesce(l.ko_count, 0),
         net_issue      = coalesce(o.net_issue, 0)    + coalesce(l.net_issue, 0),
         net_close      = coalesce(o.net_close, 0)    + coalesce(l.net_close, 0),
         raw_leads_in   = CASE WHEN o.raw_leads_in IS NULL AND l.raw_leads_in IS NULL THEN NULL
                               ELSE coalesce(o.raw_leads_in, 0) + coalesce(l.raw_leads_in, 0) END,
         good_business  = CASE WHEN o.good_business IS NULL AND l.good_business IS NULL THEN NULL
                               ELSE coalesce(o.good_business, 0) + coalesce(l.good_business, 0) END,
         gross_sales    = CASE WHEN o.gross_sales IS NULL AND l.gross_sales IS NULL THEN NULL
                               ELSE coalesce(o.gross_sales, 0) + coalesce(l.gross_sales, 0) END,
         net_sales      = CASE WHEN o.net_sales IS NULL AND l.net_sales IS NULL THEN NULL
                               ELSE coalesce(o.net_sales, 0) + coalesce(l.net_sales, 0) END,
         released_dollars = CASE WHEN o.released_dollars IS NULL AND l.released_dollars IS NULL THEN NULL
                               ELSE coalesce(o.released_dollars, 0) + coalesce(l.released_dollars, 0) END,
         pending_dollars = CASE WHEN o.pending_dollars IS NULL AND l.pending_dollars IS NULL THEN NULL
                               ELSE coalesce(o.pending_dollars, 0) + coalesce(l.pending_dollars, 0) END,
         working_dollars = CASE WHEN o.working_dollars IS NULL AND l.working_dollars IS NULL THEN NULL
                               ELSE coalesce(o.working_dollars, 0) + coalesce(l.working_dollars, 0) END,
         pending_total  = CASE WHEN o.pending_total IS NULL AND l.pending_total IS NULL THEN NULL
                               ELSE coalesce(o.pending_total, 0) + coalesce(l.pending_total, 0) END,
         deposits       = CASE WHEN o.deposits IS NULL AND l.deposits IS NULL THEN NULL
                               ELSE coalesce(o.deposits, 0) + coalesce(l.deposits, 0) END,
         provisional_gross_dollars = CASE WHEN o.provisional_gross_dollars IS NULL AND l.provisional_gross_dollars IS NULL THEN NULL
                               ELSE coalesce(o.provisional_gross_dollars, 0) + coalesce(l.provisional_gross_dollars, 0) END,
         rtp_gross_dollars = CASE WHEN o.rtp_gross_dollars IS NULL AND l.rtp_gross_dollars IS NULL THEN NULL
                               ELSE coalesce(o.rtp_gross_dollars, 0) + coalesce(l.rtp_gross_dollars, 0) END,
         -- released_dollars NULL ⇔ revenue_basis NULL holds per row; keep it on the sum.
         revenue_basis  = coalesce(o.revenue_basis, l.revenue_basis),
         revenue_as_of  = coalesce(o.revenue_as_of, l.revenue_as_of),
         good_rate_pct  = (
           SELECT CASE WHEN w = 0 THEN NULL ELSE round(num / w, 1) END
             FROM (SELECT coalesce(o.good_rate_pct * o.gross_sales, 0) + coalesce(l.good_rate_pct * l.gross_sales, 0) AS num,
                          coalesce(CASE WHEN o.good_rate_pct IS NOT NULL THEN o.gross_sales END, 0)
                        + coalesce(CASE WHEN l.good_rate_pct IS NOT NULL THEN l.gross_sales END, 0) AS w) g),
         raw_inputs     = coalesce(o.raw_inputs, '{}'::jsonb)
                          || jsonb_build_object('lake_orl_merge', jsonb_build_object(
                               'merged_at', now(), 'lake_row_id', l.id, 'sql', '135_lake_orl_merge'))
    FROM lp_market_scorecard_daily l
   WHERE o.market = 'ORL_MKT' AND l.market = 'LAKE_MKT' AND o.as_of_date = l.as_of_date;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'lp_market_scorecard_daily: % Orlando rows absorbed a Lakeland row', n;

  DELETE FROM lp_market_scorecard_daily l
   WHERE l.market = 'LAKE_MKT'
     AND EXISTS (SELECT 1 FROM lp_market_scorecard_daily o WHERE o.market = 'ORL_MKT' AND o.as_of_date = l.as_of_date);
  UPDATE lp_market_scorecard_daily SET market = 'ORL_MKT' WHERE market = 'LAKE_MKT';

  -- Ratios for every Orlando row that absorbed Lakeland (tagged above), from the sums.
  UPDATE lp_market_scorecard_daily
     SET pct_issue     = CASE WHEN coalesce(sets, 0)      = 0 THEN NULL ELSE round(issued::numeric    / sets * 100, 1) END,
         demo_pct      = CASE WHEN coalesce(issued, 0)    = 0 THEN NULL ELSE round(demos::numeric     / issued * 100, 1) END,
         close_pct     = CASE WHEN coalesce(demos, 0)     = 0 THEN NULL ELSE round(sales::numeric     / demos * 100, 1) END,
         pct_net_close = CASE WHEN coalesce(demos, 0)     = 0 THEN NULL ELSE round(net_close::numeric / demos * 100, 1) END,
         ko_pct        = CASE WHEN coalesce(sales, 0)     = 0 THEN NULL ELSE round(ko_count::numeric  / sales * 100, 1) END,
         gsli          = CASE WHEN coalesce(issued, 0)    = 0 OR gross_sales IS NULL THEN NULL ELSE round(gross_sales / issued) END,
         nsli          = CASE WHEN coalesce(issued, 0)    = 0 OR net_sales IS NULL THEN NULL ELSE round(net_sales / issued) END,
         avg_sale      = CASE WHEN coalesce(net_close, 0) = 0 OR net_sales IS NULL THEN NULL ELSE round(net_sales / net_close) END
   WHERE market = 'ORL_MKT' AND raw_inputs ? 'lake_orl_merge';

  -- ── 6. Goals ─────────────────────────────────────────────────────────────
  -- 6a. Monthly: add Lakeland into Orlando, except August 2026 (dropped).
  UPDATE scorecard_goals_monthly o
     SET goal_dollars = o.goal_dollars + l.goal_dollars,
         updated_by = 'migration:135_lake_orl_merge',
         updated_at = now()
    FROM scorecard_goals_monthly l
   WHERE o.market = 'ORL_MKT' AND l.market = 'LAKE_MKT'
     AND o.goal_month = l.goal_month
     AND l.goal_month <> DATE '2026-08-01';
  -- The dropped August Lakeland goal leaves the company total too (REECE = Σ offices).
  UPDATE scorecard_goals_monthly r
     SET goal_dollars = r.goal_dollars - l.goal_dollars,
         updated_by = 'migration:135_lake_orl_merge',
         updated_at = now()
    FROM scorecard_goals_monthly l
   WHERE r.market = 'REECE' AND l.market = 'LAKE_MKT'
     AND r.goal_month = l.goal_month
     AND l.goal_month = DATE '2026-08-01';
  DELETE FROM scorecard_goals_monthly WHERE market = 'LAKE_MKT';

  -- 6b. Live goal: Lakeland's $1,000,000 is dropped (same ruling); Orlando unchanged.
  UPDATE scorecard_goals r
     SET monthly_goal_dollars = r.monthly_goal_dollars - l.monthly_goal_dollars,
         updated_by = 'migration:135_lake_orl_merge',
         updated_at = now()
    FROM scorecard_goals l
   WHERE r.market = 'REECE' AND l.market = 'LAKE_MKT';
  DELETE FROM scorecard_goals WHERE market = 'LAKE_MKT';

  -- ── 7. Slack: Lakeland rows removed. The channels themselves are NOT archived
  -- (Mark's call). LP-MCP routes code LAKE → ORL (MARKET_ALIASES in src/slack.js),
  -- so these rows are unreachable once that PR deploys; with the old code a
  -- Lakeland card falls back to the rollup channel until then.
  DELETE FROM slack_channels     WHERE market_code = 'LAKE';
  DELETE FROM slack_market_slugs WHERE market_code = 'LAKE';
END
$merge$;

-- ── Verify (expect zero everywhere) ──────────────────────────────────────────
-- SELECT 'map' t, count(*) FROM lp_branch_market_map WHERE market_code = 'LAKE_MKT'
-- UNION ALL SELECT 'zips', count(*) FROM service_area_zips WHERE market_code = 'LAKE'
-- UNION ALL SELECT 'lma', count(*) FROM lp_lead_market_assignments WHERE resolved_market_code = 'LAKE_MKT'
-- UNION ALL SELECT 'ldh', count(*) FROM lp_lead_disposition_history WHERE market = 'LAKE_MKT'
-- UNION ALL SELECT 'jsh', count(*) FROM lp_job_status_history WHERE market = 'LAKE_MKT'
-- UNION ALL SELECT 'seh', count(*) FROM lp_sales_efficiency_history WHERE market = 'LAKE_MKT'
-- UNION ALL SELECT 'rows_a', count(*) FROM scorecard_report_rows_a WHERE market = 'LAKE_MKT'
-- UNION ALL SELECT 'rows_b', count(*) FROM scorecard_report_rows_b WHERE market = 'LAKE_MKT'
-- UNION ALL SELECT 'facts', count(*) FROM lp_report_facts WHERE market = 'LAKE_MKT'
-- UNION ALL SELECT 'scd', count(*) FROM lp_market_scorecard_daily WHERE market = 'LAKE_MKT'
-- UNION ALL SELECT 'rtp', count(*) FROM lp_net_report_rtp WHERE market = 'LAKE_MKT'
-- UNION ALL SELECT 'hourly', count(*) FROM lp_appt_fill_hourly WHERE market = 'LAKE_MKT'
-- UNION ALL SELECT 'snap', count(*) FROM lp_appt_fill_snapshot WHERE market = 'LAKE_MKT'
-- UNION ALL SELECT 'goals_m', count(*) FROM scorecard_goals_monthly WHERE market = 'LAKE_MKT'
-- UNION ALL SELECT 'goals', count(*) FROM scorecard_goals WHERE market = 'LAKE_MKT'
-- UNION ALL SELECT 'slack', count(*) FROM slack_channels WHERE market_code = 'LAKE';
