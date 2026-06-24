-- ─── Scorecard per-source selling-day denominator — sql/034_scorecard_source_working_days.sql ───
--
-- Companion to sql/032 (which added working_days_in_period to
-- lp_market_scorecard_daily). The daily job also writes per-(source, sub_source)
-- rows via writeSourceScorecard(); persist the same selling-day denominator there
-- so the dashboard's per-source period views share one basis with the aggregate.
--
-- Nullable → old readers ignore it. Idempotent — safe to re-run. Fully reversible.

ALTER TABLE lp_source_scorecard_daily
  ADD COLUMN IF NOT EXISTS working_days_in_period integer; -- selling days in the full month
