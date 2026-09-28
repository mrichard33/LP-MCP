-- 2026-09-28 — Lakeland → Orlando merge: BACKUP (run BEFORE sql/135_lake_orl_merge.sql)
--
-- Copies every row the merge touches into schema backup_lake_merge_20260928, so
-- sql/rollback/2026-09-28_lake_orl_merge_rollback.sql can put everything back.
--
--   * Config tables: copied WHOLE (small, and the merge edits several rows in each).
--   * Row-level facts: only the Lakeland rows (they get relabelled LAKE_MKT → ORL_MKT).
--   * Aggregates: the Lakeland rows AND the Orlando rows, because the merge ADDS
--     Lakeland's numbers into Orlando's row — the pre-merge Orlando value is only
--     recoverable from here.
--
-- Raw LP branch columns (branch_code_raw, market_code_raw, brn_id_raw, lp_branch_id,
-- lp_capacity_slots.rep_home_market, ci_canvassers.market, ft_*.territory) are NOT
-- changed by the merge, so they are not copied.
--
-- Re-running is refused (CREATE SCHEMA without IF NOT EXISTS) — a second run must
-- never overwrite the one good pre-merge copy with post-merge data.

CREATE SCHEMA backup_lake_merge_20260928;

-- ── Config (whole tables) ───────────────────────────────────────────────────
CREATE TABLE backup_lake_merge_20260928.scorecard_goals         AS SELECT * FROM public.scorecard_goals;
CREATE TABLE backup_lake_merge_20260928.scorecard_goals_monthly AS SELECT * FROM public.scorecard_goals_monthly;
CREATE TABLE backup_lake_merge_20260928.lp_branch_market_map    AS SELECT * FROM public.lp_branch_market_map;
CREATE TABLE backup_lake_merge_20260928.service_markets         AS SELECT * FROM public.service_markets;
CREATE TABLE backup_lake_merge_20260928.service_area_zips       AS SELECT * FROM public.service_area_zips;
CREATE TABLE backup_lake_merge_20260928.slack_channels          AS SELECT * FROM public.slack_channels;
CREATE TABLE backup_lake_merge_20260928.slack_market_slugs      AS SELECT * FROM public.slack_market_slugs;

-- ── Row-level facts (Lakeland rows only) ────────────────────────────────────
CREATE TABLE backup_lake_merge_20260928.lp_lead_market_assignments AS
  SELECT * FROM public.lp_lead_market_assignments WHERE resolved_market_code = 'LAKE_MKT';
CREATE TABLE backup_lake_merge_20260928.lp_lead_disposition_history AS
  SELECT * FROM public.lp_lead_disposition_history WHERE market = 'LAKE_MKT';
CREATE TABLE backup_lake_merge_20260928.lp_job_status_history AS
  SELECT * FROM public.lp_job_status_history WHERE market = 'LAKE_MKT';
CREATE TABLE backup_lake_merge_20260928.lp_sales_efficiency_history AS
  SELECT * FROM public.lp_sales_efficiency_history WHERE market = 'LAKE_MKT';
CREATE TABLE backup_lake_merge_20260928.scorecard_report_rows_a AS
  SELECT * FROM public.scorecard_report_rows_a WHERE market = 'LAKE_MKT';
CREATE TABLE backup_lake_merge_20260928.scorecard_report_rows_b AS
  SELECT * FROM public.scorecard_report_rows_b WHERE market = 'LAKE_MKT';

-- ── Aggregates (Lakeland AND Orlando rows) ──────────────────────────────────
CREATE TABLE backup_lake_merge_20260928.lp_report_facts AS
  SELECT * FROM public.lp_report_facts WHERE market IN ('LAKE_MKT', 'ORL_MKT');
CREATE TABLE backup_lake_merge_20260928.lp_market_scorecard_daily AS
  SELECT * FROM public.lp_market_scorecard_daily WHERE market IN ('LAKE_MKT', 'ORL_MKT');
CREATE TABLE backup_lake_merge_20260928.lp_net_report_rtp AS
  SELECT * FROM public.lp_net_report_rtp WHERE market IN ('LAKE_MKT', 'ORL_MKT');
CREATE TABLE backup_lake_merge_20260928.lp_appt_fill_hourly AS
  SELECT * FROM public.lp_appt_fill_hourly WHERE market IN ('LAKE_MKT', 'ORL_MKT');
CREATE TABLE backup_lake_merge_20260928.lp_appt_fill_snapshot AS
  SELECT * FROM public.lp_appt_fill_snapshot WHERE market IN ('LAKE_MKT', 'ORL_MKT');

-- Verify: every backup table is non-empty where the live table had rows.
-- SELECT relname, n_live_tup FROM pg_stat_user_tables WHERE schemaname = 'backup_lake_merge_20260928' ORDER BY 1;
