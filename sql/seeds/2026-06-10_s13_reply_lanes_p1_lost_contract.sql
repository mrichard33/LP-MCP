-- ════════════════════════════════════════════════════════════════════
-- S1.3 Reply Lanes + route_to_p3 P1-Lost Contract
-- 2026-06-10
--
-- WHAT: 8 contextual agent_rules giving every S1.3 inbound a conversational
--   reply lane (moved fork / already-purchased / interested / not-interested /
--   catch-all), plus the global route-to-P3 contract (Intended Loss Reason
--   field + mark-p1-lost tag) retrofitted onto layer3_action_dispatch rows
--   1 & 5 and agent_rules 14 & 96. Companion kb_intent_handlers MOVED gate
--   (id 30) was applied pre-deploy.
--
-- WHY: S1.3 pilot defects — (1) inbound replies were classified and routed
--   but never answered; (2) "Yes, we moved." misrouted to not-interested +
--   hdl:callback-service; (3) P3 routing left the P1 opportunity open.
--
-- EXECUTION CONTRACT:
--   * Run AFTER the LP-MCP code deploy that adds the context operators
--     (payload_message_not_matches, has_tag_prefix, custom_field_eq,
--     array-AND payload_message_matches). Unknown operators are silently
--     ignored by older code — running this first would UN-SCOPE the lanes.
--   * Bare top-level statements only (one per supabase_run_query call).
--   * After running: POST /n8n/decision-engine/reload-rules.
--
-- REGEX PRECEDENCE (all matching rules fire, so exclusion chains encode
-- priority): moved > already-purchased > interested > not-interested >
-- catch-all. Fork rules (IN_FL / OUT_OF_STATE / UNCLEAR) are mutually
-- exclusive by construction; ambiguous fork answers ALWAYS land on
-- UNCLEAR, never on a terminal close.
--
-- LOSS MAPPING (Intended Loss Reason I9CbRV0dKMfwaSlge9uU is a
-- SINGLE_OPTIONS picklist; L.0 248d42f0 branches on it):
--   moved out-of-state      -> loss-reason:moved             / "Out of Service Area"
--   already purchased       -> loss-reason:already-purchased / "Bad Fit (Preference)"
--   not interested          -> loss-reason:not-interested    / "Not Interested (Now)"
--   dispatch 5 (competitor) -> loss-reason:competitor        / "Price / Shopping"
--   rule 14 (DNC)           -> loss-reason:dnc               / "DNC"
--   rule 96 (zero data)     -> loss-reason:no-engagement     / "Ghosted / Unresponsive"
-- ════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────
-- Phase A (safe pre-deploy — already applied 2026-06-10, kept for replay)
-- ────────────────────────────────────────────────────────────────────

ALTER TABLE kb_intent_handlers ADD COLUMN IF NOT EXISTS trigger_patterns text[];

INSERT INTO kb_intent_handlers (intent_class, handler_code, bucket_type, gate_priority, description, trigger_keywords, trigger_patterns, action_type, ghl_handoff_tag, disqualifier, active, notes)
SELECT
  'MOVED', 'HDL-MOVED-01', 'compliance_gate', 6,
  'Contact no longer lives at / owns the marketed property (moved, sold the house, new address). Routing fork — NOT a refusal: S1.3 Lane 1 asks whether they stayed in Florida before any loss routing. Must outrank CUSTOMER_STATUS_AFFIRMATIVE (gate_priority 8, keyword "yes").',
  ARRAY['we moved','we''ve moved','i moved','i''ve moved','just moved','sold the house','sold our house','sold the home','sold our home','no longer own','no longer live','don''t live there','new address'],
  ARRAY[
    '(?:\b(?:we|i)(?:''?ve)?\s+)?\b(?:just\s+)?moved\b',
    '\bsold\s+(?:the|our|that)\s+(?:house|home|place)\b',
    '\bno\s+longer\s+(?:own|live|at)\b',
    '\bdon''?t\s+live\s+there\b',
    '\bnew\s+(?:house|home|address)\b'
  ],
  'tag_and_handoff', 'hdl:moved', false, true,
  'S1.3 pilot fix 2026-06-10: "Yes, we moved." keyword-matched CUSTOMER_STATUS_AFFIRMATIVE (id 25) -> hdl:callback-service (customer-service callback for a non-customer). Regex layer (trigger_patterns) runs before keywords as of intent-classifier patternMatch.'
WHERE NOT EXISTS (SELECT 1 FROM kb_intent_handlers WHERE intent_class = 'MOVED');

-- ────────────────────────────────────────────────────────────────────
-- Phase B1 — S13 reply lanes (8 rules)
-- ────────────────────────────────────────────────────────────────────

