-- ─── Scorecard 3-bucket revenue + raw-leads-in — sql/030_scorecard_revenue_buckets.sql ───
--
-- Phase 1 of the Reece Revenue Scorecard accuracy work. Additive columns on the
-- ACTUALS snapshot table lp_market_scorecard_daily (created in 029):
--
--   released_dollars  Sold $ in a "released to production" job status. This is the
--                     NEW meaning of Net Sales (net_sales is set equal to this).
--   working_dollars   Sold $ held pre-release (financing / HOA / docs / measure) —
--                     Working Revenue. Earned but not yet bookable.
--   pending_total     working_dollars + any other in-flight, non-cancel sold $.
--                     pending_dollars is kept and set equal to this.
--   raw_leads_in      True top-of-funnel: leads CREATED in the window, counted from
--                     the lp_leads cache (created_at_lp). Distinct from the by-appt
--                     "leads" cohort and carries cache freshness, not LP-API freshness.
--   revenue_basis     Tie-out marker: which status sets produced the split.
--
-- The split is driven by SCORECARD_RELEASED_STATUSES / SCORECARD_WORKING_STATUSES /
-- SCORECARD_CANCEL_STATUSES in src/jobs/scorecard-metrics.js. ⚠ TIE-OUT — calibrate
-- those sets against a real Reece "By Appt Date" export, then flip
-- SCORECARD_RECONCILED_MARKETS=REECE.
--
-- All columns are nullable → the existing read layer ignores them; fully reversible.
-- Idempotent — safe to re-run.

ALTER TABLE lp_market_scorecard_daily
  ADD COLUMN IF NOT EXISTS raw_leads_in     integer,
  ADD COLUMN IF NOT EXISTS released_dollars numeric,   -- Net Sales = released to production
  ADD COLUMN IF NOT EXISTS working_dollars  numeric,   -- sold but held (financing/HOA/docs/measure)
  ADD COLUMN IF NOT EXISTS pending_total    numeric,   -- working + other in-flight, not yet released
  ADD COLUMN IF NOT EXISTS revenue_basis    text;      -- tie-out marker: which status sets produced the split
