-- 2026-10-23 (the user): "Previous customer and Customer Referral we can leave blank. We do not
-- need to assign a fixed percentage cost to it."
--
-- The rule "Previous Customer / Referral 1% of net" (D2, from 2026-01-01) wrote a calculated cost
-- every month: 86 approved rows, Jan-Oct 2026, $44,466. Now:
--   * the rule is ENDED, not deleted: effective_to before effective_from, so buildCommissionRows
--     (src/marketing/commission.js) never applies it to any month;
--   * every row it wrote is retired the way replaceEarlierInvoice retires a replaced invoice:
--     allocations deleted, status 'superseded' (v_market_subsource_cost reads approved rows only).
--     The nightly recompute alone would not do it: it covers the current and prior month only, and
--     skips a month with no report 133 snapshot.
-- Data, not schema: re-runnable, each statement guarded.
-- ROLLBACK: UPDATE marketing_cost_rules SET effective_to = NULL, label = 'Previous Customer / Referral 1% of net'
--   WHERE id = 'a1a1a1a1-0001-4000-8000-000000000003'; then recomputeCalculatedCosts(month) per month
--   (it sets the superseded rows back to approved and re-allocates them).

UPDATE marketing_cost_rules
   SET effective_to = DATE '2025-12-31',
       label = 'Previous Customer / Referral (retired 2026-10-23: no cost)'
 WHERE id = 'a1a1a1a1-0001-4000-8000-000000000003'
   AND effective_to IS DISTINCT FROM DATE '2025-12-31';

DELETE FROM marketing_expense_allocations a
 USING marketing_expenses e
 WHERE a.expense_id = e.id
   AND e.source_system = 'commission_rule'
   AND e.source_ref LIKE 'a1a1a1a1-0001-4000-8000-000000000003|%';

UPDATE marketing_expenses
   SET status = 'superseded', updated_at = now()
 WHERE source_system = 'commission_rule'
   AND source_ref LIKE 'a1a1a1a1-0001-4000-8000-000000000003|%'
   AND status <> 'superseded';

UPDATE marketing_vendors
   SET notes = 'No cost since 2026-10-23 (the user: leave blank, no fixed percentage). Was 1% of net (D2).', updated_at = now()
 WHERE vendor_name = 'Previous Customer / Referral (commission)'
   AND notes IS DISTINCT FROM 'No cost since 2026-10-23 (the user: leave blank, no fixed percentage). Was 1% of net (D2).';