-- Lane 1: moved → FL fork question (no loss, no P3 — the fork decides)
INSERT INTO agent_rules (rule_key, rule_name, category, rule_type, event_pattern, context_conditions, action_template, requires_approval, enabled, priority, created_by, notes)
VALUES (
  'S13_LANE1_MOVED',
  'S1.3 Lane 1 — moved/sold reply → Florida fork question',
  'S13_REPLY_LANES', 'contextual',
  '{"event_type": "ai.analysis_completed"}'::jsonb,
  '{
    "any_of": [
      {"has_tag_prefix": "sent:s1.3-"},
      {"custom_field_eq": {"field_id": "VFSNtEqSUh5yX7RyktBj", "value": "32fa691b-2422-4727-83c9-1174801974e9"}}
    ],
    "payload_message_matches": "(?:\\b(?:we|i)(?:''?ve)?\\s+)?\\b(?:just\\s+)?moved\\b|\\bsold\\s+(?:the|our|that)\\s+(?:house|home|place)\\b|\\bno\\s+longer\\s+(?:own|live|at)\\b|\\bdon''?t\\s+live\\s+there\\b|\\bnew\\s+(?:house|home|address)\\b",
    "not_has_tag": "awaiting:moved-fork",
    "not_has_any_tag": ["mark-p1-lost", "loss-reason:moved", "moved:in-fl"]
  }'::jsonb,
  '[
    {"action_type": "send_message", "target_system": "ghl", "target_entity": "contact", "priority": 10,
     "params": {"channel": "sms", "message": "Thanks for letting me know! Quick question so I update this correctly — did you stay in Florida? If your new place could use impact windows, I''m happy to help there too. If not, I''ll close this file out right now."}},
    {"action_type": "add_tag", "target_system": "ghl", "target_entity": "contact", "params": {"tag": "awaiting:moved-fork"}},
    {"action_type": "add_tag", "target_system": "ghl", "target_entity": "contact", "params": {"tag": "hdl:moved"}}
  ]'::jsonb,
  false, true, 88, 'claude',
  'S1.3 pilot fix 2026-06-10. Moved is a fork, not a refusal: ask whether they stayed in FL before any routing. awaiting:moved-fork hands the next inbound to the fork rules (S13_LANE1_FORK_*). Regex must stay in sync with MOVED_REGEX in src/message-analyzer.js.'
)
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category, rule_type = EXCLUDED.rule_type,
  event_pattern = EXCLUDED.event_pattern, context_conditions = EXCLUDED.context_conditions,
  action_template = EXCLUDED.action_template, requires_approval = EXCLUDED.requires_approval,
  enabled = EXCLUDED.enabled, priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = now();

-- Lane 1 fork: stayed in Florida → collect address, human re-routes (NO opp move, NO loss)
INSERT INTO agent_rules (rule_key, rule_name, category, rule_type, event_pattern, context_conditions, action_template, requires_approval, enabled, priority, created_by, notes)
VALUES (
  'S13_LANE1_FORK_IN_FL',
  'S1.3 Lane 1 fork — stayed in Florida → address update + human re-route',
  'S13_REPLY_LANES', 'contextual',
  '{"event_type": "ai.analysis_completed"}'::jsonb,
  '{
    "has_tag": "awaiting:moved-fork",
    "payload_message_matches": "\\b(?:fl|fla|florida)\\b|\\b(?:tampa|orlando|miami|naples|sarasota|bradenton|venice|fort\\s+myers|cape\\s+coral|port\\s+charlotte|punta\\s+gorda|north\\s+port|clearwater|st\\.?\\s*pete(?:rsburg)?|lakeland|kissimmee|ocala|jacksonville)\\b|\\b(?:yes|yeah|yep|yup|still\\s+here|same\\s+area|stayed|local)\\b|\\bstill\\s+in\\s+(?:fl|fla|florida)\\b|\\bstay(?:ed|ing)?\\s+in\\s+(?:fl|fla|florida)\\b",
    "payload_message_not_matches": "\\b(?:no|nope|nah)\\b|\\bout\\s+of\\s+state\\b|\\bmoved\\s+(?:away|out)\\b|\\bleft\\s+florida\\b|\\bnot?\\s+(?:in|longer\\s+in)\\s+florida\\b|\\bsold\\s+(?:it|the|our)\\b|\\b(?:georgia|alabama|tennessee|texas|ohio|michigan|carolina|virginia|new\\s+york|new\\s+jersey|arizona|colorado)\\b"
  }'::jsonb,
  '[
    {"action_type": "send_message", "target_system": "ghl", "target_entity": "contact", "priority": 10,
     "params": {"channel": "sms", "message": "Perfect — glad you''re still in the area! What''s the new address? I''ll get you set up at the new place."}},
    {"action_type": "remove_tag", "target_system": "ghl", "target_entity": "contact", "params": {"tag": "awaiting:moved-fork"}},
    {"action_type": "add_tag", "target_system": "ghl", "target_entity": "contact", "params": {"tag": "moved:in-fl"}},
    {"action_type": "add_tag", "target_system": "ghl", "target_entity": "contact", "params": {"tag": "s13:address-update-needed"}},
    {"action_type": "send_notification", "target_system": "groupme", "target_entity": "contact",
     "params": {"notification_class": "priority", "action_verb": "MOVED IN-FL — ADDRESS UPDATE", "tier": "Warm", "status": "Action Required",
       "message": "S1.3 lead moved within Florida. Reply: \"{{message_text}}\"",
       "narrative": "Lead confirmed they stayed in FL after moving. Address-collection reply sent. ACTION: update the address in GHL/LP when they answer, run check_service_area on the new zip, then re-route as a fresh TOFU lead. P1 opp intentionally untouched until the new address clears the service-area check. If out of area, DQ manually.",
       "next_step": "Update address -> check_service_area -> re-route as TOFU"}}
  ]'::jsonb,
  false, true, 89, 'claude',
  'No move_opportunity by design: where the opp goes depends on the new address clearing check_service_area (MCP tool only, no executor handler) — a call this rule cannot make. Human completes via the SALES PRIORITY card.'
)
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category, rule_type = EXCLUDED.rule_type,
  event_pattern = EXCLUDED.event_pattern, context_conditions = EXCLUDED.context_conditions,
  action_template = EXCLUDED.action_template, requires_approval = EXCLUDED.requires_approval,
  enabled = EXCLUDED.enabled, priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = now();

