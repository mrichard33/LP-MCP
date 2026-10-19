-- 2026-10-19 (the user): "LightFire cost are all Call center cost. The cost for
-- canvassing should be assigned to the office that had the cost directly
-- associated for it."
-- LightFire Partners bills Reece weekly / half-monthly: "Demos - AGED" ($250 a
-- demo), "Sales 1.5%" and "Canvas" ($15 per canvass appointment its agents
-- confirm). Every line is call-center cost and goes to the office of the leads
-- it was for, never split evenly (the user, later the same day: "if there were
-- 10 demos at $250 each set in Fort Lauderdale, then those should all be
-- assigned to Fort Lauderdale. The same applies to the 1.5% sales").
-- src/marketing/allocation.js callCenterLineKind reads the kind from the line's
-- description; allocation-io.js callCenterWorkByMarketFor weights it by the
-- leads payroll pays LightFire for. ALL_OFFICES below is only the "call center
-- cost" marker (and the even split for a line naming none of the three).
INSERT INTO marketing_vendors (vendor_name, aliases, sender_domains, lp_sub_sources, eligible_markets, default_cost_type, is_active, notes)
SELECT 'LightFire Partners',
       ARRAY['LightFire Partners, LLC', 'LightFire Partners', 'LightFire', 'Lightfire Partners LLC'],
       ARRAY['lightfirepartners.com'],
       ARRAY['Call Center'],
       ARRAY['ALL_OFFICES'],
       'invoice', true,
       'Call center (the user, 2026-10-19). Each line goes to the office of its leads: aged demos set, sales (1.5%) on new leads set, canvass appointments confirmed by LightFire agents.'
WHERE NOT EXISTS (SELECT 1 FROM marketing_vendors WHERE vendor_name = 'LightFire Partners');

-- 2026-10-19: the note on a row inserted before the by-office ruling.
UPDATE marketing_vendors
SET notes = 'Call center (the user, 2026-10-19). Each line goes to the office of its leads: aged demos set, sales (1.5%) on new leads set, canvass appointments confirmed by LightFire agents.'
WHERE vendor_name = 'LightFire Partners';
