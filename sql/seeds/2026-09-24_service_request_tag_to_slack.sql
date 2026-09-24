-- ═══════════════════════════════════════════════════════════════════════════
-- SERVICE_REQUEST_TAG_TO_SLACK — 2026-09-24
-- WHAT  customer-service-request OR needs-human-followup tag → one plain-English
--       card in #service-<market> (Lakeland office → #service-lakeland).
-- WHY   Both tags were dropped at intake and had no consumer. Steven Homenda
--       (6MwOwIzUQ3mjBCOdaEh7) reported broken slider screens via chat on
--       2026-09-17; no service channel was ever told.
-- ORDER Apply ONLY after this PR's deploy is ACTIVE.
--       Earlier, the intake filter still drops the events (harmless), but a
--       firing on old code would post the generic card with no Lakeland routing.
-- NOTES No DNC/stop-bot gate on purpose: this is an internal card, never sent
--       to the customer, and a DNC customer with a leak still needs service.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

INSERT INTO agent_rules
  (rule_key, rule_name, category, event_pattern, conditions, context_conditions,
   action_template, requires_approval, enabled, priority, rule_type, created_by, notes)
VALUES (
  'SERVICE_REQUEST_TAG_TO_SLACK',
  'Service request tag → market service channel in Slack',
  'observability',
  '{"event_type": "ghl.tag_added"}'::jsonb,
  NULL,
  '{"event_subtype_in": ["customer-service-request", "needs-human-followup"]}'::jsonb,
  '[
    {"action_type": "send_notification", "target_system": "groupme", "target_entity": "contact",
     "priority": 20,
     "params": {"card": "service", "channel": "service", "flush_now": true}}
  ]'::jsonb,
  FALSE, TRUE, 190, 'contextual', 'claude',
  '2026-09-24 (Claude). card=service → src/actions/service-card.js builds the plain-English card (name, phone, what they need) and routes Lakeland-office records to LAKE, everyone else to their own market, no market → #contact-center. Both tags usually land in the same second; the card claims service-request:<contactId> in groupme_notification_marks so only one posts per 60 min.'
)
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category,
  event_pattern = EXCLUDED.event_pattern, conditions = EXCLUDED.conditions,
  context_conditions = EXCLUDED.context_conditions, action_template = EXCLUDED.action_template,
  requires_approval = EXCLUDED.requires_approval, enabled = EXCLUDED.enabled,
  priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = now();

COMMIT;

-- Rollback:
--   UPDATE agent_rules SET enabled = FALSE, updated_at = now()
--    WHERE rule_key = 'SERVICE_REQUEST_TAG_TO_SLACK';
--   then POST /n8n/decision-engine/reload-rules.
