-- ═══════════════════════════════════════════════════════════════════
-- Canvass confirmation intake idempotency marks — 2026-08-26
--
-- 24h dedup guard for POST /webhooks/canvass-confirmation — the Lightfire
-- confirmation form (workflow 20eeb054-f9a5-44fc-b74f-7c41141e5c9c), which
-- serves BOTH its branches through the one endpoint. One row per GHL contact;
-- the handler pre-checks on entry and upserts on process start / completion.
--
-- Mirrors canvassing_intake_marks (sql/052 and
-- 2026-07-15_canvassing_intake_marks.sql), minus every column that only means
-- something when a lead was created: no in1_id, no appt_date/appt_time, no
-- flagged_beyond_window. NOTHING on this path ever reaches Lead Perfection —
-- a submission is an unverified intake record, and LP creation happens later,
-- in a separate workflow, after a confirmation agent reviews it in P4. So
-- there is no inbound-queue id to record and no booking decision to flag; the
-- appointment as submitted lives on the canvass.confirmation_submitted event.
--
-- lp_prospect_id and lead_in_lp take their place. Both are nullable and
-- lead_in_lp is the normalized boolean rather than the form's option text
-- (which is a label someone will reword) — together they make "which branch
-- did this submission come in on, and did it carry the prospect it claimed"
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
--   blocked    — accepted at the door but skipped: the submission said the
--                homeowner is already in LP and carried no Prospect ID. The
--                operator fixes the contact in GHL and re-fires, so the
--                handler's pre-check deliberately does NOT treat this status
--                as a duplicate — otherwise that re-fire would be swallowed
--                for 24 hours and the fix would appear to do nothing. The row
--                is kept so blocks stay queryable.
-- No CHECK constraint on status — same as the live canvassing table, so a new
-- status value ships with the code rather than needing DDL first.
--
-- Fail-open on every access: a missing table degrades to double-processing,
-- never to a dropped submission. Do not rely on that — APPLY THIS BEFORE the
-- Railway deploy that ships the handler.
--
-- SAFE TO RUN TWICE, AND IT MAY NEED TO BE. An earlier revision of this file
-- shipped in PR #768 WITHOUT lead_in_lp. If that version was already applied,
-- the CREATE below is a no-op and would leave the column missing — the handler
-- selects lead_in_lp on its duplicate pre-check, and a select naming a column
-- that does not exist errors, which every marks path treats as fail-open. The
-- result would be 24h idempotency silently disabled: exactly the failure mode
-- canvassing_intake_marks had. Hence the explicit ADD COLUMN IF NOT EXISTS,
-- which is a no-op on a fresh table and the whole point on an existing one.
--
-- DDL runs in the Supabase dashboard SQL editor, not through MCP.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS canvass_confirmation_marks (
  dedup_key       text        NOT NULL PRIMARY KEY,  -- ghl_contact_id
  ghl_contact_id  text,
  lp_prospect_id  text,                              -- existing-prospect branch only
  lead_in_lp      boolean,                           -- normalized branch answer
  phone           text,
  status          text        NOT NULL DEFAULT 'processing',
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Brings a table created by the PR #768 revision of this file up to date.
ALTER TABLE canvass_confirmation_marks
  ADD COLUMN IF NOT EXISTS lead_in_lp boolean;

CREATE INDEX IF NOT EXISTS idx_canvass_confirmation_marks_created
  ON canvass_confirmation_marks (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_canvass_confirmation_marks_prospect
  ON canvass_confirmation_marks (lp_prospect_id, created_at DESC);

COMMENT ON TABLE canvass_confirmation_marks IS
  '24h idempotency marks for POST /webhooks/canvass-confirmation (Lightfire confirmation form, both branches). Separate from canvassing_intake_marks on purpose — a canvass and a confirmation for the same contact inside 24h are two legitimate submissions on two routes. Record-only path: nothing here ever reaches Lead Perfection, on either branch. Fail-open; see src/canvass-confirmation-handler.js.';
