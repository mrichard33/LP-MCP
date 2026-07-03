-- =============================================================================
-- 2026-07-03_agentic_reply_locks.sql
--
-- Enforcing per-CONTACT single-flight for agentic replies (Steve Nkzhm
-- incident, 2026-07-03: 12 automated SMS in 8 minutes).
--
-- Complements — does NOT replace — outbound_locks:
--   outbound_locks        : one send per (contact_id, trigger_id). Two sends
--                           with DIFFERENT trigger_ids (e.g. solo analysis +
--                           combined buffer flush of the same inbound) both
--                           pass it. That was the incident's failure mode.
--   agentic_reply_locks   : at most ONE agentic reply in flight per contact,
--                           a cooldown between sends, and supersede semantics
--                           (a newer inbound cancels an older UNSENT job).
--
-- Supersede never touches a job whose status is 'sent' — a delivered SMS
-- cannot be recalled (preempt-and-resend was tried and reverted; see
-- src/services/outbound-locks.js header).
--
-- Application module: src/services/agentic-reply-locks.js
-- TTL / cooldown are enforced application-side at acquire time
-- (LOCK_TTL_SEC, default 120; MIN_AGENTIC_SEND_GAP_SEC, default 90).
-- =============================================================================

CREATE TABLE IF NOT EXISTS agentic_reply_locks (
  contact_id     text PRIMARY KEY,
  job_id         text NOT NULL,
  status         text NOT NULL DEFAULT 'in_flight'
                 CHECK (status IN ('in_flight', 'sent')),
  holder         text,
  trigger_id     text,
  superseded_by  text,
  locked_at      timestamptz NOT NULL DEFAULT now(),
  cooldown_until timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agentic_reply_locks_cooldown
  ON agentic_reply_locks (cooldown_until)
  WHERE cooldown_until IS NOT NULL;

COMMENT ON TABLE agentic_reply_locks IS
  'Per-contact single-flight slot for agentic replies. One row per contact: in_flight while a reply is being generated/sent, sent (+cooldown_until) after a successful send. A newer job supersedes an unsent in_flight holder by setting superseded_by; the superseded job aborts before its GHL POST.';
COMMENT ON COLUMN agentic_reply_locks.job_id IS
  'Current slot holder — agent_actions.id as text, or a synthetic id.';
COMMENT ON COLUMN agentic_reply_locks.superseded_by IS
  'job_id of the newer job that superseded the current in_flight holder. The holder checks this immediately before its GHL POST and aborts if set. Only ever set while status=in_flight (unsent).';
COMMENT ON COLUMN agentic_reply_locks.cooldown_until IS
  'No further agentic send to this contact until this instant (now()+MIN_AGENTIC_SEND_GAP_SEC, set on successful send).';
