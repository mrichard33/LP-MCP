-- ============================================================================
-- Seed: Rescission rescue routes to O.0 + rescission-tag guards on the
--       rebook / rescue lanes  (Wally Scott post-mortem)
-- Date: 2026-09-09
-- Applied live: 2026-09-09 via LP MCP:supabase_run_query — THIS FILE DOCUMENTS
--               THE LIVE TABLE, it does not introduce the change.
-- Captured:     2026-09-09 22:2x UTC. Rule 356 was still being iterated during
--               the incident (v3.1 pinned stop-bot to lane 200 at 22:20:01Z);
--               every value below was read back after that edit.
-- Reload: POST /n8n/decision-engine/reload-rules -> rules_loaded 280
--         (279 enabled before, 280 after — one new rule, 356)
--
-- INCIDENT
--   Wally Scott (GHL 2LT4JDrObOgPlKnn3H0q, LP 573728) messaged that he had
--   SIGNED with another window company. Inside Florida's 3-business-day
--   rescission window that is the single most recoverable loss in the funnel.
--   What actually happened:
--
--     * INTENT_PURCHASED_ELSEWHERE (173) fired and the handler tagged him
--       `objection-confirmed:competitor` — the COLON form. O.0 step 20 branches
--       on the HYPHEN form. Nothing matched. He entered no rescue arc.
--     * O.RR, the workflow the handler's comments said owned the 72-hour rescue,
--       WAS NEVER BUILT. It exists only in the Phase 2 checklist.
--     * BEHAVIORAL_COMPETITOR_OBJECTION_PRE_DEMO (185) fired on the same event
--       and enrolled him into S5.2 v2 Branch C — a pre-demo differentiation arc
--       for a lead who had already signed — while AGENTIC_RESPOND_POST_CHATBOT
--       stamped pause-workflow on him, so even that sent nothing.
--     * ESC_CONTRACT_CHANGE (328) and BEHAVIORAL_DISENGAGEMENT (68) both fired
--       on the same inbound, adding duplicate cards on top.
--
--   Net: a signed-with-competitor lead was tagged for a workflow that does not
--   exist, entered nothing, and no human was told to call him before the
--   deadline.
--
-- RULING (Mark, 2026-09-09): O.0 IS the rescue arc. Its competitor branch is
--   PUBLISHED v154 with the trigger active. O.RR is superseded, not pending.
--
-- WHAT THIS SEED DOES
--   Sections 1-5 below, in order. Each statement is an idempotent
--   INSERT ... ON CONFLICT (rule_key) DO UPDATE, and every value was read back
--   out of the live table on 2026-09-09 — re-running this file is a no-op
--   against the database it documents.
--
-- DELIBERATELY UNCHANGED
--   BEHAVIORAL_COMPETITOR_OBJECTION (71), BRIDGE_CONCERN_COMPETITOR (104) and
--   OBJECTION_ROUTE_POST_DEMO (214) are NOT in this file. A rescission guard was
--   added to all three during the incident and REVERTED the same night: they are
--   the lanes that carry a competitor objection INTO O.0, and guarding them would
--   close the very door this fix opens. They stand at their pre-2026-09-09 state.
--
--   Master System Map Row 6 competitor_rescission_window stays DISABLED.
-- ============================================================================

BEGIN;


-- ----------------------------------------------------------------------------
-- 1. INTENT_PURCHASED_ELSEWHERE (173) — write the tag O.0 actually branches on
-- ----------------------------------------------------------------------------
-- action_template gains a second step: add_tag objection-confirmed-competitor.
--
-- 173 already computes the FL rescission deadline and posts the 🚨 card, but the
-- only competitor tag in the system was written by the handler in the colon form
-- (`objection-confirmed:competitor`), which O.0 step 20 does not match. The rule
-- now writes the hyphen form itself, so the routing is correct even if a future
-- producer regresses. src/ghl.js normalizeTag is the code-side backstop.

INSERT INTO agent_rules (id, rule_key, rule_name, category, rule_type, decision_point, event_pattern, conditions, context_conditions, action_template, priority, requires_approval, enabled, created_by, notes)
VALUES (173, 'INTENT_PURCHASED_ELSEWHERE', 'Inbound message indicates contact signed/contracted with another vendor → fire cancellation_dnc dispatch', 'INTENT', 'contextual', 'message_inbound_classification', '{"event_type": "ai.analysis_completed"}'::jsonb, NULL, E'{"not_has_any_tag": ["customer", "p2:active"], "payload_message_matches": "\\\\b(contracted\\\\s+with\\\\s+(another|a\\\\s+different)|(signed|going|went)\\\\s+with\\\\s+(another|a\\\\s+different)|already\\\\s+(chose|picked|hired|signed|decided)|purchased\\\\s+(elsewhere|from\\\\s+(another|someone))|hired\\\\s+(another|someone\\\\s+else)|with\\\\s+another\\\\s+(company|vendor|contractor))\\\\b"}'::jsonb, '[{"params": {"reason": "INTENT_PURCHASED_ELSEWHERE", "loss_reason": "Competitor"}, "action_type": "compute_rescission_dispatch", "target_entity": "contact", "target_system": "lp"}, {"params": {"tag": "objection-confirmed-competitor"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"}]'::jsonb, 116, 'f', 't', 'claude', 'Built from Thomas Michaud post-mortem 2026-05-06. Revised 2026-05-07: action_template now emits compute_rescission_dispatch directly (instead of layer3_dispatch) — the new handler in src/actions/handlers/rescission.js does the full FL 3-business-day rescission rescue activation: detects sign-date from inbound text (defaults to today per D1), computes deadline + day-variant via src/rescission-window.js, synchronously applies tags (urgency:rescission-active, rescission-variant:[key], rescission-state:active, objection-confirmed:competitor, intent-rescission-rescue) and writes custom fields, then queues GroupMe HIGH-priority alert + observability event rescission.rescue_activated. past_window branch tags lost-post-rescission + loss-reason:competitor and hands off to L.1 gracefully (90d cooling vs standard 45d). DNC override still works: when same message contains DNC language, INTENT_DNC_HARD_REQUEST (priority 120) fires concurrently and cancellation_dnc dispatch dominates via DND + suppress-outbound, neutralizing the rescue path. | 2026-09-09 Claude (Wally Scott): added add_tag objection-confirmed-competitor (HYPHEN). The handler src/actions/handlers/rescission.js writes objection-confirmed:competitor (COLON) — the only colon producer in the system. O.0 step 20 branches on the hyphen form, so a rescission lead entered O.0 and fell through every branch. Rule-layer fix is immediate; handler fix + central normalizer in the add_tag executor are in the same-day Claude Code handoff. O.RR (the workflow this handler was written to trigger) was never built — O.0 competitor branch is the rescue arc now.')
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name          = EXCLUDED.rule_name,
  category           = EXCLUDED.category,
  rule_type          = EXCLUDED.rule_type,
  decision_point     = EXCLUDED.decision_point,
  event_pattern      = EXCLUDED.event_pattern,
  conditions         = EXCLUDED.conditions,
  context_conditions = EXCLUDED.context_conditions,
  action_template    = EXCLUDED.action_template,
  priority           = EXCLUDED.priority,
  requires_approval  = EXCLUDED.requires_approval,
  enabled            = EXCLUDED.enabled,
  notes              = EXCLUDED.notes,
  updated_at         = now();


-- ----------------------------------------------------------------------------
-- 2. ESC_CONTRACT_CHANGE (328) + BEHAVIORAL_DISENGAGEMENT (68) — stand down on a signed-elsewhere message
-- ----------------------------------------------------------------------------
-- context_conditions gains payload_message_not_matches carrying rule 173's exact
-- payload_message_matches regex.
--
-- Both rules fired on Wally Scott's message alongside 173. A lead who has signed
-- with a competitor is 173/356's to own — a generic contract-change escalation and
-- a disengagement review on the same inbound are duplicate noise on a rescission
-- that has a deadline. Same regex on both sides means the three rules can never
-- disagree about what the message was.

