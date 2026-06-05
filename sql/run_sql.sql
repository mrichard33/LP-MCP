-- ─────────────────────────────────────────────────────────────────
-- public.run_sql(query_text text) RETURNS jsonb
-- ─────────────────────────────────────────────────────────────────
-- Canonical definition of the SQL execution RPC used by the LP MCP
-- supabase_run_query tool (src/admin/supabase-admin.js -> runSQL).
--
-- This file is the source of truth. Apply via the Supabase SQL Editor
-- or psql; it CANNOT be applied through the MCP tool itself, because
-- the tool routes all SQL through this same function and a
-- CREATE OR REPLACE returns no rows for the old INTO-based body.
--
-- History / root cause:
--   The original body was:
--       DECLARE result JSONB;
--       BEGIN EXECUTE query_text INTO result; RETURN result; END;
--   `EXECUTE ... INTO result` captures only the FIRST COLUMN of the
--   FIRST ROW and coerces that scalar to jsonb. Consequences:
--     1. Any non-JSON scalar (text/uuid/timestamp) threw
--        "invalid input syntax for type json".
--     2. Silent data loss — all other columns/rows discarded.
--        (COUNT(*) appeared to "work" only because a bare number is
--         valid JSON.)
--
-- Fix:
--   - SELECT / WITH queries are wrapped and aggregated with
--     jsonb_agg(row_to_json(sub)) so every column and row round-trips,
--     JSON/JSONB columns included. Empty results return '[]'.
--   - A single trailing semicolon + whitespace is stripped so the
--     query nests cleanly inside the subselect wrapper.
--   - Non-SELECT statements (INSERT/UPDATE/DELETE/CREATE/ALTER) run
--     unchanged via the original text and return a status object, so
--     the tool keeps its full read/write capability.
--
-- Behavior change to be aware of:
--   SELECT results now return as an array of row objects, e.g.
--   `[{"count": 42}]` instead of the old bare `42`. Any caller that
--   parsed run_sql output as a bare scalar should be updated.
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.run_sql(query_text text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  result JSONB;
  cleaned TEXT := regexp_replace(query_text, '^\s+', '');
BEGIN
  -- strip a single trailing semicolon + whitespace so it nests cleanly
  cleaned := regexp_replace(cleaned, ';\s*$', '');

  IF cleaned ~* '^(SELECT|WITH)\s' THEN
    EXECUTE format('SELECT COALESCE(jsonb_agg(row_to_json(sub)), ''[]''::jsonb) FROM (%s) sub', cleaned)
      INTO result;
    RETURN result;
  ELSE
    -- non-SELECT: run original text unchanged (semicolons fine here)
    EXECUTE query_text;
    RETURN jsonb_build_object('status', 'ok', 'rows_affected', 'n/a');
  END IF;
END;
$function$;
