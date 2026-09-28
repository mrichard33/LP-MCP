-- ROLLBACK for sql/135_lake_orl_merge.sql (Lakeland → Orlando, 2026-09-28)
--
-- Puts every row back exactly as sql/backup/2026-09-28_lake_orl_merge_backup.sql
-- copied it. One DO block = one transaction.
--
-- Full rollback also needs:
--   1. Revert the LP-MCP and Reece-Dashboard PRs (the LP-MCP one aliases LAKE → ORL
--      in Slack routing and drops LAKE_MKT from the dial ranker).
--   2. Re-attach the two LKE Five9 lists via approval-gated create_agent_action,
--      if they were detached.
--   3. Redeploy LP-MCP (or wait an hour) so the cached market map is re-read.
--
-- KNOWN LIMITS — read before running:
--   * Aggregate rows written AFTER the merge for keys the backup never saw (new
--     hours, new days) stay as combined Orlando rows. Only pre-merge history is
--     split back out. Re-running the day's jobs after this rollback re-splits today.
--   * Goals are restored to their pre-merge values. Any goal edited for Orlando or
--     REECE after the merge is overwritten.
--   * Leads re-resolved after the merge are relabelled back only if they were
--     Lakeland at backup time; the 05:00 ET market-assignment run fixes the rest
--     once lp_branch_market_map says LAKE_MKT again.

DO $rollback$
BEGIN
  -- ── Config ────────────────────────────────────────────────────────────────
  UPDATE lp_branch_market_map m
     SET market_code = b.market_code, market_label = b.market_label
    FROM backup_lake_merge_20260928.lp_branch_market_map b
   WHERE m.brn_id = b.brn_id AND b.brn_id = 'LAKE';

  UPDATE service_markets s
     SET enabled = b.enabled, notes = b.notes, updated_at = b.updated_at
    FROM backup_lake_merge_20260928.service_markets b
   WHERE s.market_code = b.market_code AND b.market_code = 'LAKE';

  UPDATE service_area_zips z
     SET market_code = b.market_code
    FROM backup_lake_merge_20260928.service_area_zips b
   WHERE z.zip = b.zip AND b.market_code = 'LAKE';

  INSERT INTO slack_market_slugs
  SELECT * FROM backup_lake_merge_20260928.slack_market_slugs WHERE market_code = 'LAKE'
  ON CONFLICT DO NOTHING;
  INSERT INTO slack_channels
  SELECT * FROM backup_lake_merge_20260928.slack_channels WHERE market_code = 'LAKE'
  ON CONFLICT DO NOTHING;

  -- ── Goals ─────────────────────────────────────────────────────────────────
  UPDATE scorecard_goals_monthly g
     SET goal_dollars = b.goal_dollars, updated_by = b.updated_by, updated_at = b.updated_at
    FROM backup_lake_merge_20260928.scorecard_goals_monthly b
   WHERE g.id = b.id AND b.market IN ('ORL_MKT', 'REECE');
  INSERT INTO scorecard_goals_monthly
  SELECT * FROM backup_lake_merge_20260928.scorecard_goals_monthly WHERE market = 'LAKE_MKT'
  ON CONFLICT DO NOTHING;

  UPDATE scorecard_goals g
     SET monthly_goal_dollars = b.monthly_goal_dollars, updated_by = b.updated_by, updated_at = b.updated_at
    FROM backup_lake_merge_20260928.scorecard_goals b
   WHERE g.market = b.market AND b.market IN ('ORL_MKT', 'REECE');
  INSERT INTO scorecard_goals
  SELECT * FROM backup_lake_merge_20260928.scorecard_goals WHERE market = 'LAKE_MKT'
  ON CONFLICT DO NOTHING;

  -- ── Row-level facts: relabel back ────────────────────────────────────────
  UPDATE lp_lead_market_assignments t SET resolved_market_code = 'LAKE_MKT'
    FROM backup_lake_merge_20260928.lp_lead_market_assignments b
   WHERE t.lead_id = b.lead_id AND t.resolved_market_code = 'ORL_MKT';
  UPDATE lp_lead_disposition_history t SET market = 'LAKE_MKT'
    FROM backup_lake_merge_20260928.lp_lead_disposition_history b WHERE t.id = b.id;
  UPDATE lp_job_status_history t SET market = 'LAKE_MKT'
    FROM backup_lake_merge_20260928.lp_job_status_history b WHERE t.id = b.id;
  UPDATE lp_sales_efficiency_history t SET market = 'LAKE_MKT'
    FROM backup_lake_merge_20260928.lp_sales_efficiency_history b WHERE t.id = b.id;
  UPDATE scorecard_report_rows_a t SET market = 'LAKE_MKT'
    FROM backup_lake_merge_20260928.scorecard_report_rows_a b WHERE t.id = b.id;
  UPDATE scorecard_report_rows_b t SET market = 'LAKE_MKT'
    FROM backup_lake_merge_20260928.scorecard_report_rows_b b WHERE t.id = b.id;

  -- ── Aggregates: drop the merged rows, put both originals back ─────────────
  DELETE FROM lp_report_facts t
   USING backup_lake_merge_20260928.lp_report_facts b WHERE t.fact_id = b.fact_id;
  INSERT INTO lp_report_facts SELECT * FROM backup_lake_merge_20260928.lp_report_facts;

  DELETE FROM lp_market_scorecard_daily t
   USING backup_lake_merge_20260928.lp_market_scorecard_daily b WHERE t.id = b.id;
  INSERT INTO lp_market_scorecard_daily SELECT * FROM backup_lake_merge_20260928.lp_market_scorecard_daily;

  DELETE FROM lp_net_report_rtp t
   USING backup_lake_merge_20260928.lp_net_report_rtp b
   WHERE t.market = 'ORL_MKT' AND t.report_month = b.report_month AND t.report_as_of = b.report_as_of;
  INSERT INTO lp_net_report_rtp SELECT * FROM backup_lake_merge_20260928.lp_net_report_rtp;

  DELETE FROM lp_appt_fill_hourly t
   USING backup_lake_merge_20260928.lp_appt_fill_hourly b
   WHERE t.market = 'ORL_MKT' AND t.snapshot_hour = b.snapshot_hour AND t.slot_date = b.slot_date;
  INSERT INTO lp_appt_fill_hourly SELECT * FROM backup_lake_merge_20260928.lp_appt_fill_hourly;

  DELETE FROM lp_appt_fill_snapshot t
   USING backup_lake_merge_20260928.lp_appt_fill_snapshot b
   WHERE t.market = 'ORL_MKT' AND t.snapshot_date = b.snapshot_date AND t.slot_date = b.slot_date;
  INSERT INTO lp_appt_fill_snapshot SELECT * FROM backup_lake_merge_20260928.lp_appt_fill_snapshot;
END
$rollback$;
