-- ════════════════════════════════════════════════════════════════════
-- sql/132 — Payroll Engine, Phase 1 (2026-09-26)
--
-- Run in the Supabase dashboard SQL editor, LP MCP instance, as ONE execution.
-- Additive only: five new tables, one index, a seed. Nothing existing altered.
-- Mirrored (DDL only, not the seed) in src/admin/startup-mirrors.js so a fresh
-- deploy self-heals the tables.
--
-- WHY
--   Payroll ran by hand with no pay-rules table anywhere and no audit trail
--   (Five9 keeps none). This writes the rules down once, and payroll_ledger
--   becomes the record. The engine (src/jobs/payroll-engine.js) never moves
--   money: a person approves every run and a person marks it paid.
--
-- THREE DEPARTURES FROM THE HANDOFF DDL, each deliberate:
--   1. payroll_runs' unique key is NULLS NOT DISTINCT. Call-center runs carry
--      partner_id NULL, and a plain UNIQUE treats every NULL as distinct — the
--      same call-center week could be inserted twice.
--   2. The Direct 1.5% rule seeds lead_age_rule = 'new_only'. Ruled
--      2026-09-26: Direct means an LF agent set a lead that was under 30 days
--      old on its set date; a lead 30+ days old earns the $250 demo instead.
--   3. payroll_ledger_line_key_idx backs the "already paid in an earlier run"
--      check, which looks a line_key up across every run.
--
-- The seeds are guarded by NOT EXISTS so re-running this file is harmless.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pay_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payee_type text NOT NULL CHECK (payee_type IN ('partner','call_center')),
  partner_id uuid REFERENCES lf_partners(id),
  campaign text,                         -- null = all campaigns for this payee
  event_type text NOT NULL,              -- canvass_confirmed_appt | completed_demo | direct_job_net | ...
  amount_cents integer,                  -- flat pay per event
  pct numeric(6,4),                      -- percent pay (0.0150 = 1.5%)
  lead_age_rule text NOT NULL DEFAULT 'any' CHECK (lead_age_rule IN ('any','aged_only','new_only')),
  requires_review boolean NOT NULL DEFAULT false,
  effective_from date NOT NULL,
  effective_to date,
  active boolean NOT NULL DEFAULT true,
  note text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pay_excluded_agents (
  agent_name text PRIMARY KEY,           -- exact LP "Last, First" text
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payee_type text NOT NULL,
  partner_id uuid REFERENCES lf_partners(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  mode text NOT NULL CHECK (mode IN ('shadow','live')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','paid','void')),
  total_cents bigint NOT NULL DEFAULT 0,
  approved_by text, approved_at timestamptz,
  paid_by text, paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (payee_type, partner_id, period_start, period_end, mode)
);

CREATE TABLE IF NOT EXISTS payroll_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES payroll_runs(id),
  line_key text NOT NULL,                -- sha256(payee|lead_id|event_type|event_date) — idempotency
  lp_lead_id text NOT NULL,
  campaign text,
  agent_name text,
  event_type text NOT NULL,
  event_date date NOT NULL,
  lead_created_date date,
  rule_id uuid REFERENCES pay_rules(id),
  amount_cents integer NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('pending','needs_review','disputed','excluded','approved','paid')),
  flag_reason text,
  source_report text NOT NULL DEFAULT '134 Jobs by Milestone Date',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, line_key)
);

CREATE INDEX IF NOT EXISTS payroll_ledger_line_key_idx ON payroll_ledger (line_key);

CREATE TABLE IF NOT EXISTS payroll_audit (
  id bigserial PRIMARY KEY,
  run_id uuid REFERENCES payroll_runs(id),
  ledger_id uuid REFERENCES payroll_ledger(id),
  action text NOT NULL,                  -- created | flagged | approved | disputed | paid | rule_changed | resolved | unmatched_134
  actor text NOT NULL,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- LightFire rules (from the Reece Automation ROI Plan; Direct age rule ruled 2026-09-26)
INSERT INTO pay_rules (payee_type, partner_id, event_type, amount_cents, pct, lead_age_rule, requires_review, effective_from, note, created_by)
SELECT 'partner', p.id, v.event_type, v.amount_cents, v.pct, v.lead_age_rule, v.requires_review, DATE '2026-09-01', v.note, 'mark'
FROM lf_partners p
CROSS JOIN (VALUES
  ('canvass_confirmed_appt', 1500,  NULL::numeric, 'any',       true,
   '$15 per canvass-confirmed appt. Confirmed on LightFire dialer, caller unprovable -> always review'),
  ('completed_demo',         25000, NULL::numeric, 'aged_only', false,
   '$250 per completed demo, aged leads only (30+ days old on set date). New-lead demo = auto-dispute'),
  ('direct_job_net',         NULL,  0.0150,        'new_only',  false,
   '1.5% on Direct (LF-set lead under 30 days old on set date), paid when the job nets')
) AS v(event_type, amount_cents, pct, lead_age_rule, requires_review, note)
WHERE p.slug = 'lightfire'
  AND NOT EXISTS (
    SELECT 1 FROM pay_rules r
     WHERE r.partner_id = p.id AND r.event_type = v.event_type AND r.effective_from = DATE '2026-09-01'
  );

INSERT INTO pay_excluded_agents (agent_name, reason) VALUES
  ('Agent, Revin',   'AI setter — never partner-payable'),
  ('Agent, Agentic', 'AI setter — never partner-payable')
ON CONFLICT DO NOTHING;

-- Verify (expect 3 LightFire rules, 2 excluded agents):
--   SELECT event_type, amount_cents, pct, lead_age_rule, requires_review FROM pay_rules ORDER BY event_type;
--   SELECT * FROM pay_excluded_agents;
