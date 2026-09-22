-- ═══════════════════════════════════════════════════════════════════════════
-- Missed-reply self-heal — 5 rules on agentic.reply_unanswered
-- 2026-09-21
--
-- WHAT
--   AGENTIC_REPLY_SLA_REANALYZE      220  re-run the failed analysis
--   AGENTIC_REPLY_SLA_OPTOUT         215  they asked us to stop → stop, no SMS
--   AGENTIC_REPLY_SLA_SERVICE_ROUTE  205  service issue → contact centre
--   AGENTIC_REPLY_SLA_RECOVER        210  otherwise, answer them
--   AGENTIC_REPLY_SLA_ALERT          200  always, tell an operator what happened
--
-- WHY
--   src/jobs/reply-sla-watchdog.js has emitted agentic.reply_unanswered since
--   2026-09-02 and NOTHING CONSUMES IT. The 2026-09-02 draft seed
--   (2026-09-02_agentic_reply_sla_alert.sql) was written and never applied.
--   22 misses across 18 contacts in the 7 days to 2026-09-21.
--
--   qM5QYwn5ISZ8DQOgFJpX, 2026-09-18 17:00: "no longer interested". The
--   message analyzer returned ai.analysis_failed twice, so nothing routed —
--   no exit, no DNC, no reply. S5.2 emailed her on 9/19, texted on 9/20, and
--   Five9 kept dialing. She then texted STOP twice.
--
-- THE ORDERING IS THE DESIGN: RE-ANALYZE FIRST.
--   Priority 220 re-runs the analysis before anything else acts. When it
--   succeeds it emits ai.analysis_completed and the NORMAL rules — exits,
--   DNC, not-interested, objection routing — own the outcome exactly as they
--   would have if the analyzer had worked the first time. The generic
--   recovery reply at 210 is the fallback for when that changes nothing, not
--   the first move. Writing it the other way round would have the bot
--   apologising to someone who was trying to opt out.
--
-- ORDER OF OPERATIONS
--   1. Merge the code PR and let Railway deploy. The watchdog must be
--      emitting message_text / channel / inbound_at BEFORE these rules exist,
--      or payload_message_matches reads an absent field (a quiet non-match:
--      every reply would be treated as non-opt-out and get rule 3's message).
--      reanalyze_reply must be registered or rule 1 fails "Unknown action type".
--   2. Set SLACK_CHANNEL_SERVICE on Railway to the #contact-center channel id.
--      Without it the service cards fall back to that family's rollup, which
--      is also unset, and land nowhere. The Slack mirror is FAIL-SILENT: a
--      missing channel looks exactly like a quiet night.
--   3. Record the preflight count:
--        SELECT count(*) FROM agent_rules WHERE enabled;
--   4. Apply this seed.
--   5. POST /n8n/decision-engine/reload-rules and assert the count is +5.
--
-- IMPACT
--   A reply the bot misses is answered, routed or escalated within ~13
--   minutes (10m SLA + one heartbeat) instead of never. Only rule 3 sends the
--   customer anything, and it holds 180s and cancels itself if a rep answers.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. RE-ANALYZE (220) ──────────────────────────────────────────────────
-- Fires on every unanswered reply, including opt-outs: if the analyzer now
-- works, INTENT_DNC_HARD_REQUEST and friends handle the opt-out properly and
-- rule 2 below is belt-and-braces rather than the only defence.
-- Shadow-mode events (reason=no_send_within_sla_shadow) are deliberately NOT
-- matched — shadow means the watchdog is observing, not acting.

INSERT INTO agent_rules
  (rule_key, rule_name, category, event_pattern, conditions, context_conditions,
   action_template, requires_approval, enabled, priority, rule_type, created_by, notes)
VALUES (
  'AGENTIC_REPLY_SLA_REANALYZE',
  'Missed reply → re-run the message analysis first',
  'observability',
  '{"event_type": "agentic.reply_unanswered"}'::jsonb,
  NULL,
  '{"payload_field_eq": {"field": "reason", "value": "no_send_within_sla"}}'::jsonb,
  '[
    {"action_type": "reanalyze_reply", "target_system": "ghl", "target_entity": "contact",
     "priority": 10,
     "params": {"source_event_id": "{{source_event_id}}"}}
  ]'::jsonb,
  FALSE, TRUE, 220, 'contextual', 'claude',
  '2026-09-21 (Claude). Runs BEFORE the recovery rules so the normal routing owns the outcome when the analysis succeeds on the second attempt. One attempt only — the handler does not retry, because the analyzer already failed on this message and re-failing would spend the LLM budget while the rules behind this one wait.'
)
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category,
  event_pattern = EXCLUDED.event_pattern, conditions = EXCLUDED.conditions,
  context_conditions = EXCLUDED.context_conditions, action_template = EXCLUDED.action_template,
  requires_approval = EXCLUDED.requires_approval, enabled = EXCLUDED.enabled,
  priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = now();

