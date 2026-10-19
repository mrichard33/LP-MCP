-- 2026-10-19 (the user): "LightFire cost are all Call center cost. The cost for
-- canvassing should be assigned to the office that had the cost directly
-- associated for it."
-- LightFire Partners bills Reece weekly / half-monthly: "Demos - AGED" ($250 a
-- demo), "Sales 1.5%" and "Canvas" ($15 per canvass appointment its agents
-- confirm). Every line is call-center cost, split evenly over the six offices,
-- EXCEPT a canvass line, which src/marketing/allocation.js (splitsByCanvassConfirms)
-- splits by the offices whose canvass appointments LightFire confirmed in the
-- line's period. The split is read from the line's description, so nothing
-- extra is stored here.
INSERT INTO marketing_vendors (vendor_name, aliases, sender_domains, lp_sub_sources, eligible_markets, default_cost_type, is_active, notes)
SELECT 'LightFire Partners',
       ARRAY['LightFire Partners, LLC', 'LightFire Partners', 'LightFire', 'Lightfire Partners LLC'],
       ARRAY['lightfirepartners.com'],
       ARRAY['Call Center'],
       ARRAY['ALL_OFFICES'],
       'invoice', true,
       'Call center (the user, 2026-10-19). Canvass lines split by LightFire-confirmed canvass appointments per office; aged demos and 1.5% of sales split evenly.'
WHERE NOT EXISTS (SELECT 1 FROM marketing_vendors WHERE vendor_name = 'LightFire Partners');
