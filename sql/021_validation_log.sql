-- sql/021_validation_log.sql
-- Antifragile Validation Gate — log table for blocked + warned actions.
-- See docs/ANTIFRAGILE_VALIDATION_GATE_DOCTRINE.md for the spec.

CREATE TABLE IF NOT EXISTS validation_log (
  id                BIGSERIAL PRIMARY KEY,
  action_id         BIGINT REFERENCES agent_actions(id) ON DELETE SET NULL,
  contact_id        TEXT,
  rule_applied      TEXT,                        -- the originating agent_rules.rule_key
  action_type       TEXT,                        -- e.g. 'add_to_workflow'
  invariant_key     TEXT NOT NULL,               -- e.g. 'TL-1'
  invariant_name    TEXT NOT NULL,               -- e.g. 'appointment_rescue_requires_history'
  severity          TEXT NOT NULL CHECK (severity IN ('BLOCK','WARN')),
  framework_citation TEXT,                       -- e.g. 'Antifragile Trust L4'
  reason            TEXT NOT NULL,               -- specific reason text
  context_snapshot  JSONB,                       -- contact's relevant tags at validation time
  action_payload    JSONB,                       -- the action that was rejected/warned
  blocked           BOOLEAN NOT NULL DEFAULT false,
  notified          BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_validation_log_invariant
  ON validation_log(invariant_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_validation_log_contact
  ON validation_log(contact_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_validation_log_blocked
  ON validation_log(severity, blocked, created_at DESC)
  WHERE blocked = true;

CREATE INDEX IF NOT EXISTS idx_validation_log_rule
  ON validation_log(rule_applied, invariant_key, created_at DESC);

COMMENT ON TABLE validation_log IS
  'Antifragile Validation Gate audit log. One row per validation failure (BLOCK or WARN). See docs/ANTIFRAGILE_VALIDATION_GATE_DOCTRINE.md.';

-- New terminal status for agent_actions: rejected by the validation gate.
-- We don''t enforce via CHECK constraint because the existing column has no enum;
-- the executor writes the literal 'rejected_by_validation' string.
COMMENT ON COLUMN agent_actions.status IS
  'pending | executing | completed | failed | rejected | pending_approval | rejected_by_validation';
