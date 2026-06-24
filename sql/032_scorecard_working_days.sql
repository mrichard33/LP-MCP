-- ─── Scorecard selling-day denominator — sql/032_scorecard_working_days.sql ───
--
-- Step 1 of the visualization/reporting work: fix "Days Elapsed" to count
-- SELLING days (Mon–Sat minus Reece closures) instead of calendar days, on a
-- consistent basis for numerator and denominator.
--
--   working_days_in_period  Selling days in the FULL month of the snapshot's
--                           period (e.g. 26 for June 2026). The read layer
--                           prorates the monthly goal as monthly_goal ×
--                           (days_elapsed / working_days_in_period), where
--                           days_elapsed is now selling days [period_start, as_of].
--
-- days_elapsed (column from 029) now stores SELLING days, written by
-- src/jobs/goal-scorecard-daily.js via src/selling-days.js. The selling-day
-- pattern + closure list are configured by SCORECARD_SELLING_DAYS /
-- SCORECARD_HOLIDAYS (env). Juneteenth is intentionally a selling day.
--
-- Nullable → old readers ignore it and fall back to scorecard_goals.working_days.
-- Idempotent — safe to re-run. Fully reversible.

ALTER TABLE lp_market_scorecard_daily
  ADD COLUMN IF NOT EXISTS working_days_in_period integer; -- selling days in the full month
