-- Agentic Appointment Notifications — Audit Log
--
-- One row per appointment-notification request to
-- POST /api/agentic/notifications/appointment. Inserted on EVERY path
-- (success + error), per spec §8 of the build doc
-- (claude/agentic-appointment-notifications-o9d7A).
--
-- A row is written whether or not GroupMe posted, whether or not GHL
-- wrote back, and whether or not the team_notification_ready gate
-- actually flipped. The endpoint contract guarantees the gate ONLY
-- flips on a path that results in error=null + groupme_posted_at +
-- ghl_writeback_at all populated.
--
-- Run once in Supabase SQL editor or via the LP MCP
-- supabase_run_query tool. Safe to re-run (CREATE TABLE IF NOT EXISTS,
-- CREATE INDEX IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS lp_agentic_notifications (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id        TEXT UNIQUE NOT NULL,
  contact_id             TEXT NOT NULL,
  status                 TEXT NOT NULL,
  calendar_id            TEXT,
  appointment_title      TEXT,
  lp_source              TEXT,
  lp_subsource           TEXT,
  body                   TEXT,
  groupme_posted_at      TIMESTAMPTZ,
  ghl_writeback_at       TIMESTAMPTZ,
  model_used             TEXT,
  data_gaps              JSONB,
  error                  TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lp_agentic_notifications_contact
  ON lp_agentic_notifications(contact_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lp_agentic_notifications_status
  ON lp_agentic_notifications(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lp_agentic_notifications_calendar
  ON lp_agentic_notifications(calendar_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lp_agentic_notifications_errors
  ON lp_agentic_notifications(created_at DESC) WHERE error IS NOT NULL;

COMMENT ON TABLE lp_agentic_notifications IS
  'Audit log for the agentic appointment notification endpoint. One row per call to /api/agentic/notifications/appointment. groupme_posted_at + ghl_writeback_at + error=null means the team_notification_ready gate flipped successfully; any combination of nulls indicates which step failed.';
