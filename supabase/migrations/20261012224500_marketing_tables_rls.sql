-- 20261012224500_marketing_tables_rls (2026-10-12)
--
-- WHAT: row level security on the six marketing-cost tables, no policies
-- (service role only, like every system table here).
--
-- WHY: the live database already has RLS on for all six (checked 2026-10-12:
-- relrowsecurity = true, 0 policies), but 20261012222106_158_marketing_cost_ledger
-- never switches it on. Probably the project's automatic RLS-on-create, since that
-- file was applied by hand. The drift check on PR #1270 rebuilt the folder into a
-- shadow database and reported these six tables as the difference. This file
-- makes the folder match live. On production it is a no-op.
--
-- ROLLBACK: ALTER TABLE public.<table> DISABLE ROW LEVEL SECURITY; (not advised:
-- anon and authenticated hold SELECT grants on these tables, so RLS is what keeps
-- them closed).

ALTER TABLE public.marketing_cost_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_expense_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_invoice_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_territory_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_vendors ENABLE ROW LEVEL SECURITY;
