-- ============================================================================
-- Objection-routing fallthrough fix — agent_rules changes (LP MCP Supabase)
-- 2026-06-17
-- ============================================================================
-- WHAT:
--   B.1  Harden OBJECTION_ROUTE_POST_DEMO: gate on demo_state_eq='post' (the new
--        authoritative resolver in decision-engine.js) instead of drift-prone
--        post-demo stage tags, and remove S5.1 + S5.2 on enroll so O.0 supersedes
--        a decision-compression landing.
--   B.2  Add OBJECTION_ROUTE_NOT_INTERESTED: 'not-interested' is a decline, not
--        objection-handler material — route to cooling via the state machine
--        (DISENGAGEMENT.soft_opt_out), mirroring TAG_NOT_INTERESTED_TO_SOFT_OPTOUT
--        but firing on the analyzer event intent.objection_detected.
--
-- WHY:
--   intent.objection_detected routed off empty payloads / drift-prone stage:* tags,
--   so detected objections fell through to a manual-review alert
--   (OBJECTION_FALLTHROUGH_SWEEP) — 22 contacts never reached a handler since
--   2026-05-23. demo_state_eq decides demo-state by reliable signal
--   (LP disposition -> lp-demo-completed tag -> analyzer buyer_stage).
--
-- IMPACT:
--   Post-demo objections route to O.0 by reliable signal even when stage tags are
--   stale; declines route to cooling instead of being left for the watchdog.
--
-- NOTE: Pre-demo routing is intentionally NOT touched here. The live
--   OBJECTION_ROUTE_PRE_DEMO rule was already enabled + repointed to S5.2 v2
--   (2026-06-17) and enrolls directly via webhook; the PART A stage-gate fix
--   (passesStageGate reads buyer_stage from lead_intelligence) is what lets it
--   pass for buyer_stage>=3 leads on the empty intent.objection_detected payload.
--   The originally-proposed per-type APPOINTMENT_FRICTION rules were DROPPED — the
--   v1.9 appointment-evidence gate (objection-state.js) would have suppressed S5.2
--   enrollment for no-appointment pre-demo leads, causing silent non-routing.
--
-- DEPENDS ON: decision-engine.js demo_state_eq predicate + resolveDemoState
--   (must be deployed first).
-- APPLY:  run this file against LP Supabase, then reload the engine:
--   POST https://lp-mcp-production.up.railway.app/n8n/decision-engine/reload-rules
-- VALIDATE BEFORE RELY:
--   * DEMO_COMPLETE_DISPOSITIONS (FDNS, OPPFDN, Sale, 1Leg, BO) against
--     lp_dispositions / Master System Map. FDNS label reads "Final Demo No Show";
--     it is kept because LP_DISP_OPPFDN_TO_FINANCING already treats OPPFDN/FDNS as
--     post-demo — confirm before relying on it.
--   * OBJECTION_ROUTE_NOT_INTERESTED is OBJECTION_-prefixed, so passesStageGate
--     applies: not-interested leads at buyer_stage 1-2 with no qualifying tag are
--     held (watchdog only). If declines should always reach cooling, rename to a
--     prefix outside BEHAVIORAL_/OBJECTION_/INTENT_.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- B.1  Harden OBJECTION_ROUTE_POST_DEMO
-- ----------------------------------------------------------------------------
WITH u AS (
  UPDATE agent_rules SET
    context_conditions = jsonb_build_object(
      'demo_state_eq', 'post',
      'not_has_any_tag', to_jsonb(ARRAY[
        'customer','p2:active','lp-sale','stage:dnc','cooling-active','optedOut',
        'active-w-O.0','appt-exists','booked-conf-call','conf-call-reminders-started',
        'booked-estimate','booked-measurement'
      ])
    ),
    action_template = '[
      {"params":{"tag":"objection-detected"},"action_type":"add_tag","target_entity":"contact","target_system":"ghl"},
      {"params":{"tag":"agentic-routed-O.0"},"action_type":"add_tag","target_entity":"contact","target_system":"ghl"},
      {"params":{"workflow_id":"15f47572-9ffc-453d-995d-a1890441f290","canonical_code":"F.0"},"action_type":"remove_from_workflow","target_entity":"contact","target_system":"ghl"},
      {"params":{"workflow_id":"a708de2e-3ff4-440f-8d2b-39b3c49d7f06","canonical_code":"S5.1"},"action_type":"remove_from_workflow","target_entity":"contact","target_system":"ghl"},
      {"params":{"workflow_id":"0a6a1349-0b44-429b-91e1-4c5be264cd9f","canonical_code":"S5.2"},"action_type":"remove_from_workflow","target_entity":"contact","target_system":"ghl"},
      {"params":{"workflow_id":"fdf4ad82-33ab-4e73-b581-18d21d51ac42","canonical_code":"O.0","canonical_name":"O.0 Objection Handler"},"action_type":"add_to_workflow","target_entity":"contact","target_system":"ghl"},
      {"params":{"tier":"Warm","status":"Post-Demo Objection","action_verb":"ROUTED TO O.0 OBJECTION HANDLER","narrative":"Post-demo objection (demo_state=post). Exited F.0/S5.1/S5.2, enrolled O.0.","next_step":"O.0 branches on objection-confirmed-{type}","cooldown_minutes":5,"notification_class":"intelligence"},"action_type":"send_notification"}
    ]'::jsonb,
    updated_at = now()
  WHERE rule_key = 'OBJECTION_ROUTE_POST_DEMO'
  RETURNING rule_key
) SELECT count(*) AS updated FROM u;

