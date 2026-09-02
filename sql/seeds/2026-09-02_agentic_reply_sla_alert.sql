-- ════════════════════════════════════════════════════════════════════
-- AGENTIC_REPLY_SLA_ALERT — a reply the bot owns is past the SLA with no send
-- 2026-09-02  (Jacqueline Branham, gpPQYhCsqdGy10wU14Rp)
--
-- Consumes agentic.reply_unanswered with reason = no_send_within_sla, emitted
-- by src/jobs/reply-sla-watchdog.js when REPLY_SLA_WATCHDOG_MODE=live. The
-- watchdog already enforces agentic-active + no stop-bot/consent tag from the
-- tag snapshot, so — like AGENTIC_REPLY_UNANSWERED_ALERT — this rule carries
-- NO tag verbs (has_tag fails closed on an unreadable read, which would mute
-- the alert). The shadow reason (no_send_within_sla_shadow) is NOT matched.
-- ════════════════════════════════════════════════════════════════════
BEGIN;

INSERT INTO agent_rules
  (rule_key, rule_name, category, rule_type, event_pattern, context_conditions,
   action_template, requires_approval, enabled, priority, notes)
VALUES
('AGENTIC_REPLY_SLA_ALERT',
 'Bot-owned reply past SLA with no completed send — escalate to human',
 'observability', 'contextual',
 '{"event_type": "agentic.reply_unanswered"}'::jsonb,
 '{"payload_field_eq": {"field": "reason", "value": "no_send_within_sla"}}'::jsonb,
 '[{"action_type": "send_notification", "target_system": "groupme", "target_entity": "contact",
    "params": {"tier": "Imminent",
               "status": "Lead unanswered past SLA",
               "notification_class": "priority",
               "action_verb": "BOT REPLY OVERDUE",
               "act_within": "15 minutes",
               "narrative": "This lead replied {{age_minutes}} minutes ago and the bot has not completed a reply (SLA {{sla_minutes}} min). The bot owns this conversation. Their message: \"{{message_preview}}\" (source event {{source_event_id}}).",
               "next_step": "Open the conversation in GHL and reply manually, then check the agent_actions row for this contact."}},
   {"action_type": "create_task", "target_system": "ghl", "target_entity": "contact",
    "params": {"title": "Bot reply overdue — answer this lead manually",
               "description": "The contact replied {{age_minutes}} minutes ago and no bot reply has completed (SLA {{sla_minutes}} min). The bot owns this conversation (agentic-active, no stop-bot). Their message: \"{{message_preview}}\". Source event: {{source_event_id}}."}}]'::jsonb,
 FALSE, TRUE, 200,
 'Consumes agentic.reply_unanswered reason=no_send_within_sla from src/jobs/reply-sla-watchdog.js (2026-09-02). Per-contact guarantee independent of which internal path failed: analyzed-then-stalled, queue starvation, handler timeout, or anything not yet named. The watchdog enforces ownership + consent from contact_tag_snapshot, so this rule carries no tag verbs. Shadow reason is deliberately not matched — flip REPLY_SLA_WATCHDOG_MODE=live after a clean shadow week.')
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category,
  rule_type = EXCLUDED.rule_type, event_pattern = EXCLUDED.event_pattern,
  context_conditions = EXCLUDED.context_conditions, action_template = EXCLUDED.action_template,
  requires_approval = EXCLUDED.requires_approval, enabled = EXCLUDED.enabled,
  priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = NOW();

COMMIT;

-- After apply: POST /n8n/decision-engine/reload-rules — assert rules_loaded +1.
-- Rollback: UPDATE agent_rules SET enabled = FALSE, updated_at = NOW()
--   WHERE rule_key = 'AGENTIC_REPLY_SLA_ALERT';  then reload.
