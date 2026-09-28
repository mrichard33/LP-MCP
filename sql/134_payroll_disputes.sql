-- ════════════════════════════════════════════════════════════════════
-- sql/134 — Payroll Phase 2: fewer flags + partner dispute tickets (2026-09-27)
--
-- Run in the Supabase dashboard SQL editor, LP MCP instance, as ONE execution,
-- BEFORE merging the code that ships with it: that code writes status 'info',
-- which the sql/132 CHECK constraint rejects.
--
-- WHY
--   The first dry run (9/14–9/20) flagged 389 of 410 lines. Ruled 2026-09-27:
--   flag only what does not match up.
--     - A canvass confirmation recorded to an LF agent pays straight away
--       (the rule's requires_review goes false — data, not code).
--     - A new-lead demo is a $0 'info' row the partner can see, not a dispute.
--   And the partner gets a ticket to dispute a line (or report a lead the
--   run missed), which Reece approves or denies. payroll_disputes is that
--   ticket; every decision is also written to payroll_audit.
--
-- Additive. Mirrored (the new table only) in src/admin/startup-mirrors.js.
-- ════════════════════════════════════════════════════════════════════

-- 1. 'info' — a line to show, not to pay and not to act on.
ALTER TABLE payroll_ledger DROP CONSTRAINT IF EXISTS payroll_ledger_status_check;
ALTER TABLE payroll_ledger ADD CONSTRAINT payroll_ledger_status_check
  CHECK (status IN ('pending','needs_review','disputed','excluded','info','approved','paid'));

-- 2. LightFire canvass confirmations recorded to an LF agent pay without review.
UPDATE pay_rules r SET requires_review = false,
       note = '$15 per canvass-confirmed appt, paid when LP records an LF agent as the confirmer. No confirmer recorded -> review'
  FROM lf_partners p
 WHERE r.partner_id = p.id AND p.slug = 'lightfire'
   AND r.event_type = 'canvass_confirmed_appt' AND r.requires_review = true;

-- 3. The dispute ticket.
CREATE TABLE IF NOT EXISTS payroll_disputes (
  id bigserial PRIMARY KEY,               -- the ticket number the partner sees
  partner_id uuid NOT NULL REFERENCES lf_partners(id),
  ledger_id uuid REFERENCES payroll_ledger(id),   -- NULL = "a lead the run missed"
  lp_lead_id text NOT NULL,
  event_type text NOT NULL,
  event_date date,
  claimed_amount_cents integer,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','approved','denied')),
  filed_by_email text NOT NULL,
  filed_at timestamptz NOT NULL DEFAULT now(),
  decided_by text,
  decided_at timestamptz,
  decision_note text,
  approved_amount_cents integer,
  applied_run_id uuid REFERENCES payroll_runs(id),  -- set once the approval reaches a run
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payroll_disputes_partner_status_idx ON payroll_disputes (partner_id, status);

-- One open ticket per line: a second click must not file a second ticket.
CREATE UNIQUE INDEX IF NOT EXISTS payroll_disputes_one_open_per_line_idx
  ON payroll_disputes (ledger_id) WHERE status = 'open' AND ledger_id IS NOT NULL;

-- Service role only (the dashboard reads through its service client, scoped
-- server-side to the partner). No policies = no anon or authenticated access.
ALTER TABLE payroll_disputes ENABLE ROW LEVEL SECURITY;

-- Verify:
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'payroll_ledger_status_check';
--   SELECT event_type, requires_review FROM pay_rules ORDER BY event_type;   -- canvass → false
--   SELECT count(*) FROM payroll_disputes;                                   -- 0
