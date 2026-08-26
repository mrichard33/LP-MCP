-- ═══════════════════════════════════════════════════════════════════
-- Canvass confirmation intake idempotency marks — 2026-08-26
--
-- 24h dedup guard for POST /webhooks/canvass-confirmation — the Lightfire
-- confirmation form's EXISTING-PROSPECT branch. One row per GHL contact; the
-- handler pre-checks on entry and upserts on process start / completion.
--
-- Mirrors canvassing_intake_marks (sql/052 and
-- 2026-07-15_canvassing_intake_marks.sql), minus every column that only means
-- something when a lead was created: no in1_id, no appt_date/appt_time, no
-- flagged_beyond_window. This path never writes to Lead Perfection, so there
-- is no inbound-queue id to record and no booking decision to flag; the
-- appointment as submitted lives on the canvass.confirmation_submitted event.
-- lp_prospect_id takes their place — it is the defining fact of this branch,
-- and having it here makes "which confirmations landed for this prospect"
-- answerable without joining out to system_events.
--
-- Deliberately a SEPARATE table from canvassing_intake_marks: a homeowner
-- canvassed and then confirmed by Lightfire inside 24h is TWO legitimate
-- submissions on two different routes, and a shared dedup key would silently
-- drop the second. Same reasoning as affiliate_intake_marks (2026-08-07).
--
-- status values written by src/canvass-confirmation-handler.js:
--   processing — mark claimed, pipeline running
--   recorded   — event emitted, note attempted, card sent
--   failed     — the pipeline threw before recording anything. Deliberately
--                NOT treated as a duplicate by the handler's pre-check: there
--                is no event and no note to be duplicate WITH, so a re-fire
--                must be able to get in. The row is kept so the failure stays
--                queryable.
-- No CHECK constraint on status — same as the live canvassing table, so a new
-- status value ships with the code rather than needing DDL first.
--
-- Fail-open on every access: a missing table degrades to double-processing,
-- never to a dropped confirmation. Do not rely on that — APPLY THIS BEFORE the
-- Railway deploy that ships the handler.
--
-- DDL runs in the Supabase dashboard SQL editor, not through MCP.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS canvass_confirmation_marks (
  dedup_key       text        NOT NULL PRIMARY KEY,  -- ghl_contact_id
  ghl_contact_id  text,
  lp_prospect_id  text,                              -- the prospect being confirmed
  phone           text,
  status          text        NOT NULL DEFAULT 'processing',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canvass_confirmation_marks_created
  ON canvass_confirmation_marks (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_canvass_confirmation_marks_prospect
  ON canvass_confirmation_marks (lp_prospect_id, created_at DESC);

COMMENT ON TABLE canvass_confirmation_marks IS
  '24h idempotency marks for POST /webhooks/canvass-confirmation (Lightfire confirmation form, existing-prospect branch). Separate from canvassing_intake_marks on purpose — a canvass and a confirmation for the same contact inside 24h are two legitimate submissions on two routes. Record-only path: nothing here ever reaches Lead Perfection. Fail-open; see src/canvass-confirmation-handler.js.';
