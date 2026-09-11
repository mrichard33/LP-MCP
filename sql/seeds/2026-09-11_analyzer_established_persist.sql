-- ============================================================================
-- Seed: ANALYZER_ESTABLISHED_PERSIST — write the fact down the first time
-- Date: 2026-09-11
-- Applied live: 2026-09-11 via LP MCP:supabase_run_query. THIS FILE DOCUMENTS
--               THE LIVE TABLE; re-running it is a no-op against the database
--               it describes.
-- Reload: POST /n8n/decision-engine/reload-rules -> rules_loaded 281
--         (280 enabled before, 281 after — one new rule)
--
-- INCIDENT
--   Alfredo Fontan (GHL VKMKhd8JQ4wsp3zMn8Lt, conversation mivvUZnKmGScwo5FoVUR,
--   LP lead 575210, ORL).
--
--   19:37:37Z  ai.analysis_completed event 3603318, on his inbound
--              "Just myself." The analyzer's own reasoning reads: "He is the
--              sole decision-maker." It said so in PROSE, in the `reasoning`
--              string, where nothing downstream can act on it. NOTHING
--              PERSISTED. GH1QGGOseMKmJAMqajiN stayed empty.
--
--   21:11:55Z  outbound yFkfGW3AOmm9M8Myk7W8:
--                "Fair point, Alfredo — close is close. To get the visit
--                 scheduled correctly, will it just be you home, or is there
--                 someone else who'd want to be there?"
--              The question he had answered 1h34m earlier, asked again.
--
--   21:25:22Z  agent_actions 448555, rule_applied QUALIFYING_DATA_PERSIST,
--              finally writes GH1QGGOseMKmJAMqajiN = "Solo Owner".
--              1h48m after the fact was known, and one repeat-ask too late.
--
--   The analyzer knew at 19:37. The write happened at 21:25. Everything that
--   went wrong lives in that gap.
--
-- WHAT THIS RULE DOES
--   Fires on every ai.analysis_completed that carries a non-null
--   `established_facts` object and queues ONE persist_established_facts action.
--   The facts themselves are resolved in code from the source event — see
--   "WHY NOT update_custom_fields" below.
--
-- WHY NOT update_custom_fields (the shape the handoff specified)
--   A template writing "only the fields present and non-null" is not
--   expressible, for three independent reasons verified in the repo:
--     1. agent_rules.action_template is static JSON — no conditional.
--     2. createActionsFromRule (src/decision-engine.js) copies tmpl.params into
--        action_payload VERBATIM; only send_message is rewritten at queue time.
--     3. executeUpdateCustomFields does no interpolation, and
--        interpolatePayload (src/actions/helpers.js) is SHALLOW — it maps over
--        array items but does not descend into objects, so it could never reach
--        fields[].field_value even if it were wired in.
--   So this rule carries NO values at all. It decides WHEN; the handler
--   (src/actions/handlers/established-facts.js) decides WHAT, and drops any
--   value outside the live select options rather than coercing it.
--
-- IRON LAW 1: conditions is NULL. All gating lives in context_conditions.
--
-- PRIORITY 75 — above AGENTIC_RESPOND_POST_CHATBOT (70), so the write is
--   QUEUED before the reply is generated. Note that the executor drains
--   GLOBALLY, not per-batch, so this ordering is BEST-EFFORT and not a
--   guarantee: a busy queue can still run the send first. The responder's
--   transcript fallback (src/agentic/established-facts.js, feat/established-facts)
--   is the real backstop and MUST NOT be removed on the strength of this rule.
--
-- DELIBERATELY UNCHANGED
--   QUALIFYING_DATA_PERSIST (src/send-message-handler.js:3323) stays exactly as
--   it is. Both paths writing the same value is harmless — GHL takes the same
--   write twice without complaint — and the second is a backstop for any turn
--   where the analyzer did not establish the fact but the responder did.
-- ============================================================================

BEGIN;

