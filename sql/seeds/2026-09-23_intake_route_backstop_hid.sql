-- ============================================================================
-- Seed: INTAKE_ROUTE_BACKSTOP_HID + INTAKE_ROUTE_BACKSTOP_HID_LATE
--       route intake-created active-entry:high-intent-digital contacts into E.7
-- Date: 2026-09-23
-- Applied live: AFTER the PR that widens the dedupPolicy group to
--               'INTAKE_ROUTE_BACKSTOP_%' (src/decision-engine.js) is deployed.
--               Before that deploy these keys are not deduped at all.
--
-- WHAT
--   The E.7 counterpart of the E.5 pair (355 INTAKE_ROUTE_BACKSTOP_OTHER and
--   378 INTAKE_ROUTE_BACKSTOP_OTHER_LATE):
--     _HID       on contact.created — contacts the AP intake now creates already
--                tagged from lp_source_mapping (src/ap-intake.js, same PR)
--     _HID_LATE  on ghl.routing_tags_ensured (subtype high-intent-digital) —
--                contacts n8n I.AP creates untagged, which ensure-routing-tags
--                tags from the map ~6-10s later
--   Both enroll E.7 High-Intent Digital Bridge through its Inbound Agentic
--   Trigger (a4018fa3), whose first step finds the contact by
--   inboundWebhookRequest.contact_id — the same shape rule 355 posts to E.5.
--
-- WHY
--   Mark ruled all Swish Leads traffic high-intent-digital on 2026-09-14
--   (lp_source_mapping notes). No rule sent intake/backstop high-intent contacts
--   anywhere: rule 355's own notes excluded them ("route via I.AC / hygiene"),
--   but I.AC excludes lp-backstop-created and the hygiene rules only fire for
--   landing-page / voice-AI subtypes. Live 2026-09-23: 8 ap-intake-created Swish
--   contacts sat at stage:new-lead with active-entry:high-intent-digital and no
--   bridge. Mark: fix going forward, do NOT enroll those 8.
--
-- GUARDS
--   Same DNC / suppression family as 355, plus: active-w07 and
--   stage:entry-bridge (E.7's own in-flight markers), active-e.5 (already in the
--   E.5 lane), active-e.0 (E.0 routes to E.7 itself). Double enrollment across
--   all four intake keys is blocked by the shared dedup group.
-- ============================================================================

INSERT INTO agent_rules
 (rule_key, rule_name, category, rule_type, event_pattern, conditions,
  context_conditions, action_template, requires_approval, enabled, priority,
  created_by, notes)
