-- ════════════════════════════════════════════════════════════════════
-- 4. Confirmation Pipeline sync rules — 2026-10-16
--
-- WHY: every LP appointment gets ONE card in GHL "4. Confirmation Pipeline"
--   (ThrBNpyzJhAON4WFC855), moved by LP disposition and by the time to the
--   appointment, closed once it has passed. No GHL workflow triggers on that
--   pipeline (checked 2026-10-16: 0 workflow_triggers rows); LP MCP owns it.
--   Each rule queues sync_confirmation_opportunity
--   (src/actions/handlers/confirmation-pipeline-sync.js — deploy the code
--   BEFORE seeding, or the executor fails on the unknown action type).
--   `Issue` is deliberately NOT mapped: it means issued to a rep.
--
-- RUNNER NOTES (same as 2026-07-07_lp_ghl_appointment_sync.sql):
--   * One statement per supabase_run_query call; no data-modifying CTEs.
--   * Idempotent: ON CONFLICT (rule_key) DO UPDATE.
--   * After running: POST /n8n/decision-engine/reload-rules and assert
--     rules_loaded increased by 5.
--
-- SHAPE NOTES:
--   * The CONF_PIPE_ prefix keeps these out of the LP_DISP_% group dedup
--     (dedupPolicy in decision-engine.js), which would drop a CONF_PIPE row
--     queued minutes after a LP_DISP_* one. The handler is idempotent.
--   * params are a cross-check only; the handler re-reads the newest lp_leads
--     row for the contact every run.
--   * CONF_PIPE_DRY_RUN (default true) makes every run log-only.
--   * The LP_APPT_GHL_SYNC_* rules are untouched.
-- ════════════════════════════════════════════════════════════════════

INSERT INTO agent_rules (rule_key, rule_name, category, rule_type, event_pattern, conditions, context_conditions, action_template, requires_approval, enabled, priority, created_by, notes)
VALUES (
  'CONF_PIPE_SET',
  'LP Set → Confirmation card: 1. New Submission, or 3. Confirm Now under 24h',
  'appointment', 'pattern',
  '{"event_type": "lp.disposition_changed", "payload": {"disposition_code": "Set"}}'::jsonb,
  NULL, NULL,
  '[{"action_type": "sync_confirmation_opportunity", "target_system": "ghl", "target_entity": "contact", "priority": 20, "params": {"disposition_code": "Set"}}]'::jsonb,
  false, true, 20, 'claude',
  '4. Confirmation Pipeline (2026-10-16). One card per LP appointment; locked stages, hand moves and the 24h / close clock are in src/confirmation-pipeline/rules.js.'
  )
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category, rule_type = EXCLUDED.rule_type,
  event_pattern = EXCLUDED.event_pattern, conditions = EXCLUDED.conditions,
  context_conditions = EXCLUDED.context_conditions, action_template = EXCLUDED.action_template,
  requires_approval = EXCLUDED.requires_approval, enabled = EXCLUDED.enabled,
  priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = now();

INSERT INTO agent_rules (rule_key, rule_name, category, rule_type, event_pattern, conditions, context_conditions, action_template, requires_approval, enabled, priority, created_by, notes)
VALUES (
  'CONF_PIPE_VERIF',
  'LP Verif → Confirmation card: 2. Issue Detected (wins over the 24h rule; moves the card, nothing else)',
  'appointment', 'pattern',
  '{"event_type": "lp.disposition_changed", "payload": {"disposition_code": "Verif"}}'::jsonb,
  NULL, NULL,
  '[{"action_type": "sync_confirmation_opportunity", "target_system": "ghl", "target_entity": "contact", "priority": 20, "params": {"disposition_code": "Verif"}}]'::jsonb,
  false, true, 20, 'claude',
  '4. Confirmation Pipeline (2026-10-16). One card per LP appointment; locked stages, hand moves and the 24h / close clock are in src/confirmation-pipeline/rules.js.'
  )
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category, rule_type = EXCLUDED.rule_type,
  event_pattern = EXCLUDED.event_pattern, conditions = EXCLUDED.conditions,
  context_conditions = EXCLUDED.context_conditions, action_template = EXCLUDED.action_template,
  requires_approval = EXCLUDED.requires_approval, enabled = EXCLUDED.enabled,
  priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = now();

