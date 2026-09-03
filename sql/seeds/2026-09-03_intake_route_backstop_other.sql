-- ============================================================================
-- Seed: INTAKE_ROUTE_BACKSTOP_OTHER (agent_rules id 355)
-- Date: 2026-09-03
-- Applied live: 2026-09-03 12:22 UTC via LP MCP:supabase_run_query
-- Reload: POST /n8n/decision-engine/reload-rules -> rules_loaded 278 -> 279
-- First verified firing: contact kfNhTvHaKFhptkatBpGv (LP 572604), backstop
--   sweep at 12:30 UTC; agent_actions completed 12:31 UTC; contact carried
--   stage:entry-bridge + active-e.5 + agentic-active by 12:33 UTC.
--
-- WHAT: When the LP intake backstop creates a GHL contact for a purchased /
--   vendor lead (contact.created + lp-backstop-created + active-entry:other),
--   enroll it in E.5 Unknown Source Bridge via E.5's inbound webhook.
--
-- WHY: Audit 2026-09-02 found 280 new GHL contacts, 11 of which received any
--   GHL message. 195 were backstop-created and never routed:
--     - I.AC (All Contacts Created) trigger was edited 2026-08-31 to
--       `tagsAdded contains-none lp-backstop-created`.
--     - E.0 Master Router only fires from the agentic inbound webhook, a P1
--       opportunity-created trigger, or the HRR form.
--     - The backstop emits `contact.created` (GHL native ContactCreate).
--       Zero agent_rules listened to that event type.
--   Net effect: ~195 purchased leads/day landed at stage:new-lead with no
--   speed-to-lead, no nurture, no agentic bot. Only the LP dialer touched them.
--
-- USER-VISIBLE IMPACT: vendor leads (Modernize, MyHomePros, Lead Gurus,
--   HomeBuddy, radio, affiliates, etc.) now enter E.5 within one backstop
--   sweep (<=15 min) of arriving in LP. E.5 owns the customer/DQ/stop gate and
--   the already-booked check. NOTE: E.5's first SMS currently sits behind a
--   30-day wait; Mark is moving it to Day 0 in the GHL UI (manual edit).
--
-- SCOPE: active-entry:other ONLY. Canvass / referral / high-intent backstop
--   leads route via I.CC and the ghl.contact_created hygiene family.
--   suppress-outbound (stale/backlog) leads are excluded by design.
--   DNC family, stop-bot, active-e.5, agentic-active re-read at fire time.
-- ============================================================================

INSERT INTO agent_rules
 (rule_key, rule_name, category, rule_type, event_pattern, conditions,
  context_conditions, action_template, requires_approval, enabled, priority,
  created_by, notes)
VALUES
 ('INTAKE_ROUTE_BACKSTOP_OTHER',
  'Intake backstop: route active-entry:other leads into E.5',
  'attribution', 'contextual',
  '{"event_type": "contact.created"}'::jsonb,
  NULL,
  '{"has_tag": "lp-backstop-created",
    "has_any_tag": ["active-entry:other"],
    "not_has_any_tag": ["suppress-outbound","stop-bot","dnc","dnc-sms",
                        "do-not-contact","stage:dnc","unsubscribed",
                        "active-e.5","agentic-active"]}'::jsonb,
  '[{"action_type":"add_to_workflow","target_system":"ghl","target_entity":"contact",
     "params":{"format":"form",
               "webhook_url":"https://services.leadconnectorhq.com/hooks/SsBG7j5KQAIP1SFP2Sca/webhook-trigger/b438b1a2-04c0-4b25-98a6-e16832f80cee",
               "workflow_name":"E.5 Unknown Source Bridge",
               "canonical_code":"E.5",
               "canonical_name":"E.5 Unknown Source Bridge",
               "payload":{"source":"intake_backstop","entry_route_rule":"INTAKE_ROUTE_BACKSTOP_OTHER"}}}]'::jsonb,
  FALSE, TRUE, 60, 'claude',
  'Added 2026-09-03. WHY: I.AC excludes lp-backstop-created (edited 2026-08-31) and E.0 only fires from agentic webhook / P1 opportunity / HRR form, so ~195 purchased leads/day landed at stage:new-lead with no routing (audit 2026-09-02: 11 of 280 new contacts got any GHL message). Backstop emits contact.created; no rule listened. Enrolls active-entry:other backstop leads in E.5, which owns the customer/DQ/booked gates. Canvass/referral/high-intent backstop leads NOT covered (route via I.CC / ghl.contact_created hygiene). Suppress-outbound leads excluded by design.')
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
--     SELECT status, execution_result, created_at FROM agent_actions
--     WHERE rule_applied = 'INTAKE_ROUTE_BACKSTOP_OTHER'
--     ORDER BY created_at DESC LIMIT 5) s;

-- ROLLBACK:
--   WITH u AS (UPDATE agent_rules SET enabled = FALSE, updated_at = NOW()
--              WHERE rule_key = 'INTAKE_ROUTE_BACKSTOP_OTHER' RETURNING 1)
--   SELECT count(*) FROM u;
--   then reload and assert rules_loaded = count - 1.