INSERT INTO agent_rules (id, rule_key, rule_name, category, rule_type, decision_point, event_pattern, conditions, context_conditions, action_template, priority, requires_approval, enabled, created_by, notes)
VALUES (328, 'ESC_CONTRACT_CHANGE', 'Escalation: signed-contract change/cancel — humans only', 'behavioral', 'contextual', NULL, '{"event_type": "ai.analysis_completed"}'::jsonb, NULL, E'{"not_has_tag": "stop-bot", "payload_field_eq": {"field": "escalation_category", "value": "contract_change"}, "payload_message_not_matches": ["\\\\b(contracted\\\\s+with\\\\s+(another|a\\\\s+different)|(signed|going|went)\\\\s+with\\\\s+(another|a\\\\s+different)|already\\\\s+(chose|picked|hired|signed|decided)|purchased\\\\s+(elsewhere|from\\\\s+(another|someone))|hired\\\\s+(another|someone\\\\s+else)|with\\\\s+another\\\\s+(company|vendor|contractor))\\\\b"]}'::jsonb, E'[{"params": {"tag": "esc:contract-change"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"title": "CONTRACT change/cancel request — HUMANS ONLY", "priority": "high", "description": "Request to change or cancel a signed contract. Rescission-sensitive: the bot NEVER advises on rescission windows or deadlines (hard compliance rule) and its reply contains zero rescission information. A human must own this conversation immediately. Context summary on contact notes."}, "action_type": "create_task", "target_entity": "contact", "target_system": "ghl"}, {"params": {"tier": "Hot", "status": "Escalation", "message": "Signed-contract change/cancel request. Reply: \\"{{message_text}}\\"", "narrative": "Contract change/cancellation request — rescission-sensitive, humans only. Bot gave no rescission info.", "next_step": "Human contact today", "action_verb": "CONTRACT CHANGE", "notification_class": "priority"}, "action_type": "send_notification", "target_entity": "contact", "target_system": "groupme"}, {"params": {"next_step": "Human call today; rescission questions answered by humans only.", "include_context_summary": true}, "action_type": "add_note", "target_entity": "contact", "target_system": "ghl"}]'::jsonb, 110, 'f', 't', 'claude', 'Bot 2/3/4 consolidation 6c (2026-07-06, Sentinel §13). Inert until analyzer deploys. | DISABLED until code deploy: gates on operators the live engine does not know yet (payload_field_eq / analysis_occurrence_*), which fail closed with per-event telemetry — disabled to avoid days of rule.condition_failed_closed noise. RE-ENABLE in the post-merge runbook (deferred SQL in PR). | 2026-07-06 E2E: re-disabled — payload_field_eq treats the analyzer''s legitimate null (dq_detected/escalation_category are null on every normal turn) as fail-closed WITH telemetry, spraying ~9 rule.condition_failed_closed events per analysis. Code fix (null/undefined → quiet block) in the follow-up PR; re-enable after it deploys. | 2026-07-06: re-enabled after PR #482 deploy (payload_field_eq null → quiet block). | 2026-09-09 Claude (Wally Scott 2LT4JDrObOgPlKnn3H0q): added payload_message_not_matches with the INTENT_PURCHASED_ELSEWHERE regex. Analyzer set escalation_category=contract_change on "we signed a contract with another company" — that is a competitor signing (rule 173 territory), not a Reece contract change. This rule fired a false HUMANS-ONLY contract-change task + GroupMe card on a non-customer.')
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name          = EXCLUDED.rule_name,
  category           = EXCLUDED.category,
  rule_type          = EXCLUDED.rule_type,
  decision_point     = EXCLUDED.decision_point,
  event_pattern      = EXCLUDED.event_pattern,
  conditions         = EXCLUDED.conditions,
  context_conditions = EXCLUDED.context_conditions,
  action_template    = EXCLUDED.action_template,
  priority           = EXCLUDED.priority,
  requires_approval  = EXCLUDED.requires_approval,
  enabled            = EXCLUDED.enabled,
  notes              = EXCLUDED.notes,
  updated_at         = now();

INSERT INTO agent_rules (id, rule_key, rule_name, category, rule_type, decision_point, event_pattern, conditions, context_conditions, action_template, priority, requires_approval, enabled, created_by, notes)
VALUES (68, 'BEHAVIORAL_DISENGAGEMENT', 'Disengagement Detected → Rep Review', 'behavioral', 'contextual', NULL, '{"event_type": "ai.analysis_completed"}'::jsonb, NULL, E'{"not_has_any_tag": ["pause-bot", "awaiting:cancel-decision"], "payload_field_eq": {"field": "appointment_active", "value": "false"}, "engagement_quality_eq": "disengagement", "payload_message_not_matches": ["\\\\b(contracted\\\\s+with\\\\s+(another|a\\\\s+different)|(signed|going|went)\\\\s+with\\\\s+(another|a\\\\s+different)|already\\\\s+(chose|picked|hired|signed|decided)|purchased\\\\s+(elsewhere|from\\\\s+(another|someone))|hired\\\\s+(another|someone\\\\s+else)|with\\\\s+another\\\\s+(company|vendor|contractor))\\\\b"]}'::jsonb, '[{"params": {"tag": "flag:disengagement"}, "action_type": "add_tag"}, {"params": {"title": "DISENGAGEMENT: AI detected disengagement signal. Review conversation and decide next action.", "description": "Lead has stopped engaging mid-funnel. Review the last 5 messages for what triggered the drop. If post-demo, route to W9.0 Objection Handler. If pre-demo, route to W11.1 reactivation. Do NOT auto-message — diagnose first."}, "action_type": "create_task"}]'::jsonb, 70, 'f', 't', 'claude', ' | 2026-04-13: Changed to auto-approve. Actions are purely informational (tags, tasks, GroupMe notifications). No risk of automation side effects. | 2026-04-15: Removed send_notification — GroupMe now approval-only. | 2026-05-01: Added description for v2.0 rich-notification handler. | 2026-05-01: Added not_has_tag:pause-bot gate. Rule was firing in parallel with AGENTIC_RESPOND_POST_CHATBOT on the same ai.analysis_completed event — system was simultaneously replying to the lead AND escalating to rep. The agentic responder IS the handler when pause-bot is set; this rule now defers until the responder hands off (pause-bot removed). | 2026-09-09 Claude: added payload_message_not_matches (purchased-elsewhere regex from rule 173). A signed-with-competitor message is owned by INTENT_PURCHASED_ELSEWHERE; the generic DISENGAGEMENT task was a third duplicate task on Wally Scott 2LT4JDrObOgPlKnn3H0q.')
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name          = EXCLUDED.rule_name,
  category           = EXCLUDED.category,
  rule_type          = EXCLUDED.rule_type,
  decision_point     = EXCLUDED.decision_point,
  event_pattern      = EXCLUDED.event_pattern,
  conditions         = EXCLUDED.conditions,
  context_conditions = EXCLUDED.context_conditions,
  action_template    = EXCLUDED.action_template,
  priority           = EXCLUDED.priority,
  requires_approval  = EXCLUDED.requires_approval,
  enabled            = EXCLUDED.enabled,
  notes              = EXCLUDED.notes,
  updated_at         = now();


-- ----------------------------------------------------------------------------
-- 3. BEHAVIORAL_COMPETITOR_OBJECTION_PRE_DEMO (185) — the rule that put Wally in S5.2
-- ----------------------------------------------------------------------------
-- context_conditions gains BOTH guards: the three rescission tags in
-- not_has_any_tag, and payload_message_not_matches (same 173 regex).
--
-- This is the rule that did the damage. On the same ai.analysis_completed event
-- it ran transition_objection_state → STATE_ENROLLMENT and enrolled a lead who
-- had already signed elsewhere into S5.2 v2 Branch C — a pre-demo differentiation
-- arc — while AGENTIC_RESPOND_POST_CHATBOT stamped pause-workflow on him. Both
-- guards are needed: the tag guard covers the second and later messages, the
-- regex guard covers the first one, before any rescission tag exists.