INSERT INTO agent_rules (
  rule_key, rule_name, category, rule_type, decision_point,
  event_pattern, conditions, context_conditions, action_template,
  priority, requires_approval, enabled, created_by, notes
)
VALUES (
  'ANALYZER_ESTABLISHED_PERSIST',
  'Analyzer established a fact from the lead''s own words → persist it to the contact record immediately',
  'INTELLIGENCE',
  'contextual',
  'message_inbound_classification',
  '{"event_type": "ai.analysis_completed"}'::jsonb,
  NULL,
  '{"payload_field_not_null": "established_facts", "not_has_tag": "stop-bot"}'::jsonb,
  '[{"params": {}, "action_type": "persist_established_facts", "target_entity": "contact", "target_system": "ghl"}]'::jsonb,
  75,
  'f',
  't',
  'claude',
  'Built from the Alfredo Fontan post-mortem 2026-09-11 (GHL VKMKhd8JQ4wsp3zMn8Lt). '
  'ai.analysis_completed 3603318 at 19:37:37Z concluded "He is the sole decision-maker" in PROSE and persisted nothing; '
  'GH1QGGOseMKmJAMqajiN was not written until 21:25:22Z by the responder path (agent_actions 448555, QUALIFYING_DATA_PERSIST), '
  '1h48m later and one repeat-ask too late — outbound yFkfGW3AOmm9M8Myk7W8 at 21:11:55Z re-asked the closed question AND conceded his objection. '
  'The analyzer now emits established_facts as DATA on the same event and this rule persists it at analysis time. '
  'action_template carries NO values: agent_rules templates are static JSON, createActionsFromRule copies tmpl.params verbatim, '
  'and interpolatePayload is shallow (it cannot reach fields[].field_value) — so the values are resolved in code by '
  'src/actions/handlers/established-facts.js, which drops any value outside the live select options rather than coercing it. '
  'requires_approval false: single-contact, additive, reversible field writes that never clear a field. '
  'PRIORITY 75 puts this above AGENTIC_RESPOND_POST_CHATBOT (70) so the write is QUEUED before the reply is generated, but the executor '
  'drains GLOBALLY — this ordering is BEST-EFFORT, not a guarantee. The responder-side transcript fallback in '
  'src/agentic/established-facts.js is the real backstop and must not be removed on the strength of this rule. '
  'QUALIFYING_DATA_PERSIST is deliberately KEPT: both paths writing the same value is harmless and the second is a backstop.'
)
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name          = EXCLUDED.rule_name,
  category           = EXCLUDED.category,
  rule_type          = EXCLUDED.rule_type,
  decision_point     = EXCLUDED.decision_point,
  event_pattern      = EXCLUDED.event_pattern,
  conditions         = EXCLUDED.conditions,
  context_conditions = EXCLUDED.context_conditions,
  action_template    = EXCLUDED.action_template,
  priority           = EXCLUDED.priority,
  requires_approval  = EXCLUDED.requires_approval,
  enabled            = EXCLUDED.enabled,
  notes              = EXCLUDED.notes;

COMMIT;

-- ============================================================================
-- VERIFY
-- ============================================================================
-- SELECT id, rule_key, priority, enabled, conditions, context_conditions, action_template
--   FROM agent_rules WHERE rule_key = 'ANALYZER_ESTABLISHED_PERSIST';
--
-- Expect: conditions NULL, priority 75, enabled true, requires_approval false,
--         and priority strictly greater than AGENTIC_RESPOND_POST_CHATBOT (70):
-- SELECT rule_key, priority FROM agent_rules
--  WHERE rule_key IN ('ANALYZER_ESTABLISHED_PERSIST','AGENTIC_RESPOND_POST_CHATBOT')
--  ORDER BY priority DESC;

-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- Disable first — it is reversible and keeps the row's history:
--
--   UPDATE agent_rules SET enabled = 'f'
--    WHERE rule_key = 'ANALYZER_ESTABLISHED_PERSIST';
--
-- Then reload: POST /n8n/decision-engine/reload-rules -> rules_loaded 280.
--
-- Full removal (only if the action type is also being unregistered from
-- src/actions/index.js — a queued action whose handler no longer exists fails
-- as an unknown action type):
--
--   DELETE FROM agent_rules WHERE rule_key = 'ANALYZER_ESTABLISHED_PERSIST';
--
-- Nothing this rule writes needs undoing at the contact level: the handler
-- only ever SETS a field to a value the lead stated, and never clears one.
-- To revert a specific contact, write the prior value back directly.
-- ============================================================================
