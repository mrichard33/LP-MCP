-- 145_revoke_run_sql_public.sql
--
-- 2026-10-03 (security review) — APPLIED LIVE on 2026-10-03 to the LP project
-- (rcjcgjlqzepicbwhnnjl) and the HL project (jtlngmcrtqncimtjjzlz). This file is
-- the record, so a rebuilt database gets the same grants.
--
-- run_sql is SECURITY DEFINER and executes any text it is given. Postgres grants
-- EXECUTE to PUBLIC by default and Supabase adds anon + authenticated, so the
-- Security Advisor flagged it as callable at /rest/v1/rpc/run_sql with the public
-- anon key — which ships in the dashboard's browser bundle. That was full
-- read/write/delete on this database for anyone who opened the page source.
--
-- Every legitimate caller (LP-MCP, HL-MCP, scripts) uses the service-role key,
-- so only service_role keeps EXECUTE. Verified after applying:
--   has_function_privilege('anon', 'public.run_sql(text)', 'execute')          = false
--   has_function_privilege('authenticated', 'public.run_sql(text)', 'execute') = false
--   has_function_privilege('service_role', 'public.run_sql(text)', 'execute')  = true
-- and supabase_run_query "select 1" still answered through both MCP servers.

GRANT EXECUTE ON FUNCTION public.run_sql(text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.run_sql(text) FROM PUBLIC, anon, authenticated;
