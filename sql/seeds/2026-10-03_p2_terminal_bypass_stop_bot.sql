-- ============================================================================
-- Seed: rules 365 P2_JOB_TERMINAL_LOST and 366 P2_JOB_TERMINAL_WON close the
--       P2 opportunity even when the contact carries stop-bot.
-- Date: 2026-10-03 (applied live the same day, by the user's ruling)
-- WHY: neither rule needs approval (2026-09-22 seeds), but the mutation gate in
--      src/actions/index.js blocks update_opportunity for a stop-bot /
--      suppress-automation contact. 17 WON closes in 14 days were suppressed
--      that way, leaving 16 Paid In Full jobs open in P2 (~$417k) and inflating
--      open pipeline value. The P2_MILESTONE_* rules already carry
--      bypass_suppression=true (isMutationGateExempt in
--      src/services/suppression-check.js), so closing the card is treated the
--      same as moving it. The user chose Won AND Lost (a Lost close also posts
--      to L.6). The send_notification step is unchanged.
-- The 16 suppressed WON rows were re-queued the same day with the flag added.
-- Idempotent: jsonb_set on the first (update_opportunity) step only.
-- ============================================================================
BEGIN;
UPDATE agent_rules SET
  action_template = jsonb_set(action_template, '{0,params,bypass_suppression}', 'true'::jsonb),
  version = coalesce(version, 1) + 1,
  updated_at = now()
WHERE rule_key IN ('P2_JOB_TERMINAL_WON', 'P2_JOB_TERMINAL_LOST')
  AND action_template->0->>'action_type' = 'update_opportunity'
  AND coalesce(action_template->0->'params'->>'bypass_suppression', 'false') <> 'true';
COMMIT;

-- VERIFY:
-- SELECT rule_key, requires_approval, action_template->0->'params' FROM agent_rules
--  WHERE rule_key IN ('P2_JOB_TERMINAL_WON','P2_JOB_TERMINAL_LOST');
-- ROLLBACK:
-- UPDATE agent_rules SET action_template = action_template #- '{0,params,bypass_suppression}', updated_at = now()
--  WHERE rule_key IN ('P2_JOB_TERMINAL_WON','P2_JOB_TERMINAL_LOST');