VALUES
 ('INTAKE_ROUTE_BACKSTOP_HID',
  'Intake backstop: route active-entry:high-intent-digital leads into E.7',
  'attribution', 'contextual',
  '{"event_type": "contact.created"}'::jsonb,
  NULL,
  '{"has_tag": "active-entry:high-intent-digital",
    "has_any_tag": ["lp-backstop-created", "ap-intake-created"],
    "not_has_any_tag": ["suppress-outbound","stop-bot","dnc","dnc-sms",
                        "do-not-contact","stage:dnc","unsubscribed",
                        "active-w07","stage:entry-bridge","active-e.5","active-e.0"]}'::jsonb,
  '[{"action_type":"add_to_workflow","target_system":"ghl","target_entity":"contact",
     "params":{"format":"form",
               "webhook_url":"https://services.leadconnectorhq.com/hooks/SsBG7j5KQAIP1SFP2Sca/webhook-trigger/a4018fa3-a128-434a-9758-c76ff89006ad",
               "workflow_name":"E.7 High-Intent Digital Bridge",
               "canonical_code":"E.7",
               "canonical_name":"E.7 High-Intent Digital Bridge",
               "payload":{"source":"intake_backstop","entry_route_rule":"INTAKE_ROUTE_BACKSTOP_HID"}}}]'::jsonb,
  FALSE, TRUE, 60, 'claude',
  'Added 2026-09-23. E.7 counterpart of INTAKE_ROUTE_BACKSTOP_OTHER (355). Mark ruled Swish Leads high-intent-digital (2026-09-14) but no rule routed intake/backstop high-intent contacts: 8 Swish contacts sat with active-entry:high-intent-digital and no bridge. Fires on contact.created for contacts the AP intake creates already tagged from lp_source_mapping. Guards: suppression family + active-w07/stage:entry-bridge (E.7 in flight), active-e.5, active-e.0. Deduped with every INTAKE_ROUTE_BACKSTOP_* key (dedupPolicy). The 8 stranded were NOT enrolled (Mark).'),
 ('INTAKE_ROUTE_BACKSTOP_HID_LATE',
  'Intake backstop (late tags): route active-entry:high-intent-digital leads into E.7 after ensure-routing-tags',
  'attribution', 'contextual',
  '{"event_type": "ghl.routing_tags_ensured", "event_subtype": "high-intent-digital"}'::jsonb,
  NULL,
  '{"has_tag": "active-entry:high-intent-digital",
    "has_any_tag": ["lp-backstop-created", "ap-intake-created"],
    "not_has_any_tag": ["suppress-outbound","stop-bot","dnc","dnc-sms",
                        "do-not-contact","stage:dnc","unsubscribed",
                        "active-w07","stage:entry-bridge","active-e.5","active-e.0"]}'::jsonb,
  '[{"action_type":"add_to_workflow","target_system":"ghl","target_entity":"contact",
     "params":{"format":"form",
               "webhook_url":"https://services.leadconnectorhq.com/hooks/SsBG7j5KQAIP1SFP2Sca/webhook-trigger/a4018fa3-a128-434a-9758-c76ff89006ad",
               "workflow_name":"E.7 High-Intent Digital Bridge",
               "canonical_code":"E.7",
               "canonical_name":"E.7 High-Intent Digital Bridge",
               "payload":{"source":"intake_backstop","entry_route_rule":"INTAKE_ROUTE_BACKSTOP_HID_LATE"}}}]'::jsonb,
  FALSE, TRUE, 60, 'claude',
  'Added 2026-09-23. Late-tags companion to INTAKE_ROUTE_BACKSTOP_HID, same pattern as 378 for E.5: n8n I.AP creates contacts untagged and ensure-routing-tags adds active-entry:high-intent-digital ~6-10s after contact.created, so a contact.created rule cannot see it. Fires on ghl.routing_tags_ensured subtype high-intent-digital (emitted only when the contact had no active-entry:*). Same guards and E.7 action; deduped with every INTAKE_ROUTE_BACKSTOP_* key.')
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category,
  rule_type = EXCLUDED.rule_type, event_pattern = EXCLUDED.event_pattern,
  conditions = NULL, context_conditions = EXCLUDED.context_conditions,
  action_template = EXCLUDED.action_template,
  requires_approval = EXCLUDED.requires_approval, enabled = EXCLUDED.enabled,
  priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = NOW();

-- After apply:
--   POST https://lp-mcp-production.up.railway.app/n8n/decision-engine/reload-rules
--   assert rules_loaded = previous enabled count + 2

-- Verify a firing (first Swish lead after deploy):
--   SELECT json_agg(row_to_json(s)) FROM (
--     SELECT target_id, rule_applied, status, execution_result, created_at FROM agent_actions
--     WHERE rule_applied LIKE 'INTAKE_ROUTE_BACKSTOP_HID%'
--     ORDER BY created_at DESC LIMIT 5) s;
--   then that contact carries active-w07 + stage:entry-bridge in HL contacts.
--   No contact may carry actions from two INTAKE_ROUTE_BACKSTOP_* keys:
--   SELECT json_agg(row_to_json(s)) FROM (
--     SELECT target_id, array_agg(DISTINCT rule_applied) rules FROM agent_actions
--     WHERE rule_applied LIKE 'INTAKE_ROUTE_BACKSTOP_%' AND created_at > '2026-09-23'
--     GROUP BY target_id HAVING count(DISTINCT rule_applied) > 1) s;

-- ROLLBACK:
--   WITH u AS (UPDATE agent_rules SET enabled = FALSE, updated_at = NOW()
--              WHERE rule_key IN ('INTAKE_ROUTE_BACKSTOP_HID','INTAKE_ROUTE_BACKSTOP_HID_LATE')
--              RETURNING 1)
--   SELECT count(*) FROM u;
--   then reload and assert rules_loaded = count - 2.
--   To also return Swish contacts to the E.5 lane at creation, revert the
--   src/ap-intake.js change (or set ENTRY_RESOLVER_MAP_DRIVEN=false, which also
--   disables the map everywhere else).
