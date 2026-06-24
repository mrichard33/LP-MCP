-- ─── Per-source scorecard actuals — sql/031_source_scorecard.sql ───
--
-- Phase 2 of the Reece Revenue Scorecard. One ACTUALS row per
-- (market, source, sub_source, as_of_date), computed in the SAME daily run as the
-- aggregate lp_market_scorecard_daily row (same prospect set, no extra LP calls) by
-- src/jobs/goal-scorecard-daily.js via computeActuals(..., { groupBy:['source','sub_source'] }).
--
-- Same metric definitions as the aggregate (released/working/cancel buckets, By Appt
-- Date). source / sub_source are the raw LP values, coalesced to '(none)' when absent
-- so the UNIQUE upsert key is deterministic. raw_inputs.unmapped flags sources that do
-- not resolve through lp_source_mapping (ties to lp_unmapped_sources); raw_inputs.bucket
-- carries the resolved GHL intent bucket when known.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS lp_source_scorecard_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market text NOT NULL,
  source text,
  sub_source text,
  as_of_date date NOT NULL,
  period_start date, period_end date, days_elapsed int,
  raw_leads_in int, leads int, sets int, issued int, net_issue int,
  demos int, sales int, net_close int, ko_count int,
  gross_sales numeric, net_sales numeric, released_dollars numeric,
  working_dollars numeric, pending_total numeric,
  pct_issue numeric, demo_pct numeric, close_pct numeric, pct_net_close numeric,
  good_rate_pct numeric, ko_pct numeric, gsli numeric, nsli numeric, avg_sale numeric,
  computed_from text DEFAULT 'lp_api', reconciled boolean DEFAULT false,
  raw_inputs jsonb, created_at timestamptz DEFAULT now(),
  UNIQUE (market, source, sub_source, as_of_date)
);

CREATE INDEX IF NOT EXISTS idx_source_scorecard_market_asof
  ON lp_source_scorecard_daily (market, as_of_date DESC);
