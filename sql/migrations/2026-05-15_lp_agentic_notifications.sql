-- Agentic Appointment Notifications — Audit Log
--
-- One row per appointment-notification request to
-- POST /api/agentic/notifications/appointment. Inserted on EVERY path
-- (success + error).
--
-- Delivery model: LP-MCP writes the generated email_body + sms_body to
-- four custom fields on the GHL contact (team_notification_body,
-- team_notification_sms, team_notification_id) and then flips
-- team_notification_ready = "Yes" as the atomic gate. The GHL
-- workflow's wait-for-condition step picks that up and runs its
-- existing internal_notification (email + SMS) steps, which use
-- {{contact.team_notification_body}} and
-- {{contact.team_notification_sms}} as their merge tags. LP-MCP never
-- posts to GroupMe; that's a separate pipeline.
--
-- A row is written whether or not the GHL writeback succeeded. The
-- endpoint contract guarantees the gate ONLY flips on a path that
-- results in error=null + ghl_writeback_at populated.
--
-- Run once in Supabase SQL editor or via the LP MCP
-- supabase_run_query tool. Safe to re-run (CREATE TABLE IF NOT
-- EXISTS, CREATE INDEX IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS lp_agentic_notifications (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id        TEXT UNIQUE NOT NULL,
  contact_id             TEXT NOT NULL,
  status                 TEXT NOT NULL,
  calendar_id            TEXT,
  appointment_title      TEXT,
  lp_source              TEXT,
  lp_subsource           TEXT,
  email_body             TEXT,
  sms_body               TEXT,
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
  'Audit log for the agentic appointment notification endpoint. One row per call to /api/agentic/notifications/appointment. ghl_writeback_at populated + error=null means the team_notification_ready gate flipped successfully and the GHL workflow''s native internal_notification email + SMS steps will fire on the next tick. error populated indicates which step failed (context_load, body_generation, ghl_writeback).';