INSERT INTO agent_rules (id, rule_key, rule_name, category, rule_type, decision_point, event_pattern, conditions, context_conditions, action_template, priority, requires_approval, enabled, created_by, notes)
VALUES (185, 'BEHAVIORAL_COMPETITOR_OBJECTION_PRE_DEMO', 'Pre-Demo Competitor Mention → SA3 Differentiation + Rep Alert', 'behavioral', 'contextual', NULL, '{"event_type": "ai.analysis_completed"}'::jsonb, NULL, E'{"not_has_any_tag": ["lp-demo-completed", "stage:post-appointment", "bj:stage-4-negotiating", "bj:stage-5-committed", "customer", "lp-sale", "stage:dnc", "rescission-state:active", "intent-rescission-rescue", "lost-post-rescission"], "objection_type_eq": "competitor", "engagement_quality_eq": "meaningful", "payload_message_not_matches": ["\\\\b(contracted\\\\s+with\\\\s+(another|a\\\\s+different)|(signed|going|went)\\\\s+with\\\\s+(another|a\\\\s+different)|already\\\\s+(chose|picked|hired|signed|decided)|purchased\\\\s+(elsewhere|from\\\\s+(another|someone))|hired\\\\s+(another|someone\\\\s+else)|with\\\\s+another\\\\s+(company|vendor|contractor))\\\\b"]}'::jsonb, '[{"params": {"tag": "concern-expressed:competitor"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"tag": "pre-demo-concern:competitor"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"tag": "story-arc:sa3"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"title": "PRE-DEMO COMPETITOR — shopping other vendors", "description": "Lead mentioned other vendors BEFORE demo. Lead with positioning + differentiation in next touch. Do not name competitors directly. SA3 tagged."}, "action_type": "create_task", "target_entity": "contact", "target_system": "ghl"}, {"params": {"tier": "Warm", "status": "Pre-Demo Prep", "message": "PRE-DEMO COMPETITOR FLAGGED — SA3 tagged", "narrative": "Competitor mention detected before in-home demo. Rep should position differentiation explicitly during pitch. Story arc 3 tagged for nurture continuity.", "next_step": "SA3 positioning in next conversation", "action_verb": "PRE-DEMO COMPETITOR FLAGGED", "notification_class": "intelligence"}, "action_type": "send_notification"}, {"params": {"trigger": "ai_objection_handler", "event_type": "agentic.pre_demo_concern", "concern_type": "competitor"}, "action_type": "emit_event", "target_entity": "contact", "target_system": "lp"}, {"params": {"proposed_state": "APPOINTMENT_FRICTION.trust_hesitation", "trigger_source": "BEHAVIORAL_RULE"}, "action_type": "transition_objection_state", "target_entity": "contact", "target_system": "lp"}]'::jsonb, 80, 'f', 't', 'claude-wave-1.1', 'Wave 1.1 — Pre-demo objection gap closure. Mirrors BEHAVIORAL_COMPETITOR_OBJECTION (rule 71) for pre-demo cohort. | 2026-08-17: mapped to a routing state so S5.2 v2 has a branch to land on. 185 competitor -> trust_hesitation (trust_building variant, Randy story on day 4, differentiation play). 186 complexity/DIY -> overwhelmed (ultra_light, single day-5 touch); also gives overwhelmed its first non-analyzer producer. Both mappings are judgment calls, flagged for Mark. | 2026-09-09 Claude (Wally Scott 2LT4JDrObOgPlKnn3H0q): rescission guard — not_has_any_tag += rescission-state:active, intent-rescission-rescue, lost-post-rescission + payload_message_not_matches (purchased-elsewhere regex) for the same-event race before tags land. A lead who SIGNED with a competitor is in the rescission-rescue lane (rule 173, human-owned); routing them into S5.2/O.0 objection or rebook sequences fought the rescue and double-messaged. Wally was enrolled in S5.2 v2 twice in 32 minutes.')
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name          = EXCLUDED.rule_name,
  category           = EXCLUDED.category,
  rule_type          = EXCLUDED.rule_type,
  decision_point     = EXCLUDED.decision_point,
  event_pattern      = EXCLUDED.event_pattern,
  conditions         = EXCLUDED.conditions,
  context_conditions = EXCLUDED.context_conditions,
  action_template    = EXCLUDED.action_template,
  priority           = EXCLUDED.priority,
  requires_approval  = EXCLUDED.requires_approval,
  enabled            = EXCLUDED.enabled,
  notes              = EXCLUDED.notes,
  updated_at         = now();


-- ----------------------------------------------------------------------------
-- 4. Rescission-tag guards on the rebook / rescue lanes
-- ----------------------------------------------------------------------------
-- not_has_any_tag gains rescission-state:active, intent-rescission-rescue and
-- lost-post-rescission on 215, 107, 171 and 271. LP_DISP_CXL_TO_CANCELLED (229)
-- had no not_has_any_tag at all and gets the key with those three.
--
-- A lead inside the rescission window must not be pulled into an appointment-
-- rescue or objection-routing arc. The rescission conversation is human-owned
-- (356 sets stop-bot); these lanes would talk over the rep.

INSERT INTO agent_rules (id, rule_key, rule_name, category, rule_type, decision_point, event_pattern, conditions, context_conditions, action_template, priority, requires_approval, enabled, created_by, notes)
VALUES (215, 'OBJECTION_ROUTE_PRE_DEMO', 'Layer 3 Objection Routing — Pre-Demo → S5.2', 'INTENT', 'contextual', NULL, '{"event_type": "intent.objection_detected"}'::jsonb, NULL, '{"has_any_tag": ["appt-exists", "completed-conf-call", "booked-measurement", "booked-estimate", "chatbot-booked-call", "chatbot-booked-estimate", "canceled-estimate", "lp-appt-set", "lp-appt-issued"], "not_has_any_tag": ["lp-demo-completed", "stage:post-appointment", "customer", "p2:active", "lp-sale", "stage:dnc", "cooling-active", "optedOut", "active-w5.2", "active-w-S5.2", "active-w-S5.1", "rescission-state:active", "intent-rescission-rescue", "lost-post-rescission"]}'::jsonb, '[{"params": {"tag": "objection-detected"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"tag": "agentic-routed-S5.2v2"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"tier": "Warm", "status": "Pre-Demo Objection", "narrative": "Pre-demo objection detected. Enrolled in S5.2 v2 (0a6a1349) — workflow reads objection_state_code from custom field ATvhIO4G5UvI93nRDsnY and routes to the matching branch.", "next_step": "S5.2 v2 branch handling", "action_verb": "ROUTED TO S5.2 v2", "notification_class": "intelligence"}, "action_type": "send_notification", "target_entity": "contact", "target_system": "groupme"}, {"params": {"proposed_state": "APPOINTMENT_FRICTION.timing_delay", "trigger_source": "BEHAVIORAL_RULE"}, "action_type": "transition_objection_state", "target_entity": "contact", "target_system": "lp"}]'::jsonb, 95, 'f', 't', 'claude_layer3_phase3.5', 'UPDATED 2026-06-17: enabled + repointed to v2 (0a6a1349) via webhook ZXz0xlpBilGAkbJEbDHy. Reads objection_state_code from field ATvhIO4G5UvI93nRDsnY to branch correctly. | 2026-08-17: removed manual S5.2 add_to_workflow + premature active-s5.2/active-w5.2 tag. Enrollment owned by transition_objection_state. | 2026-08-17: added transition_objection_state so the objection state code field is written before S5.2 v2 enrollment. | 2026-09-09 Claude (Wally Scott 2LT4JDrObOgPlKnn3H0q): rescission guard — not_has_any_tag += rescission-state:active, intent-rescission-rescue, lost-post-rescission. A lead who SIGNED with a competitor is in the rescission-rescue lane (rule 173, human-owned); routing them into S5.2/O.0 objection or rebook sequences fought the rescue and double-messaged. Wally was enrolled in S5.2 v2 twice in 32 minutes.')
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name          = EXCLUDED.rule_name,
  category           = EXCLUDED.category,
  rule_type          = EXCLUDED.rule_type,
  decision_point     = EXCLUDED.decision_point,
  event_pattern      = EXCLUDED.event_pattern,
  conditions         = EXCLUDED.conditions,
  context_conditions = EXCLUDED.context_conditions,
  action_template    = EXCLUDED.action_template,
  priority           = EXCLUDED.priority,
  requires_approval  = EXCLUDED.requires_approval,
  enabled            = EXCLUDED.enabled,
  notes              = EXCLUDED.notes,
  updated_at         = now();