-- ── 2. OPT-OUT (215) ─────────────────────────────────────────────────────
-- They asked us to stop and we never answered. The ONLY correct response is
-- to stop — no message, not even an apology.
-- add_tag stop-bot is pinned to action priority 200 so it runs LAST: the
-- rule-356 lesson is that same-lane order is not guaranteed, and stop-bot
-- applied first would block the workflow removals through the mutation gate.

INSERT INTO agent_rules
  (rule_key, rule_name, category, event_pattern, conditions, context_conditions,
   action_template, requires_approval, enabled, priority, rule_type, created_by, notes)
VALUES (
  'AGENTIC_REPLY_SLA_OPTOUT',
  'Missed reply was an opt-out → stop everything, no reply',
  'observability',
  '{"event_type": "agentic.reply_unanswered"}'::jsonb,
  NULL,
  '{
    "payload_field_eq": {"field": "reason", "value": "no_send_within_sla"},
    "payload_message_matches": "(not\\s+interested|no\\s+longer\\s+interested|\\bstop\\b|\\bunsubscribe\\b|remove\\s+me|do\\s+not\\s+(contact|text|call|email)|don''?t\\s+(contact|text|call|email)|leave\\s+(me|us)\\s+alone|never\\s+use\\s+you|solicit)"
  }'::jsonb,
  '[
    {"action_type": "remove_from_workflow", "target_system": "ghl", "target_entity": "contact",
     "priority": 10,
     "params": {"workflow_id": "0a6a1349-0b44-429b-91e1-4c5be264cd9f", "canonical_code": "S5.2", "workflow_name": "S5.2 Objection Handling v2"}},
    {"action_type": "remove_from_workflow", "target_system": "ghl", "target_entity": "contact",
     "priority": 10,
     "params": {"workflow_id": "a708de2e-3ff4-440f-8d2b-39b3c49d7f06", "canonical_code": "S5.1", "workflow_name": "S5.1"}},
    {"action_type": "create_task", "target_system": "ghl", "target_entity": "contact",
     "priority": 20,
     "params": {"title": "Lead asked us to stop / not interested — reply was missed",
                "description": "They wrote: \"{{message_preview}}\" and the bot never answered ({{age_minutes}} min past the {{sla_minutes}} min SLA). Workflows removed and stop-bot applied automatically. Source event {{source_event_id}}. Check nothing else is still running before closing."}},
    {"action_type": "send_notification", "target_system": "groupme", "target_entity": "contact",
     "priority": 20,
     "params": {"channel": "sales", "notification_class": "priority", "tier": "Cold",
                "status": "Opt-out we missed",
                "action_verb": "OPT-OUT MISSED — AUTO-HANDLED",
                "act_within": "review today",
                "narrative": "{{contact_name}} wrote \"{{message_preview}}\" and the bot never answered ({{age_minutes}} min). Handled automatically: removed from S5.2 and S5.1, stop-bot applied, task created. No message was sent to them. Nothing to do unless this reads wrong.",
                "cooldown_minutes": 60}},
    {"action_type": "add_tag", "target_system": "ghl", "target_entity": "contact",
     "priority": 200,
     "params": {"tag": "stop-bot"}}
  ]'::jsonb,
  FALSE, TRUE, 215, 'contextual', 'claude',
  '2026-09-21 (Claude). NO customer-facing message by design: someone who asked us to stop and was ignored does not want an apology text, they want silence. add_tag stop-bot sits at action priority 200 so it lands AFTER the workflow removals (rule-356 lesson — same-lane ordering is not guaranteed, and stop-bot first would trip the mutation-suppression gate on its own siblings).'
)
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category,
  event_pattern = EXCLUDED.event_pattern, conditions = EXCLUDED.conditions,
  context_conditions = EXCLUDED.context_conditions, action_template = EXCLUDED.action_template,
  requires_approval = EXCLUDED.requires_approval, enabled = EXCLUDED.enabled,
  priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = now();

