-- 042_rtp_gross_dollars.sql
-- Separate the two "gross" figures on lp_market_scorecard_daily.
--
-- Closed net_report_rtp rows carried report RTP GROSS in `gross_sales` (a revenue
-- figure), which collided with the funnel SOLD gross that gross_sales holds on live
-- (lp_api) rows — and made Good Rate read ~99.9% (RTP net ÷ RTP gross). The funnel
-- re-derive (src/jobs/scorecard-market-rederive.js) preserves report RTP gross here
-- and restores gross_sales to funnel sold-basis, so Good Rate = (sold gross −
-- cancellations) ÷ sold gross on a single basis.
--
-- Nullable; populated only on closed net_report_rtp rows by the re-derive (it also
-- adds this column idempotently via exec_sql on first apply, so this migration is
-- optional).

ALTER TABLE lp_market_scorecard_daily
  ADD COLUMN IF NOT EXISTS rtp_gross_dollars numeric;

COMMENT ON COLUMN lp_market_scorecard_daily.rtp_gross_dollars IS
  'Report RTP GROSS (revenue basis), preserved off gross_sales on closed rows. gross_sales is funnel SOLD gross; released_dollars/net_sales are RTP net.';
