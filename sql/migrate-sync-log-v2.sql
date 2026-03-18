-- Migrate lp_sync_log to per-entity-type schema
-- Safe to run multiple times

-- Drop the old table if it exists (old monolithic schema)
DROP TABLE IF EXISTS lp_sync_log;

-- Create new per-entity sync log
CREATE TABLE IF NOT EXISTS lp_sync_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type     TEXT NOT NULL,
  sync_type       TEXT NOT NULL DEFAULT 'full',
  status          TEXT NOT NULL DEFAULT 'running',
  records_synced  INTEGER DEFAULT 0,
  error_message   TEXT,
  started_at      TIMESTAMPTZ DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sync_log_entity ON lp_sync_log(entity_type);
CREATE INDEX IF NOT EXISTS idx_sync_log_status ON lp_sync_log(status);
