-- ════════════════════════════════════════════════════════════════════
-- P2 Won requires the install — 2026-10-20 (the user's ruling)
--
-- "The only time an opportunity in pipeline 2 should be considered won is if
--  the project is installed." Won = the job is collected (Paid In Full, PIF
--  Survey Ready, PIF NO Survey, Assumed Complete) AND installed (an actual,
--  passed Install End (F) or Completion (C) date). Installed & Unpaid stays open
--  until paid (same ruling).
--
-- WHY: rule 366 P2_JOB_TERMINAL_WON closed cards Won on the job STATUS alone and
--   left the stage where it was. On 2026-10-20, 106 of 1,468 Won P2 cards sat in
--   a stage before "7. Install Completed" (47 at Contract Signed), 102 of them
--   closed by rule 366 on 2026-09-18..23.
--
-- THE CODE HALF ships in the same PR and must deploy FIRST:
--   src/p2-won-guard.js                   decideP2Win(): refuses any P2 Won close
--                                         whose tracked job is not installed AND
--                                         paid (skipped, reason won_before_install
--                                         / won_job_not_collected / ...), and moves
--                                         the card forward to Install Completed
--   src/actions/handlers/opportunities.js executeUpdateOpportunity runs it
--   src/lp-job-terminal.js                isInstalled() / isWonJob()
--   Rule 366 keeps its trigger (a collected status): the guard decides.
--
-- THIS FILE adds the other half: a job paid BEFORE its install (rule 366 now
--   refuses it) is won when the install lands. P2_INSTALL_COMPLETE_WON fires on
--   lp.milestone_completed for F, C, I or B (I and B because the emitter may send
--   only the furthest-along milestone) and queues the same update_opportunity.
--   The guard passes it only when the job is also collected, so an Installed &
--   Unpaid job's milestone is a skipped row (won_job_not_collected), not a win.
--   No notification step: wins are counted in the 08:00 digest (P2_RULES).
--
-- ORDER: 1. merge + deploy. 2. run this file. 3. reload and assert the count.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

INSERT INTO agent_rules
  (rule_key, rule_name, category, event_pattern, conditions, context_conditions,
   action_template, requires_approval, enabled, priority, rule_type, notes, created_by)
SELECT
  'P2_INSTALL_COMPLETE_WON',
  'LP install finished on a paid job -> mark P2 opportunity won',
  'integration',
  '{"event_type": "lp.milestone_completed"}'::jsonb,
  NULL,
  '{"payload_field_in": {"field": "mdt_id", "values": ["F","C","I","B"]}}'::jsonb,
  '[{"action_type":"update_opportunity","target_system":"ghl","target_entity":"opportunity",
     "params":{"pipeline":"P2","status":"won","bypass_suppression":true},"priority":5}]'::jsonb,
  false, true, 95, 'contextual',
  'Won needs installed AND paid (user, 2026-10-20). The executor guard (src/p2-won-guard.js) refuses the close unless the tracked LP job is collected and installed. Pairs with rule 366, which fires on the status.',
  'claude'
WHERE NOT EXISTS (SELECT 1 FROM agent_rules WHERE rule_key = 'P2_INSTALL_COMPLETE_WON');

UPDATE agent_rules SET
  notes = 'Fires on a collected status. Won needs installed AND paid (user, 2026-10-20): the executor guard (src/p2-won-guard.js) refuses the close until the install has finished; P2_INSTALL_COMPLETE_WON wins it then. Installed & Unpaid deliberately excluded.',
  updated_at = now()
WHERE rule_key = 'P2_JOB_TERMINAL_WON';

COMMIT;

-- Verification: expect the new rule enabled, requires_approval false.
SELECT json_agg(row_to_json(s)) FROM (
  SELECT rule_key, enabled, requires_approval, priority, rule_type, event_pattern, context_conditions
    FROM agent_rules WHERE rule_key IN ('P2_JOB_TERMINAL_WON', 'P2_INSTALL_COMPLETE_WON')
) s;

-- Reload required after apply:
--   POST /n8n/decision-engine/reload-rules → rules_loaded 315 (314 enabled on 2026-10-20 + 1)

-- After a day: refusals and wins.
SELECT json_agg(row_to_json(s)) FROM (
  SELECT rule_applied, status, error_message, count(*) AS n
    FROM agent_actions
   WHERE rule_applied IN ('P2_JOB_TERMINAL_WON', 'P2_INSTALL_COMPLETE_WON')
     AND action_type = 'update_opportunity' AND created_at > now() - interval '1 day'
   GROUP BY 1, 2, 3 ORDER BY 1, 2
) s;

-- Rollback (the code guard stays; a paid-before-install card then stays open):
-- DELETE FROM agent_rules WHERE rule_key = 'P2_INSTALL_COMPLETE_WON';  then reload, assert 314.
