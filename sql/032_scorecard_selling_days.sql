-- ─── Scorecard selling-day denominator — sql/032_scorecard_selling_days.sql ───
--
-- The daily job (src/jobs/goal-scorecard-daily.js) now computes days_elapsed on a
-- SELLING-day basis (Mon–Sat minus Reece closures, via src/selling-days.js) and
-- persists working_days_in_period (selling days in the full month) so the dashboard
-- prorates the MTD goal against a matching numerator/denominator instead of the
-- editable scorecard_goals.working_days fallback.
--
-- Idempotent — safe to re-run.

ALTER TABLE lp_market_scorecard_daily
  ADD COLUMN IF NOT EXISTS working_days_in_period integer;

ALTER TABLE lp_source_scorecard_daily
  ADD COLUMN IF NOT EXISTS working_days_in_period integer;
