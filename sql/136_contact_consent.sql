-- ════════════════════════════════════════════════════════════════════
-- sql/136 — contact_consent: one consent record per contact (2026-09-28)
--
-- Run in the Supabase dashboard SQL editor, LP MCP instance, BEFORE the
-- consent-model code deploys (Part 1, execution 1 of 5). Additive only.
-- Mirrored in src/admin/startup-mirrors.js so a fresh deploy self-heals.
--
-- WHY
--   Opt-outs lived only as scattered GHL tags (dnc, dnc-sms, dnc-voice,
--   lp-dnc, stage:dnc, stop-bot), GHL DND flags, LP DNC codes (T/C) and the
--   Five9 DNC list. Nobody could see WHY a lead was blocked or WHICH channel.
--   This row is the source of truth; consent_events (sql/137) is its audit.
--
-- CHANNELS
--   phone_consent covers texts AND automated calls together. They are paired
--   on purpose: FCC 24-24 para. 32 attaches a revocation to the NUMBER, not
--   the medium. CONSENT_SPLIT_SMS_CALL (default false) is the one switch that
--   could split them later, after counsel signs off; nothing reads it yet.
--   email_consent is separate: the TCPA does not govern email.
--
--   sms_carrier_stop is the lead's own texted STOP. A Slack-approved lift
--   never clears it — only START/UNSTOP or a new form with SMS consent does.
--
-- WRITES go through record_consent_change() (sql/139), which updates this
-- row and inserts the consent_events row in one transaction.
--
-- CONSENT_MODEL_MODE=shadow (default): rows are written, nothing reads them
-- to gate a send. Mark flips that separately.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS contact_consent (
  ghl_contact_id      text PRIMARY KEY,
  lp_lead_id          text,
  lp_prospect_id      text,
  phone_consent       text NOT NULL DEFAULT 'unknown'
                        CHECK (phone_consent IN ('granted','revoked','unknown')),
  email_consent       text NOT NULL DEFAULT 'unknown'
                        CHECK (email_consent IN ('granted','revoked','unknown')),
  sms_carrier_stop    boolean NOT NULL DEFAULT false,
  dnc_full            boolean NOT NULL DEFAULT false,
  last_reason         text,
  last_source         text,          -- sms_stop | voice_request | email_unsub | lp_dnc | auto_lift | slack_lift | slack_review | backfill
  last_changed_by     text,          -- 'system' or the Slack approver
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE contact_consent ENABLE ROW LEVEL SECURITY;
