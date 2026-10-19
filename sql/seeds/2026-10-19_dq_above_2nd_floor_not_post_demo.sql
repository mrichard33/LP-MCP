-- 2026-10-19 (Sam, IMWge24jxc0xO0ppy7OR): a lead past the demo is never turned
-- away for the building height. His rep had been to the high-rise; he asked
-- about "a list of high-rises" and the reply said we only do two stories. The
-- reply guard now skips the lead side after a demo (property-scope.js
-- pastDemo), and the two building-height DQ rules must not hard-disqualify a
-- lead whose rep already saw the home: one "high-rise" after a demo would add
-- hard-disqualified, loss-reason:bad-fit and send the exit text.
--
-- lp_had_demo: false is LP demo truth (decision-engine.js, contactHadDemo over
-- every lead); a failed read fails closed, so the rule does not fire.
--
-- ROLLBACK: UPDATE agent_rules SET context_conditions = context_conditions - 'lp_had_demo'
--           WHERE rule_key IN ('DQ_ABOVE_2ND_FLOOR_INTERIM', 'DQ_ABOVE_2ND_FLOOR_DETECTED');

WITH u AS (
  UPDATE agent_rules
     SET context_conditions = context_conditions || '{"lp_had_demo": false}'::jsonb,
         version = coalesce(version, 1) + 1, updated_at = now()
   WHERE rule_key IN ('DQ_ABOVE_2ND_FLOOR_INTERIM', 'DQ_ABOVE_2ND_FLOOR_DETECTED')
  RETURNING 1
)
SELECT count(*) AS updated FROM u;  -- expect 2
