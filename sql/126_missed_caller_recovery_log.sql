-- 126_missed_caller_recovery_log.sql
-- Audit + idempotency record for src/jobs/missed-caller-recovery.js (2026-09-24).
--
-- WHY. v_unmatched_inbound_callers_30d (sql/125) showed 257 Google PPC Windows
-- callers in 30 days with no LP record, most of them Hung Up / Sent To
-- Voicemail / Abandon — paid leads that received zero follow-up. The recovery
-- job queues them to the Five9 "Callback Request" list (never to LP), and this
-- table is how it knows it already has.
--
-- THE UNIQUE KEY IS THE IDEMPOTENCY GUARD, NOT JUST AN INDEX. The job claims a
-- (caller, campaign, last_call_at) row with ON CONFLICT DO NOTHING BEFORE it
-- queues a dial, and queues only when the claim returned a row. Two passes, or
-- two containers overlapping across a deploy, therefore cannot push the same
-- call twice. A caller who rings again gets a new last_call_at and a new key;
-- the job's 72-hour per-caller cooldown handles that case.
--
-- A key logged in shadow mode (would_push) is never re-pushed after the flip
-- to live — only calls that arrive after the flip are queued. That is
-- deliberate: going live must not dump a 72-hour backlog on the floor at once.
--
-- mode:   'shadow' | 'live'
-- action: 'would_push' | 'pushed' | 'skipped_dnc' | 'skipped_ineligible' | 'alert_appt_no_lp'
--
-- APPLY FROM THE DASHBOARD, LP instance, as ONE execution. Mirrored in
-- runMigrations() (src/index.js) so a fresh deploy self-heals.

CREATE TABLE IF NOT EXISTS missed_caller_recovery_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_phone text NOT NULL,
  campaign text NOT NULL,
  last_call_at timestamptz NOT NULL,
  last_disposition text,
  mode text NOT NULL,              -- 'shadow' | 'live'
  action text NOT NULL,            -- 'would_push' | 'pushed' | 'skipped_dnc' | 'skipped_ineligible' | 'alert_appt_no_lp'
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (caller_phone, campaign, last_call_at)
);
