-- ════════════════════════════════════════════════════════════════════
-- AGENTIC_REPLY_UNANSWERED_ALERT — the bot owned it and still said nothing
-- 2026-08-03  (agentic silence incident follow-up; pairs with PR #614)
--
-- WHAT: consumes `agentic.reply_unanswered`, emitted by
--   runReplyBackstopIfAnalyzerSilent() in src/decision-engine.js (PR #614).
--   Fires ONLY on payload.reason = 'backstop_matched_zero_actions': the
--   analyzer went silent, the contact IS agentic-owned, AGENTIC_ACTIVE_REPLY_
--   BACKSTOP matched, and it STILL produced no action (suppression, outbound
--   lock, or dedup swallowed it). A lead the bot owns is sitting unanswered.
--   Raises a priority GroupMe page + a GHL note/task so a human takes over.
--
-- WHY: on 2026-08-03 12:12–19:16 UTC the agentic bot answered nobody. Seven
--   replies across five contacts were dropped with zero telemetry — 0
--   ai.analysis_failed rows in system_events against 39 in
--   system_events_filtered over the preceding 14 days. PR #614 made the
--   failures land and made the backstop reachable; this rule is the paging
--   layer on the one case that is unambiguously a defect.
--
-- WHY NOT the other reason: `analyzer_silent_and_backstop_unmatched` is
--   deliberately NOT alerted. That branch is dominated by contacts the bot
--   does not own or who carry stop-bot — 16 of 94 replies (17%) over the 14d
--   to 2026-08-03 — where silence is CORRECT. Paging on it would open rep
--   tasks instructing humans to manually contact people who opted out. That
--   is the exact "cries wolf on the normal case" failure src/agentic-silence-
--   alerts.js was written to avoid; aggregate outage detection lives there,
--   not here. The unmatched branch stays queryable telemetry only.
--
-- WHY NO TAG VERBS: has_tag / not_has_tag fail CLOSED on an unreadable GHL
--   read, which would silently mute the very alert this exists to guarantee.
--   The backstop already enforces agentic-active + not stop-bot upstream, so
--   the ownership gate is implicit and needs no second, failure-prone read.
--   payload_field_eq is pure — it reads the event payload, no I/O.
--
-- NOTE: `due_in_hours` is deliberately omitted from create_task. The handler
--   (src/actions/handlers/tasks.js executeCreateTask) reads only title,
--   description and assigned_to — AGENTIC_REPLY_DROPPED_ALERT (rule 341)
--   ships due_in_hours and it has never done anything.
-- ════════════════════════════════════════════════════════════════════
BEGIN;

INSERT INTO agent_rules
  (rule_key, rule_name, category, rule_type, event_pattern, context_conditions,
   action_template, requires_approval, enabled, priority, notes)
VALUES
('AGENTIC_REPLY_UNANSWERED_ALERT',
 'Bot owned the conversation and produced no reply — escalate to human',
 'observability', 'contextual',
 '{"event_type": "agentic.reply_unanswered"}'::jsonb,
 '{"payload_field_eq": {"field": "reason", "value": "backstop_matched_zero_actions"}}'::jsonb,
 '[{"action_type": "send_notification", "target_system": "groupme", "target_entity": "contact",
    "params": {"tier": "Imminent",
               "status": "Lead unanswered — bot produced nothing",
               "notification_class": "priority",
               "action_verb": "BOT SILENT",
               "act_within": "15 minutes",
               "narrative": "The message analyzer failed for this lead and the agentic backstop matched but created ZERO actions — suppression, an outbound lock, or dedup swallowed the reply. The bot owns this conversation and the customer is sitting with no answer. Their message: \"{{message_preview}}\" (source event {{source_event_id}}, analyzer: {{analyzer_result}}).",
               "next_step": "Open the conversation in GHL and reply manually."}},
   {"action_type": "create_task", "target_system": "ghl", "target_entity": "contact",
    "params": {"title": "Bot went silent — answer this lead manually",
               "description": "The message analyzer produced no analysis and AGENTIC_ACTIVE_REPLY_BACKSTOP matched but created zero actions, so no reply was ever generated. The bot owns this conversation (agentic-active, no stop-bot) and the lead has received no answer. Their message: \"{{message_preview}}\". Source event: {{source_event_id}}. Analyzer result: {{analyzer_result}}."}}]'::jsonb,
 FALSE, TRUE, 200,
 'Consumes agentic.reply_unanswered (emitted by runReplyBackstopIfAnalyzerSilent in src/decision-engine.js, PR #614, 2026-08-03). Fires ONLY on reason=backstop_matched_zero_actions: the analyzer went silent, the contact IS agentic-owned, the backstop rule matched, and it still produced no action. That is the bot failing to answer a lead it owns — the sharpest form of the 2026-08-03 silence incident. DELIBERATELY does NOT fire on reason=analyzer_silent_and_backstop_unmatched: that branch is dominated by contacts the bot does not own or who carry stop-bot, where silence is CORRECT, and paging on it would create rep tasks telling humans to contact people who opted out (17% of replies over the 14d to 2026-08-03). That noise class is the exact failure src/agentic-silence-alerts.js was built to avoid; aggregate outage detection lives there, not here. Carries NO tag verbs on purpose — has_tag/not_has_tag fail closed on an unreadable GHL read, which would silently mute the very alert this exists to guarantee. The backstop already enforces agentic-active + not stop-bot upstream, so the ownership gate is implicit.')
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category,
  rule_type = EXCLUDED.rule_type, event_pattern = EXCLUDED.event_pattern,
  context_conditions = EXCLUDED.context_conditions, action_template = EXCLUDED.action_template,
  requires_approval = EXCLUDED.requires_approval, enabled = EXCLUDED.enabled,
  priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = NOW();

COMMIT;

-- Verification (applied live 2026-08-03, rule id 345):
--   Pre-count 271 enabled → post-count 272. Reload returned rules_loaded=272.
--   Negative case: synthetic event with reason='analyzer_silent_and_backstop_
--     unmatched' → matched_rules 0, actions_created 0 (correctly NOT alerted).
--   Positive case: rule temporarily set requires_approval=TRUE so nothing could
--     send, synthetic event with reason='backstop_matched_zero_actions' →
--     matched_rules 1, fired_rules [AGENTIC_REPLY_UNANSWERED_ALERT], 2 actions
--     (send_notification + create_task) both status=pending_approval.
--   Test actions and both synthetic events deleted; requires_approval reverted
--     to FALSE; reload re-asserted at 272.
--
-- Reload required after apply:
--   POST /n8n/decision-engine/reload-rules  (assert rules_loaded delta +1)
--
-- Rollback:
--   UPDATE agent_rules SET enabled = FALSE, updated_at = NOW()
--     WHERE rule_key = 'AGENTIC_REPLY_UNANSWERED_ALERT';
--   -- then reload and assert rules_loaded dropped by 1.