-- ── 3. RECOVERY REPLY (210) ──────────────────────────────────────────────
-- The only rule here that says anything to a customer, and it is wrapped in
-- two guards: not_before_seconds 180 gives a rep first refusal, and
-- skip_if_answered_since_inbound cancels the send if anyone — a rep, or a
-- reply produced by rule 1's re-analysis — answered inside that window.
-- The tag list is the standard suppression stack: a DNC contact never gets a
-- recovery reply, however sincere.

INSERT INTO agent_rules
  (rule_key, rule_name, category, event_pattern, conditions, context_conditions,
   action_template, requires_approval, enabled, priority, rule_type, created_by, notes)
VALUES (
  'AGENTIC_REPLY_SLA_RECOVER',
  'Missed reply → answer their last message, late',
  'observability',
  '{"event_type": "agentic.reply_unanswered"}'::jsonb,
  NULL,
  '{
    "payload_field_eq": {"field": "reason", "value": "no_send_within_sla"},
    "payload_message_not_matches": ["(not\\s+interested|no\\s+longer\\s+interested|\\bstop\\b|\\bunsubscribe\\b|remove\\s+me|do\\s+not\\s+(contact|text|call|email)|don''?t\\s+(contact|text|call|email)|leave\\s+(me|us)\\s+alone|never\\s+use\\s+you|solicit)"],
    "not_has_any_tag": ["stop-bot", "dnc", "dnc-sms", "dnc-all", "do-not-contact", "stage:dnc", "unsubscribed", "lp-dnc", "dnd:sms", "dnd:all"]
  }'::jsonb,
  '[
    {"action_type": "send_message", "target_system": "ghl", "target_entity": "contact",
     "priority": 20,
     "params": {"requires_ai_generation": true,
                "skip_if_answered_since_inbound": true,
                "not_before_seconds": 180,
                "prompt_hint": "RECOVERY REPLY. This person texted us and never got an answer. Read the whole thread and answer their LAST message directly, first sentence. If more than two hours have passed, open with one short sincere apology clause; otherwise do not mention the delay. LINK OR ESTIMATE REQUEST (a link, pricing, or changing options such as vinyl instead of aluminum): send the estimate calculator link from the knowledge base (Agentic Bot Trigger - Estimate Calculator) and say they can choose frame and window type there. EXISTING CUSTOMER OR SERVICE ISSUE (installed job, screens, repair, leak, refund, warranty, or no call back): do not sell, do not ask qualifying questions, do not promise a refund or outcome; thank them, say our service team has their message and will reach out, stop. RESCHEDULE, CANCELLATION, ILLNESS OR FAMILY MATTER: lead with warmth, confirm any new date and time exactly as written, ask for nothing else. THANK YOU OR GOODBYE: one short friendly line, no question. Under 320 characters. No exclamation points. Company voice only, never Randy. Never name an insurance carrier, predict a claim outcome, promise a lower price, or use urgency or scarcity."}},
    {"action_type": "add_tag", "target_system": "ghl", "target_entity": "contact",
     "priority": 30,
     "params": {"tag": "reply-recovered"}},
    {"action_type": "add_note", "target_system": "ghl", "target_entity": "contact",
     "priority": 30,
     "params": {"note": "Recovery reply queued: this contact wrote \"{{message_preview}}\" and the bot did not answer within {{sla_minutes}} min ({{age_minutes}} min elapsed). Source event {{source_event_id}}. The send holds 3 minutes and cancels itself if a rep answers first."}}
  ]'::jsonb,
  FALSE, TRUE, 210, 'contextual', 'claude',
  '2026-09-21 (Claude). The only customer-facing rule in this family. Two guards on the send: not_before_seconds 180 (a rep gets first refusal) and skip_if_answered_since_inbound (cancels if anyone answered in the window, including a reply produced by AGENTIC_REPLY_SLA_REANALYZE). payload_message_not_matches fails CLOSED on an absent message_text, which is why the watchdog change ships first — without it this rule suppresses itself rather than texting blind.'
)
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category,
  event_pattern = EXCLUDED.event_pattern, conditions = EXCLUDED.conditions,
  context_conditions = EXCLUDED.context_conditions, action_template = EXCLUDED.action_template,
  requires_approval = EXCLUDED.requires_approval, enabled = EXCLUDED.enabled,
  priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = now();

