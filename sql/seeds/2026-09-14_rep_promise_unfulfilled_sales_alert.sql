-- ════════════════════════════════════════════════════════════════════
-- REP_PROMISE_UNFULFILLED — "he said he'd send the quote and I never got it"
-- 2026-09-14
--
-- WHAT: two rows, one per detection layer.
--
--   1. kb_intent_handlers.FULFILLMENT_NOT_RECEIVED — the keyword layer. Stops
--      the bot from answering a broken promise with a sales message, and tags
--      the contact so a human picks it up.
--
--   2. agent_rules.REP_PROMISE_UNFULFILLED_ALERT — the routing layer. Fires on
--      the analyzer's escalation_category and posts a priority card into the
--      SALES channel for the market the REP works in, falling back to the
--      lead's own market when the rep is not on the roster yet.
--
-- WHY: a lead chasing something a rep personally promised was previously split
--   three ways — a trust objection, a frustrated fast-track, or a generic
--   escalate_to_rep with escalation_category NULL. Whichever way it landed, the
--   alert went to the general feed, not to anyone positioned to chase that rep.
--
-- ORDER OF OPERATIONS — do NOT run this before the code is deployed:
--   1. merge and deploy the LP-MCP change that adds the 'sales' logical channel
--      (src/slack.js, src/groupme.js) and the escalation_category
--      (src/message-analyzer.js);
--   2. set SLACK_CHANNEL_SALES on the Railway service (#sales-all, C0C0AQMARE1);
--   3. run this file;
--   4. reload the decision engine — agent_rules is config, and a new row does
--      nothing until the engine re-reads the table;
--   5. confirm a card actually lands. The Slack mirror is fail-silent by
--      design, so a misconfigured channel looks exactly like a quiet night.
--
-- Re-running is safe: both statements are idempotent on their natural key.

-- ─── 1. Keyword layer ────────────────────────────────────────────────
--
-- gate_priority 102 is deliberate and load-bearing: BOOK_QUOTE_READY sits at
-- 105 and its keyword list already covers quote wording, so at any priority
-- above it "I never got my quote" is swallowed as a booking intent. Handlers
-- are evaluated in ascending gate_priority order.
--
-- Keyword matching rule (src/knowledge/intent-classifier.js): a keyword of six
-- characters or fewer matches as a whole word, anything longer matches as a
-- substring phrase. Every entry below is a phrase for that reason — a bare
-- "sent" or "quote" would fire on half the inbox.

INSERT INTO kb_intent_handlers
  (intent_class, handler_code, bucket_type, gate_priority, description,
   trigger_keywords, action_type, ghl_handoff_tag, disqualifier, active, notes)
VALUES (
  'FULFILLMENT_NOT_RECEIVED',
  'HDL-NOT-RECEIVED-01',
  'intent_router',
  102,
  'The lead is chasing something a rep personally promised and never delivered — a quote, pricing, a proposal, paperwork or a promised callback. A sales escalation, not a service issue, and it applies to a prospect as readily as a customer.',
  ARRAY[
    'never received',
    'never got the',
    'have not received',
    'havent received',
    'still waiting on',
    'still waiting for the',
    'never sent me',
    'never sent it',
    'no one ever sent',
    'nobody ever sent',
    'never emailed me',
    'was supposed to send',
    'supposed to send me',
    'promised to send',
    'said he would send',
    'said she would send',
    'never heard back from'
  ],
  'tag_and_handoff',
  'hdl:fulfillment-not-received',
  false,
  true,
  'Added 2026-09-14. Pairs with the rep_promise_unfulfilled escalation_category in src/message-analyzer.js — keywords are the fast path, the analyzer is the recall net. Priority MUST stay below BOOK_QUOTE_READY (105).'
)
ON CONFLICT (intent_class) DO UPDATE SET
  handler_code     = EXCLUDED.handler_code,
  bucket_type      = EXCLUDED.bucket_type,
  gate_priority    = EXCLUDED.gate_priority,
  description      = EXCLUDED.description,
  trigger_keywords = EXCLUDED.trigger_keywords,
  action_type      = EXCLUDED.action_type,
  ghl_handoff_tag  = EXCLUDED.ghl_handoff_tag,
  disqualifier     = EXCLUDED.disqualifier,
  active           = EXCLUDED.active,
  notes            = EXCLUDED.notes,
  updated_at       = now();

-- ─── 2. Routing layer ────────────────────────────────────────────────
--
-- There is no escalation_category_eq condition verb. payload_field_eq is the
-- documented way to read it, and its own source comment names
-- escalation_category as the example — an unknown verb would short-circuit
-- silently and the rule would never fire, with no error and no log.
--
-- channel 'sales' is what routes this. src/actions/handlers/notifications.js
-- resolves the market code for that channel from the rep first
-- (src/rep-roster.js, matching lp_leads.rep_name against team_members) and the
-- lead second, then src/slack.js posts to #sales-<market> plus the #sales-all
-- rollup. With no market at all it still reaches the rollup.

INSERT INTO agent_rules
  (rule_key, rule_name, category, event_pattern, conditions, context_conditions,
   action_template, requires_approval, enabled, priority, created_by, notes)
VALUES (
  'REP_PROMISE_UNFULFILLED_ALERT',
  'Lead chasing an undelivered rep promise → alert the rep''s market sales channel',
  'escalation',
  '{"event_type": "ai.analysis_completed"}'::jsonb,
  NULL,
  '{"payload_field_eq": {"field": "escalation_category", "value": "rep_promise_unfulfilled"},
    "not_has_any_tag": ["suppress-outbound", "mark-p1-lost"]}'::jsonb,
  '[{"action_type": "send_notification",
     "target_system": "groupme",
     "target_entity": "contact",
     "params": {
       "channel": "sales",
       "notification_class": "priority",
       "action_verb": "REP FOLLOW-UP MISSING",
       "tier": "Hot",
       "status": "Promised item never arrived",
       "message": "{{contact_name}} is still waiting on something their rep promised.",
       "narrative": "{{contact_name}} says they never received what their rep said they would send. Their words: \"{{message_preview}}\"",
       "act_within": "today",
       "next_step": "Find out what was promised, send it, and reply to the lead yourself.",
       "cooldown_minutes": 720
     }},
    {"action_type": "create_task",
     "target_system": "ghl",
     "target_entity": "contact",
     "params": {"title": "Send {{contact_name}} what was promised — they say it never arrived", "due_in_hours": 4}}]'::jsonb,
  false,
  true,
  20,
  'claude-code',
  'Added 2026-09-14. Posts to #sales-<market> for the REP''s market where the rep is on the team_members roster, otherwise the lead''s market, otherwise the #sales-all rollup only. The roster is thin until people are onboarded through the Slack form, so expect the lead-market fallback to carry this at first — src/rep-roster.js logs every miss with a reason. cooldown_minutes 720 stops a back-and-forth thread paging the channel repeatedly.'
)
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name          = EXCLUDED.rule_name,
  category           = EXCLUDED.category,
  event_pattern      = EXCLUDED.event_pattern,
  conditions         = EXCLUDED.conditions,
  context_conditions = EXCLUDED.context_conditions,
  action_template    = EXCLUDED.action_template,
  requires_approval  = EXCLUDED.requires_approval,
  enabled            = EXCLUDED.enabled,
  priority           = EXCLUDED.priority,
  notes              = EXCLUDED.notes,
  updated_at         = now();

-- ─── Verification ────────────────────────────────────────────────────
-- SELECT intent_class, gate_priority, action_type FROM kb_intent_handlers
--   WHERE bucket_type = 'intent_router' ORDER BY gate_priority LIMIT 6;
--   -- FULFILLMENT_NOT_RECEIVED must appear ABOVE BOOK_QUOTE_READY.
-- SELECT rule_key, enabled, priority FROM agent_rules
--   WHERE rule_key = 'REP_PROMISE_UNFULFILLED_ALERT';
