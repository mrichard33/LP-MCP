-- ============================================================================
-- Seed: one front door — intake leads enter through E.0 Master Router
--   + INTAKE_ROUTE_BACKSTOP_E0 (new)
--   - INTAKE_ROUTE_BACKSTOP_OTHER (355), _OTHER_LATE (378), _HID (379),
--     _HID_LATE (380) disabled (rows kept for rollback)
-- Date: 2026-09-24
--
-- APPLY ONLY WHEN BOTH ARE LIVE:
--   1. The PR adding add_to_workflow format 'json_custom_data'
--      (src/actions/handlers/workflows.js) is deployed. Without it E.0's
--      Find Contact step matches nobody and every intake lead goes unrouted.
--   2. Mark's E.0 edits are published in GHL:
--        a) step 9 "Already Active" exits on ANY of active-e.0, active-e.5,
--           active-w07, stage:entry-bridge (double-entry guard for every path
--           into E.0 — this rule, I.LP-IN, the opportunity trigger)
--        b) step 52 High-Intent Digital branch also matches tag
--           active-entry:high-intent-digital (else Swish leads fall to Other,
--           fail "Check Valid Entry" and exit with no bridge)
--
-- WHY
--   Mark, 2026-09-24: every lead should enter the system the same way, with E.0
--   choosing the bridge. The four direct-to-bridge rules bypassed E.0. E.0 also
--   runs ensure-routing-tags itself (step 29) before it branches, so the
--   late-tags race the _LATE rules existed for no longer applies — this rule
--   needs no active-entry:* tag at all.
--
-- DOUBLE ENTRY
--   Our side: the key is in the INTAKE_ROUTE_BACKSTOP_% dedup group
--   (dedupPolicy) — at most one intake POST per contact per 30 min.
--   E.0 side: edit (a) above.
-- ============================================================================

BEGIN;

INSERT INTO agent_rules
 (rule_key, rule_name, category, rule_type, event_pattern, conditions,
  context_conditions, action_template, requires_approval, enabled, priority,
  created_by, notes)
VALUES
 ('INTAKE_ROUTE_BACKSTOP_E0',
  'Intake backstop: route new intake leads through E.0 Master Router',
  'attribution', 'contextual',
  '{"event_type": "contact.created"}'::jsonb,
  NULL,
  '{"has_any_tag": ["ap-intake-created", "lp-backstop-created"],
    "not_has_any_tag": ["suppress-outbound","stop-bot","dnc","dnc-sms",
                        "do-not-contact","stage:dnc","unsubscribed",
                        "active-e.0","active-e.5","active-w07","stage:entry-bridge"]}'::jsonb,
  '[{"action_type":"add_to_workflow","target_system":"ghl","target_entity":"contact",
     "params":{"format":"json_custom_data",
               "webhook_url":"https://services.leadconnectorhq.com/hooks/SsBG7j5KQAIP1SFP2Sca/webhook-trigger/0ac2b756-81ef-42ae-aeed-e9ab4bfaf374",
               "workflow_name":"E.0 Master Router",
               "canonical_code":"E.0",
               "canonical_name":"E.0 Master Router",
               "payload":{"source":"intake_backstop","entry_route_rule":"INTAKE_ROUTE_BACKSTOP_E0"}}}]'::jsonb,
  FALSE, TRUE, 60, 'claude',
  'Added 2026-09-24 (Mark: every lead enters the same way). Replaces 355/378/379/380, which posted straight to E.5/E.7. Posts intake contacts (ap-intake-created / lp-backstop-created) to E.0 Master Router, which runs ensure-routing-tags and picks the bridge (other -> E.5, high-intent-digital -> E.7). format json_custom_data because E.0 finds the contact via customData.ghl_contact_id. Requires Mark''s E.0 edits: step 9 exits on active-e.0/active-e.5/active-w07/stage:entry-bridge; step 52 HID branch matches active-entry:high-intent-digital. Deduped with every INTAKE_ROUTE_BACKSTOP_* key.')
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category,
  rule_type = EXCLUDED.rule_type, event_pattern = EXCLUDED.event_pattern,
  conditions = NULL, context_conditions = EXCLUDED.context_conditions,
  action_template = EXCLUDED.action_template,
  requires_approval = EXCLUDED.requires_approval, enabled = EXCLUDED.enabled,
  priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = NOW();

UPDATE agent_rules
SET enabled = FALSE,
    notes = notes || ' | Disabled 2026-09-24: superseded by INTAKE_ROUTE_BACKSTOP_E0 (intake leads now enter via E.0).',
    updated_at = NOW()
WHERE rule_key IN ('INTAKE_ROUTE_BACKSTOP_OTHER', 'INTAKE_ROUTE_BACKSTOP_OTHER_LATE',
                   'INTAKE_ROUTE_BACKSTOP_HID', 'INTAKE_ROUTE_BACKSTOP_HID_LATE')
  AND enabled = TRUE;

COMMIT;

-- After apply:
--   SELECT count(*) FROM agent_rules WHERE enabled;   -- expect previous - 3
--   POST https://lp-mcp-production.up.railway.app/n8n/decision-engine/reload-rules
--   assert rules_loaded = previous enabled count - 3

-- Verify a firing:
--   SELECT json_agg(row_to_json(s)) FROM (
--     SELECT target_id, status, execution_result, created_at FROM agent_actions
--     WHERE rule_applied = 'INTAKE_ROUTE_BACKSTOP_E0'
--     ORDER BY created_at DESC LIMIT 5) s;
--   then in HL contacts: active-e.0 briefly, then active-e.5 (other) or
--   active-w07 + stage:entry-bridge (high-intent-digital).

-- ROLLBACK (restores direct-to-bridge routing):
--   BEGIN;
--   UPDATE agent_rules SET enabled = FALSE, updated_at = NOW()
--    WHERE rule_key = 'INTAKE_ROUTE_BACKSTOP_E0';
--   UPDATE agent_rules SET enabled = TRUE, updated_at = NOW()
--    WHERE rule_key IN ('INTAKE_ROUTE_BACKSTOP_OTHER','INTAKE_ROUTE_BACKSTOP_OTHER_LATE',
--                       'INTAKE_ROUTE_BACKSTOP_HID','INTAKE_ROUTE_BACKSTOP_HID_LATE');
--   COMMIT;
--   then reload and assert rules_loaded = count + 3.
--   Mark's E.0 edits are safe to keep either way.
