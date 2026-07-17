-- ═══════════════════════════════════════════════════════════════════
-- Canvassing intake idempotency marks — 2026-07-15
--
-- 24h dedup guard for POST /webhooks/canvassing-lead (Canvassing Pilot
-- v2). One row per GHL contact; the handler pre-checks on entry and
-- upserts on process start / completion. Fail-open by design — a DB
-- error must never block a lead (see src/canvassing-lead-handler.js).
--
-- Follows the marks pattern of lp_appointment_sync_marks.
-- APPLY BEFORE the Railway deploy that ships the handler.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS canvassing_intake_marks (
  dedup_key             text PRIMARY KEY,           -- ghl_contact_id
  ghl_contact_id        text NOT NULL,
  phone                 text,
  in1_id                text,                        -- LP inbound-queue id (NOT lds_id)
  appt_date             text,                        -- MM/DD/YYYY as sent to LP
  appt_time             text,                        -- canonical slot, e.g. '2:00 PM'
  status                text NOT NULL DEFAULT 'processing'
                        CHECK (status IN ('processing', 'lp_created', 'lp_failed')),
  flagged_beyond_window boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canvassing_intake_marks_created_at
  ON canvassing_intake_marks (created_at);

COMMENT ON TABLE canvassing_intake_marks IS
  '24h idempotency marks for POST /webhooks/canvassing-lead (Canvassing Pilot v2). Fail-open; see src/canvassing-lead-handler.js.';
