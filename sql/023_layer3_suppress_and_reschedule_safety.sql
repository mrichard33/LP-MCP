-- ─────────────────────────────────────────────────────────────────────────────
-- 023 — Layer-3 suppress + reschedule safety (Jacqueline Virtue post-mortem)
-- ─────────────────────────────────────────────────────────────────────────────
-- Pairs with code changes:
--   • src/services/layer3-dispatch.js  — suppress benign-hold gate
--   • src/actions/handlers/appointments.js — book-before-cancel reschedule
--   • src/services/reschedule-inflight.js  — TTL marker (table below)
--   • src/decision-engine.js — not_reschedule_inflight context operator
--   • src/services/agentic-handoff.js + actions/index.js — end_agentic_handoff
--
-- ORDERING: apply this migration ONLY after the code above is deployed and
-- healthy. Rows 2-4 reference the `end_agentic_handoff` action type and the
-- `not_reschedule_inflight` context operator, which must exist in the running
-- code first. Idempotent — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────


-- 1. reschedule_inflight — short-lived correlation marker (mirrors outbound_locks)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reschedule_inflight (
  contact_id  TEXT PRIMARY KEY,
  expires_at  TIMESTAMPTZ NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reschedule_inflight_expires_at
  ON reschedule_inflight(expires_at);

COMMENT ON TABLE reschedule_inflight IS
  'Set by the reschedule handler before cancelling an old slot so the agent-initiated ghl.appointment_cancelled webhook does not trip the customer-cancellation rules. Self-expires via expires_at (default TTL 300s).';


-- 2. layer3_action_dispatch.suppress → silent agentic-active teardown (last action)
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE layer3_action_dispatch
SET actions = actions || '[
      {"action_type": "end_agentic_handoff", "target_system": "ghl", "target_entity": "contact", "params": {}}
    ]'::jsonb,
    updated_at = NOW()
WHERE recommended_action = 'suppress'
  AND active = TRUE
  AND NOT (actions @> '[{"action_type": "end_agentic_handoff"}]'::jsonb);


-- 3. GHL_APPT_CANCELLED_REBOOK_COLD → teardown + reschedule-inflight guard
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE agent_rules
SET action_template = action_template || '[
      {"action_type": "end_agentic_handoff", "target_system": "ghl", "target_entity": "contact", "params": {}}
    ]'::jsonb,
    updated_at = NOW()
WHERE rule_key = 'GHL_APPT_CANCELLED_REBOOK_COLD'
  AND NOT (action_template @> '[{"action_type": "end_agentic_handoff"}]'::jsonb);

UPDATE agent_rules
SET context_conditions = COALESCE(context_conditions, '{}'::jsonb) || '{"not_reschedule_inflight": true}'::jsonb,
    updated_at = NOW()
WHERE rule_key = 'GHL_APPT_CANCELLED_REBOOK_COLD';


-- 4. GHL_APPT_CANCELLED_REBOOK (warm) → reschedule-inflight guard only
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE agent_rules
SET context_conditions = COALESCE(context_conditions, '{}'::jsonb) || '{"not_reschedule_inflight": true}'::jsonb,
    updated_at = NOW()
WHERE rule_key = 'GHL_APPT_CANCELLED_REBOOK';
