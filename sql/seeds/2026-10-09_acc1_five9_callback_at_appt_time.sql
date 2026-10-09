-- 2026-10-09 — ACC1_FIVE9_CALLBACK_AT_APPT_TIME (Mark)
--
-- A.CC-1 Confirmation Call Reminders replaced the GHL "Connect with Call Center"
-- call step with a webhook to /webhook/ghl/workflow (customData
-- workflowId=acc1-five9-callback) at 1 minute before the appointment. That emits
-- ghl.workflow_completed with event_subtype 'acc1-five9-callback'. This rule pushes
-- the lead to the Five9 "Callback Request" list via lp_callback_requeue (the same
-- action HOT_CALL_IMMEDIATE uses; call-now ANY, so it dials immediately).
-- The push needs lp_prospect_id (CustID) and a usable phone; A.CC-1 runs
-- "Extract Prospect ID From LP" at its 2-hours-before step.
-- APPLIED LIVE 2026-10-09 18:21 UTC, reload rules_loaded 308 -> 309.

INSERT INTO agent_rules (rule_key, rule_name, category, rule_type, event_pattern, conditions,
  context_conditions, action_template, requires_approval, enabled, priority, created_by, notes)
VALUES ('ACC1_FIVE9_CALLBACK_AT_APPT_TIME',
 'Confirmation Call time reached → push to Five9 Callback Request list',
 'appointment', 'contextual',
 '{"event_type": "ghl.workflow_completed", "event_subtype": "acc1-five9-callback"}'::jsonb,
 NULL,
 '{"not_has_any_tag": ["dnc", "dnc-sms", "do-not-contact", "stage:dnc", "unsubscribed", "suppress-outbound"]}'::jsonb,
 '[{"action_type": "lp_callback_requeue", "target_system": "lp", "target_entity": "contact", "params": {}},
   {"action_type": "add_note", "target_system": "ghl", "target_entity": "contact", "params": {"next_step": "Confirmation Call time reached. Sent to the Five9 Callback Request list so the call center dials now (replaces GHL Connect with Call Center)."}}]'::jsonb,
 FALSE, TRUE, 60, 'claude',
 'See file header. Rehash copy should send its own workflowId and get its own rule.')
ON CONFLICT (rule_key) DO NOTHING;

-- Then: POST /n8n/decision-engine/reload-rules and assert rules_loaded +1.

-- ROLLBACK:
-- UPDATE agent_rules SET enabled = false WHERE rule_key = 'ACC1_FIVE9_CALLBACK_AT_APPT_TIME';
-- POST /n8n/decision-engine/reload-rules