-- ----------------------------------------------------------------------------
-- B.2  Add OBJECTION_ROUTE_NOT_INTERESTED -> DISENGAGEMENT.soft_opt_out (cooling)
-- ----------------------------------------------------------------------------
WITH u AS (
  INSERT INTO agent_rules (rule_key, rule_name, category, rule_type, enabled, priority, event_pattern, context_conditions, action_template, requires_approval, notes)
  VALUES (
    'OBJECTION_ROUTE_NOT_INTERESTED',
    'Not-Interested objection (fallthrough) -> DISENGAGEMENT.soft_opt_out (cooling)',
    'INTENT', 'contextual', true, 95,
    '{"event_type":"intent.objection_detected"}'::jsonb,
    jsonb_build_object(
      'objection_type_eq','not-interested',
      'not_has_any_tag', to_jsonb(ARRAY['customer','lp-sale','stage:dnc','cooling-active','optedOut'])
    ),
    '[
      {"params":{"proposed_state":"DISENGAGEMENT.soft_opt_out","trigger_source":"OBJECTION_FALLTHROUGH"},"action_type":"transition_objection_state","target_entity":"contact","target_system":"lp"},
      {"params":{"tier":"Cool","status":"Soft Opt-Out","action_verb":"ROUTED TO COOLING","narrative":"Analyzer classified reply as not-interested. Transitioned to DISENGAGEMENT.soft_opt_out.","next_step":"Cooling cadence; no objection handler","cooldown_minutes":5,"notification_class":"intelligence"},"action_type":"send_notification"}
    ]'::jsonb,
    false,
    'Fallthrough fix 2026-06-17. not-interested is a decline, not an objection — route to cooling, never O.0/S5.2. Mirrors TAG_NOT_INTERESTED_TO_SOFT_OPTOUT but on intent.objection_detected.'
  )
  RETURNING rule_key
) SELECT count(*) AS inserted FROM u;

-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- B.2:  UPDATE agent_rules SET enabled=false WHERE rule_key='OBJECTION_ROUTE_NOT_INTERESTED';
-- B.1:  restore original context_conditions, then reload:
--   UPDATE agent_rules SET context_conditions =
--     '{"has_any_tag":["lp-demo-completed","stage:post-appointment","buyer:post-decision"],
--       "not_has_any_tag":["customer","p2:active","lp-sale","stage:dnc","cooling-active","optedOut",
--         "active-w-O.0","appt-exists","booked-conf-call","conf-call-reminders-started",
--         "booked-estimate","booked-measurement"]}'::jsonb
--   WHERE rule_key='OBJECTION_ROUTE_POST_DEMO';
-- Then POST /n8n/decision-engine/reload-rules
-- ============================================================================
