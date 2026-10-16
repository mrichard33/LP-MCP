-- ════════════════════════════════════════════════════════════════════
-- LP → GHL appointment parity, self-healing — 2026-10-16 (Roberta Ritchie)
--
-- WHY: GHL contact 0Hwk6Mw05TSkKfQDhssm. LP lead 583833 moved from 10/17 10 AM to
--   10/16 2 PM and went Issue in ONE edit; no rule routed an Issue, so GHL kept the
--   stale time (`no_matching_rules`, 10/16 13:03Z). LP's confirmed checkbox changed
--   nothing either. After the demo (OPPFDN) nothing closed the GHL estimate.
--
-- Ships with the code (deploy FIRST: two of these name a new action type, and the
-- executor fails an unknown one):
--   LP_APPT_GHL_SYNC_ISSUE      lp.disposition_changed Issue → sync_lp_appointment_to_ghl
--   LP_APPT_GHL_SYNC_CONFIRMED  lp.appointment_confirmed     → sync_lp_appointment_to_ghl
--   LP_APPT_GHL_CLOSE           lp.disposition_changed demo / NoHome / CXL / CCC / NG
--                               → close_past_lp_appointment (POST_APPT_CLOSE_MODE, default shadow)
--   CONF_PIPE_RESCHEDULED       lp.appointment_rescheduled   → sync_confirmation_opportunity
--   CONF_PIPE_CONFIRMED         lp.appointment_confirmed     → sync_confirmation_opportunity
--
-- RUNNER NOTES: one statement per supabase_run_query call; idempotent
-- (ON CONFLICT (rule_key) DO UPDATE). Confirm with the SELECT at the end (expect 5
-- rows, all enabled), then POST /n8n/decision-engine/reload-rules.
-- ════════════════════════════════════════════════════════════════════

INSERT INTO agent_rules (rule_key, rule_name, category, rule_type, event_pattern, conditions, context_conditions, action_template, requires_approval, enabled, priority, created_by, notes)
VALUES (
  'LP_APPT_GHL_SYNC_ISSUE',
  'LP Issue → GHL Window Estimate sync (reschedule in place + confirm, create-confirmed if missing)',
  'appointment', 'pattern',
  '{"event_type": "lp.disposition_changed", "payload": {"disposition_code": "Issue"}}'::jsonb,
  NULL, NULL,
  '[{"action_type": "sync_lp_appointment_to_ghl", "target_system": "ghl", "target_entity": "contact", "priority": 20, "params": {"disposition_code": "Issue"}}]'::jsonb,
  false, true, 20, 'claude',
  '2026-10-16 (Roberta Ritchie 583833): Issue = a live, confirmed visit (handoff v3.4). LP moved her visit and issued it in one edit, and with no Issue rule GHL kept the old day. Mirrors only; the post-issue gate governs LP writes.'
  )
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category, rule_type = EXCLUDED.rule_type,
  event_pattern = EXCLUDED.event_pattern, conditions = EXCLUDED.conditions,
  context_conditions = EXCLUDED.context_conditions, action_template = EXCLUDED.action_template,
  requires_approval = EXCLUDED.requires_approval, enabled = EXCLUDED.enabled,
  priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = now();

INSERT INTO agent_rules (rule_key, rule_name, category, rule_type, event_pattern, conditions, context_conditions, action_template, requires_approval, enabled, priority, created_by, notes)
VALUES (
  'LP_APPT_GHL_SYNC_CONFIRMED',
  'LP confirmed checkbox on a Set lead → GHL Window Estimate confirmed',
  'appointment', 'pattern',
  '{"event_type": "lp.appointment_confirmed"}'::jsonb,
  NULL, NULL,
  '[{"action_type": "sync_lp_appointment_to_ghl", "target_system": "ghl", "target_entity": "contact", "priority": 20, "params": {"disposition_code": "Set", "reason": "lp_confirmed_checkbox"}}]'::jsonb,
  false, true, 20, 'claude',
  '2026-10-16 (the user, Roberta Ritchie): LP''s confirmed checkbox counts as confirmed in GHL. sync-leads emits lp.appointment_confirmed when it flips on a Set lead; the reconciler reads the checkbox (lpConfirmedFlag).'
  )
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category, rule_type = EXCLUDED.rule_type,
  event_pattern = EXCLUDED.event_pattern, conditions = EXCLUDED.conditions,
  context_conditions = EXCLUDED.context_conditions, action_template = EXCLUDED.action_template,
  requires_approval = EXCLUDED.requires_approval, enabled = EXCLUDED.enabled,
  priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = now();

