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
--                                         paid, and moves the card forward to
--                                         Install Completed
--   src/actions/handlers/opportunities.js executeUpdateOpportunity runs it
--   src/lp-job-terminal.js                isInstalled() / isWonJob()
--   Rule 366 keeps its trigger (a collected status): the guard decides.
--
-- THIS FILE adds the other half: a job paid BEFORE its install (rule 366 now
--   refuses it) is won when the install lands. The four install milestone rules
--   (F 117, C 118, I 350, B 119) get a SECOND step, update_opportunity won, AFTER
--   their stage move. A batch runs its actions serially in sequence_order
--   (src/actions/index.js), so the card enters Install Completed while still OPEN
--   and GHL C.2 Post-Install Check-In (trigger: stage Install Completed AND status
--   open) still starts; only then is it closed Won. A separate rule would race the
--   move: a win that landed first would enter the stage already Won and C.2 would
--   never start. The guard passes the win only when the job is also collected, so
--   on an Installed & Unpaid job that step is a skipped row
--   (won_job_not_collected), not a win.
--   Templates are written whole, so re-running does not stack steps.
--
-- ORDER: 1. merge + deploy. 2. run this file. 3. reload: rules_loaded unchanged
--   (314 enabled on 2026-10-20; templates only).
-- ════════════════════════════════════════════════════════════════════

BEGIN;

UPDATE agent_rules SET action_template = jsonb_build_array(
    jsonb_build_object('action_type', 'move_opportunity',
      'params', jsonb_build_object('stage', v.stage, 'status', 'open', 'pipeline', 'P2', 'bypass_suppression', true)),
    jsonb_build_object('action_type', 'add_tag',
      'params', jsonb_build_object('tag', v.tag, 'bypass_suppression', true)),
    jsonb_build_object('action_type', 'update_opportunity', 'target_system', 'ghl', 'target_entity', 'opportunity',
      'params', jsonb_build_object('pipeline', 'P2', 'status', 'won', 'bypass_suppression', true))
  ),
  updated_at = now()
FROM (VALUES
  ('P2_MILESTONE_INSTALL_END',       'Install Completed',    'p2-stage:install-completed'),
  ('P2_MILESTONE_COMPLETION',        'Install Completed',    'p2-stage:install-completed'),
  ('P2_MILESTONE_INSPECTION_SET',    'Install Completed',    'p2-stage:inspection-scheduled'),
  ('P2_MILESTONE_INSPECTION_PASSED', 'Referral & Expansion', 'p2-stage:referral-expansion')
) AS v(rule_key, stage, tag)
WHERE agent_rules.rule_key = v.rule_key;

UPDATE agent_rules SET
  notes = 'Fires on a collected status. Won needs installed AND paid (user, 2026-10-20): the executor guard (src/p2-won-guard.js) refuses the close until the install has finished; the install milestone rules (F/C/I/B) close it Won then, after their stage move. Installed & Unpaid deliberately excluded.',
  updated_at = now()
WHERE rule_key = 'P2_JOB_TERMINAL_WON';

COMMIT;

-- Verification: expect 4 rows, each with 3 steps, the last update_opportunity won.
SELECT json_agg(row_to_json(s)) FROM (
  SELECT rule_key, enabled, jsonb_array_length(action_template) AS steps,
         action_template->2->>'action_type' AS last_step, action_template->2->'params'->>'status' AS last_status
    FROM agent_rules
   WHERE rule_key IN ('P2_MILESTONE_INSTALL_END','P2_MILESTONE_COMPLETION','P2_MILESTONE_INSPECTION_SET','P2_MILESTONE_INSPECTION_PASSED')
) s;

-- Reload required after apply:
--   POST /n8n/decision-engine/reload-rules → rules_loaded unchanged (314)

-- After a day: wins and refusals by rule.
SELECT json_agg(row_to_json(s)) FROM (
  SELECT rule_applied, status, error_message, count(*) AS n
    FROM agent_actions
   WHERE rule_applied IN ('P2_JOB_TERMINAL_WON','P2_MILESTONE_INSTALL_END','P2_MILESTONE_COMPLETION',
                          'P2_MILESTONE_INSPECTION_SET','P2_MILESTONE_INSPECTION_PASSED')
     AND action_type = 'update_opportunity' AND created_at > now() - interval '1 day'
   GROUP BY 1, 2, 3 ORDER BY 1, 2
) s;

-- Rollback: drop the third step (templates as of 2026-10-20), then reload.
-- UPDATE agent_rules SET action_template = action_template - 2, updated_at = now()
--  WHERE rule_key IN ('P2_MILESTONE_INSTALL_END','P2_MILESTONE_COMPLETION',
--                     'P2_MILESTONE_INSPECTION_SET','P2_MILESTONE_INSPECTION_PASSED')
--    AND jsonb_array_length(action_template) = 3;
