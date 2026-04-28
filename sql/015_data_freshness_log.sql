-- ════════════════════════════════════════════════════════════════════
-- 015_data_freshness_log.sql
-- Logs every freshness check for monitored tables. Used by:
--   - src/admin/data-freshness.js — periodic checks + GroupMe alerts
--   - GET  /n8n/admin/freshness   — current state
--   - POST /n8n/admin/freshness-check — manual trigger
--
-- Apply via Supabase SQL editor (idempotent).
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS data_freshness_log (
  id BIGSERIAL PRIMARY KEY,
  table_name        TEXT NOT NULL,
  latest_timestamp  TIMESTAMPTZ,
  staleness_minutes INTEGER,
  threshold_minutes INTEGER,
  status            TEXT NOT NULL,            -- 'fresh' | 'stale' | 'empty' | 'error'
  severity          TEXT,                      -- 'info' | 'warning' | 'critical'
  alerted_at        TIMESTAMPTZ,               -- when GroupMe alert was fired (NULL = no alert sent)
  error_message     TEXT,
  checked_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_data_freshness_log_table_checked
  ON data_freshness_log(table_name, checked_at DESC);

CREATE INDEX IF NOT EXISTS idx_data_freshness_log_alerted
  ON data_freshness_log(table_name, alerted_at DESC)
  WHERE alerted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_data_freshness_log_stale
  ON data_freshness_log(checked_at DESC)
  WHERE status IN ('stale', 'empty');

COMMENT ON TABLE  data_freshness_log IS 'Per-table freshness check audit + alert dedup state.';
COMMENT ON COLUMN data_freshness_log.alerted_at IS 'NULL until a GroupMe alert is fired for this row. Dedup window honors the most-recent alerted_at per table.';
