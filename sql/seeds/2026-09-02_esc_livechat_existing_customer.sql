-- 2026-09-02 — ESC_LIVECHAT_EXISTING_CUSTOMER
--
-- WHY: ESC_EXISTING_CUSTOMER (enabled, correct) fires only on
-- ai.analysis_completed, which the live-chat channel never produces. A
-- closed-won customer asking for service through the chat widget therefore
-- produced no task and no notification. Confirmed on m4Yx7n8XVDb8QnxfUsio.
--
-- Pairs with behavioral-emitter v2.16, which starts emitting
-- ghl.reply_channel_excluded (event_subtype='livechat') for that channel.
--
-- rule_type MUST be 'contextual' — findMatchingRules only evaluates
-- context_conditions for contextual rules (W11_1_REMOVE_CUSTOMERS precedent).
--
-- THROTTLE: not_has_any_tag includes 'esc:existing-customer', which the rule's
-- own first action applies. One escalation per open service issue; the rule
-- re-arms when service clears the tag.

INSERT INTO agent_rules (
  rule_key, rule_name, category, rule_type,
  event_pattern, conditions, context_conditions, action_template,
  requires_approval, enabled, priority, version, created_by, notes
) VALUES (
  'ESC_LIVECHAT_EXISTING_CUSTOMER',
  'Escalation: existing-customer service request via live chat',
  'behavioral',
  'contextual',
  '{"event_type":"ghl.reply_channel_excluded","event_subtype":"livechat"}'::jsonb,
  NULL,
  '{"has_any_tag":["deal-won","lp-status:closed-won","customer","sw-customer","closed-won"],"not_has_any_tag":["stop-bot","esc:existing-customer","dnc","do-not-contact"]}'::jsonb,
  '[
    {"action_type":"add_tag","target_entity":"contact","target_system":"ghl",
     "params":{"tag":"esc:existing-customer"}},
    {"action_type":"create_task","target_entity":"contact","target_system":"ghl",
     "params":{"title":"EXISTING CUSTOMER service request (live chat) — same-day",
               "priority":"high",
               "description":"Closed-won customer contacted us through live chat with a service or product question. NO selling logic — route to service with a SAME-DAY expectation set. Chat text on contact notes."}},
    {"action_type":"send_notification","target_entity":"contact","target_system":"groupme",
     "params":{"tier":"Hot","status":"Service","action_verb":"CUSTOMER SERVICE (LIVE CHAT)",
               "message":"Existing-customer service request in live chat: \"{{message_text}}\"",
               "narrative":"Closed-won customer came back through the chat widget with a service question. The agentic bot does not answer live chat — a human must.",
               "next_step":"Route to service today",
               "notification_class":"priority"}},
    {"action_type":"add_note","target_entity":"contact","target_system":"ghl",
     "params":{"next_step":"Service team, same-day contact.","include_context_summary":true}}
  ]'::jsonb,
  false, true, 110, 1, 'claude-code',
  'Live-chat twin of ESC_EXISTING_CUSTOMER. Same actions, different trigger event, no send_message (agentic bot is permanently excluded from live chat). Throttled by its own esc:existing-customer tag.'
);
