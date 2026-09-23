-- ============================================================================
-- Seed: INTAKE_ROUTE_BACKSTOP_OTHER_LATE — re-check E.5 routing after
--       ensure-routing-tags adds active-entry:other
-- Date: 2026-09-23
-- Applied live: AFTER the PR carrying the INTAKE_ROUTE_BACKSTOP_OTHER% dedup
--               group (src/decision-engine.js dedupPolicy) is deployed.
--               Applying it before that deploy can enroll a contact in E.5 twice.
--
-- WHAT
--   A second listener for rule 355's job. Same conditions, same E.5 action,
--   but fires on ghl.routing_tags_ensured (subtype 'other') instead of
--   contact.created, and also excludes active-e.0 (E.0 routes to E.5 itself).
--
-- WHY
--   n8n I.AP (ActiveProspect intake) creates the GHL contact WITHOUT
--   active-entry:other, then calls /webhook/ghl/ensure-routing-tags, which adds
--   it ~6-10s later. Rule 355 evaluates contact.created, fails has_tag, and
--   nothing re-checks. Live 2026-09-23: 229 ap-intake-created contacts created
--   in the prior 14 days still sat at stage:new-lead with no agentic-active and
--   no rule-355 action (mostly Sept 10-15, 0-9/day since). Proof pair:
--   system_events 3810919 (contact.created, no active-entry tag) ->
--   3810922 (ghl.routing_tags_ensured, previous_tags without it,
--   tags_written with active-entry:other). ensure-routing-tags only writes and
--   emits when the contact had NO active-entry:* — exactly 355's blind spot.
--
--   The 229 are NOT backfilled (Mark, 2026-09-23): fix going forward only.
--
-- DOUBLE-ENTRY GUARD
--   has_tag reads the contact live, so a late-processed contact.created could
--   pass 355 AND this rule. dedupPolicy puts both keys in one group
--   ('INTAKE_ROUTE_BACKSTOP_OTHER%') that blocks on pending..completed for 30
--   min per contact.
--
-- USER-VISIBLE IMPACT
--   ActiveProspect / backstop leads routed to active-entry:other after creation
--   now enter E.5 instead of sitting unrouted.
-- ============================================================================

INSERT INTO agent_rules
 (rule_key, rule_name, category, rule_type, event_pattern, conditions,
  context_conditions, action_template, requires_approval, enabled, priority,
  created_by, notes)
VALUES
 ('INTAKE_ROUTE_BACKSTOP_OTHER_LATE',
  'Intake backstop (late tags): route active-entry:other leads into E.5 after ensure-routing-tags',
  'attribution', 'contextual',
  '{"event_type": "ghl.routing_tags_ensured", "event_subtype": "other"}'::jsonb,
  NULL,
  '{"has_tag": "active-entry:other",
    "has_any_tag": ["lp-backstop-created", "ap-intake-created"],
    "not_has_any_tag": ["suppress-outbound","stop-bot","dnc","dnc-sms",
                        "do-not-contact","stage:dnc","unsubscribed",
                        "active-e.5","active-e.0"]}'::jsonb,
  '[{"action_type":"add_to_workflow","target_system":"ghl","target_entity":"contact",
     "params":{"format":"form",
               "webhook_url":"https://services.leadconnectorhq.com/hooks/SsBG7j5KQAIP1SFP2Sca/webhook-trigger/b438b1a2-04c0-4b25-98a6-e16832f80cee",
               "workflow_name":"E.5 Unknown Source Bridge",
               "canonical_code":"E.5",
               "canonical_name":"E.5 Unknown Source Bridge",
               "payload":{"source":"intake_backstop","entry_route_rule":"INTAKE_ROUTE_BACKSTOP_OTHER_LATE"}}}]'::jsonb,
  FALSE, TRUE, 60, 'claude',
  'Added 2026-09-23. Companion to INTAKE_ROUTE_BACKSTOP_OTHER (355). WHY: n8n I.AP creates contacts without active-entry:other; ensure-routing-tags adds it ~6-10s after contact.created, so 355 failed has_tag and 229 AP contacts in 14 days never reached a bridge. This rule re-checks on ghl.routing_tags_ensured (emitted only when the contact had no active-entry:*). Same guards and E.5 action as 355, plus active-e.0 (E.0 routes to E.5 itself). Deduped against 355 via the INTAKE_ROUTE_BACKSTOP_OTHER% group in dedupPolicy — never apply before that code is deployed. Stranded 229 not backfilled (Mark).')
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category,
  rule_type = EXCLUDED.rule_type, event_pattern = EXCLUDED.event_pattern,
  conditions = NULL, context_conditions = EXCLUDED.context_conditions,
  action_template = EXCLUDED.action_template,
  requires_approval = EXCLUDED.requires_approval, enabled = EXCLUDED.enabled,
  priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = NOW();

-- After apply:
--   POST https://lp-mcp-production.up.railway.app/n8n/decision-engine/reload-rules
--   assert rules_loaded = previous enabled count + 1

-- Verify a firing:
--   SELECT json_agg(row_to_json(s)) FROM (
--     SELECT target_id, status, execution_result, created_at FROM agent_actions
--     WHERE rule_applied = 'INTAKE_ROUTE_BACKSTOP_OTHER_LATE'
--     ORDER BY created_at DESC LIMIT 5) s;
--   No contact should carry completed actions from BOTH rule keys:
--   SELECT json_agg(row_to_json(s)) FROM (
--     SELECT target_id, array_agg(DISTINCT rule_applied) rules FROM agent_actions
--     WHERE rule_applied LIKE 'INTAKE_ROUTE_BACKSTOP_OTHER%' AND created_at > '2026-09-23'
--     GROUP BY target_id HAVING count(DISTINCT rule_applied) > 1) s;

-- ROLLBACK:
--   WITH u AS (UPDATE agent_rules SET enabled = FALSE, updated_at = NOW()
--              WHERE rule_key = 'INTAKE_ROUTE_BACKSTOP_OTHER_LATE' RETURNING 1)
--   SELECT count(*) FROM u;
--   then reload and assert rules_loaded = count - 1.
