-- 2026-10-18 — a new follow-up request does not clear the follow-up it renews (the user).
--
-- Rule 330 FOLLOW_UP_CLEARED_ON_REPLY removes the follow-up:* tag when the lead
-- replies. Rasheema (HEln9jIOvRvDLEwhYo8T) asked for a follow-up, then texted
-- "I need a few days to unfreeze my credit for the soft pull." — itself a
-- follow_up_scheduled reply — and rule 330 cleared the tag, so when hold 584107
-- ended (2026-10-17 17:38 UTC) rule 331 FOLLOW_UP_DUE_REENGAGE found no
-- follow-up:* tag and the check-in never went (no_matching_rules).
-- Applied live on 2026-10-18 (1 row); this file records it.

-- Expect 1 (0 once applied).
WITH u AS (
  UPDATE agent_rules SET
    context_conditions = coalesce(context_conditions, '{}'::jsonb) || '{"recommended_action_nin": ["follow_up_scheduled"]}'::jsonb,
    version = coalesce(version, 1) + 1, updated_at = now(),
    notes = coalesce(notes, '') || E'\n2026-10-18: + recommended_action_nin follow_up_scheduled (the user): a new follow-up request keeps its tag.'
  WHERE rule_key = 'FOLLOW_UP_CLEARED_ON_REPLY'
    AND NOT (coalesce(context_conditions, '{}'::jsonb) ? 'recommended_action_nin')
  RETURNING 1)
SELECT count(*) FROM u;
