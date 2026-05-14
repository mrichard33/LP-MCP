-- ============================================================================
-- Migration: objection state substrate (S5.2 v2, Spec v1.2)
-- Date: 2026-05-14
-- Reference: S5_2_Spec_v1.2.md + S5_2_Build_Handoff_v1.2.md
-- ----------------------------------------------------------------------------
-- Three new tables co-located with the writer (Action Executor lives in LP MCP):
--   1. objection_state_policies     — config (per-state cadence, workflow, etc.)
--   2. contact_objection_states     — per-contact state ledger (exit when superseded)
--   3. objection_state_transitions  — allowed/forbidden from/to pairs (wildcards ok)
--
-- v1.2 taxonomy note: APPOINTMENT_DISRUPTION.no_home is merged into .no_show.
-- NoHome dispositions carry nuance_tags=['nuance:rep_traveled'] for ops.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. objection_state_policies
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS objection_state_policies (
  state_code              text PRIMARY KEY,
  parent_state            text,
  display_name            text NOT NULL,
  description             text,
  priority                integer NOT NULL,
  recovery_workflow_id    text,
  recovery_window_days    integer NOT NULL,
  recovery_touch_count    integer NOT NULL,
  recovery_cadence        jsonb NOT NULL,
  copy_variant            text,
  cooldown_period_days    integer,
  cooldown_workflow_id    text,
  allowed_transitions     text[],
  resolution_criteria     jsonb,
  escalation_triggers     jsonb,
  stale_threshold_hours   integer DEFAULT 168,
  active                  boolean DEFAULT true,
  created_at              timestamptz DEFAULT now(),
  updated_at              timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_osp_parent   ON objection_state_policies(parent_state);
CREATE INDEX IF NOT EXISTS idx_osp_active   ON objection_state_policies(active);
CREATE INDEX IF NOT EXISTS idx_osp_priority ON objection_state_policies(priority DESC);

-- ----------------------------------------------------------------------------
-- 2. contact_objection_states
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contact_objection_states (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id                  text NOT NULL,
  state_code                  text NOT NULL REFERENCES objection_state_policies(state_code),
  parent_state                text,
  entered_at                  timestamptz NOT NULL DEFAULT now(),
  exited_at                   timestamptz,
  recovery_attempt_number     integer NOT NULL DEFAULT 1,
  parent_attempt_number       integer NOT NULL DEFAULT 1,
  trigger_source              text NOT NULL,
  classifier_confidence       numeric,
  classifier_version          text,
  resolution                  text,
  triggering_event_id         uuid,
  exit_event_id               uuid,
  nuance_tags                 text[],
  notes                       text,
  CONSTRAINT chk_trigger_source CHECK (trigger_source IN (
    'LP_WEBHOOK', 'MESSAGE_ANALYZER', 'BEHAVIORAL_RULE', 'TIMER_EXPIRY',
    'STATE_ESCALATION', 'MANUAL_OVERRIDE', 'IMPORT_BACKFILL', 'EXTERNAL_API'
  ))
);

-- Exactly one active state per contact. Partial unique index over the open row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cos_one_active_per_contact
  ON contact_objection_states(contact_id) WHERE exited_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_cos_contact         ON contact_objection_states(contact_id);
CREATE INDEX IF NOT EXISTS idx_cos_state           ON contact_objection_states(state_code);
CREATE INDEX IF NOT EXISTS idx_cos_parent          ON contact_objection_states(parent_state);
CREATE INDEX IF NOT EXISTS idx_cos_active          ON contact_objection_states(contact_id) WHERE exited_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_cos_trigger_source  ON contact_objection_states(trigger_source);
CREATE INDEX IF NOT EXISTS idx_cos_entered_at      ON contact_objection_states(entered_at);

-- Attempt-number trigger: computed in BEFORE INSERT so callers never set it.
CREATE OR REPLACE FUNCTION set_recovery_attempt_numbers()
RETURNS TRIGGER AS $$
BEGIN
  NEW.recovery_attempt_number := (
    SELECT COALESCE(MAX(recovery_attempt_number), 0) + 1
    FROM contact_objection_states
    WHERE contact_id = NEW.contact_id AND state_code = NEW.state_code
  );
  NEW.parent_attempt_number := (
    SELECT COALESCE(MAX(parent_attempt_number), 0) + 1
    FROM contact_objection_states
    WHERE contact_id = NEW.contact_id AND parent_state = NEW.parent_state
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cos_attempt_numbers ON contact_objection_states;
CREATE TRIGGER trg_cos_attempt_numbers
  BEFORE INSERT ON contact_objection_states
  FOR EACH ROW EXECUTE FUNCTION set_recovery_attempt_numbers();

-- ----------------------------------------------------------------------------
-- 3. objection_state_transitions
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS objection_state_transitions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_state          text NOT NULL,
  to_state            text NOT NULL,
  allowed             boolean NOT NULL DEFAULT true,
  requires_approval   boolean NOT NULL DEFAULT false,
  approval_threshold  numeric,
  reason_codes        text[],
  notes               text,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ost_pair    ON objection_state_transitions(from_state, to_state);
CREATE INDEX IF NOT EXISTS idx_ost_to             ON objection_state_transitions(to_state);
CREATE INDEX IF NOT EXISTS idx_ost_allowed        ON objection_state_transitions(allowed) WHERE allowed = true;

-- ----------------------------------------------------------------------------
-- 4. v_active_objection_states — dashboard / monitoring view
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_active_objection_states AS
SELECT
  c.contact_id,
  c.state_code,
  c.parent_state,
  c.entered_at,
  c.recovery_attempt_number,
  c.parent_attempt_number,
  c.trigger_source,
  p.recovery_workflow_id,
  p.priority,
  EXTRACT(EPOCH FROM (now() - c.entered_at)) / 3600 AS hours_in_state
FROM contact_objection_states c
JOIN objection_state_policies p ON p.state_code = c.state_code
WHERE c.exited_at IS NULL;

-- ----------------------------------------------------------------------------
-- Verification: should return 3 rows
-- ----------------------------------------------------------------------------
-- SELECT json_agg(row_to_json(t)) FROM (
--   SELECT table_name FROM information_schema.tables
--   WHERE table_name IN ('objection_state_policies', 'contact_objection_states', 'objection_state_transitions')
-- ) t;
