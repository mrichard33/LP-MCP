-- 2026-10-23 (the user): "we don't need to display any calculated cost for Canvas Sticky."
--
-- The Canvass rule (15% of net, estimate until canvasser payroll) listed both "Canvass" and
-- "Canvass Sticky", so Canvass Sticky got a calculated cost every month: 37 approved rows,
-- Mar-Sep 2026, $267,885.45. Now, the same way the referral rule was retired today
-- (2026-10-23_retire_referral_commission.sql):
--   * "Canvass Sticky" leaves the rule's lp_sub_sources, so buildCommissionRows
--     (src/marketing/commission.js) never writes one again; "Canvass" keeps its 15% estimate;
--   * every Canvass Sticky row it wrote is retired: allocations deleted, status 'superseded'
--     (v_market_subsource_cost reads approved rows only). The nightly recompute alone would not do
--     it: it covers the current and prior month only.
-- Data, not schema: re-runnable, each statement guarded.
-- ROLLBACK: UPDATE marketing_cost_rules SET lp_sub_sources = ARRAY['Canvass','Canvass Sticky']
--   WHERE id = 'a1a1a1a1-0001-4000-8000-000000000001'; then recomputeCalculatedCosts(month) per month.

UPDATE marketing_cost_rules
   SET lp_sub_sources = array_remove(lp_sub_sources, 'Canvass Sticky')
 WHERE id = 'a1a1a1a1-0001-4000-8000-000000000001'
   AND 'Canvass Sticky' = ANY (lp_sub_sources);

DELETE FROM marketing_expense_allocations a
 USING marketing_expenses e
 WHERE a.expense_id = e.id
   AND e.source_system = 'commission_rule'
   AND e.source_ref LIKE 'a1a1a1a1-0001-4000-8000-000000000001|%|Canvass Sticky|%';

UPDATE marketing_expenses
   SET status = 'superseded', updated_at = now()
 WHERE source_system = 'commission_rule'
   AND source_ref LIKE 'a1a1a1a1-0001-4000-8000-000000000001|%|Canvass Sticky|%'
   AND status <> 'superseded';
