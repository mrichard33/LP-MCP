-- ============================================================================
-- Seed: STATE_CLASSIFICATION agent_rules (S5.2 v2, Spec v1.2)
-- Date: 2026-05-14
-- ----------------------------------------------------------------------------
-- 13 rules mapping today's signals to objection_state transitions. v1.2
-- merges LP_DISP_NS and LP_DISP_NOHOME into a single rule that emits
-- the conditional nuance:rep_traveled tag.
--
-- Each rule emits an action of type 'transition_objection_state', which
-- is handled by src/actions/handlers/objection-state.js (Action Executor).
-- ============================================================================

BEGIN;

INSERT INTO agent_rules
  (category, rule_name, trigger_event_type, trigger_conditions,
   action_type, action_payload, priority, active)
VALUES
-- ─── LP disposition rules (priority 100) ─────────────────────────────────
('STATE_CLASSIFICATION', 'LP_DISP_CXL_TO_CANCELLED', 'lp_disposition_change',
 '{"disposition": ["CXL", "CCC"]}'::jsonb,
 'transition_objection_state',
 '{"proposed_state": "APPOINTMENT_DISRUPTION.cancelled", "trigger_source": "LP_WEBHOOK"}'::jsonb,
 100, true),

('STATE_CLASSIFICATION', 'LP_DISP_NS_OR_NOHOME_TO_NOSHOW', 'lp_disposition_change',
 '{"disposition": ["NS", "NoHome"]}'::jsonb,
 'transition_objection_state',
 '{"proposed_state": "APPOINTMENT_DISRUPTION.no_show", "trigger_source": "LP_WEBHOOK", "nuance_tags_conditional": {"if_disposition": "NoHome", "tags": ["nuance:rep_traveled"]}}'::jsonb,
 100, true),

('STATE_CLASSIFICATION', 'LP_DISP_1LEG_TO_ONELEG', 'lp_disposition_change',
 '{"disposition": ["1Leg"]}'::jsonb,
 'transition_objection_state',
 '{"proposed_state": "APPOINTMENT_DISRUPTION.one_leg", "trigger_source": "LP_WEBHOOK", "nuance_tags": ["nuance:spouse_required"]}'::jsonb,
 100, true),

('STATE_CLASSIFICATION', 'LP_DISP_BO_TO_BEBACK', 'lp_disposition_change',
 '{"disposition": ["BO"]}'::jsonb,
 'transition_objection_state',
 '{"proposed_state": "APPOINTMENT_DISRUPTION.be_back", "trigger_source": "LP_WEBHOOK"}'::jsonb,
 100, true),

('STATE_CLASSIFICATION', 'LP_DISP_OPPFDN_TO_FINANCING', 'lp_disposition_change',
 '{"disposition": ["OPPFDN", "FDNS"], "post_demo": true}'::jsonb,
 'transition_objection_state',
 '{"proposed_state": "POST_PROPOSAL_RESISTANCE.financing_pressure", "trigger_source": "LP_WEBHOOK"}'::jsonb,
 100, true),

-- ─── Layer 3 (message_analyzer) rules (priority 90) ──────────────────────
('STATE_CLASSIFICATION', 'LAYER3_PRICE_ANXIETY', 'message_analyzer_proposal',
 '{"to_state": "APPOINTMENT_FRICTION.price_anxiety_pre_demo"}'::jsonb,
 'transition_objection_state',
 '{"proposed_state": "APPOINTMENT_FRICTION.price_anxiety_pre_demo", "trigger_source": "MESSAGE_ANALYZER", "use_proposal_confidence": true}'::jsonb,
 90, true),

('STATE_CLASSIFICATION', 'LAYER3_TIMING_DELAY', 'message_analyzer_proposal',
 '{"to_state": "APPOINTMENT_FRICTION.timing_delay"}'::jsonb,
 'transition_objection_state',
 '{"proposed_state": "APPOINTMENT_FRICTION.timing_delay", "trigger_source": "MESSAGE_ANALYZER", "use_proposal_confidence": true}'::jsonb,
 90, true),

('STATE_CLASSIFICATION', 'LAYER3_DISENGAGEMENT', 'message_analyzer_proposal',
 '{"to_state": "DISENGAGEMENT.passive_cooling"}'::jsonb,
 'transition_objection_state',
 '{"proposed_state": "DISENGAGEMENT.passive_cooling", "trigger_source": "MESSAGE_ANALYZER", "use_proposal_confidence": true}'::jsonb,
 90, true),

-- ─── Behavioral (priority 80) ────────────────────────────────────────────
('STATE_CLASSIFICATION', 'BEHAVIORAL_GHOST_AFTER_BOOKING', 'confirmation_unacknowledged',
 '{"hours_since_booking": {">=": 24}, "appointment_pending": true}'::jsonb,
 'transition_objection_state',
 '{"proposed_state": "APPOINTMENT_FRICTION.ghost_after_booking", "trigger_source": "BEHAVIORAL_RULE"}'::jsonb,
 80, true),

-- ─── Tag-based (priorities 90/100) ───────────────────────────────────────
('STATE_CLASSIFICATION', 'TAG_DNC_TO_HARDLOSS', 'tag_added',
 '{"tag": ["dnc", "lp-dnc", "unsubscribed"]}'::jsonb,
 'transition_objection_state',
 '{"proposed_state": "DISENGAGEMENT.hard_loss", "trigger_source": "BEHAVIORAL_RULE"}'::jsonb,
 100, true),

('STATE_CLASSIFICATION', 'TAG_NOT_INTERESTED_TO_SOFT_OPTOUT', 'tag_added',
 '{"tag": "objection:not-interested"}'::jsonb,
 'transition_objection_state',
 '{"proposed_state": "DISENGAGEMENT.soft_opt_out", "trigger_source": "BEHAVIORAL_RULE"}'::jsonb,
 90, true),

-- ─── Timer-driven (priority 50) ──────────────────────────────────────────
('STATE_CLASSIFICATION', 'STALE_TO_PASSIVE_COOLING', 'nightly_state_sweep',
 '{"hours_in_state": {">=": "policy.stale_threshold_hours"}}'::jsonb,
 'transition_objection_state',
 '{"proposed_state": "DISENGAGEMENT.passive_cooling", "trigger_source": "TIMER_EXPIRY"}'::jsonb,
 50, true);

COMMIT;

-- ----------------------------------------------------------------------------
-- Verification: 12 STATE_CLASSIFICATION rules active
-- ----------------------------------------------------------------------------
-- SELECT count(*) FROM agent_rules WHERE category='STATE_CLASSIFICATION' AND active=true;
