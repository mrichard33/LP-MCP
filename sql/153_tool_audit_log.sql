-- ============================================================================
-- 153_tool_audit_log.sql — Append-only audit trail of privileged MCP tool calls
-- ============================================================================
-- 2026-10-07 (IT/GoCloud security review of 2026-09-23; AI OS CANON.SEC.011).
--
-- One row per privileged MCP tool decision, written fire-and-forget by
-- src/security/tool-audit.js (TOOL_AUDIT_LOG_MODE=off is the rollback):
--   supabase_write_query    every call (preview, refusal, execution)
--   set_railway_env_var, redeploy_railway_service,
--   rollback_railway_deployment, http_request
--                           every call (src/security/infra-guard.js)
--   http_request egress     would_deny / deny (src/security/egress-guard.js)
--   supabase_run_query, hl_query
--                           would_deny / deny only (allowed reads are not logged)
--
-- decision: allow | deny | would_deny (would_deny = a shadow-mode flag).
-- detail never carries a secret, an auth header, a request body or an env var
-- VALUE. SQL is stored as sql_sha256 + its first 500 characters, which can hold
-- a phone number in a WHERE clause, so only service_role may read the table.
--
-- APPEND-ONLY: UPDATE, DELETE and TRUNCATE raise, by trigger, for every role
-- (service_role included), and are revoked from anon / authenticated /
-- service_role as well. The table OWNER (postgres) could still disable the
-- trigger; run_sql executes as its owner, which is why the PR also proposes
-- moving the MCP read path off it (sql/154).
--
-- Mirrored in STARTUP_MIRRORS (src/admin/startup-mirrors.js). Safe to re-run.
-- EXECUTION: Supabase dashboard SQL editor, LP MCP instance. One execution.
--
-- Rollback: DROP TABLE IF EXISTS tool_audit_log;
--           DROP FUNCTION IF EXISTS tool_audit_log_refuse_change();
-- (A DROP TABLE is the one way to remove it; the trigger blocks row changes.)
-- ============================================================================

CREATE TABLE IF NOT EXISTS tool_audit_log (
  id        bigserial   PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  tool      text        NOT NULL,
  actor     text        NOT NULL DEFAULT 'unknown',
  mode      text,
  decision  text        NOT NULL CHECK (decision IN ('allow', 'deny', 'would_deny')),
  reason    text,
  detail    jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_tool_audit_log_at
  ON tool_audit_log (at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_audit_log_tool_at
  ON tool_audit_log (tool, at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_audit_log_decision_at
  ON tool_audit_log (decision, at DESC)
  WHERE decision <> 'allow';

CREATE OR REPLACE FUNCTION tool_audit_log_refuse_change()
  RETURNS trigger
  LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'tool_audit_log is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$fn$;

CREATE OR REPLACE TRIGGER trg_tool_audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON tool_audit_log
  FOR EACH ROW EXECUTE FUNCTION tool_audit_log_refuse_change();

CREATE OR REPLACE TRIGGER trg_tool_audit_log_no_truncate
  BEFORE TRUNCATE ON tool_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION tool_audit_log_refuse_change();

-- Reads and inserts only, and only for the server's own key.
ALTER TABLE tool_audit_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON tool_audit_log FROM PUBLIC, anon, authenticated;
REVOKE UPDATE, DELETE, TRUNCATE ON tool_audit_log FROM service_role;
GRANT SELECT, INSERT ON tool_audit_log TO service_role;
GRANT USAGE, SELECT ON SEQUENCE tool_audit_log_id_seq TO service_role;
REVOKE EXECUTE ON FUNCTION tool_audit_log_refuse_change() FROM PUBLIC, anon, authenticated;
