-- ============================================================================
-- Seed: rule 365 P2_JOB_TERMINAL_LOST no longer requires approval, and posts a
--       notification instead (notify-and-execute tier). Same change as
--       2026-09-22_p2_won_no_approval.sql for rule 366.
-- Date: 2026-09-22 (applied live the same day, per Mark)
-- WHY: the approval step was a one-hour delay, not a gate. 12 firings:
--      0 rejected; 10 were run by the approval-escalation sweep at 60 minutes
--      with nobody deciding (approved_by = auto_escalation_60min), 1 approved
--      by Mark in Slack, 1 skipped.
--      The L.6 hand-off after a successful close (src/loss-routing/l6.js,
--      postL6AfterP2Loss) keys on rule_applied and on the update_opportunity
--      result, not on approval, so it is unaffected — and the new
--      send_notification step cannot trigger it.
-- Idempotent: sets the full template, so re-running does not stack actions.
-- ============================================================================
BEGIN;
UPDATE agent_rules SET
  requires_approval = false,
  action_template = '[
    {"params": {"status": "lost", "pipeline": "P2"}, "priority": 5,
     "action_type": "update_opportunity", "target_entity": "opportunity", "target_system": "ghl"},
    {"action_type": "send_notification",
     "params": {
       "notification_class": "intelligence",
       "action_verb": "P2 MARKED LOST",
       "status": "Lost",
       "message": "P2 LOST — LP job reached a terminal dead status, Pipeline 2 opportunity marked Lost automatically",
       "narrative": "The LP job for this contact moved to a terminal dead status (Cancelled, Cancelled By Mgt, Dead Deal, Sent To Attorney or Credit Decline). The Pipeline 2 opportunity was marked Lost with no approval step, and the contact was handed to L.6 for loss routing. If this is wrong, reopen the opportunity in GHL."
     }}
  ]'::jsonb,
  updated_at = now()
WHERE rule_key = 'P2_JOB_TERMINAL_LOST';
COMMIT;
-- Verification (2026-09-22 21:05Z):
--   SELECT requires_approval, version, jsonb_array_length(action_template)
--   FROM agent_rules WHERE rule_key = 'P2_JOB_TERMINAL_LOST';
--   → false, 2, 2
--   Enabled rules still requiring approval: only 169 W9_OUTCOME_HIGH_VALUE_UNRESOLVED_REP_TASK.
-- Reload required after apply:
--   POST /n8n/decision-engine/reload-rules → rules_loaded 295 (295 → 295, modify only)
-- Rollback:
--   UPDATE agent_rules SET requires_approval = true,
--     action_template = '[{"params": {"status": "lost", "pipeline": "P2"}, "priority": 5,
--       "action_type": "update_opportunity", "target_entity": "opportunity", "target_system": "ghl"}]'::jsonb,
--     updated_at = now()
--   WHERE rule_key = 'P2_JOB_TERMINAL_LOST';
--   then reload and assert rules_loaded unchanged.
