-- 2026-10-01 — 1Leg and "ghost after booking" still route to S5.2, but never a contact who had a
-- demo (Mark, 2026-10-01). Cancels and no-shows are unchanged: they go to S5.2 whether or not the
-- contact demoed (Mark, 2026-09-30).
--
-- Needs the lp_had_demo operator (src/decision-engine.js) DEPLOYED FIRST: an unknown operator
-- fails closed and the rule would stop firing altogether.
--
-- Last 30 days before this: 15 of 110 1Leg entries and 6 of 53 ghost entries had a demo on record.
-- lp_had_demo reads LP demo truth (src/demo-truth.js: every lead, every appointment), not the
-- lp-demo-completed tag, which lagged a day behind the demo.

-- Expect 2.
WITH u AS (
  UPDATE agent_rules SET
    context_conditions = context_conditions || '{"lp_had_demo":false}'::jsonb,
    version = coalesce(version,1) + 1, updated_at = now(),
    notes = coalesce(notes,'') || E'\n2026-10-01: lp_had_demo=false — a contact who had a demo never goes to S5.2 this way (Mark).'
  WHERE rule_key IN ('LP_DISP_1LEG_TO_ONELEG','BEHAVIORAL_GHOST_AFTER_BOOKING')
    AND enabled AND NOT (context_conditions ? 'lp_had_demo')
  RETURNING 1)
SELECT count(*) FROM u;

-- Then reload: POST https://lp-mcp-production.up.railway.app/n8n/decision-engine/reload-rules

-- ROLLBACK:
-- UPDATE agent_rules SET context_conditions = context_conditions - 'lp_had_demo', updated_at = now()
--   WHERE rule_key IN ('LP_DISP_1LEG_TO_ONELEG','BEHAVIORAL_GHOST_AFTER_BOOKING');
