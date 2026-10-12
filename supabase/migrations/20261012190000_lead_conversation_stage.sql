-- lead_conversation_stage + lead_conversation_stage_events (2026-10-12)
--
-- WHAT: where each lead's chatbot conversation stands, on the NEPQ conversation
-- track (connection → … → slot_held → booked, plus side states), one row per
-- contact, and one event row per change. Written by src/services/lead-stage-io.js
-- after every bot turn and on the real booking event (ghl.appointment_booked).
-- Read by GET /admin/lead-stage/:contactId and, once LEAD_STAGE_MODE=live, by the
-- NEPQ planner.
--
-- WHY: three AIOS test batches (~35 conversations) reached zero confirmed
-- bookings because nothing remembered where a conversation was; the planner
-- re-guessed the stage from the thread on every turn.
--
-- WHAT IT IS NOT: not buyer_stage (the analyzer's 5-stage journey, stored here
-- only as tone context), not "Stage Last Engaged" in GHL, and not a transcript.
-- Neither table holds customer free text: stage keys, reason codes, short
-- keywords and the bot's own time labels only.
--
-- The handoff's index used CREATE INDEX CONCURRENTLY; a migration runs inside a
-- transaction, so it is a plain CREATE INDEX on a new, empty table (sql/README.md
-- rule 4).
--
-- RLS on with no policies, like every system table here: service_role only.
--
-- ROLLBACK: DROP TABLE lead_conversation_stage_events; DROP TABLE lead_conversation_stage;
-- (the code reads a missing table as "no stored stage" and keeps answering).

CREATE TABLE IF NOT EXISTS lead_conversation_stage (
  contact_id text PRIMARY KEY,
  track text NOT NULL DEFAULT 'new_lead',
  stage text NOT NULL,
  ghl_label text,
  buyer_stage smallint,
  facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_move text,
  channel text,
  mode text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lead_conversation_stage_events (
  id bigserial PRIMARY KEY,
  contact_id text NOT NULL,
  from_stage text,
  to_stage text NOT NULL,
  reason text NOT NULL,
  channel text,
  mode text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lcse_contact_created_idx
  ON lead_conversation_stage_events (contact_id, created_at DESC);

ALTER TABLE lead_conversation_stage ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_conversation_stage_events ENABLE ROW LEVEL SECURITY;
