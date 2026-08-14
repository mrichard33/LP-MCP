-- ════════════════════════════════════════════════════════════════════
-- RULE 106 — escalate_to_rep no longer stands down (silence at handoff)
-- 2026-08-14  (durable record; pairs with the agentic email channel work
--              in PR #679)
--
-- STATUS: ALREADY APPLIED IN PRODUCTION by hand on 2026-08-13 22:41:28 UTC
--   (agent_rules.id=106 → version 6). agent_rules is database config: it
--   takes effect on the next decision-engine rule load and never passes
--   through GitHub, so this file exists as the durable record of a change
--   that otherwise leaves no trace in the repo. The statement below is
--   IDEMPOTENT — removing an absent array element is a no-op — so it is safe
--   to re-run, and safe to run against a restored/branched database that
--   predates the manual change.
--
-- WHAT: drops 'escalate_to_rep' from rule 106
--   (AGENTIC_RESPOND_POST_CHATBOT) context_conditions.recommended_action_nin,
--   taking that stand-down list from 8 entries to 7. Nothing else in
--   context_conditions is touched (has_tag, not_has_tag, payload_field_in,
--   payload_field_null all unchanged).
--
-- WHY: recommended_action_nin is the list of classifications rule 106 stands
--   down from because something ELSE owns the reply — normally a
--   layer3_action_dispatch row. escalate_to_rep had no such owner. Its
--   dispatch row carries no send_message, and no other enabled rule sends on
--   it (BEHAVIORAL_ESCALATE_REP creates a task only; BEHAVIORAL_ESCALATE_NON_
--   CS_HOT_CALL enrols B.HC and tags). So nothing owned the reply and the
--   lead got TOTAL SILENCE at the exact moment their conversation was being
--   handed to a human: 3 of 13 email inbounds classified escalate_to_rep over
--   the 90 days to 2026-08-13.
--
--   This is the same fix pattern applied to fast_track_booking on 2026-07-06,
--   whose own rule notes record that it was removed from the stand-down list
--   precisely so contacts got "a normal (logistics-style) reply instead of
--   silence".
--
-- NO NEW CODE: the responder already has acknowledgment-only conduct wired to
--   this exact classification — response-generator's `ackOnly` branch
--   (recommendedAction === 'escalate_to_rep') confirms receipt, names the
--   human who now owns it, sells nothing and promises no timeline. It also
--   suppresses the handoff bridge, so an escalation acknowledgment is never
--   stacked with a broadcast-handoff preamble.
--
-- NO DOUBLE-SEND: the escalate_to_rep dispatch row has no send_message
--   sub-action, so rule 106 is the only sender. This is the condition that
--   makes removal safe, and it is what the other seven entries in the list
--   still fail — they each have a Layer 3 row that owns the reply.
--
-- SCOPE NOTE: 'objection_price' remains in the list deliberately. It is
--   covered by a strike rule, not by a dispatch row, so it is not a silence
--   gap. The other silent-non-reply classifications seen in the same 90-day
--   window (suppress 8, deploy_objection_handler 4, continue_current 2) are
--   NOT nin-related at all — those classifications ARE admitted by rule 106
--   and did get 10, 21 and 13 email replies respectively; their gaps are
--   guards firing, some of them correctly (a suppress on a genuine decline
--   SHOULD be silent). Do not "fix" them by the same move.
-- ════════════════════════════════════════════════════════════════════
BEGIN;

UPDATE agent_rules
SET context_conditions = jsonb_set(
      context_conditions,
      '{recommended_action_nin}',
      (context_conditions->'recommended_action_nin') - 'escalate_to_rep'
    ),
    updated_at = now()
WHERE id = 106
  AND context_conditions->'recommended_action_nin' ? 'escalate_to_rep';

COMMIT;

-- Reload the decision engine so the change takes effect without waiting for
-- the next deploy:  POST /n8n/decision-engine/reload-rules

-- ── Verify ──────────────────────────────────────────────────────────
-- Expect 7 entries, escalate_to_rep absent, everything else intact.
--
-- SELECT jsonb_array_length(context_conditions->'recommended_action_nin') AS n,
--        context_conditions->'recommended_action_nin' AS stand_down_list,
--        context_conditions - 'recommended_action_nin' AS other_conditions
-- FROM agent_rules WHERE id = 106;
--
-- Behavioural check — escalate_to_rep inbounds should now queue a
-- send_message under AGENTIC_RESPOND_POST_CHATBOT instead of nothing:
--
-- SELECT se.created_at, se.payload->>'channel' AS inbound_channel,
--        aa.id AS action_id, aa.status, aa.rule_applied
-- FROM system_events se
-- LEFT JOIN agent_actions aa
--        ON aa.event_id = se.id AND aa.action_type = 'send_message'
-- WHERE se.event_type = 'ai.analysis_completed'
--   AND se.payload->>'recommended_action' = 'escalate_to_rep'
--   AND se.created_at > '2026-08-13T22:41:28Z'
-- ORDER BY se.created_at DESC;

-- ── Rollback ────────────────────────────────────────────────────────
-- Restores the stand-down, returning escalated leads to silence. Only do
-- this if the acknowledgment is judged worse than no reply at all.
--
-- BEGIN;
-- UPDATE agent_rules
-- SET context_conditions = jsonb_set(
--       context_conditions,
--       '{recommended_action_nin}',
--       (context_conditions->'recommended_action_nin') || '["escalate_to_rep"]'::jsonb
--     ),
--     updated_at = now()
-- WHERE id = 106
--   AND NOT (context_conditions->'recommended_action_nin' ? 'escalate_to_rep');
-- COMMIT;
