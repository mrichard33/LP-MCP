-- ════════════════════════════════════════════════════════════════════
-- DNC lift on re-entry + E.2 v2 single entry path — 2026-09-21
-- APPLIED LIVE 21:39 UTC. Reload 289 → 289 (−1 E0_CALC_ROUTE_E2V2, +1 new rule).
--
-- MARK RULING: a lead who reaches back out may be contacted again, so the DNC
-- lift must actually happen (not sit in an approval queue).
--
-- EVIDENCE
--   DNC_LIFT_ON_REENGAGEMENT_LP / _FIVE9 (approval-gated): 385 lift actions for
--   ~45 contacts EXPIRED unapproved Jul–Sep. Zero rejections of the lift itself;
--   every rejection was a duplicate or backward set_stage. Root cause: the rules
--   never removed `dnc` / `dnc-sms`, so the has_any_tag condition stayed true and
--   the rule re-fired on every later disposition.
--
-- CHANGES
--   1. E0_CALC_ROUTE_E2V2 disabled — E.0 step 112 now posts to v2 hook 5352aa9e
--      (E.0 v186, verified). One entry path.
--   2. DNC_LIFT_ON_REENGAGEMENT_LP + _FIVE9 → requires_approval FALSE; prepend
--      remove_tag dnc, dnc-sms, do-not-contact; 24h notification cooldown.
--   3. NEW DNC_LIFT_ON_REENTRY_CALCULATOR — ghl.tag_added/estimator-completed on
--      a DNC-family contact → lift full stack + set_dnd inactive + re-enroll E.2 v2.
--   Carrier-level STOP (dnd:sms) is not overridden anywhere.
-- ════════════════════════════════════════════════════════════════════
BEGIN;

UPDATE agent_rules SET enabled = FALSE, updated_at = NOW()
 WHERE rule_key = 'E0_CALC_ROUTE_E2V2';

UPDATE agent_rules SET
  requires_approval = FALSE, version = version + 1, updated_at = NOW(),
  action_template =
    '[{"action_type":"remove_tag","target_system":"ghl","target_entity":"contact","priority":5,"params":{"tag":"dnc","bypass_suppression":true}},
      {"action_type":"remove_tag","target_system":"ghl","target_entity":"contact","priority":5,"params":{"tag":"dnc-sms","bypass_suppression":true}},
      {"action_type":"remove_tag","target_system":"ghl","target_entity":"contact","priority":5,"params":{"tag":"do-not-contact","bypass_suppression":true}}]'::jsonb
    || (SELECT jsonb_agg(CASE WHEN a->>'action_type'='send_notification'
                              THEN jsonb_set(a,'{params,cooldown_minutes}','1440'::jsonb) ELSE a END)
          FROM jsonb_array_elements(action_template) a)
WHERE rule_key IN ('DNC_LIFT_ON_REENGAGEMENT_LP','DNC_LIFT_ON_REENGAGEMENT_FIVE9')
  AND NOT (action_template @> '[{"params":{"tag":"dnc-sms"}}]'::jsonb);  -- idempotent

-- NEW: DNC_LIFT_ON_REENTRY_CALCULATOR (full row is live; summary here)
--   event_pattern      {"event_type":"ghl.tag_added","event_subtype":"estimator-completed"}
--   context_conditions has_any_tag [dnc, dnc-sms, stage:dnc, lp-dnc, loss-reason:dnc, do-not-contact, stop-bot]
--                      not_has_any_tag [suppress:dnc-reply, suppress:dnc-voice]
--   actions            remove_tag ×9 (DNC family, stop-bot, mark-p1-lost, suppress-automation; bypass_suppression)
--                      set_dnd inactive (all channels), resolve_objection_state (recovered),
--                      add_tag recovery:dnc-lifted, add_to_workflow E.2 v2 (hook 5352aa9e),
--                      send_notification (intelligence, 24h cooldown)
--   requires_approval FALSE, priority 15.

COMMIT;

-- Rollback:
--   UPDATE agent_rules SET requires_approval = TRUE WHERE rule_key IN
--     ('DNC_LIFT_ON_REENGAGEMENT_LP','DNC_LIFT_ON_REENGAGEMENT_FIVE9');
--   UPDATE agent_rules SET enabled = FALSE WHERE rule_key = 'DNC_LIFT_ON_REENTRY_CALCULATOR';
--   then POST /n8n/decision-engine/reload-rules.