-- Lane 1 fork: left Florida / sold and done → loss-reason:moved, P3 Bad Fit, P1 lost, suppress.
-- Asymmetric exclusion: also-not-matching IN_FL_STRONG (cities + affirmatives + still/stay-in-FL,
-- WITHOUT bare fl/florida tokens — "left Florida" legitimately contains "florida") so a both-match
-- reply ("we sold it and bought in Naples") falls to FORK_UNCLEAR instead of terminal-closing a
-- live in-FL buyer.
INSERT INTO agent_rules (rule_key, rule_name, category, rule_type, event_pattern, context_conditions, action_template, requires_approval, enabled, priority, created_by, notes)
VALUES (
  'S13_LANE1_FORK_OUT_OF_STATE',
  'S1.3 Lane 1 fork — left Florida / sold → loss-reason:moved + P1 lost',
  'S13_REPLY_LANES', 'contextual',
  '{"event_type": "ai.analysis_completed"}'::jsonb,
  '{
    "has_tag": "awaiting:moved-fork",
    "payload_message_matches": "\\b(?:no|nope|nah)\\b|\\bout\\s+of\\s+state\\b|\\bmoved\\s+(?:away|out)\\b|\\bleft\\s+florida\\b|\\bnot?\\s+(?:in|longer\\s+in)\\s+florida\\b|\\bsold\\s+(?:it|the|our)\\b|\\b(?:georgia|alabama|tennessee|texas|ohio|michigan|carolina|virginia|new\\s+york|new\\s+jersey|arizona|colorado)\\b",
    "payload_message_not_matches": "\\b(?:tampa|orlando|miami|naples|sarasota|bradenton|venice|fort\\s+myers|cape\\s+coral|port\\s+charlotte|punta\\s+gorda|north\\s+port|clearwater|st\\.?\\s*pete(?:rsburg)?|lakeland|kissimmee|ocala|jacksonville)\\b|\\b(?:yes|yeah|yep|yup|still\\s+here|same\\s+area|stayed|local)\\b|\\bstill\\s+in\\s+(?:fl|fla|florida)\\b|\\bstay(?:ed|ing)?\\s+in\\s+(?:fl|fla|florida)\\b",
    "not_has_tag": "mark-p1-lost"
  }'::jsonb,
  '[
    {"action_type": "send_message", "target_system": "ghl", "target_entity": "contact", "priority": 10,
     "params": {"channel": "sms", "message": "Got it — thanks for letting me know, and best of luck at the new place! I''ll close this out so we stop reaching out. Take care!"}},
    {"action_type": "remove_tag", "target_system": "ghl", "target_entity": "contact", "params": {"tag": "awaiting:moved-fork"}},
    {"action_type": "add_tag", "target_system": "ghl", "target_entity": "contact", "params": {"tag": "loss-reason:moved"}},
    {"action_type": "update_custom_fields", "target_system": "ghl", "target_entity": "contact",
     "params": {"fields": [{"id": "I9CbRV0dKMfwaSlge9uU", "value": "Out of Service Area"}]}},
    {"action_type": "move_opportunity", "target_system": "ghl", "target_entity": "opportunity",
     "params": {"pipeline": "P3", "stage": "Bad Fit / Wrong Home", "status": "open"}},
    {"action_type": "add_tag", "target_system": "ghl", "target_entity": "contact", "params": {"tag": "mark-p1-lost"}},
    {"action_type": "add_tag", "target_system": "ghl", "target_entity": "contact", "params": {"tag": "suppress-outbound"}}
  ]'::jsonb,
  false, true, 89, 'claude',
  'Terminal close. Contract order: send (inline fast-path, priority 10) -> loss-reason tag -> Intended Loss Reason field -> P3 move -> mark-p1-lost (L.0 closes P1) -> suppress-outbound. No cooling timer for moved leads.'
)
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category, rule_type = EXCLUDED.rule_type,
  event_pattern = EXCLUDED.event_pattern, context_conditions = EXCLUDED.context_conditions,
  action_template = EXCLUDED.action_template, requires_approval = EXCLUDED.requires_approval,
  enabled = EXCLUDED.enabled, priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = now();