INSERT INTO agent_rules (id, rule_key, rule_name, category, rule_type, decision_point, event_pattern, conditions, context_conditions, action_template, priority, requires_approval, enabled, created_by, notes)
VALUES (107, 'GHL_APPT_CANCELLED_REBOOK', 'Appointment Cancelled → W5.2 Rebook', 'appointment', 'contextual', NULL, '{"event_type": "ghl.appointment_cancelled"}'::jsonb, NULL, '{"has_any_tag": ["lp-demo-completed", "stage:post-appointment", "bj:stage-4-negotiating", "bj:stage-5-committed"], "not_has_tag": "stage:dnc", "not_has_any_tag": ["hard-disqualified", "suppress-outbound", "stop-bot", "rescission-state:active", "intent-rescission-rescue", "lost-post-rescission"], "last_active_appointment": true, "not_reschedule_inflight": true, "not_duplicate_lead_live_appointment": true}'::jsonb, '[{"params": {"workflow_id": "ea3c3aed-77a4-470d-bc3c-1b1765bfff3b", "workflow_name": "S2.2 Chatbot Indoctrination", "canonical_code": "S2.2"}, "action_type": "remove_from_workflow", "target_entity": "contact", "target_system": "ghl"}, {"params": {"workflow_id": "0c7b2137-76fd-46d9-9f9b-75d095d3d769", "workflow_name": "E.5 Unknown Source Bridge", "canonical_code": "E.5"}, "action_type": "remove_from_workflow", "target_entity": "contact", "target_system": "ghl"}, {"params": {"prefix": "active-s2."}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"tag": "stage:indoctrination"}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"tag": "appt-cancelled"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"tag": "suppress-automation"}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"tag": "stage:reactivation"}, "action_type": "set_stage", "target_entity": "contact", "target_system": "ghl"}, {"params": {"tag": "rebook-reason:cancelled"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"proposed_state": "APPOINTMENT_DISRUPTION.cancelled", "trigger_source": "BEHAVIORAL_RULE"}, "action_type": "transition_objection_state", "target_entity": "contact", "target_system": "lp"}, {"params": {"stage": "Reactivation", "status": "open", "pipeline": "P1"}, "action_type": "move_opportunity", "target_entity": "opportunity", "target_system": "ghl"}, {"params": {"tag": "active-w8.0"}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"tag": "lp-route:post-appointment"}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"tag": "lp-demo-completed"}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"workflow_id": "15f47572-9ffc-453d-995d-a1890441f290", "workflow_name": "F.0 Post-Appointment Follow-Up", "canonical_code": "F.0"}, "action_type": "remove_from_workflow", "target_entity": "contact", "target_system": "ghl"}, {"params": {"title": "APPOINTMENT CANCELLED — Engaged lead, S5.2 firing", "description": "{{contact_name}} cancelled their appointment. Has engagement history (lp-demo-completed / stage:post-appointment / bj:stage-4-negotiating / bj:stage-5-committed). S5.2 Appointment Rescue Reactivation enrolled. Call to confirm rebook intent and overcome any new objection. Compression psychology appropriate — they have earned BOFU re-entry."}, "action_type": "create_task", "target_entity": "contact", "target_system": "ghl"}]'::jsonb, 70, 'f', 't', 'claude', 'Bug 2 fix 2026-06-19: Added S2.2 + E.5 remove_from_workflow and active-s2.* / stage:indoctrination strip at the top of the action list. Engaged cancels could have been mid-indoctrination if LP sync wrote CXL after E.5 enrolled them but before engagement signals were applied. Ejection is now the first action so indoctrination halts immediately regardless of timing. All other actions unchanged. | 2026-08-17: removed manual S5.2 add_to_workflow + premature active-s5.2/active-w5.2 tag. Enrollment owned by transition_objection_state. | 2026-08-25 DQ SUPPRESSION GATE ADDED (Linda Hunter, Xd9tT6myzPLXSXazb3K1). This row gated only on stage:dnc and fired TWICE on a hard-disqualified contact carrying stop-bot, suppress-outbound and DND on all seven channels — each time queuing a rebook task, an opportunity move and a stage set off our OWN DQ cancellation. A cancel we issue to stand down must never be read as a customer cancellation to be rescued from.
[2026-09-02 Claude] Added not_duplicate_lead_live_appointment. Call-center duplicate-lead cleanup CXLs one LP lead while the real appointment stays Set/Cnf on another lead for the same contact; this rule was firing its full action batch (stage:reactivation, move_opportunity, appt-cancelled, task, end_agentic_handoff, S5.2 enrollment) against contacts who never cancelled. objection-state v2.0 guarded only the state write and enrollment; this gates the siblings. Requires decision-engine.js v2.19. Fails OPEN on lp_leads query error. Evidence: cySIThxV1wJsV5E11Umu, actions 389380-389397. | 2026-09-09 Claude (Wally Scott 2LT4JDrObOgPlKnn3H0q): rescission guard — not_has_any_tag += rescission-state:active, intent-rescission-rescue, lost-post-rescission. A lead who SIGNED with a competitor is in the rescission-rescue lane (rule 173, human-owned); routing them into S5.2/O.0 objection or rebook sequences fought the rescue and double-messaged. Wally was enrolled in S5.2 v2 twice in 32 minutes.')
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name          = EXCLUDED.rule_name,
  category           = EXCLUDED.category,
  rule_type          = EXCLUDED.rule_type,
  decision_point     = EXCLUDED.decision_point,
  event_pattern      = EXCLUDED.event_pattern,
  conditions         = EXCLUDED.conditions,
  context_conditions = EXCLUDED.context_conditions,
  action_template    = EXCLUDED.action_template,
  priority           = EXCLUDED.priority,
  requires_approval  = EXCLUDED.requires_approval,
  enabled            = EXCLUDED.enabled,
  notes              = EXCLUDED.notes,
  updated_at         = now();

INSERT INTO agent_rules (id, rule_key, rule_name, category, rule_type, decision_point, event_pattern, conditions, context_conditions, action_template, priority, requires_approval, enabled, created_by, notes)
VALUES (171, 'GHL_APPT_CANCELLED_REBOOK_COLD', 'CXL/NS cancellation (cold) → S5.2 Appointment Rescue', 'appointment', 'contextual', NULL, '{"event_type": "ghl.appointment_cancelled"}'::jsonb, NULL, '{"any_of": [{"not_has_tag": "active-entry:canvassing"}, {"has_prior_inbound": true}], "not_has_tag": "stage:dnc", "not_has_any_tag": ["lp-demo-completed", "stage:post-appointment", "bj:stage-4-negotiating", "bj:stage-5-committed", "hard-disqualified", "suppress-outbound", "stop-bot", "rescission-state:active", "intent-rescission-rescue", "lost-post-rescission"], "last_active_appointment": true, "not_reschedule_inflight": true, "not_duplicate_lead_live_appointment": true}'::jsonb, '[{"params": {"workflow_id": "ea3c3aed-77a4-470d-bc3c-1b1765bfff3b", "workflow_name": "S2.2 Chatbot Indoctrination", "canonical_code": "S2.2"}, "action_type": "remove_from_workflow", "target_entity": "contact", "target_system": "ghl"}, {"params": {"workflow_id": "0c7b2137-76fd-46d9-9f9b-75d095d3d769", "workflow_name": "E.5 Unknown Source Bridge", "canonical_code": "E.5"}, "action_type": "remove_from_workflow", "target_entity": "contact", "target_system": "ghl"}, {"params": {"prefix": "active-s2."}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"tag": "stage:indoctrination"}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"tag": "appt-cancelled"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"tag": "suppress-automation"}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"tag": "stage:reactivation"}, "action_type": "set_stage", "target_entity": "contact", "target_system": "ghl"}, {"params": {"tag": "rebook-reason:cancelled"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"tag": "active-w8.0"}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"tag": "lp-route:post-appointment"}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"tag": "lp-demo-completed"}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"workflow_id": "15f47572-9ffc-453d-995d-a1890441f290", "workflow_name": "F.0 Post-Appointment Follow-Up", "canonical_code": "F.0"}, "action_type": "remove_from_workflow", "target_entity": "contact", "target_system": "ghl"}, {"params": {"tags": ["time-lapse:warm", "time-lapse:cool", "time-lapse:cold"]}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"fallback_tag": "time-lapse:cold", "field_format": "iso_date", "source_field_id": "x8KO5o89WPLfC7ivia3A", "tier_thresholds": {"cold": {"tag": "time-lapse:cold", "min_days": 181}, "cool": {"tag": "time-lapse:cool", "max_days": 180, "min_days": 91}, "warm": {"tag": "time-lapse:warm", "max_days": 90}}, "fallback_strategy": "contact_creation_date", "source_field_name": "Last Appointment Start Date"}, "action_type": "calculate_time_lapse_tier", "target_entity": "contact", "target_system": "ghl"}, {"params": {"stage": "Reactivation", "status": "open", "pipeline": "P1"}, "action_type": "move_opportunity", "target_entity": "opportunity", "target_system": "ghl"}, {"params": {"title": "APPOINTMENT CANCELLED — CXL lead routed to S5.2", "description": "{{contact_name}} cancelled their appointment. No post-demo engagement signals but booked once — warm traffic per DotCom Secrets. Routed to S5.2 Appointment Rescue. Soft rebook, 4 messages max. Falls back to S1.1 if no response."}, "action_type": "create_task", "target_entity": "contact", "target_system": "ghl"}, {"params": {}, "action_type": "end_agentic_handoff", "target_entity": "contact", "target_system": "ghl"}, {"params": {"proposed_state": "APPOINTMENT_DISRUPTION.cancelled", "trigger_source": "BEHAVIORAL_RULE"}, "action_type": "transition_objection_state", "target_entity": "contact", "target_system": "lp"}]'::jsonb, 70, 'f', 't', 'claude', 'FRAMEWORK FIX 2026-06-19: Cold-side destination changed from TOFU/S1.1 to S5.2 per Dotcom Secrets traffic-temperature law — a CXL lead booked once, making them warm traffic, not cold. Indoctrination restart (S2.2) and re-engagement (S1.1) are cold-traffic treatments. S5.2 FS3 is the correct warm-traffic rebook path. Adds S2.2+E.5 ejection (Bug 2 fix) so indoctrination stops immediately on any cancel event. S5.2 falls back to S1.1 naturally if no response. Previous name: Cold cancellation — clean exit to TOFU, no compression. | 2026-08-17: removed manual S5.2 add_to_workflow + premature active-s5.2/active-w5.2 tag. Enrollment owned by transition_objection_state. | 2026-08-17: added transition_objection_state so the objection state code field is written before S5.2 v2 enrollment. | 2026-08-25 DQ SUPPRESSION GATE ADDED (Linda Hunter, Xd9tT6myzPLXSXazb3K1). The three DQ tags are MERGED into the existing not_has_any_tag array rather than added as a separate key, because this row already uses that key for the cold/warm discriminator. Both are exclusions ANDed together, so merging preserves the cold split exactly while adding the DQ stop.
[2026-09-02 Claude] Added not_duplicate_lead_live_appointment. Call-center duplicate-lead cleanup CXLs one LP lead while the real appointment stays Set/Cnf on another lead for the same contact; this rule was firing its full action batch (stage:reactivation, move_opportunity, appt-cancelled, task, end_agentic_handoff, S5.2 enrollment) against contacts who never cancelled. objection-state v2.0 guarded only the state write and enrollment; this gates the siblings. Requires decision-engine.js v2.19. Fails OPEN on lp_leads query error. Evidence: cySIThxV1wJsV5E11Umu, actions 389380-389397.
[2026-09-05 Claude] Added the canvassing engagement gate (any_of: not canvassing OR has_prior_inbound). Canvassing opt-outs were 14.3% vs 0-12% elsewhere; all 24 came from contacts who had never messaged us. Non-canvassing traffic is unaffected. Requires decision-engine v2.20. | 2026-09-09 Claude (Wally Scott 2LT4JDrObOgPlKnn3H0q): rescission guard — not_has_any_tag += rescission-state:active, intent-rescission-rescue, lost-post-rescission. A lead who SIGNED with a competitor is in the rescission-rescue lane (rule 173, human-owned); routing them into S5.2/O.0 objection or rebook sequences fought the rescue and double-messaged. Wally was enrolled in S5.2 v2 twice in 32 minutes.')
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name          = EXCLUDED.rule_name,
  category           = EXCLUDED.category,
  rule_type          = EXCLUDED.rule_type,
  decision_point     = EXCLUDED.decision_point,
  event_pattern      = EXCLUDED.event_pattern,
  conditions         = EXCLUDED.conditions,
  context_conditions = EXCLUDED.context_conditions,
  action_template    = EXCLUDED.action_template,
  priority           = EXCLUDED.priority,
  requires_approval  = EXCLUDED.requires_approval,
  enabled            = EXCLUDED.enabled,
  notes              = EXCLUDED.notes,
  updated_at         = now();

INSERT INTO agent_rules (id, rule_key, rule_name, category, rule_type, decision_point, event_pattern, conditions, context_conditions, action_template, priority, requires_approval, enabled, created_by, notes)
VALUES (271, 'LP_DISP_CANCEL_COLD_TO_S5_2', 'Cold LP cancellation (CXL/CCC/BO) → S5.2 Appointment Rescue', 'appointment', 'contextual', NULL, '{"event_type": "lp.disposition_changed"}'::jsonb, NULL, '{"any_of": [{"not_has_tag": "active-entry:canvassing"}, {"has_prior_inbound": true}], "not_has_tag": "stage:dnc", "not_has_any_tag": ["lp-demo-completed", "stage:post-appointment", "bj:stage-4-negotiating", "bj:stage-5-committed", "rescission-state:active", "intent-rescission-rescue", "lost-post-rescission"], "lp_disposition_in": ["CXL", "CCC"], "not_reschedule_inflight": true, "not_duplicate_lead_live_appointment": true}'::jsonb, '[{"params": {"workflow_id": "ea3c3aed-77a4-470d-bc3c-1b1765bfff3b", "workflow_name": "S2.2 Chatbot Indoctrination", "canonical_code": "S2.2"}, "action_type": "remove_from_workflow", "target_entity": "contact", "target_system": "ghl"}, {"params": {"workflow_id": "0c7b2137-76fd-46d9-9f9b-75d095d3d769", "workflow_name": "E.5 Unknown Source Bridge", "canonical_code": "E.5"}, "action_type": "remove_from_workflow", "target_entity": "contact", "target_system": "ghl"}, {"params": {"prefix": "active-s2."}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"tag": "stage:indoctrination"}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"tag": "appt-cancelled"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"tag": "suppress-automation"}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"tag": "stage:reactivation"}, "action_type": "set_stage", "target_entity": "contact", "target_system": "ghl"}, {"params": {"tag": "rebook-reason:cancelled"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"tag": "active-w8.0"}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"tag": "lp-route:post-appointment"}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"tag": "lp-demo-completed"}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"workflow_id": "15f47572-9ffc-453d-995d-a1890441f290", "workflow_name": "F.0 Post-Appointment Follow-Up", "canonical_code": "F.0"}, "action_type": "remove_from_workflow", "target_entity": "contact", "target_system": "ghl"}, {"params": {"tags": ["time-lapse:warm", "time-lapse:cool", "time-lapse:cold"]}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"fallback_tag": "time-lapse:cold", "field_format": "iso_date", "source_field_id": "x8KO5o89WPLfC7ivia3A", "tier_thresholds": {"cold": {"tag": "time-lapse:cold", "min_days": 181}, "cool": {"tag": "time-lapse:cool", "max_days": 180, "min_days": 91}, "warm": {"tag": "time-lapse:warm", "max_days": 90}}, "fallback_strategy": "contact_creation_date", "source_field_name": "Last Appointment Start Date"}, "action_type": "calculate_time_lapse_tier", "target_entity": "contact", "target_system": "ghl"}, {"params": {"stage": "Reactivation", "status": "open", "pipeline": "P1"}, "action_type": "move_opportunity", "target_entity": "opportunity", "target_system": "ghl"}, {"params": {"proposed_state": "APPOINTMENT_DISRUPTION.cancelled", "trigger_source": "LP_WEBHOOK"}, "action_type": "transition_objection_state", "target_entity": "contact", "target_system": "lp"}, {"params": {"title": "LP CANCELLATION — CXL/CCC/BO routed to S5.2", "description": "{{contact_name}} cancelled via LP disposition (CXL/CCC/BO). Booked once = warm traffic per DotCom Secrets. Routed to S5.2 Appointment Rescue. Soft rebook, 4 messages max, time-lapse variant applied. Falls back to S1.1 if no response."}, "action_type": "create_task", "target_entity": "contact", "target_system": "ghl"}, {"params": {}, "action_type": "end_agentic_handoff", "target_entity": "contact", "target_system": "ghl"}]'::jsonb, 70, 'f', 't', 'claude', 'FRAMEWORK FIX 2026-06-19: Destination changed from TOFU/enroll:s1.1-reengage to S5.2 per Dotcom Secrets traffic-temperature law. CXL = booked once = warm traffic. Cold-traffic treatment (S1.1 re-engagement) was wrong. S5.2 FS3 is the correct rebook path for all CXL regardless of engagement depth. S5.2 falls back to S1.1 naturally if no response — re-engagement is not lost, just sequenced correctly. Adds S2.2+E.5 ejection so indoctrination halts immediately. Time-lapse calc retained — S5.2 messaging variants use it. Previous rule_key: LP_DISP_CANCEL_COLD_TO_TOFU.
2026-08-02: added not_reschedule_inflight guard for symmetry with GHL_APPT_CANCELLED_REBOOK_COLD, which has carried it since 2026-06-16. Without it an agentic reschedule (cancel-then-book) on the LP side reads as a customer cancellation and enrolls the contact in S5.2. Canary contact 4qcX45ReKbXPbKKQTLka: 5 S5.2 enrollments in one afternoon during a live reschedule. Deliberately did NOT add last_active_appointment here - this rule fires at priority 70 on the same lp.disposition_changed event that queues LP_APPT_GHL_SYNC_CXL at priority 20, so the GHL appointment is still active at evaluation time and the guard would suppress every cold cancellation. | 2026-08-17: removed manual S5.2 add_to_workflow + premature active-s5.2/active-w5.2 tag. Enrollment owned by transition_objection_state. | 2026-08-17: removed BO from lp_disposition_in. BO now routes to APPOINTMENT_DISRUPTION.be_back via LP_DISP_BO_TO_BEBACK (8-day continuation cadence) instead of being mislabelled cancelled (3-day cancellation_standard copy).
[2026-09-02 Claude] Added not_duplicate_lead_live_appointment. Call-center duplicate-lead cleanup CXLs one LP lead while the real appointment stays Set/Cnf on another lead for the same contact; this rule was firing its full action batch (stage:reactivation, move_opportunity, appt-cancelled, task, end_agentic_handoff, S5.2 enrollment) against contacts who never cancelled. objection-state v2.0 guarded only the state write and enrollment; this gates the siblings. Requires decision-engine.js v2.19. Fails OPEN on lp_leads query error. Evidence: cySIThxV1wJsV5E11Umu, actions 389380-389397.
[2026-09-05 Claude] Added the canvassing engagement gate (any_of: not canvassing OR has_prior_inbound). Canvassing opt-outs were 14.3% vs 0-12% elsewhere; all 24 came from contacts who had never messaged us. Non-canvassing traffic is unaffected. Requires decision-engine v2.20. | 2026-09-09 Claude (Wally Scott 2LT4JDrObOgPlKnn3H0q): rescission guard — not_has_any_tag += rescission-state:active, intent-rescission-rescue, lost-post-rescission. A lead who SIGNED with a competitor is in the rescission-rescue lane (rule 173, human-owned); routing them into S5.2/O.0 objection or rebook sequences fought the rescue and double-messaged. Wally was enrolled in S5.2 v2 twice in 32 minutes.')
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name          = EXCLUDED.rule_name,
  category           = EXCLUDED.category,
  rule_type          = EXCLUDED.rule_type,
  decision_point     = EXCLUDED.decision_point,
  event_pattern      = EXCLUDED.event_pattern,
  conditions         = EXCLUDED.conditions,
  context_conditions = EXCLUDED.context_conditions,
  action_template    = EXCLUDED.action_template,
  priority           = EXCLUDED.priority,
  requires_approval  = EXCLUDED.requires_approval,
  enabled            = EXCLUDED.enabled,
  notes              = EXCLUDED.notes,
  updated_at         = now();

INSERT INTO agent_rules (id, rule_key, rule_name, category, rule_type, decision_point, event_pattern, conditions, context_conditions, action_template, priority, requires_approval, enabled, created_by, notes)
VALUES (229, 'LP_DISP_CXL_TO_CANCELLED', 'LP CXL/CCC disposition → APPOINTMENT_DISRUPTION.cancelled', 'STATE_CLASSIFICATION', 'contextual', NULL, '{"event_type": "lp.disposition_changed"}'::jsonb, NULL, '{"has_any_tag": ["lp-demo-completed", "stage:post-appointment", "bj:stage-4-negotiating", "bj:stage-5-committed"], "not_has_any_tag": ["rescission-state:active", "intent-rescission-rescue", "lost-post-rescission"], "lp_disposition_in": ["CXL", "CCC"], "not_duplicate_lead_live_appointment": true}'::jsonb, '[{"params": {"workflow_id": "ea3c3aed-77a4-470d-bc3c-1b1765bfff3b", "workflow_name": "S2.2 Chatbot Indoctrination", "canonical_code": "S2.2"}, "action_type": "remove_from_workflow", "target_entity": "contact", "target_system": "ghl"}, {"params": {"workflow_id": "0c7b2137-76fd-46d9-9f9b-75d095d3d769", "workflow_name": "E.5 Unknown Source Bridge", "canonical_code": "E.5"}, "action_type": "remove_from_workflow", "target_entity": "contact", "target_system": "ghl"}, {"params": {"prefix": "active-s2."}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"tag": "stage:indoctrination"}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"proposed_state": "APPOINTMENT_DISRUPTION.cancelled", "trigger_source": "LP_WEBHOOK"}, "action_type": "transition_objection_state", "target_entity": "contact", "target_system": "lp"}]'::jsonb, 100, 'f', 't', 'claude', 'Bug 2 fix 2026-06-19: Added S2.2 + E.5 remove_from_workflow and active-s2.* / stage:indoctrination strip. LP CXL can arrive while a contact is still mid-indoctrination (sync latency). Ejection halts S2.2 immediately. transition_objection_state retained — downstream rules handle S5.2 enrollment for engaged path. Previous notes: Routes LP cancellation dispositions to the S5.2 v2 cancelled branch via the state handler. | 2026-06-05: Added engagement gate (parity w/ GHL rule 107). Only engaged CXL/CCC -> DISRUPTION.cancelled/S5.2; cold -> TOFU via LP_DISP_CANCEL_COLD_TO_TOFU.
[2026-09-02 Claude] Added not_duplicate_lead_live_appointment. Call-center duplicate-lead cleanup CXLs one LP lead while the real appointment stays Set/Cnf on another lead for the same contact; this rule was firing its full action batch (stage:reactivation, move_opportunity, appt-cancelled, task, end_agentic_handoff, S5.2 enrollment) against contacts who never cancelled. objection-state v2.0 guarded only the state write and enrollment; this gates the siblings. Requires decision-engine.js v2.19. Fails OPEN on lp_leads query error. Evidence: cySIThxV1wJsV5E11Umu, actions 389380-389397. | 2026-09-09 Claude: rescission guard added (not_has_any_tag rescission-state:active / intent-rescission-rescue / lost-post-rescission) — signed-with-competitor leads stay in the human-owned rescue lane, not S5.2.')
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name          = EXCLUDED.rule_name,
  category           = EXCLUDED.category,
  rule_type          = EXCLUDED.rule_type,
  decision_point     = EXCLUDED.decision_point,
  event_pattern      = EXCLUDED.event_pattern,
  conditions         = EXCLUDED.conditions,
  context_conditions = EXCLUDED.context_conditions,
  action_template    = EXCLUDED.action_template,
  priority           = EXCLUDED.priority,
  requires_approval  = EXCLUDED.requires_approval,
  enabled            = EXCLUDED.enabled,
  notes              = EXCLUDED.notes,
  updated_at         = now();


-- ----------------------------------------------------------------------------
-- 5. NEW RULE — RESCISSION_RESCUE_HUMAN_OWNED (356)
-- ----------------------------------------------------------------------------
-- INTENT category, contextual, priority 115, requires_approval false, fires on
-- ai.analysis_completed with 173's regex and a DNC/customer/already-rescued
-- exclusion list.
--
-- Eight actions. ORDER IS LOAD-BEARING — this is the live v3.1 template:
--   1. add_tag  objection-confirmed-competitor  ← written BEFORE enrollment so
--                                                 O.0 step 20 matches by tag
--   2. remove_tag pause-workflow                ← AGENTIC_RESPOND_POST_CHATBOT
--                                                 stamps it on the same event;
--                                                 clears O.0 step 90
--   3. remove_from_workflow S5.2 (0a6a1349-0b44-429b-91e1-4c5be264cd9f)
--   4. remove_from_workflow S5.1 (a708de2e-3ff4-440f-8d2b-39b3c49d7f06)
--   5. update_custom_fields Rescission State = active (KMqEPfs11nb1XrTDif2H)
--                                               ← the O.0 SMS/email prompts branch
--                                                 on this FIELD, not on a tag:
--                                                 GHL prompts cannot read tags
--   6. add_to_workflow O.0 (fdf4ad82-33ab-4e73-b581-18d21d51ac42) with payload
--                      {objection_type: competitor, rescission_state: active}
--   7. create_task     the rep call shape, priority high
--   8. add_tag stop-bot, params.priority = 200  ← humans own the rescission talk
--
-- WHY stop-bot IS LAST AND PINNED TO 200: add_tag, remove_tag, add_to_workflow,
-- update_custom_fields and create_task all resolve to the same default execution
-- lane (100, verified against 48h of agent_actions), so template position alone
-- did not guarantee stop-bot ran after its siblings — and a stop-bot that lands
-- first suppresses the rest of its own batch. Lane 200 (BULK) is unambiguous.
-- ANYONE EDITING THIS TEMPLATE MUST KEEP stop-bot AT priority 200.
--
-- No send_notification: 173 already posts the card, and a second card is exactly
-- the duplicate noise this PR removes elsewhere.
--
-- PREREQUISITE (Mark): O.0 "Send Objection SMS 1 - Competitor" must carry the
-- rescission-aware copy. Until it does, the locked SMS tells a lead who has
-- signed that they are "still comparing quotes".

INSERT INTO agent_rules (id, rule_key, rule_name, category, rule_type, decision_point, event_pattern, conditions, context_conditions, action_template, priority, requires_approval, enabled, created_by, notes)
VALUES (356, 'RESCISSION_RESCUE_HUMAN_OWNED', 'Signed with competitor → human-owned rescue: rep task, exit S5.2/S5.1, stop-bot', 'INTENT', 'contextual', NULL, '{"event_type": "ai.analysis_completed"}'::jsonb, NULL, E'{"not_has_any_tag": ["customer", "p2:active", "lp-sale", "stop-bot", "intent-rescission-rescue", "lost-post-rescission", "dnc", "dnc-sms", "do-not-contact", "stage:dnc", "unsubscribed"], "payload_message_matches": "\\\\b(contracted\\\\s+with\\\\s+(another|a\\\\s+different)|(signed|going|went)\\\\s+with\\\\s+(another|a\\\\s+different)|already\\\\s+(chose|picked|hired|signed|decided)|purchased\\\\s+(elsewhere|from\\\\s+(another|someone))|hired\\\\s+(another|someone\\\\s+else)|with\\\\s+another\\\\s+(company|vendor|contractor))\\\\b"}'::jsonb, '[{"params": {"tag": "objection-confirmed-competitor"}, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"tag": "pause-workflow"}, "action_type": "remove_tag", "target_entity": "contact", "target_system": "ghl"}, {"params": {"workflow_id": "0a6a1349-0b44-429b-91e1-4c5be264cd9f", "workflow_name": "S5.2 v2 Appointment Rescue", "canonical_code": "S5.2"}, "action_type": "remove_from_workflow", "target_entity": "contact", "target_system": "ghl"}, {"params": {"workflow_id": "a708de2e-3ff4-440f-8d2b-39b3c49d7f06", "workflow_name": "S5.1 Decision Compression Reactivation", "canonical_code": "S5.1"}, "action_type": "remove_from_workflow", "target_entity": "contact", "target_system": "ghl"}, {"params": {"customFields": [{"id": "KMqEPfs11nb1XrTDif2H", "field_value": "active"}]}, "action_type": "update_custom_fields", "target_entity": "contact", "target_system": "ghl"}, {"params": {"payload": {"objection_type": "competitor", "rescission_state": "active"}, "workflow_id": "fdf4ad82-33ab-4e73-b581-18d21d51ac42", "workflow_name": "O.0 Objection Handler", "canonical_code": "O.0"}, "action_type": "add_to_workflow", "target_entity": "contact", "target_system": "ghl"}, {"params": {"title": "RESCISSION RESCUE — human call required before the deadline on the contact record", "priority": "high", "description": "{{contact_name}} said they SIGNED with another company. Florida gives them 3 business days to reconsider — the deadline is on the contact in the Rescission Deadline field and on the RESCISSION RESCUE card in GroupMe/Slack (assumes signed today unless the message said otherwise; confirm the signing date on the call). This is a HUMAN call, today or first thing tomorrow. The O.0 competitor emails (Cheaper Quote → Vanishing Warranty → Hidden Math) are already going out — they carry the belief shift; you carry the rescission conversation. Call shape: (1) thank them for telling us; (2) if we missed or fumbled a visit, own it first; (3) ONE story, SA3 Cheap Window — what a cheaper contract usually leaves out: verified openings, frame condition, correct wind-zone rating, code-compliant install. Position, never name or attack the other company; (4) offer a no-obligation review of the contract they signed so they can compare like-for-like before the window closes. Rescission questions are answered by humans only — the bot is stopped on this contact; replies to the O.0 emails and SMS come to you. Log the outcome: rebooked (book the visit, remove stop-bot) or lost (tag loss-reason:competitor, move to P3, the system handles cooling)."}, "action_type": "create_task", "target_entity": "contact", "target_system": "ghl"}, {"params": {"tag": "stop-bot"}, "priority": 200, "action_type": "add_tag", "target_entity": "contact", "target_system": "ghl"}]'::jsonb, 115, 'f', 't', 'claude', '2026-09-09 Claude (Wally Scott 2LT4JDrObOgPlKnn3H0q post-mortem). Companion to INTENT_PURCHASED_ELSEWHERE (173, priority 116). 173 computes the deadline, tags the contact and sends the 🚨 RESCISSION RESCUE card — but created no rep task, never stopped the bot, and did not exit S5.2, so the same event (via BEHAVIORAL_COMPETITOR_OBJECTION_PRE_DEMO → transition_objection_state → STATE_ENROLLMENT) enrolled Wally into S5.2 v2 Branch C while AGENTIC_RESPOND_POST_CHATBOT stamped pause-workflow on him — the rescue existed on paper and nothing customer-facing was scheduled before the deadline. This rule makes the rescue explicitly human-owned: task with call shape, exit S5.2/S5.1, stop-bot (rep-takeover convention; ESC_CONTRACT_CHANGE hard rule = bot never discusses rescission). No send_notification on purpose — 173 already posts the card; a second card is the duplicate noise Mark is seeing. Fires on ai.analysis_completed (not on rescission.rescue_activated, which is emitted by the handler but never lands in system_events — verified 2026-09-09, zero rows ever). Same regex as 173 so the two always agree. stop-bot is applied, never removed, by this rule. Rollback: UPDATE agent_rules SET enabled=false WHERE rule_key=''RESCISSION_RESCUE_HUMAN_OWNED''; then POST /reload-rules. | 2026-09-09 v2 (Mark ruling: O.0 IS the rescue arc): now enrolls O.0 competitor branch (fdf4ad82) with objection_type in the webhook payload AND the hyphen tag written first (lane 50 before lane 100) so step 20 matches by either path. Removes pause-workflow (AGENTIC_RESPOND_POST_CHATBOT stamps it on the same event, lane 20; this removal runs at lane 50, so O.0 step 90 "Pause Workflow Active?" is clear by enrollment). Exits S5.2/S5.1 — no appointment to rescue. stop-bot stays: O.0 sends, humans answer replies. PREREQUISITE for the SMS to be correct: O.0 "Send Objection SMS 1 - Competitor" prompt must be the rescission-aware version (pasted by Mark 2026-09-09); until then the locked SMS says "still comparing quotes" to a lead who has signed. | 2026-09-09 v3 ORDERING FIX (self-inflicted defect found on Wally): v2 applied stop-bot at lane 20 (add_tag) while add_to_workflow runs at lane 100, and the executor SUPPRESSES every mutation on a stop-bot contact — so the rule suppressed its own O.0 enrollment, tag write, and field write. Verified live: actions 439367/439368/439513/439514 all status=suppressed, matched_tag=stop-bot. v3 puts stop-bot LAST in the template and relies on same-lane sequence_order; it must stay last. Also adds update_custom_fields writing Rescission State = active (field KMqEPfs11nb1XrTDif2H) — that field, not a tag, is what the O.0 SMS/email prompts branch on, since GHL prompts cannot read tags. | 2026-09-09 v3.1: stop-bot pinned to explicit priority 200 (BULK lane). add_tag / add_to_workflow / update_custom_fields / remove_tag / create_task all resolve to the SAME default lane 100 (verified against 48h of agent_actions), so template position alone was not a durable guarantee that stop-bot executes last. 200 is unambiguous. If anyone edits this template, stop-bot must keep priority 200 or it will suppress the rest of its own batch again.')
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name          = EXCLUDED.rule_name,
  category           = EXCLUDED.category,
  rule_type          = EXCLUDED.rule_type,
  decision_point     = EXCLUDED.decision_point,
  event_pattern      = EXCLUDED.event_pattern,
  conditions         = EXCLUDED.conditions,
  context_conditions = EXCLUDED.context_conditions,
  action_template    = EXCLUDED.action_template,
  priority           = EXCLUDED.priority,
  requires_approval  = EXCLUDED.requires_approval,
  enabled            = EXCLUDED.enabled,
  notes              = EXCLUDED.notes,
  updated_at         = now();

COMMIT;

-- ============================================================================
-- VERIFICATION (captured 2026-09-09 22:00Z)
-- ============================================================================
--   SELECT count(*) FROM agent_rules WHERE enabled;
--     -> 280
--
--   POST https://<lp-mcp-host>/n8n/decision-engine/reload-rules
--     -> { "rules_loaded": 280 }
--
--   Spot-check the tag the whole fix turns on:
--     SELECT rule_key
--       FROM agent_rules, jsonb_array_elements(action_template) a
--      WHERE a->'params'->>'tag' = 'objection-confirmed-competitor';
--     -> INTENT_PURCHASED_ELSEWHERE, RESCISSION_RESCUE_HUMAN_OWNED
--
--   Nothing anywhere still writes the colon form:
--     SELECT rule_key
--       FROM agent_rules, jsonb_array_elements(action_template) a
--      WHERE a->'params'->>'tag' LIKE 'objection-confirmed:%';
--     -> 0 rows
-- ============================================================================


-- ============================================================================
-- ROLLBACK — restores every rule to its pre-2026-09-09 state.
-- Run the whole block, then reload and assert rules_loaded = 279.
--
-- 356 is DISABLED rather than deleted: its id is referenced in the 2026-09-09
-- post-mortem and in agent_actions.rule_applied. Deleting it would orphan both.
-- ============================================================================
/*
BEGIN;

-- 1. INTENT_PURCHASED_ELSEWHERE — drop the appended add_tag step, keeping
--    compute_rescission_dispatch. Targeted by tag value so it cannot remove
--    the wrong element if the template is reordered later.
UPDATE agent_rules
   SET action_template = (
         SELECT coalesce(jsonb_agg(e), '[]'::jsonb)
           FROM jsonb_array_elements(action_template) e
          WHERE coalesce(e->'params'->>'tag', '') <> 'objection-confirmed-competitor'
       ),
       updated_at = now()
 WHERE rule_key = 'INTENT_PURCHASED_ELSEWHERE';

-- 2. ESC_CONTRACT_CHANGE (328)
UPDATE agent_rules
   SET context_conditions = '{"not_has_tag": "stop-bot", "payload_field_eq": {"field": "escalation_category", "value": "contract_change"}}'::jsonb,
       updated_at = now()
 WHERE rule_key = 'ESC_CONTRACT_CHANGE';

-- 2. BEHAVIORAL_DISENGAGEMENT (68)
UPDATE agent_rules
   SET context_conditions = '{"not_has_any_tag": ["pause-bot", "awaiting:cancel-decision"], "payload_field_eq": {"field": "appointment_active", "value": "false"}, "engagement_quality_eq": "disengagement"}'::jsonb,
       updated_at = now()
 WHERE rule_key = 'BEHAVIORAL_DISENGAGEMENT';

-- 3. BEHAVIORAL_COMPETITOR_OBJECTION_PRE_DEMO (185)
UPDATE agent_rules
   SET context_conditions = '{"not_has_any_tag": ["lp-demo-completed", "stage:post-appointment", "bj:stage-4-negotiating", "bj:stage-5-committed", "customer", "lp-sale", "stage:dnc"], "objection_type_eq": "competitor", "engagement_quality_eq": "meaningful"}'::jsonb,
       updated_at = now()
 WHERE rule_key = 'BEHAVIORAL_COMPETITOR_OBJECTION_PRE_DEMO';

-- 4. OBJECTION_ROUTE_PRE_DEMO (215)
UPDATE agent_rules
   SET context_conditions = '{"has_any_tag": ["appt-exists", "completed-conf-call", "booked-measurement", "booked-estimate", "chatbot-booked-call", "chatbot-booked-estimate", "canceled-estimate", "lp-appt-set", "lp-appt-issued"], "not_has_any_tag": ["lp-demo-completed", "stage:post-appointment", "customer", "p2:active", "lp-sale", "stage:dnc", "cooling-active", "optedOut", "active-w5.2", "active-w-S5.2", "active-w-S5.1"]}'::jsonb,
       updated_at = now()
 WHERE rule_key = 'OBJECTION_ROUTE_PRE_DEMO';

-- 4. GHL_APPT_CANCELLED_REBOOK (107)
UPDATE agent_rules
   SET context_conditions = '{"has_any_tag": ["lp-demo-completed", "stage:post-appointment", "bj:stage-4-negotiating", "bj:stage-5-committed"], "not_has_tag": "stage:dnc", "not_has_any_tag": ["hard-disqualified", "suppress-outbound", "stop-bot"], "last_active_appointment": true, "not_reschedule_inflight": true, "not_duplicate_lead_live_appointment": true}'::jsonb,
       updated_at = now()
 WHERE rule_key = 'GHL_APPT_CANCELLED_REBOOK';

-- 4. GHL_APPT_CANCELLED_REBOOK_COLD (171)
UPDATE agent_rules
   SET context_conditions = '{"any_of": [{"not_has_tag": "active-entry:canvassing"}, {"has_prior_inbound": true}], "not_has_tag": "stage:dnc", "not_has_any_tag": ["lp-demo-completed", "stage:post-appointment", "bj:stage-4-negotiating", "bj:stage-5-committed", "hard-disqualified", "suppress-outbound", "stop-bot"], "last_active_appointment": true, "not_reschedule_inflight": true, "not_duplicate_lead_live_appointment": true}'::jsonb,
       updated_at = now()
 WHERE rule_key = 'GHL_APPT_CANCELLED_REBOOK_COLD';

-- 4. LP_DISP_CANCEL_COLD_TO_S5_2 (271)
UPDATE agent_rules
   SET context_conditions = '{"any_of": [{"not_has_tag": "active-entry:canvassing"}, {"has_prior_inbound": true}], "not_has_tag": "stage:dnc", "not_has_any_tag": ["lp-demo-completed", "stage:post-appointment", "bj:stage-4-negotiating", "bj:stage-5-committed"], "lp_disposition_in": ["CXL", "CCC"], "not_reschedule_inflight": true, "not_duplicate_lead_live_appointment": true}'::jsonb,
       updated_at = now()
 WHERE rule_key = 'LP_DISP_CANCEL_COLD_TO_S5_2';

-- 4. LP_DISP_CXL_TO_CANCELLED (229) — had NO not_has_any_tag key before.
UPDATE agent_rules
   SET context_conditions = context_conditions - 'not_has_any_tag',
       updated_at = now()
 WHERE rule_key = 'LP_DISP_CXL_TO_CANCELLED';

-- 5. RESCISSION_RESCUE_HUMAN_OWNED (356) — disabled, not deleted.
UPDATE agent_rules
   SET enabled = false,
       updated_at = now()
 WHERE rule_key = 'RESCISSION_RESCUE_HUMAN_OWNED';

COMMIT;

-- Then:
--   POST https://<lp-mcp-host>/n8n/decision-engine/reload-rules
--     -> assert { "rules_loaded": 279 }
--   SELECT count(*) FROM agent_rules WHERE enabled;  -> 279
*/
