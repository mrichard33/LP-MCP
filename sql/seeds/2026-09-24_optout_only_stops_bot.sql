-- ═══════════════════════════════════════════════════════════════════════════
-- Only an opt-out switches the bot off — missed-reply pair narrowed
-- 2026-09-24 · APPLIED LIVE 2026-09-24 02:28 UTC · reload rules_loaded 302 → 302
--
-- WHAT
--   AGENTIC_REPLY_SLA_OPTOUT  (372)  payload_message_matches      → opt-out words only
--   AGENTIC_REPLY_SLA_RECOVER (373)  payload_message_not_matches  → the SAME regex
--   372's task title now reads "Lead asked us to stop — reply was missed".
--
-- WHY
--   Mark, 2026-09-24: "I don't think the bot should ever deactivate unless an
--   opt out." 372 applied stop-bot (permanent) to a missed reply that said
--   "not interested", "no longer interested", "never use you" or "solicit".
--   None of those is an opt-out. They now fall to 373, which answers the lead.
--   STOP / unsubscribe / opt out / remove me / take me off / don't text-call-
--   email / leave me alone still stop everything, with no reply, as before.
--
--   The two regexes MUST stay identical: 372 matches, 373 not_matches. If they
--   drift, a message either gets both (stop-bot plus a reply) or neither.
--
--   372 had fired 0 times when this was applied (created 2026-09-22).
--
-- REGEX NOTE
--   The engine compiles these with JavaScript `new RegExp(raw, 'i')`, where \b
--   is a word boundary. In Postgres `~*`, \b is a backspace, so a SQL test of
--   this pattern is meaningless. Test with node.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE agent_rules SET
  context_conditions = jsonb_set(context_conditions, '{payload_message_matches}',
    to_jsonb('(\bstop\b|\bunsubscribe\b|opt\s*out|remove\s+me|take\s+me\s+off|do\s+not\s+(contact|text|call|email)|don''?t\s+(contact|text|call|email)|leave\s+(me|us)\s+alone)'::text)),
  action_template = jsonb_set(jsonb_set(action_template,
      '{2,params,title}', to_jsonb('Lead asked us to stop — reply was missed'::text)),
      '{3,params,status}', to_jsonb('Opt-out we missed'::text)),
  updated_at = now()
WHERE rule_key = 'AGENTIC_REPLY_SLA_OPTOUT';

UPDATE agent_rules SET
  context_conditions = jsonb_set(context_conditions, '{payload_message_not_matches}',
    jsonb_build_array('(\bstop\b|\bunsubscribe\b|opt\s*out|remove\s+me|take\s+me\s+off|do\s+not\s+(contact|text|call|email)|don''?t\s+(contact|text|call|email)|leave\s+(me|us)\s+alone)'::text)),
  updated_at = now()
WHERE rule_key = 'AGENTIC_REPLY_SLA_RECOVER';

-- Verify: the pair must agree.
-- SELECT (a.context_conditions->>'payload_message_matches') = (b.context_conditions->'payload_message_not_matches'->>0)
--   FROM agent_rules a, agent_rules b
--  WHERE a.rule_key = 'AGENTIC_REPLY_SLA_OPTOUT' AND b.rule_key = 'AGENTIC_REPLY_SLA_RECOVER';   -- true
--
-- Then: POST /n8n/decision-engine/reload-rules and assert rules_loaded.

-- ROLLBACK (the 2026-09-21 regex):
-- (not\s+interested|no\s+longer\s+interested|\bstop\b|\bunsubscribe\b|remove\s+me|do\s+not\s+(contact|text|call|email)|don'?t\s+(contact|text|call|email)|leave\s+(me|us)\s+alone|never\s+use\s+you|solicit)
-- written into both rules the same way as above, then reload.