-- Lane 1 fork: unresolvable answer → ack + human, fork stays open.
-- UNCLEAR ⇔ (¬IN_FL ∧ ¬OUT) ∨ (OUT ∧ IN_FL_STRONG); exactly one of the three
-- fork rules fires for any fork-state inbound.
INSERT INTO agent_rules (rule_key, rule_name, category, rule_type, event_pattern, context_conditions, action_template, requires_approval, enabled, priority, created_by, notes)
VALUES (
  'S13_LANE1_FORK_UNCLEAR',
  'S1.3 Lane 1 fork — ambiguous answer → ack + human handoff, fork kept open',
  'S13_REPLY_LANES', 'contextual',
  '{"event_type": "ai.analysis_completed"}'::jsonb,
  '{
    "has_tag": "awaiting:moved-fork",
    "any_of": [
      {"payload_message_not_matches": [
        "\\b(?:fl|fla|florida)\\b|\\b(?:tampa|orlando|miami|naples|sarasota|bradenton|venice|fort\\s+myers|cape\\s+coral|port\\s+charlotte|punta\\s+gorda|north\\s+port|clearwater|st\\.?\\s*pete(?:rsburg)?|lakeland|kissimmee|ocala|jacksonville)\\b|\\b(?:yes|yeah|yep|yup|still\\s+here|same\\s+area|stayed|local)\\b|\\bstill\\s+in\\s+(?:fl|fla|florida)\\b|\\bstay(?:ed|ing)?\\s+in\\s+(?:fl|fla|florida)\\b",
        "\\b(?:no|nope|nah)\\b|\\bout\\s+of\\s+state\\b|\\bmoved\\s+(?:away|out)\\b|\\bleft\\s+florida\\b|\\bnot?\\s+(?:in|longer\\s+in)\\s+florida\\b|\\bsold\\s+(?:it|the|our)\\b|\\b(?:georgia|alabama|tennessee|texas|ohio|michigan|carolina|virginia|new\\s+york|new\\s+jersey|arizona|colorado)\\b"
      ]},
      {"payload_message_matches": [
        "\\b(?:no|nope|nah)\\b|\\bout\\s+of\\s+state\\b|\\bmoved\\s+(?:away|out)\\b|\\bleft\\s+florida\\b|\\bnot?\\s+(?:in|longer\\s+in)\\s+florida\\b|\\bsold\\s+(?:it|the|our)\\b|\\b(?:georgia|alabama|tennessee|texas|ohio|michigan|carolina|virginia|new\\s+york|new\\s+jersey|arizona|colorado)\\b",
        "\\b(?:tampa|orlando|miami|naples|sarasota|bradenton|venice|fort\\s+myers|cape\\s+coral|port\\s+charlotte|punta\\s+gorda|north\\s+port|clearwater|st\\.?\\s*pete(?:rsburg)?|lakeland|kissimmee|ocala|jacksonville)\\b|\\b(?:yes|yeah|yep|yup|still\\s+here|same\\s+area|stayed|local)\\b|\\bstill\\s+in\\s+(?:fl|fla|florida)\\b|\\bstay(?:ed|ing)?\\s+in\\s+(?:fl|fla|florida)\\b"
      ]}
    ]
  }'::jsonb,
  '[
    {"action_type": "send_message", "target_system": "ghl", "target_entity": "contact", "priority": 10,
     "params": {"channel": "sms", "message": "Thanks for getting back to me — give me a moment and I''ll get you a proper answer."}},
    {"action_type": "send_notification", "target_system": "groupme", "target_entity": "contact",
     "params": {"notification_class": "priority", "action_verb": "MOVED FORK — UNCLEAR REPLY", "tier": "Warm", "status": "Action Required",
       "message": "S1.3 moved-fork follow-up could not be auto-classified. Reply: \"{{message_text}}\"",
       "narrative": "The in-FL vs out-of-state fork could not resolve this answer (or it matched both directions). awaiting:moved-fork left in place so their next clarifying reply re-enters the fork. ACTION: read the thread and resolve manually.",
       "next_step": "Resolve in-FL vs out-of-state manually"}}
  ]'::jsonb,
  false, true, 87, 'claude',
  'Safety invariant: ambiguous fork answers NEVER resolve to a terminal close — uncertainty goes to the human. Covers both no-match and both-match ("we sold it and bought in Naples", "no, still in Florida") cases. Requires array-AND payload_message_matches (deployed 2026-06-10).'
)
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category, rule_type = EXCLUDED.rule_type,
  event_pattern = EXCLUDED.event_pattern, context_conditions = EXCLUDED.context_conditions,
  action_template = EXCLUDED.action_template, requires_approval = EXCLUDED.requires_approval,
  enabled = EXCLUDED.enabled, priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = now();

