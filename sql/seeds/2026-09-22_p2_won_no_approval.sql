-- ============================================================================
-- Seed: rule 366 P2_JOB_TERMINAL_WON no longer requires approval, and posts a
--       notification instead (notify-and-execute tier).
-- Date: 2026-09-22 (applied live the same day, per Mark)
-- WHY: the approval step was delaying the WON mark, not catching errors.
--      33 firings 2026-09-19..22: 0 rejected, 0 failed. 30 of them were run by
--      the approval-escalation sweep at 60 minutes with nobody deciding
--      (approved_by = auto_escalation_60min), 2 were approved by Mark in Slack,
--      1 was suppressed. #486315 ($116,000 job) is the card that prompted the
--      plain-English approval work in LP-MCP#1007 / #1009.
--      The notification keeps a visible trail of every automatic WON.
--      365 P2_JOB_TERMINAL_LOST is deliberately left approval-gated.
-- Idempotent: sets the full template, so re-running does not stack actions.
-- ============================================================================
BEGIN;
UPDATE agent_rules SET
  requires_approval = false,
  action_template = '[
    {"params": {"status": "won", "pipeline": "P2"}, "priority": 5,
     "action_type": "update_opportunity", "target_entity": "opportunity", "target_system": "ghl"},
    {"action_type": "send_notification",
     "params": {
       "notification_class": "intelligence",
       "action_verb": "P2 MARKED WON",
       "status": "Won",
       "message": "P2 WON — LP job reached a collected status, Pipeline 2 opportunity marked Won automatically",
       "narrative": "The LP job for this contact moved to a collected status (Paid In Full, PIF Survey Ready, PIF NO Survey or Assumed Complete). The Pipeline 2 opportunity was marked Won with no approval step. If this is wrong, reopen the opportunity in GHL."
     }}
  ]'::jsonb,
  updated_at = now()
WHERE rule_key = 'P2_JOB_TERMINAL_WON';
COMMIT;
-- Verification (2026-09-22 20:39Z):
--   SELECT requires_approval, version, jsonb_array_length(action_template)
--   FROM agent_rules WHERE rule_key = 'P2_JOB_TERMINAL_WON';
--   → false, 2, 2
-- Reload required after apply:
--   POST /n8n/decision-engine/reload-rules → rules_loaded 295 (295 → 295, modify only)
-- Rollback:
--   UPDATE agent_rules SET requires_approval = true,
--     action_template = '[{"params": {"status": "won", "pipeline": "P2"}, "priority": 5,
--       "action_type": "update_opportunity", "target_entity": "opportunity", "target_system": "ghl"}]'::jsonb,
--     updated_at = now()
--   WHERE rule_key = 'P2_JOB_TERMINAL_WON';
--   then reload and assert rules_loaded unchanged.
