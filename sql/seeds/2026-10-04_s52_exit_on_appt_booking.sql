-- ============================================================================
-- Seed: S52_EXIT_ON_APPT_BOOKING — exit S5.2 on appt.booking (created)
-- Date: 2026-10-04   (APPLIED LIVE 2026-10-04; reload asserted 306 -> 307)
-- WHY: Rebooks that start in LP create the GHL appointment through LP MCP,
--      which emits appt.booking (created), not ghl.appointment_booked, so
--      BOOKING_EXITS_W5_2 never sees them. Incident: Waleid Mohamed
--      uQSQEsGSmQPygKatHYql got the S5.2 cancelled SMS 2 a day after rebooking.
-- ============================================================================
BEGIN;
INSERT INTO agent_rules
  (rule_key, rule_name, category, rule_type, event_pattern, context_conditions,
   action_template, requires_approval, enabled, priority, notes)
VALUES
('S52_EXIT_ON_APPT_BOOKING',
 'Exit S5.2 when a Window Estimate appointment is created by LP MCP (appt.booking)',
 'routing', 'contextual',
 '{"event_type": "appt.booking", "event_subtype": "created"}'::jsonb,
 '{"has_any_tag": ["active-s5.2", "active-w5.2"]}'::jsonb,
 '[{"action_type":"remove_from_workflow","target_system":"ghl","target_entity":"contact","params":{"workflow_id":"0a6a1349-0b44-429b-91e1-4c5be264cd9f","workflow_name":"S5.2 Appointment Rescue (Policy Executor) v2","canonical_code":"S5.2"}},
   {"action_type":"remove_from_workflow","target_system":"ghl","target_entity":"contact","params":{"workflow_id":"613dbbbd-b7af-4be0-81fa-371f3e1d7b14","workflow_name":"S5.2 Appointment Rescue Reactivation","canonical_code":"S5.2"}},
   {"action_type":"remove_tag","target_system":"ghl","target_entity":"contact","params":{"tag":"active-s5.2"}},
   {"action_type":"remove_tag","target_system":"ghl","target_entity":"contact","params":{"tag":"active-w5.2"}},
   {"action_type":"remove_tag","target_system":"ghl","target_entity":"contact","params":{"tag":"s52-task-created"}},
   {"action_type":"remove_tag","target_system":"ghl","target_entity":"contact","params":{"tag":"rebook-reason:cancelled"}},
   {"action_type":"remove_tag","target_system":"ghl","target_entity":"contact","params":{"tag":"rebook-reason:cxl"}},
   {"action_type":"add_tag","target_system":"ghl","target_entity":"contact","params":{"tag":"s52-exit-rescued"}}]'::jsonb,
 FALSE, TRUE, 95,
 '2026-10-04 (Mark): Backstop exit for S5.2 on appt.booking (created). See seed header.')
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category,
  rule_type = EXCLUDED.rule_type, event_pattern = EXCLUDED.event_pattern,
  context_conditions = EXCLUDED.context_conditions,
  action_template = EXCLUDED.action_template,
  requires_approval = EXCLUDED.requires_approval, enabled = EXCLUDED.enabled,
  priority = EXCLUDED.priority, updated_at = NOW();
COMMIT;
-- Verification:
--   SELECT rule_key, enabled FROM agent_rules WHERE rule_key = 'S52_EXIT_ON_APPT_BOOKING';
-- Reload required after apply:
--   POST /n8n/decision-engine/reload-rules  (assert rules_loaded delta)
-- Rollback:
--   UPDATE agent_rules SET enabled = FALSE, updated_at = NOW()
--   WHERE rule_key = 'S52_EXIT_ON_APPT_BOOKING';  then reload.
