-- 120_lp_leads_verified_at.sql
-- lp_verified_at: last time this row was compared against live LP and either
-- matched (skip path, stamped at most daily) or rewritten (write path).
-- synced_at is NOT this: it moves only on a write, so a row that is correct
-- and untouched for a year looks identical to a row nobody has checked.
-- Additive: new column, new view, nothing live is mutated.

ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS lp_verified_at timestamptz;

COMMENT ON COLUMN lp_leads.lp_verified_at IS
  'Last compare against live LP (match or rewrite). Stamped by src/sync-leads.js when LP_VERIFIED_AT_ENABLED=true.';

-- Freshness at a glance. "Active" = created in LP within the last year.
CREATE OR REPLACE VIEW v_lp_lead_freshness AS
SELECT
  count(*)                                                                   AS active_leads,
  count(*) FILTER (WHERE lp_verified_at >= now() - interval '1 day')          AS verified_24h,
  count(*) FILTER (WHERE lp_verified_at >= now() - interval '7 days')         AS verified_7d,
  count(*) FILTER (WHERE lp_verified_at IS NULL)                              AS never_verified,
  round(100.0 * count(*) FILTER (WHERE lp_verified_at >= now() - interval '7 days')
        / greatest(count(*), 1), 2)                                           AS pct_verified_7d
FROM lp_leads
WHERE created_at_lp >= now() - interval '365 days';
