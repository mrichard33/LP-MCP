-- 2026-10-19 — A post-demo decline gets ONE reply, never an O.0 drip beside it (Mark's ruling).
--
-- Thomas Geary (GHL aueIFUNV3UeZpATu51hc, LP Prospect 461733, rehash lead, OPPFDN 10/10) emailed a
-- firm decline on 2026-10-12 ("We will not be investing 25 % of purchased value when the market value
-- will not justify the cost."). Beside the email reply (agent_actions 573254), rule 65
-- BEHAVIORAL_PRICE_OBJECTION enrolled him in O.0 (573250) and rule 214 OBJECTION_ROUTE_POST_DEMO
-- enrolled him again (573270). Rule 297 (not-interested cooling track) stays the owner of a decline;
-- it fires only when the analyzer calls it not-interested (Thomas was classified price).
--
-- New verb `not_post_demo_decline` (src/decision-engine.js; pure check isPostDemoDecline in
-- src/agentic/post-demo-email.js): post-demo tags (lp-demo-completed, stage:post-appointment, rehash,
-- active-f.0) AND a firm decline in the lead's words (isNotInterested, src/agentic/not-interested.js).
-- Rule 65 reads the text from its ai.analysis_completed payload; rule 214's intent.objection_detected
-- has an empty payload, so the lead's latest inbound in the hour before is read. A failed read fails
-- closed (no O.0); no inbound at all is not a decline.
--
-- APPLY AFTER THE DEPLOY that carries the verb (an unknown verb fails closed and would stop both rules
-- firing at all). Then POST /n8n/decision-engine/reload-rules.

-- Expect 2.
WITH u AS (
  UPDATE agent_rules SET
    context_conditions = coalesce(context_conditions, '{}'::jsonb) || '{"not_post_demo_decline": true}'::jsonb,
    version = coalesce(version,1) + 1, updated_at = now(),
    notes = coalesce(notes,'') || E'\n2026-10-19: + not_post_demo_decline. A post-demo decline gets one reply, never O.0 beside it (Mark; Thomas Geary, 2026-10-12).'
  WHERE rule_key IN ('BEHAVIORAL_PRICE_OBJECTION', 'OBJECTION_ROUTE_POST_DEMO')
    AND NOT (coalesce(context_conditions, '{}'::jsonb) ? 'not_post_demo_decline')
  RETURNING 1)
SELECT count(*) FROM u;

-- Rollback:
-- UPDATE agent_rules SET context_conditions = context_conditions - 'not_post_demo_decline', updated_at = now()
--   WHERE rule_key IN ('BEHAVIORAL_PRICE_OBJECTION', 'OBJECTION_ROUTE_POST_DEMO');
