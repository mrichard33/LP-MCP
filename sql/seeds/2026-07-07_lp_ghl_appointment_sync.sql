-- ════════════════════════════════════════════════════════════════════
-- LP→GHL Agentic Appointment Sync rules — 2026-07-07
--
-- WHY: GHL workflow I.LP-IN cannot maintain appointment parity with LP
--   (its "existing appointment" condition reads contact proxy fields, and
--   its update_appointment_status steps carry no appointment reference —
--   silent no-ops). Verified July 7: of 47 real LP appointments for July 8,
--   only 17 were correct in GHL. These rules make the agentic layer the
--   LP→GHL appointment authority: every LP disposition change to Set / Cnf
--   / CXL reconciles the GHL Window Estimate calendar against LP reality
--   via the sync_lp_appointment_to_ghl action
--   (src/actions/handlers/lp-ghl-appointment-sync.js — deploy the code
--   BEFORE seeding, or the executor fails on the unknown action type).
--
-- RUNNER NOTES:
--   * One statement per supabase_run_query call.
--   * Each statement is wrapped so it returns a confirmable count — expect
--     seeded = 1 from every call.
--   * Idempotent: ON CONFLICT (rule_key) DO UPDATE (safe to re-run).
--   * After running: POST /n8n/decision-engine/reload-rules and assert
--     rules_loaded increased by 3 (or wait ≤60s for the cache TTL).
--
-- SHAPE NOTES (verified against decision-engine.js):
--   * event_pattern payload matching is nested equality (matchesPattern) —
--     same pattern as the live LP_DISP_* disposition_routing rules.
--   * createActionsFromRule takes target_id from event.ghl_contact_id and
--     skips unlinked leads (no GHL contact) automatically.
--   * params are inserted RAW as action_payload; the handler re-reads the
--     authoritative lp_leads row itself (newest by created_at_lp), so
--     disposition_code here is informational/cross-check only.
--   * priority 20 = the time-sensitive appointment lane (also the type's
--     default via DEFAULT_PRIORITY_BY_TYPE, set explicitly for clarity).
--
-- COEXISTENCE: the stale-appt tag rules (LP_DISP_SET / LP_DISP_CNF / …)
--   also fire on these events — separate defect with its own pending fix;
--   NOT modified here. I.LP-IN's booking branch also still exists; the
--   reconciler's idempotent same-time skip makes that race benign.
-- ════════════════════════════════════════════════════════════════════

WITH i AS (
  INSERT INTO agent_rules (rule_key, rule_name, category, rule_type, event_pattern, conditions, context_conditions, action_template, requires_approval, enabled, priority, created_by, notes)
  VALUES (
    'LP_APPT_GHL_SYNC_SET',
    'LP Set → GHL Window Estimate sync (create/reschedule, never downgrade)',
    'appointment', 'pattern',
    '{"event_type": "lp.disposition_changed", "payload": {"disposition_code": "Set"}}'::jsonb,
    NULL, NULL,
    '[{"action_type": "sync_lp_appointment_to_ghl", "target_system": "ghl", "target_entity": "contact", "priority": 20, "params": {"disposition_code": "Set"}}]'::jsonb,
    false, true, 20, 'claude',
    'LP→GHL appointment authority (2026-07-07). LP Set: create WE appointment status new, or reschedule in place if time differs; same-time no-op never downgrades a confirmed. Handler re-reads newest lp_leads row.'
  )
  ON CONFLICT (rule_key) DO UPDATE SET
    rule_name = EXCLUDED.rule_name, category = EXCLUDED.category, rule_type = EXCLUDED.rule_type,
    event_pattern = EXCLUDED.event_pattern, conditions = EXCLUDED.conditions,
    context_conditions = EXCLUDED.context_conditions, action_template = EXCLUDED.action_template,
    requires_approval = EXCLUDED.requires_approval, enabled = EXCLUDED.enabled,
    priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = now()
  RETURNING 1
)
SELECT count(*) AS seeded FROM i;

WITH i AS (
  INSERT INTO agent_rules (rule_key, rule_name, category, rule_type, event_pattern, conditions, context_conditions, action_template, requires_approval, enabled, priority, created_by, notes)
  VALUES (
    'LP_APPT_GHL_SYNC_CNF',
    'LP Cnf → GHL Window Estimate sync (confirm, create-confirmed if missing)',
    'appointment', 'pattern',
    '{"event_type": "lp.disposition_changed", "payload": {"disposition_code": "Cnf"}}'::jsonb,
    NULL, NULL,
    '[{"action_type": "sync_lp_appointment_to_ghl", "target_system": "ghl", "target_entity": "contact", "priority": 20, "params": {"disposition_code": "Cnf"}}]'::jsonb,
    false, true, 20, 'claude',
    'LP→GHL appointment authority (2026-07-07). LP Cnf IS the confirmation authority (call center) — no DM backstop. Confirms the WE appointment (reschedule first if time differs), or creates it status confirmed if missing.'
  )
  ON CONFLICT (rule_key) DO UPDATE SET
    rule_name = EXCLUDED.rule_name, category = EXCLUDED.category, rule_type = EXCLUDED.rule_type,
    event_pattern = EXCLUDED.event_pattern, conditions = EXCLUDED.conditions,
    context_conditions = EXCLUDED.context_conditions, action_template = EXCLUDED.action_template,
    requires_approval = EXCLUDED.requires_approval, enabled = EXCLUDED.enabled,
    priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = now()
  RETURNING 1
)
SELECT count(*) AS seeded FROM i;

WITH i AS (
  INSERT INTO agent_rules (rule_key, rule_name, category, rule_type, event_pattern, conditions, context_conditions, action_template, requires_approval, enabled, priority, created_by, notes)
  VALUES (
    'LP_APPT_GHL_SYNC_CXL',
    'LP CXL → GHL Window Estimate cancel (+ contact-field mirror)',
    'appointment', 'pattern',
    '{"event_type": "lp.disposition_changed", "payload": {"disposition_code": "CXL"}}'::jsonb,
    NULL, NULL,
    '[{"action_type": "sync_lp_appointment_to_ghl", "target_system": "ghl", "target_entity": "contact", "priority": 20, "params": {"disposition_code": "CXL"}}]'::jsonb,
    false, true, 20, 'claude',
    'LP→GHL appointment authority (2026-07-07). LP CXL: cancel the active WE appointment + syncCancelledAppointmentState field mirror. Deliberately NO reschedule-inflight marker — real customer cancellation, GHL_APPT_CANCELLED_REBOOK* rules should see it. No active appointment → nothing_to_cancel no-op.'
  )
  ON CONFLICT (rule_key) DO UPDATE SET
    rule_name = EXCLUDED.rule_name, category = EXCLUDED.category, rule_type = EXCLUDED.rule_type,
    event_pattern = EXCLUDED.event_pattern, conditions = EXCLUDED.conditions,
    context_conditions = EXCLUDED.context_conditions, action_template = EXCLUDED.action_template,
    requires_approval = EXCLUDED.requires_approval, enabled = EXCLUDED.enabled,
    priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = now()
  RETURNING 1
)
SELECT count(*) AS seeded FROM i;