-- Lane 2: already purchased → goodbye + Bad Fit + P1 lost.
-- Excludes RX_MOVED (lane 1 owns) and rule 173''s competitor regex (rescission rescue owns).
INSERT INTO agent_rules (rule_key, rule_name, category, rule_type, event_pattern, context_conditions, action_template, requires_approval, enabled, priority, created_by, notes)
VALUES (
  'S13_LANE2_ALREADY_PURCHASED',
  'S1.3 Lane 2 — already purchased → graceful close + P1 lost',
  'S13_REPLY_LANES', 'contextual',
  '{"event_type": "ai.analysis_completed"}'::jsonb,
  '{
    "any_of": [
      {"has_tag_prefix": "sent:s1.3-"},
      {"custom_field_eq": {"field_id": "VFSNtEqSUh5yX7RyktBj", "value": "32fa691b-2422-4727-83c9-1174801974e9"}}
    ],
    "payload_message_matches": "\\balready\\s+(?:had|have|got|did|done|been|installed|replaced|purchased|bought)\\b|\\b(?:had|got)\\s+(?:them|it|that|the\\s+(?:windows|work|job))\\s+done\\b|\\bwindows\\s+(?:are|were|got)\\s+(?:already\\s+)?(?:done|replaced|installed)\\b",
    "payload_message_not_matches": [
      "(?:\\b(?:we|i)(?:''?ve)?\\s+)?\\b(?:just\\s+)?moved\\b|\\bsold\\s+(?:the|our|that)\\s+(?:house|home|place)\\b|\\bno\\s+longer\\s+(?:own|live|at)\\b|\\bdon''?t\\s+live\\s+there\\b|\\bnew\\s+(?:house|home|address)\\b",
      "\\b(contracted\\s+with\\s+(another|a\\s+different)|(signed|going|went)\\s+with\\s+(another|a\\s+different)|already\\s+(chose|picked|hired|signed|decided)|purchased\\s+(elsewhere|from\\s+(another|someone))|hired\\s+(another|someone\\s+else)|with\\s+another\\s+(company|vendor|contractor))\\b"
    ],
    "not_has_tag": "awaiting:moved-fork",
    "not_has_any_tag": ["mark-p1-lost", "loss-reason:already-purchased"]
  }'::jsonb,
  '[
    {"action_type": "send_message", "target_system": "ghl", "target_entity": "contact", "priority": 10,
     "params": {"channel": "sms", "message": "Good for you — that''s the right move down here. I''ll close your file so we stop bugging you. If you ever need service or know a neighbor still putting it off, we''re around. Take care!"}},
    {"action_type": "add_tag", "target_system": "ghl", "target_entity": "contact", "params": {"tag": "loss-reason:already-purchased"}},
    {"action_type": "update_custom_fields", "target_system": "ghl", "target_entity": "contact",
     "params": {"fields": [{"id": "I9CbRV0dKMfwaSlge9uU", "value": "Bad Fit (Preference)"}]}},
    {"action_type": "move_opportunity", "target_system": "ghl", "target_entity": "opportunity",
     "params": {"pipeline": "P3", "stage": "Bad Fit / Wrong Home", "status": "open"}},
    {"action_type": "add_tag", "target_system": "ghl", "target_entity": "contact", "params": {"tag": "mark-p1-lost"}},
    {"action_type": "add_tag", "target_system": "ghl", "target_entity": "contact", "params": {"tag": "suppress-outbound"}}
  ]'::jsonb,
  false, true, 88, 'claude',
  'loss-reason:already-purchased is a NEW tag (analytics namespace); the L.0 field value maps to "Bad Fit (Preference)" per 2026-06-10 decision (picklist has no already-purchased option). Competitor-signed messages stay with rule 173 (rescission rescue) via the exclusion.'
)
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category, rule_type = EXCLUDED.rule_type,
  event_pattern = EXCLUDED.event_pattern, context_conditions = EXCLUDED.context_conditions,
  action_template = EXCLUDED.action_template, requires_approval = EXCLUDED.requires_approval,
  enabled = EXCLUDED.enabled, priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = now();

-- Lane 3: interested / still on the list → booking link + intent-warm + Mark ping. No P3, no loss.
INSERT INTO agent_rules (rule_key, rule_name, category, rule_type, event_pattern, context_conditions, action_template, requires_approval, enabled, priority, created_by, notes)
VALUES (
  'S13_LANE3_INTERESTED',
  'S1.3 Lane 3 — interested reply → PPR booking link + priority notify',
  'S13_REPLY_LANES', 'contextual',
  '{"event_type": "ai.analysis_completed"}'::jsonb,
  '{
    "any_of": [
      {"has_tag_prefix": "sent:s1.3-"},
      {"custom_field_eq": {"field_id": "VFSNtEqSUh5yX7RyktBj", "value": "32fa691b-2422-4727-83c9-1174801974e9"}}
    ],
    "payload_message_matches": "\\bstill\\s+(?:need|want|interested)\\b|\\b(?:i''?m|we''?re)\\s+interested\\b|\\bready\\s+to\\s+(?:schedule|book|talk|move\\s+forward)\\b|\\blet''?s\\s+(?:do\\s+it|schedule|book|talk)\\b|\\b(?:send|get)\\s+(?:me\\s+)?(?:a\\s+)?(?:quote|estimate|price|pricing)\\b|\\bhow\\s+much\\b",
    "payload_message_not_matches": [
      "(?:\\b(?:we|i)(?:''?ve)?\\s+)?\\b(?:just\\s+)?moved\\b|\\bsold\\s+(?:the|our|that)\\s+(?:house|home|place)\\b|\\bno\\s+longer\\s+(?:own|live|at)\\b|\\bdon''?t\\s+live\\s+there\\b|\\bnew\\s+(?:house|home|address)\\b",
      "\\balready\\s+(?:had|have|got|did|done|been|installed|replaced|purchased|bought)\\b|\\b(?:had|got)\\s+(?:them|it|that|the\\s+(?:windows|work|job))\\s+done\\b|\\bwindows\\s+(?:are|were|got)\\s+(?:already\\s+)?(?:done|replaced|installed)\\b",
      "\\bnot\\s+interested\\b|\\bno\\s+longer\\s+interested\\b|\\bno\\s+thanks?\\b|\\b(?:i''?m|we''?re)\\s+(?:out|good|all\\s+set)\\b|\\bnot\\s+for\\s+(?:me|us)\\b|\\bcount\\s+(?:me|us)\\s+out\\b"
    ],
    "not_has_tag": "awaiting:moved-fork"
  }'::jsonb,
  '[
    {"action_type": "send_message", "target_system": "ghl", "target_entity": "contact", "priority": 10,
     "params": {"channel": "sms", "message": "Glad it''s still on the radar — that''s exactly why I reached out. Easiest next step is a quick 15-minute phone call where we map out what your home actually needs (no visit, no pressure): https://link.reecewindows.com/widget/booking/DQYMaJ22N6zL4SXjHukw?utm_source=s13&utm_medium=sms — or just tell me a good time and I''ll call you."}},
    {"action_type": "add_tag", "target_system": "ghl", "target_entity": "contact", "params": {"tag": "intent-warm"}},
    {"action_type": "send_notification", "target_system": "groupme", "target_entity": "contact",
     "params": {"notification_class": "priority", "action_verb": "S1.3 REVIVAL — WARM REPLY", "tier": "Hot", "status": "Call Now",
       "message": "Stale-revival lead replied interested. Reply: \"{{message_text}}\"",
       "narrative": "S1.3 revival lead is back on the list. Protection Profile Review booking link already sent by the lane. ACTION: follow up by phone to lock the 15-minute call.",
       "next_step": "Call to lock the PPR slot"}}
  ]'::jsonb,
  false, true, 88, 'claude',
  'Booking link is the LITERAL PPR URL (calendar DQYMaJ22N6zL4SXjHukw) — send_message does NOT resolve {{custom_values.*}} merge tags, per 2026-06-10 decision. No P3, no loss, no suppression.'
)
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category, rule_type = EXCLUDED.rule_type,
  event_pattern = EXCLUDED.event_pattern, context_conditions = EXCLUDED.context_conditions,
  action_template = EXCLUDED.action_template, requires_approval = EXCLUDED.requires_approval,
  enabled = EXCLUDED.enabled, priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = now();