-- ── 4. SERVICE ROUTE (205) ───────────────────────────────────────────────
-- An installed customer chasing a screen, a leak or a callback is not a lead.
-- Routes to the market's service channel, never the sales floor.
-- next_step is folded into the narrative on purpose: the card renderer only
-- prints "🎯 Next" for notification_class 'intelligence', so a next_step on a
-- 'priority' card is silently dropped (src/actions/notification-classifier.js).

INSERT INTO agent_rules
  (rule_key, rule_name, category, event_pattern, conditions, context_conditions,
   action_template, requires_approval, enabled, priority, rule_type, created_by, notes)
VALUES (
  'AGENTIC_REPLY_SLA_SERVICE_ROUTE',
  'Missed reply was a service issue → contact centre',
  'observability',
  '{"event_type": "agentic.reply_unanswered"}'::jsonb,
  NULL,
  '{
    "payload_field_eq": {"field": "reason", "value": "no_send_within_sla"},
    "payload_message_matches": "(refund|screen|warrant|repair|leak|broken|crack|install|crew|service|damage|missing|called (you )?(multiple|several|many) times|no one (has )?called|left (my|a) (name|message)|never (heard|got a call))"
  }'::jsonb,
  '[
    {"action_type": "send_notification", "target_system": "groupme", "target_entity": "contact",
     "priority": 20,
     "params": {"channel": "service", "notification_class": "priority", "tier": "Hot",
                "status": "Customer waiting on service",
                "action_verb": "SERVICE — CUSTOMER WAITING",
                "act_within": "2 hours",
                "narrative": "{{contact_name}} wrote \"{{message_preview}}\" — a service issue, not a lead — and the bot never answered ({{age_minutes}} min). Call them. Do not route this to the sales floor. Source event {{source_event_id}}.",
                "cooldown_minutes": 60}},
    {"action_type": "create_task", "target_system": "ghl", "target_entity": "contact",
     "priority": 20,
     "params": {"title": "Service follow-up — customer waiting",
                "description": "They wrote: \"{{message_preview}}\" ({{age_minutes}} min unanswered). Service issue — someone from the service team needs to call. Source event {{source_event_id}}."}},
    {"action_type": "add_tag", "target_system": "ghl", "target_entity": "contact",
     "priority": 30,
     "params": {"tag": "service-issue"}}
  ]'::jsonb,
  FALSE, TRUE, 205, 'contextual', 'claude',
  '2026-09-21 (Claude). Runs alongside AGENTIC_REPLY_SLA_RECOVER, not instead of it — the reply still goes out, and its prompt_hint already tells the model not to sell to an existing customer. This rule adds the human routing. channel "service" resolves #service-<market> via MARKET_FAMILIES in src/slack.js and falls back to SLACK_CHANNEL_SERVICE (#contact-center), never to #lead-intelligence. Market must be the CODE (FTMYR), not the display name.'
)
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category,
  event_pattern = EXCLUDED.event_pattern, conditions = EXCLUDED.conditions,
  context_conditions = EXCLUDED.context_conditions, action_template = EXCLUDED.action_template,
  requires_approval = EXCLUDED.requires_approval, enabled = EXCLUDED.enabled,
  priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = now();

