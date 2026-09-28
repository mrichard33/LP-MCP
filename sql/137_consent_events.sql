-- ════════════════════════════════════════════════════════════════════
-- sql/137 — consent_events: the audit trail behind contact_consent (2026-09-28)
--
-- Run in the Supabase dashboard SQL editor, LP MCP instance, AFTER sql/136
-- (Part 1, execution 2 of 5). Additive only. Mirrored in
-- src/admin/startup-mirrors.js (with a plain index; the CONCURRENTLY form for
-- the live table is sql/138, which must be its own execution).
--
-- One row per change, never updated or deleted. `actor` is 'system' for a
-- rule-driven change and the Slack approver for a manual lift or a
-- keep-blocked decision, so "who lifted this lead?" always has an answer.
-- `evidence` carries what the decision rested on (Slack ts, request id, the
-- tags that blocked the lead, the triggering event).
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS consent_events (
  id              bigserial PRIMARY KEY,
  ghl_contact_id  text NOT NULL,
  channel         text NOT NULL CHECK (channel IN ('phone','email','all')),
  change          text NOT NULL CHECK (change IN ('revoked','granted','dnc_full_on','dnc_full_off','carrier_stop_on','carrier_stop_off')),
  source          text NOT NULL,
  reason          text,
  actor           text NOT NULL,
  evidence        jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE consent_events ENABLE ROW LEVEL SECURITY;
