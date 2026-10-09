-- ============================================================================
-- 154_mcp_readonly_role.sql — A read-only database path for the MCP read tool
-- ============================================================================
-- 2026-10-07 (IT/GoCloud security review of 2026-09-23; AI OS CANON.SEC.007).
--
-- DASHBOARD-APPLIED ONLY. Deliberately NOT a startup mirror: it creates a role
-- and changes grants, which is a decision for a person, not a boot.
-- EXECUTION: Supabase dashboard SQL editor, LP MCP instance. Safe to re-run.
--
-- WHY. supabase_run_query goes through public.run_sql, which is SECURITY
-- DEFINER: it runs as its owner (postgres) whoever calls it, so a filter in
-- code (src/security/sql-guard.js) is the only thing between an MCP client and
-- a write. That filter cannot see inside a user-defined function that writes.
-- This file adds two database-enforced layers:
--
--   1. public.run_sql_readonly(query_text) — SECURITY INVOKER (runs with the
--      CALLER's privileges, not postgres's) and it switches the transaction to
--      READ ONLY before executing, so INSERT/UPDATE/DELETE/DDL, nextval, and a
--      writing function all fail with "cannot execute … in a read-only
--      transaction" — whoever the caller is, service_role included.
--      Usable TODAY with the existing service_role key: set
--      SQL_TOOL_MODE=readonly and SQL_READONLY_RPC=run_sql_readonly.
--
--   2. role mcp_readonly — SELECT on public tables (and future ones), its
--      sessions default to read-only, no EXECUTE on run_sql. Caveat: a role
--      that can read every table can still read every row (phones, emails);
--      RLS-on tables with no policy for it return nothing. Grant narrower if
--      the tool should not see some tables (REVOKE SELECT ON … FROM mcp_readonly).
--
-- SWITCHING THE READ TOOL OFF service_role needs a NEW credential that runs as
-- mcp_readonly. That swap is NOT implemented in code; the steps are in the PR
-- (security/least-privilege-tools): mint a PostgREST JWT with
-- {"role":"mcp_readonly"} signed by the project JWT secret, store it as a new
-- Railway variable, and give the read tool its own Supabase client. The
-- `GRANT mcp_readonly TO authenticator` below is what lets PostgREST switch
-- into the role for such a JWT.
--
-- Verify after applying:
--   SELECT run_sql_readonly('select 1 as ok');                        -- [{"ok":1}]
--   SELECT run_sql_readonly('select nextval(''tool_audit_log_id_seq'')'); -- ERROR read-only
--   SELECT run_sql_readonly('delete from tool_audit_log');           -- ERROR not a read
--   SELECT has_function_privilege('anon', 'public.run_sql_readonly(text)', 'execute'); -- false
--
-- Rollback:
--   DROP FUNCTION IF EXISTS public.run_sql_readonly(text);
--   REVOKE mcp_readonly FROM authenticator;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM mcp_readonly;
--   REVOKE ALL ON ALL TABLES IN SCHEMA public FROM mcp_readonly;
--   REVOKE USAGE ON SCHEMA public FROM mcp_readonly;
--   DROP ROLE IF EXISTS mcp_readonly;
-- ============================================================================

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_readonly') THEN
    CREATE ROLE mcp_readonly NOLOGIN NOINHERIT;
  END IF;
END
$do$;

ALTER ROLE mcp_readonly SET default_transaction_read_only = on;
ALTER ROLE mcp_readonly SET statement_timeout = '30s';

GRANT USAGE ON SCHEMA public TO mcp_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_readonly;
-- Tables created later by the role applying this file (postgres) are readable
-- too. Tables created by another role need their own grant.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO mcp_readonly;

-- Never the definer-rights executor, never the audit trail's sequence.
REVOKE EXECUTE ON FUNCTION public.run_sql(text) FROM mcp_readonly;

-- Lets PostgREST (which logs in as `authenticator`) SET ROLE mcp_readonly for a
-- JWT whose role claim is mcp_readonly. Nothing uses that until the key exists.
GRANT mcp_readonly TO authenticator;

CREATE OR REPLACE FUNCTION public.run_sql_readonly(query_text text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path = public, pg_catalog
AS $function$
DECLARE
  result  jsonb;
  cleaned text := regexp_replace(query_text, '^\s+', '');
BEGIN
  -- From here to the end of the transaction nothing may write. Going TO read
  -- only is allowed mid-transaction (going back is not), so a PostgREST
  -- request cannot undo it, and neither can the query below.
  PERFORM set_config('transaction_read_only', 'on', true);

  cleaned := regexp_replace(cleaned, ';\s*$', '');
  IF cleaned !~* '^(SELECT|WITH)\s' THEN
    RAISE EXCEPTION 'run_sql_readonly: only SELECT / WITH queries are allowed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Same result shape as run_sql (sql/run_sql.sql): an array of row objects.
  EXECUTE format('SELECT COALESCE(jsonb_agg(row_to_json(sub)), ''[]''::jsonb) FROM (%s) sub', cleaned)
    INTO result;
  RETURN result;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.run_sql_readonly(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_sql_readonly(text) TO service_role, mcp_readonly;