INSERT INTO agent_rules (rule_key, rule_name, category, rule_type, event_pattern, conditions, context_conditions, action_template, requires_approval, enabled, priority, created_by, notes)
VALUES (
  'LP_APPT_GHL_CLOSE',
  'LP says what happened at the visit → GHL estimate showed / noshow / cancelled',
  'appointment', 'contextual',
  '{"event_type": "lp.disposition_changed"}'::jsonb,
  NULL,
  '{"event_subtype_in": ["Sale", "OPPFDN", "NoRehash", "FDNS", "SW", "PM", "NoHome", "CXL", "CCC", "NG"]}'::jsonb,
  '[{"action_type": "close_past_lp_appointment", "target_system": "ghl", "target_entity": "contact", "priority": 30, "params": {}}]'::jsonb,
  false, true, 30, 'claude',
  '2026-10-16 (the user, Roberta Ritchie): once LP''s visit time has passed, demo → showed + P1 Appointment Completed, NoHome → noshow, CXL/CCC/NG → cancelled. A future GHL appointment against a cancel stays Class E''s. POST_APPT_CLOSE_MODE (default shadow) gates the write; the parity watchdog''s Class F is the backstop.'
  )
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category, rule_type = EXCLUDED.rule_type,
  event_pattern = EXCLUDED.event_pattern, conditions = EXCLUDED.conditions,
  context_conditions = EXCLUDED.context_conditions, action_template = EXCLUDED.action_template,
  requires_approval = EXCLUDED.requires_approval, enabled = EXCLUDED.enabled,
  priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = now();

INSERT INTO agent_rules (rule_key, rule_name, category, rule_type, event_pattern, conditions, context_conditions, action_template, requires_approval, enabled, priority, created_by, notes)
VALUES (
  'CONF_PIPE_RESCHEDULED',
  'LP reschedule (same disposition) → Confirmation card follows the new time',
  'appointment', 'pattern',
  '{"event_type": "lp.appointment_rescheduled"}'::jsonb,
  NULL, NULL,
  '[{"action_type": "sync_confirmation_opportunity", "target_system": "ghl", "target_entity": "contact", "priority": 20, "params": {}}]'::jsonb,
  false, true, 20, 'claude',
  '4. Confirmation Pipeline (2026-10-16, Roberta Ritchie): a reschedule changes no disposition, so no CONF_PIPE rule ran; the handler re-reads the newest lead and creates the card if none exists.'
  )
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category, rule_type = EXCLUDED.rule_type,
  event_pattern = EXCLUDED.event_pattern, conditions = EXCLUDED.conditions,
  context_conditions = EXCLUDED.context_conditions, action_template = EXCLUDED.action_template,
  requires_approval = EXCLUDED.requires_approval, enabled = EXCLUDED.enabled,
  priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = now();

INSERT INTO agent_rules (rule_key, rule_name, category, rule_type, event_pattern, conditions, context_conditions, action_template, requires_approval, enabled, priority, created_by, notes)
VALUES (
  'CONF_PIPE_CONFIRMED',
  'LP confirmed checkbox → Confirmation card re-read',
  'appointment', 'pattern',
  '{"event_type": "lp.appointment_confirmed"}'::jsonb,
  NULL, NULL,
  '[{"action_type": "sync_confirmation_opportunity", "target_system": "ghl", "target_entity": "contact", "priority": 20, "params": {}}]'::jsonb,
  false, true, 20, 'claude',
  '4. Confirmation Pipeline (2026-10-16): the card is re-read on LP''s confirmed checkbox, like any other LP change.'
  )
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category, rule_type = EXCLUDED.rule_type,
  event_pattern = EXCLUDED.event_pattern, conditions = EXCLUDED.conditions,
  context_conditions = EXCLUDED.context_conditions, action_template = EXCLUDED.action_template,
  requires_approval = EXCLUDED.requires_approval, enabled = EXCLUDED.enabled,
  priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = now();

SELECT json_agg(row_to_json(s)) FROM (
  SELECT id, rule_key, enabled FROM agent_rules
  WHERE rule_key IN ('LP_APPT_GHL_SYNC_ISSUE', 'LP_APPT_GHL_SYNC_CONFIRMED', 'LP_APPT_GHL_CLOSE', 'CONF_PIPE_RESCHEDULED', 'CONF_PIPE_CONFIRMED')
) s;
