-- 2026-10-19 (the user): commission rules.
--   * LeadPilotData is paid 15% of net, like MVP Marketing.
--   * Canvass stays at 15% of net, but only as an ESTIMATE: the real cost is
--     everything paid to canvassers, which will come from payroll reports. The
--     basis 'net_sales_estimate' makes commission.js write those rows as
--     provisional with flags {estimate}, so every report marks them.
--   * MVP Marketing 15% and Previous Customer / Referral 1% are unchanged.
-- Data, not schema: re-runnable, each statement guarded.

INSERT INTO marketing_cost_rules (lp_sub_sources, rate, basis, label, effective_from)
SELECT ARRAY['LeadPilotData'], 0.15, 'net_sales', 'LeadPilotData 15% of net', DATE '2026-01-01'
WHERE NOT EXISTS (SELECT 1 FROM marketing_cost_rules WHERE 'LeadPilotData' = ANY (lp_sub_sources));

INSERT INTO marketing_vendors (vendor_name, aliases, sender_domains, lp_sub_sources, eligible_markets, default_cost_type, notes)
SELECT 'LeadPilotData (commission)', '{}', '{}', ARRAY['LeadPilotData'],
       ARRAY['STPET_MKT','ORL_MKT','FTMYR_MKT','FTLAU_MKT','JAX_MKT','SAR_MKT'], 'calculated',
       '15% of net, computed monthly (the user, 2026-10-19).'
WHERE NOT EXISTS (SELECT 1 FROM marketing_vendors WHERE vendor_name = 'LeadPilotData (commission)');

UPDATE marketing_cost_rules
   SET basis = 'net_sales_estimate', label = 'Canvass 15% of net (estimate until canvasser payroll)'
 WHERE id = 'a1a1a1a1-0001-4000-8000-000000000001';

UPDATE marketing_vendors
   SET notes = '15% of net, an ESTIMATE until canvasser payroll reports are uploaded (the user, 2026-10-19).', updated_at = now()
 WHERE vendor_name = 'Canvass (commission)';