-- ── 5. ALERT (200) ───────────────────────────────────────────────────────
-- Supersedes the never-applied 2026-09-02 draft. Fires on EVERY miss, with no
-- tag conditions: has_* verbs fail closed, and a fail-closed alarm is a muted
-- alarm. notification_class 'intelligence' so the "🎯 Next" line renders — the
-- draft used 'priority', where the renderer drops next_step silently.

INSERT INTO agent_rules
  (rule_key, rule_name, category, event_pattern, conditions, context_conditions,
   action_template, requires_approval, enabled, priority, rule_type, created_by, notes)
VALUES (
  'AGENTIC_REPLY_SLA_ALERT',
  'Missed reply → tell an operator what was done about it',
  'observability',
  '{"event_type": "agentic.reply_unanswered"}'::jsonb,
  NULL,
  '{"payload_field_eq": {"field": "reason", "value": "no_send_within_sla"}}'::jsonb,
  '[
    {"action_type": "send_notification", "target_system": "groupme", "target_entity": "contact",
     "priority": 30,
     "params": {"notification_class": "intelligence", "tier": "Warm",
                "status": "Bot reply missed",
                "action_verb": "BOT REPLY MISSED — AUTO-HANDLED",
                "narrative": "{{contact_name}} replied {{age_minutes}} min ago and the bot never answered (SLA {{sla_minutes}} min). They wrote: \"{{message_preview}}\". The self-heal re-ran the analysis and routed it. Source event {{source_event_id}}.",
                "next_step": "No action unless the recovery looks wrong.",
                "cooldown_minutes": 30}}
  ]'::jsonb,
  FALSE, TRUE, 200, 'contextual', 'claude',
  '2026-09-21 (Claude). Supersedes sql/seeds/2026-09-02_agentic_reply_sla_alert.sql, which was written and never applied. Two changes from that draft: notification_class is intelligence, not priority, because the renderer only prints the "Next" line for intelligence and the draft''s next_step would have been dropped; and the narrative says what the system already DID, because by the time this card lands the re-analysis, the opt-out handling or the recovery reply has run. No tag conditions on purpose — has_* verbs fail closed and would mute the alarm on exactly the contacts whose reads are failing.'
)
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category,
  event_pattern = EXCLUDED.event_pattern, conditions = EXCLUDED.conditions,
  context_conditions = EXCLUDED.context_conditions, action_template = EXCLUDED.action_template,
  requires_approval = EXCLUDED.requires_approval, enabled = EXCLUDED.enabled,
  priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = now();

COMMIT;

-- ── Verification ─────────────────────────────────────────────────────────
-- SELECT rule_key, priority, enabled, jsonb_array_length(action_template) AS n
--   FROM agent_rules WHERE rule_key LIKE 'AGENTIC_REPLY_SLA_%' ORDER BY priority DESC;
--   -- expect REANALYZE 220/1, OPTOUT 215/5, RECOVER 210/3, SERVICE_ROUTE 205/3, ALERT 200/1
--
-- Then POST /n8n/decision-engine/reload-rules and confirm enabled count is +5
-- against the preflight number.
--
-- Confirm a card actually lands in #contact-center. The Slack mirror is
-- fail-silent by design — a missing SLACK_CHANNEL_SERVICE looks exactly like
-- a quiet night, so silence is not evidence.

-- ── Rollback ─────────────────────────────────────────────────────────────
--   UPDATE agent_rules SET enabled = FALSE, updated_at = now()
--    WHERE rule_key LIKE 'AGENTIC_REPLY_SLA_%';
--   then POST /n8n/decision-engine/reload-rules.
--
--   To disable ONLY the customer-facing send while keeping the routing and
--   the alert (the narrower rollback, and the one to reach for first):
--     UPDATE agent_rules SET enabled = FALSE WHERE rule_key = 'AGENTIC_REPLY_SLA_RECOVER';
