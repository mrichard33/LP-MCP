-- ─── Scorecard Report-Aligned Columns — sql/030_scorecard_report_columns.sql ───
--
-- CONTEXT
-- -------
-- 029_goal_scorecard.sql created lp_market_scorecard_daily with the initial
-- column set. After that migration was applied, scorecard-metrics.js was updated
-- to align output with Reece's "Marketing Sub-Source By Appt Date" report, which
-- added five computed columns:
--
--   net_issue      integer   Issued leads that were NOT later cancelled
--   net_close      integer   Sold deals that were NOT later cancelled
--   gsli           integer   Gross Sale $ ÷ Issued   (Gross NSLI)
--   pct_issue      numeric   Issue ÷ Set × 100        (% Issue)
--   pct_net_close  numeric   Net Close ÷ Demo × 100   (% Net Close)
--
-- These columns were added to the live LP Supabase DB directly but were never
-- captured in a migration file, leaving the repo out of sync. This file
-- re-establishes that sync.
--
-- IDEMPOTENCY
-- -----------
-- Every ALTER TABLE uses IF NOT EXISTS — safe to run against a DB that already
-- has these columns. No data is modified; existing rows are unaffected (columns
-- default to 0 / null as appropriate).
--
-- COLUMN ALIGNMENT WITH scorecard-metrics.js → computeActuals()
-- -------------------------------------------------------------
-- The full upsert payload produced by the daily job is now:
--
--   leads, sets, issued, net_issue           ← funnel (integer)
--   demos, sales, net_close, ko_count        ← conversions (integer)
--   gross_sales, net_sales, good_business    ← dollar buckets (numeric)
--   pending_dollars, deposits                ← dollar buckets (numeric)
--   pct_issue, demo_pct, close_pct           ← rates (numeric, %)
--   pct_net_close, good_rate_pct, ko_pct     ← rates (numeric, %)
--   gsli, nsli, avg_sale                     ← per-unit $ (numeric)
--   computed_from, reconciled, raw_inputs    ← metadata
--
-- PREREQUISITE: 029_goal_scorecard.sql must have been applied first.

ALTER TABLE lp_market_scorecard_daily
  ADD COLUMN IF NOT EXISTS net_issue     integer     DEFAULT 0,
  ADD COLUMN IF NOT EXISTS net_close     integer     DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gsli          integer     DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS pct_issue     numeric     DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS pct_net_close numeric     DEFAULT NULL;

-- Verify: confirm all expected report columns are present after migration.
-- (Run manually or via supabase_run_query to audit post-deploy.)
--
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'lp_market_scorecard_daily'
-- ORDER BY ordinal_position;