-- Lane 4: explicit decline → goodbye + existing cooling route + P1 lost.
INSERT INTO agent_rules (rule_key, rule_name, category, rule_type, event_pattern, context_conditions, action_template, requires_approval, enabled, priority, created_by, notes)
VALUES (
  'S13_LANE4_NOT_INTERESTED',
  'S1.3 Lane 4 — explicit decline → graceful goodbye + cooling + P1 lost',
  'S13_REPLY_LANES', 'contextual',
  '{"event_type": "ai.analysis_completed"}'::jsonb,
  '{
    "any_of": [
      {"has_tag_prefix": "sent:s1.3-"},
      {"custom_field_eq": {"field_id": "VFSNtEqSUh5yX7RyktBj", "value": "32fa691b-2422-4727-83c9-1174801974e9"}}
    ],
    "payload_message_matches": "\\bnot\\s+interested\\b|\\bno\\s+longer\\s+interested\\b|\\bno\\s+thanks?\\b|\\b(?:i''?m|we''?re)\\s+(?:out|good|all\\s+set)\\b|\\bnot\\s+for\\s+(?:me|us)\\b|\\bcount\\s+(?:me|us)\\s+out\\b",
    "payload_message_not_matches": [
      "(?:\\b(?:we|i)(?:''?ve)?\\s+)?\\b(?:just\\s+)?moved\\b|\\bsold\\s+(?:the|our|that)\\s+(?:house|home|place)\\b|\\bno\\s+longer\\s+(?:own|live|at)\\b|\\bdon''?t\\s+live\\s+there\\b|\\bnew\\s+(?:house|home|address)\\b",
      "\\balready\\s+(?:had|have|got|did|done|been|installed|replaced|purchased|bought)\\b|\\b(?:had|got)\\s+(?:them|it|that|the\\s+(?:windows|work|job))\\s+done\\b|\\bwindows\\s+(?:are|were|got)\\s+(?:already\\s+)?(?:done|replaced|installed)\\b"
    ],
    "not_has_tag": "awaiting:moved-fork",
    "not_has_any_tag": ["mark-p1-lost"]
  }'::jsonb,
  '[
    {"action_type": "send_message", "target_system": "ghl", "target_entity": "contact", "priority": 10,
     "params": {"channel": "sms", "message": "No problem at all — I''ll close your file and you won''t hear from me again on this. If a storm season ever changes the math, you know where we are. Thanks for the straight answer."}},
    {"action_type": "add_tag", "target_system": "ghl", "target_entity": "contact", "params": {"tag": "loss-reason:not-interested"}},
    {"action_type": "add_tag", "target_system": "ghl", "target_entity": "contact", "params": {"tag": "objection-confirmed:not-interested"}},
    {"action_type": "add_tag", "target_system": "ghl", "target_entity": "contact", "params": {"tag": "cooling-active"}},
    {"action_type": "update_custom_fields", "target_system": "ghl", "target_entity": "contact",
     "params": {"fields": [{"id": "I9CbRV0dKMfwaSlge9uU", "value": "Not Interested (Now)"}]}},
    {"action_type": "move_opportunity", "target_system": "ghl", "target_entity": "opportunity",
     "params": {"pipeline": "P3", "stage": "Not Interested (Cooling)", "status": "open"}},
    {"action_type": "add_tag", "target_system": "ghl", "target_entity": "contact", "params": {"tag": "mark-p1-lost"}},
    {"action_type": "add_tag", "target_system": "ghl", "target_entity": "contact", "params": {"tag": "suppress-outbound"}}
  ]'::jsonb,
  false, true, 88, 'claude',
  'Explicit decline only — soft deferrals ("maybe next year") fall to Lane 5. May co-fire with rule 125 / dispatch row 1 on the same event: all tag/opp writes are idempotent, the P3 stage is the same id, and the outbound lock guarantees exactly one send.'
)
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category, rule_type = EXCLUDED.rule_type,
  event_pattern = EXCLUDED.event_pattern, context_conditions = EXCLUDED.context_conditions,
  action_template = EXCLUDED.action_template, requires_approval = EXCLUDED.requires_approval,
  enabled = EXCLUDED.enabled, priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = now();

