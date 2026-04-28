-- ─── sql/016_lp_sync_errors.sql ─────────────────────────────────────
-- 
-- Per-record sync error tracking for LP → Supabase ingestion.
--
-- Background: src/sync-log.js logSyncError() has been calling
-- supabase.from('lp_sync_errors').insert(...) since at least v6.0,
-- but the table was never created. The insert silently failed every
-- time (caught by the inner try/catch and only echoed to console).
-- Result: when processProspect throws on a record, we see the error
-- in Railway logs but can't query "show me everything that failed
-- in the last 24h" — making sync drift hard to diagnose at scale.
--
-- This migration creates the table to match the columns logSyncError
-- already inserts, plus a few useful query helpers.
--
-- Schema mirrors src/sync-log.js logSyncError():
--   lp_lead_id      → entityId from caller (often cst_id, sometimes lds_id)
--   lp_prospect_id  → null for now; future enhancement
--   error_message   → err.message  
--   error_stack     → err.stack
--   sync_type       → 'full' | 'incremental' | 'webhook_*' | null
--   retry_count     → 0 (incremented manually if record is retried)
--   resolved        → false until a sync succeeds for this entity
--
-- Useful queries this enables:
--   - Recent unresolved errors:
--       SELECT * FROM lp_sync_errors WHERE resolved = false
--       ORDER BY created_at DESC LIMIT 50;
--   - Most common error patterns:
--       SELECT split_part(error_message, ':', 1) AS family, count(*)
--       FROM lp_sync_errors WHERE created_at > now() - interval '7 days'
--       GROUP BY 1 ORDER BY 2 DESC;
--   - Stuck retries:
--       SELECT * FROM lp_sync_errors
--       WHERE resolved = false AND retry_count >= 3 ORDER BY retry_count DESC;
--
-- Apply via Supabase SQL editor (DDL — not via lp_run_query).

-- ─── Table ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lp_sync_errors (
  id              BIGSERIAL PRIMARY KEY,
  lp_lead_id      TEXT,
  lp_prospect_id  TEXT,
  error_message   TEXT NOT NULL,
  error_stack     TEXT,
  sync_type       TEXT,
  retry_count     INTEGER NOT NULL DEFAULT 0,
  resolved        BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at     TIMESTAMPTZ,
  resolved_note   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Indexes ────────────────────────────────────────────────────────
-- Optimize for the three queries we care about:
--   1. "What's broken right now?" → unresolved + recent
--   2. "What happened to lead X?" → by lp_lead_id
--   3. "What's been failing repeatedly?" → unresolved + high retry_count

CREATE INDEX IF NOT EXISTS idx_lp_sync_errors_unresolved_recent
  ON lp_sync_errors (resolved, created_at DESC)
  WHERE resolved = false;

CREATE INDEX IF NOT EXISTS idx_lp_sync_errors_lp_lead_id
  ON lp_sync_errors (lp_lead_id, created_at DESC)
  WHERE lp_lead_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lp_sync_errors_retry_count
  ON lp_sync_errors (retry_count DESC, created_at DESC)
  WHERE resolved = false AND retry_count > 0;

CREATE INDEX IF NOT EXISTS idx_lp_sync_errors_sync_type_recent
  ON lp_sync_errors (sync_type, created_at DESC)
  WHERE sync_type IS NOT NULL;

-- ─── Auto-resolve helper ────────────────────────────────────────────
-- When the next successful incremental sync touches a lead that previously
-- errored, we want its error rows marked resolved automatically. This
-- function is called from sync-leads.js processProspect on success.
-- (Wiring in code is a separate commit; safe no-op if unused.)

CREATE OR REPLACE FUNCTION mark_lp_sync_errors_resolved(p_lp_lead_id TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE lp_sync_errors
     SET resolved    = TRUE,
         resolved_at = now(),
         resolved_note = COALESCE(resolved_note, 'auto-resolved on successful sync')
   WHERE lp_lead_id = p_lp_lead_id
     AND resolved   = FALSE;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ─── Comment for inline schema docs ─────────────────────────────────
COMMENT ON TABLE lp_sync_errors IS
  'Per-record sync errors from LP → Supabase ingestion. Written by '
  'src/sync-log.js logSyncError(). Created by sql/016 (2026-04-28) '
  'after discovering this table was referenced but never created — '
  'silently swallowing processProspect failures for the entire history '
  'of the agentic system.';

COMMENT ON COLUMN lp_sync_errors.lp_lead_id IS
  'LP entity ID — typically cst_id (prospect ID) but may also be lds_id '
  '(lead ID). Stored as TEXT to accommodate either.';

COMMENT ON COLUMN lp_sync_errors.sync_type IS
  'Sync run type: ''full'', ''incremental'', ''webhook_*'', or NULL when '
  'the calling context is unknown (e.g. webhook handler errors).';

COMMENT ON COLUMN lp_sync_errors.retry_count IS
  'Manual retry counter — incremented when a sweep job re-attempts the '
  'failed record. Records with retry_count >= 3 should be human-reviewed.';
