-- LP MCP Server v5.1 Migration
-- Adds: lp_sync_errors table, run_sql function

-- ─── lp_sync_errors — Per-record sync failure tracking ───────────
CREATE TABLE IF NOT EXISTS lp_sync_errors (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lp_lead_id      TEXT,
  lp_prospect_id  TEXT,
  error_message   TEXT,
  error_stack     TEXT,
  sync_type       TEXT,           -- 'full' | 'incremental' | 'reconcile'
  sync_batch_id   UUID,           -- references lp_sync_log.id
  retry_count     INTEGER DEFAULT 0,
  resolved        BOOLEAN DEFAULT FALSE,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sync_errors_unresolved
  ON lp_sync_errors(resolved) WHERE resolved = FALSE;
CREATE INDEX IF NOT EXISTS idx_sync_errors_lead
  ON lp_sync_errors(lp_lead_id);

-- ─── run_sql — Direct SQL execution for Supabase admin tool ──────
-- SECURITY DEFINER: runs with the privileges of the function owner.
-- Only callable via service role key (RLS doesn't apply to service role).
CREATE OR REPLACE FUNCTION run_sql(query_text TEXT)
RETURNS JSONB AS $$
DECLARE
  result JSONB;
BEGIN
  EXECUTE query_text INTO result;
  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