-- Lane 5: catch-all acknowledgment — no S1.3 inbound dies in silence.
INSERT INTO agent_rules (rule_key, rule_name, category, rule_type, event_pattern, context_conditions, action_template, requires_approval, enabled, priority, created_by, notes)
VALUES (
  'S13_LANE5_CATCHALL',
  'S1.3 Lane 5 — unmatched inbound → ack + human handoff (safety net)',
  'S13_REPLY_LANES', 'contextual',
  '{"event_type": "ai.analysis_completed"}'::jsonb,
  '{
    "any_of": [
      {"has_tag_prefix": "sent:s1.3-"},
      {"custom_field_eq": {"field_id": "VFSNtEqSUh5yX7RyktBj", "value": "32fa691b-2422-4727-83c9-1174801974e9"}}
    ],
    "payload_message_not_matches": [
      "(?:\\b(?:we|i)(?:''?ve)?\\s+)?\\b(?:just\\s+)?moved\\b|\\bsold\\s+(?:the|our|that)\\s+(?:house|home|place)\\b|\\bno\\s+longer\\s+(?:own|live|at)\\b|\\bdon''?t\\s+live\\s+there\\b|\\bnew\\s+(?:house|home|address)\\b",
      "\\balready\\s+(?:had|have|got|did|done|been|installed|replaced|purchased|bought)\\b|\\b(?:had|got)\\s+(?:them|it|that|the\\s+(?:windows|work|job))\\s+done\\b|\\bwindows\\s+(?:are|were|got)\\s+(?:already\\s+)?(?:done|replaced|installed)\\b",
      "\\bstill\\s+(?:need|want|interested)\\b|\\b(?:i''?m|we''?re)\\s+interested\\b|\\bready\\s+to\\s+(?:schedule|book|talk|move\\s+forward)\\b|\\blet''?s\\s+(?:do\\s+it|schedule|book|talk)\\b|\\b(?:send|get)\\s+(?:me\\s+)?(?:a\\s+)?(?:quote|estimate|price|pricing)\\b|\\bhow\\s+much\\b",
      "\\bnot\\s+interested\\b|\\bno\\s+longer\\s+interested\\b|\\bno\\s+thanks?\\b|\\b(?:i''?m|we''?re)\\s+(?:out|good|all\\s+set)\\b|\\bnot\\s+for\\s+(?:me|us)\\b|\\bcount\\s+(?:me|us)\\s+out\\b",
      "\\b(stop\\s+(sending|emailing|texting|messaging|calling|contacting)|do\\s+not\\s+contact|remove\\s+me\\s+(from|off)|unsubscribe|no\\s+further\\s+(emails|messages|contact|texts))\\b",
      "\\b(contracted\\s+with\\s+(another|a\\s+different)|(signed|going|went)\\s+with\\s+(another|a\\s+different)|already\\s+(chose|picked|hired|signed|decided)|purchased\\s+(elsewhere|from\\s+(another|someone))|hired\\s+(another|someone\\s+else)|with\\s+another\\s+(company|vendor|contractor))\\b"
    ],
    "not_has_tag": "awaiting:moved-fork",
    "not_has_any_tag": ["mark-p1-lost", "suppress-outbound", "agentic-active"]
  }'::jsonb,
  '[
    {"action_type": "send_message", "target_system": "ghl", "target_entity": "contact", "priority": 10,
     "params": {"channel": "sms", "message": "Thanks for getting back to me — give me a moment and I''ll get you a proper answer."}},
    {"action_type": "send_notification", "target_system": "groupme", "target_entity": "contact",
     "params": {"notification_class": "priority", "action_verb": "S1.3 REPLY — NEEDS HUMAN", "tier": "Warm", "status": "Review",
       "message": "S1.3 inbound matched no lane. Message: \"{{message_text}}\"",
       "narrative": "Pilot safety net: unmatched S1.3 replies become human handoffs and classifier training data. The lead got an acknowledgment; ACTION: read and respond personally.",
       "next_step": "Read the message and reply personally"}}
  ]'::jsonb,
  false, true, 60, 'claude',
  'During the pilot no reply ever dies in silence. Excludes all four lane regexes + rule 172''s DNC regex + rule 173''s competitor regex (those paths own the conversation). No tags or routing — pure ack + handoff. | 2026-06-24: added agentic-active to not_has_any_tag — the catch-all must not fire (and steal the outbound-lock slot with the "give me a moment" filler) while the agentic lane (rule 106 + LAYER3_DISPATCH) owns the conversation. Diagnosed via Mark Test 0kk3xz6.'
)
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category, rule_type = EXCLUDED.rule_type,
  event_pattern = EXCLUDED.event_pattern, context_conditions = EXCLUDED.context_conditions,
  action_template = EXCLUDED.action_template, requires_approval = EXCLUDED.requires_approval,
  enabled = EXCLUDED.enabled, priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = now();

-- ────────────────────────────────────────────────────────────────────
-- Phase B2 — layer3_action_dispatch route_to_p3 contract retrofit
-- (full-array rewrites of the live JSON captured 2026-06-10; the two
--  inserted elements sit directly after the loss-reason tag)
-- ────────────────────────────────────────────────────────────────────

