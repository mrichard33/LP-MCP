-- ═══════════════════════════════════════════════════════════════════
-- Affiliate lead intake idempotency marks — 2026-08-07
--
-- 24h dedup guard for POST /webhooks/affiliate-lead. One row per GHL
-- contact; the handler pre-checks on entry and upserts on process start /
-- completion.
--
-- Mirrors canvassing_intake_marks AS IT EXISTS LIVE (verified 2026-08-07 —
-- note the live table has ghl_contact_id NULLABLE, unlike what
-- 2026-07-15_canvassing_intake_marks.sql declares, and carries no CHECK on
-- status). Same fail-open marks pattern per
-- src/services/appointment-sync-claim.js, plus affiliate_code so per-affiliate
-- volume and failure rates are queryable without joining out.
--
-- Deliberately a SEPARATE table: sharing canvassing_intake_marks would make a
-- homeowner who was canvassed and then submitted by an affiliate inside 24h
-- look like a duplicate, and the second lead would be silently dropped.
--
-- APPLY BEFORE the Railway deploy that ships the handler. The handler is
-- fail-open on DB errors, so a missing table degrades to double-processing
-- rather than lead loss — but do not rely on that.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS affiliate_intake_marks (
  dedup_key             text        NOT NULL PRIMARY KEY,  -- ghl_contact_id
  ghl_contact_id        text,
  affiliate_code        text,                              -- registry key, e.g. 'lead-pilot'
  phone                 text,
  in1_id                text,                              -- LP inbound-QUEUE id (NOT lds_id)
  appt_date             text,                              -- MM/DD/YYYY as sent to LP
  appt_time             text,                              -- canonical slot, e.g. '2:00 PM'
  flagged_beyond_window boolean     NOT NULL DEFAULT false,
  status                text        NOT NULL DEFAULT 'processing',
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_affiliate_intake_marks_created
  ON affiliate_intake_marks (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_affiliate_intake_marks_affiliate
  ON affiliate_intake_marks (affiliate_code, created_at DESC);

COMMENT ON TABLE affiliate_intake_marks IS
  '24h idempotency marks for POST /webhooks/affiliate-lead. Separate from canvassing_intake_marks on purpose — a shared table would drop an affiliate lead for a homeowner canvassed within 24h. Fail-open; see src/affiliate-lead-handler.js.';