INSERT INTO agent_rules (rule_key, rule_name, category, rule_type, event_pattern, conditions, context_conditions, action_template, requires_approval, enabled, priority, created_by, notes)
VALUES (
  'CONF_PIPE_CNF',
  'LP Cnf → Confirmation card: 4. Confirmed (locked)',
  'appointment', 'pattern',
  '{"event_type": "lp.disposition_changed", "payload": {"disposition_code": "Cnf"}}'::jsonb,
  NULL, NULL,
  '[{"action_type": "sync_confirmation_opportunity", "target_system": "ghl", "target_entity": "contact", "priority": 20, "params": {"disposition_code": "Cnf"}}]'::jsonb,
  false, true, 20, 'claude',
  '4. Confirmation Pipeline (2026-10-16). One card per LP appointment; locked stages, hand moves and the 24h / close clock are in src/confirmation-pipeline/rules.js.'
  )
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category, rule_type = EXCLUDED.rule_type,
  event_pattern = EXCLUDED.event_pattern, conditions = EXCLUDED.conditions,
  context_conditions = EXCLUDED.context_conditions, action_template = EXCLUDED.action_template,
  requires_approval = EXCLUDED.requires_approval, enabled = EXCLUDED.enabled,
  priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = now();

INSERT INTO agent_rules (rule_key, rule_name, category, rule_type, event_pattern, conditions, context_conditions, action_template, requires_approval, enabled, priority, created_by, notes)
VALUES (
  'CONF_PIPE_ND',
  'LP ND → Confirmation card: 5. Disqualified (locked; the one move out of Confirmed)',
  'appointment', 'pattern',
  '{"event_type": "lp.disposition_changed", "payload": {"disposition_code": "ND"}}'::jsonb,
  NULL, NULL,
  '[{"action_type": "sync_confirmation_opportunity", "target_system": "ghl", "target_entity": "contact", "priority": 20, "params": {"disposition_code": "ND"}}]'::jsonb,
  false, true, 20, 'claude',
  '4. Confirmation Pipeline (2026-10-16). One card per LP appointment; locked stages, hand moves and the 24h / close clock are in src/confirmation-pipeline/rules.js.'
  )
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category, rule_type = EXCLUDED.rule_type,
  event_pattern = EXCLUDED.event_pattern, conditions = EXCLUDED.conditions,
  context_conditions = EXCLUDED.context_conditions, action_template = EXCLUDED.action_template,
  requires_approval = EXCLUDED.requires_approval, enabled = EXCLUDED.enabled,
  priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = now();

INSERT INTO agent_rules (rule_key, rule_name, category, rule_type, event_pattern, conditions, context_conditions, action_template, requires_approval, enabled, priority, created_by, notes)
VALUES (
  'CONF_PIPE_CXL',
  'LP CXL → Confirmation card closed abandoned',
  'appointment', 'pattern',
  '{"event_type": "lp.disposition_changed", "payload": {"disposition_code": "CXL"}}'::jsonb,
  NULL, NULL,
  '[{"action_type": "sync_confirmation_opportunity", "target_system": "ghl", "target_entity": "contact", "priority": 20, "params": {"disposition_code": "CXL"}}]'::jsonb,
  false, true, 20, 'claude',
  '4. Confirmation Pipeline (2026-10-16). One card per LP appointment; locked stages, hand moves and the 24h / close clock are in src/confirmation-pipeline/rules.js.'
  )
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category, rule_type = EXCLUDED.rule_type,
  event_pattern = EXCLUDED.event_pattern, conditions = EXCLUDED.conditions,
  context_conditions = EXCLUDED.context_conditions, action_template = EXCLUDED.action_template,
  requires_approval = EXCLUDED.requires_approval, enabled = EXCLUDED.enabled,
  priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = now();

-- Verify (expect 5 rows, all enabled):
-- SELECT json_agg(row_to_json(s)) FROM (SELECT rule_key, enabled, priority FROM agent_rules WHERE rule_key LIKE 'CONF_PIPE_%' ORDER BY rule_key) s;