UPDATE layer3_action_dispatch SET actions = '[
  {"params": {"tag": "reactivation-eligible"}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "reactivation-tier-1"}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "reactivation-tier-2"}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "reactivation-tier-3"}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "cooling-active"}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "p3:not-interested-now"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "loss-reason:not-interested"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"fields": [{"id": "I9CbRV0dKMfwaSlge9uU", "value": "Not Interested (Now)"}]}, "action_type": "update_custom_fields", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "mark-p1-lost"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "objection-confirmed:not-interested"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "suppress-outbound"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "stage:long-term-nurture"}, "action_type": "set_stage", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"stage": "Not Interested (Now)", "status": "open", "pipeline": "P3"}, "action_type": "move_opportunity", "target_entity": "opportunity", "target_system": "ghl"}
]'::jsonb,
notes = notes || ' | 2026-06-10 route_to_p3 contract: +Intended Loss Reason field (Not Interested (Now)) + mark-p1-lost after the loss-reason tag, so L.0 closes the P1 opp.',
updated_at = now()
WHERE id = 1 AND recommended_action = 'suppress';

UPDATE layer3_action_dispatch SET actions = '[
  {"params": {"dnd": true}, "action_type": "update_contact", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "dnc-email"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "dnc-all"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "trust-break-process"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "suppress-outbound"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "loss-reason:competitor"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"fields": [{"id": "I9CbRV0dKMfwaSlge9uU", "value": "Price / Shopping"}]}, "action_type": "update_custom_fields", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "mark-p1-lost"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "loss-pre-appointment"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "p3:dnc"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "intent-hot"}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "intent-spike"}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "intent-imminent"}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "engaged-email"}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "engaged-sms"}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "pause-workflow"}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "reactivation-eligible"}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "reactivation-tier-1"}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "reactivation-tier-2"}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "reactivation-tier-3"}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "cooling-active"}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "stage:lost"}, "action_type": "set_stage", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"stage": "Do Not Contact", "status": "open", "pipeline": "P3"}, "action_type": "move_opportunity", "target_entity": "opportunity", "target_system": "ghl"},
  {"params": {"body": "Layer 3 detected hard cancellation/DNC. Contact closed in P1, moved to P3 DNC, GHL DND set. Audit upstream messaging — may be automation-caused trust break.", "title": "DNC + Lost to Competitor", "channel": "automation-alerts"}, "action_type": "send_notification", "target_entity": "contact", "target_system": "groupme"}
]'::jsonb,
notes = notes || ' | 2026-06-10 route_to_p3 contract: +Intended Loss Reason field (Price / Shopping) + mark-p1-lost after loss-reason:competitor — the notes always claimed "Closes P1 opp lost" but the actions never did it.',
updated_at = now()
WHERE id = 5 AND recommended_action = 'cancellation_dnc';

-- ────────────────────────────────────────────────────────────────────
-- Phase B3 — agent_rules audit retrofit (rules 14, 96)
-- ────────────────────────────────────────────────────────────────────

UPDATE agent_rules SET action_template = '[
  {"params": {"tag": "stage:dnc"}, "action_type": "set_stage", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "suppress-automation"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "stop-bot"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "lp-dnc"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"remove_all": true}, "action_type": "remove_from_workflow", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "loss-reason:dnc"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"fields": [{"id": "I9CbRV0dKMfwaSlge9uU", "value": "DNC"}]}, "action_type": "update_custom_fields", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "mark-p1-lost"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"stage": "Do Not Contact", "status": "open", "pipeline": "P3"}, "action_type": "move_opportunity", "target_entity": "opportunity", "target_system": "ghl"}
]'::jsonb,
context_conditions = '{"not_has_tag": "mark-p1-lost"}'::jsonb,
notes = COALESCE(notes, '') || ' | 2026-06-10 route_to_p3 contract: +loss-reason:dnc + Intended Loss Reason (DNC) + mark-p1-lost before the P3 move; not_has_tag guard for idempotency.',
updated_at = now()
WHERE id = 14 AND rule_key = 'LP_DISP_DNC';

UPDATE agent_rules SET action_template = '[
  {"params": {"tag": "cold-lead-archived"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"reason": "Zero-data lead archived after 48h", "remove_all": true}, "action_type": "remove_from_workflow", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "loss-reason:no-engagement"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"fields": [{"id": "I9CbRV0dKMfwaSlge9uU", "value": "Ghosted / Unresponsive"}]}, "action_type": "update_custom_fields", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"tag": "mark-p1-lost"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"},
  {"params": {"stage": "Hard Disqualified", "status": "abandoned", "pipeline": "P3"}, "action_type": "move_opportunity", "target_entity": "opportunity", "target_system": "ghl"}
]'::jsonb,
rule_type = 'contextual',
context_conditions = '{"not_has_tag": "mark-p1-lost"}'::jsonb,
notes = COALESCE(notes, '') || ' | 2026-06-10 route_to_p3 contract: +loss-reason:no-engagement + Intended Loss Reason (Ghosted / Unresponsive) + mark-p1-lost; rule_type -> contextual with not_has_tag guard (daily cron — guard essential). findMatchingRules does not filter by rule_type, so the flip only adds the condition check.',
updated_at = now()
WHERE id = 96 AND rule_key = 'COLD_LEAD_ZERO_DATA';
