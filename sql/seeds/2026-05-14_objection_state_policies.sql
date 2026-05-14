-- ============================================================================
-- Seed: objection_state_policies (S5.2 v2, Spec v1.2)
-- Date: 2026-05-14
-- ----------------------------------------------------------------------------
-- 16 leaf states across 4 clusters (no_home merged into no_show in v1.2).
-- Replace placeholder workflow IDs before/after running:
--   '0a6a1349-0b44-429b-91e1-4c5be264cd9f' is the locked S5.2 v2 workflow ID
--   'W9.0-WORKFLOW-ID' — replace with the W9.0 workflow ID when built
--   'L5-WORKFLOW-ID'   — replace with the existing L.5 Cooling Timer workflow
-- ============================================================================

BEGIN;

INSERT INTO objection_state_policies
  (state_code, parent_state, display_name, priority, recovery_workflow_id,
   recovery_window_days, recovery_touch_count, recovery_cadence, copy_variant,
   cooldown_period_days, cooldown_workflow_id, allowed_transitions, resolution_criteria)
VALUES
-- ─── APPOINTMENT_FRICTION cluster (priority 40) ───────────────────────────
('APPOINTMENT_FRICTION.spouse_uncertainty', 'APPOINTMENT_FRICTION',
 'Spouse Uncertainty (Pre-Appt)', 40,
 '0a6a1349-0b44-429b-91e1-4c5be264cd9f', 10, 3,
 '[{"day":1,"channel":"sms"},{"day":4,"channel":"email"},{"day":8,"channel":"sms"}]'::jsonb,
 'spouse_aware', 30, 'L5-WORKFLOW-ID',
 ARRAY['__RESOLVED__','APPOINTMENT_DISRUPTION.cancelled','DISENGAGEMENT.passive_cooling'],
 '{"appointment_booked":true}'::jsonb),

('APPOINTMENT_FRICTION.timing_delay', 'APPOINTMENT_FRICTION',
 'Timing Delay (Pre-Appt)', 40,
 '0a6a1349-0b44-429b-91e1-4c5be264cd9f', 7, 2,
 '[{"day":2,"channel":"sms"},{"day":6,"channel":"sms"}]'::jsonb,
 'low_pressure', 45, 'L5-WORKFLOW-ID',
 ARRAY['__RESOLVED__','DISENGAGEMENT.passive_cooling'],
 '{"appointment_booked":true}'::jsonb),

('APPOINTMENT_FRICTION.trust_hesitation', 'APPOINTMENT_FRICTION',
 'Trust Hesitation (Pre-Appt)', 40,
 '0a6a1349-0b44-429b-91e1-4c5be264cd9f', 10, 3,
 '[{"day":1,"channel":"sms"},{"day":4,"channel":"email","template":"randy_story"},{"day":8,"channel":"sms"}]'::jsonb,
 'trust_building', 30, 'L5-WORKFLOW-ID',
 ARRAY['__RESOLVED__','APPOINTMENT_FRICTION.price_anxiety_pre_demo','DISENGAGEMENT.passive_cooling'],
 '{"appointment_booked":true}'::jsonb),

('APPOINTMENT_FRICTION.overwhelmed', 'APPOINTMENT_FRICTION',
 'Overwhelmed (Pre-Appt)', 40,
 '0a6a1349-0b44-429b-91e1-4c5be264cd9f', 14, 1,
 '[{"day":5,"channel":"sms"}]'::jsonb,
 'ultra_light', 60, 'L5-WORKFLOW-ID',
 ARRAY['__RESOLVED__','DISENGAGEMENT.passive_cooling'],
 '{"engagement_signal":"positive"}'::jsonb),

('APPOINTMENT_FRICTION.price_anxiety_pre_demo', 'APPOINTMENT_FRICTION',
 'Price Anxiety (Pre-Appt)', 40,
 '0a6a1349-0b44-429b-91e1-4c5be264cd9f', 7, 3,
 '[{"day":1,"channel":"sms","cta":"calculator"},{"day":3,"channel":"email"},{"day":7,"channel":"sms"}]'::jsonb,
 'calculator_downsell', 45, 'L5-WORKFLOW-ID',
 ARRAY['__RESOLVED__','APPOINTMENT_FRICTION.trust_hesitation','DISENGAGEMENT.passive_cooling'],
 '{"calculator_engaged":true,"appointment_booked":true}'::jsonb),

('APPOINTMENT_FRICTION.ghost_after_booking', 'APPOINTMENT_FRICTION',
 'Ghost After Booking', 40,
 '0a6a1349-0b44-429b-91e1-4c5be264cd9f', 5, 3,
 '[{"day":1,"channel":"sms"},{"day":2,"channel":"sms"},{"day":4,"channel":"sms"}]'::jsonb,
 'pre_appt_confirmation', 14, 'L5-WORKFLOW-ID',
 ARRAY['__RESOLVED__','APPOINTMENT_DISRUPTION.no_show','DISENGAGEMENT.passive_cooling'],
 '{"confirmation_reply":true}'::jsonb),

-- ─── APPOINTMENT_DISRUPTION cluster (priority 50) ─────────────────────────
('APPOINTMENT_DISRUPTION.cancelled', 'APPOINTMENT_DISRUPTION',
 'Appointment Cancelled', 50,
 '0a6a1349-0b44-429b-91e1-4c5be264cd9f', 7, 3,
 '[{"day":1,"channel":"sms"},{"day":3,"channel":"email"},{"day":7,"channel":"sms"}]'::jsonb,
 'cancellation_standard', 30, 'L5-WORKFLOW-ID',
 ARRAY['__RESOLVED__','APPOINTMENT_FRICTION.spouse_uncertainty','APPOINTMENT_FRICTION.timing_delay','DISENGAGEMENT.passive_cooling'],
 '{"appointment_booked":true}'::jsonb),

('APPOINTMENT_DISRUPTION.no_show', 'APPOINTMENT_DISRUPTION',
 'No Show (incl. No Home via nuance:rep_traveled)', 50,
 '0a6a1349-0b44-429b-91e1-4c5be264cd9f', 7, 3,
 '[{"day":1,"channel":"sms"},{"day":3,"channel":"email"},{"day":7,"channel":"sms"}]'::jsonb,
 'no_show_deshame', 45, 'L5-WORKFLOW-ID',
 ARRAY['__RESOLVED__','DISENGAGEMENT.passive_cooling','DISENGAGEMENT.active_avoidance'],
 '{"appointment_booked":true,"confirmation_call_completed_if_rep_traveled":true}'::jsonb),

('APPOINTMENT_DISRUPTION.one_leg', 'APPOINTMENT_DISRUPTION',
 'One Leg (Spouse Compound)', 50,
 '0a6a1349-0b44-429b-91e1-4c5be264cd9f', 10, 3,
 '[{"day":1,"channel":"sms"},{"day":4,"channel":"email"},{"day":8,"channel":"sms"}]'::jsonb,
 'spouse_aware', 30, 'L5-WORKFLOW-ID',
 ARRAY['__RESOLVED__','APPOINTMENT_FRICTION.spouse_uncertainty','DISENGAGEMENT.passive_cooling'],
 '{"appointment_booked":true,"both_decision_makers_confirmed":true}'::jsonb),

('APPOINTMENT_DISRUPTION.be_back', 'APPOINTMENT_DISRUPTION',
 'Be Back (Demo Incomplete)', 50,
 '0a6a1349-0b44-429b-91e1-4c5be264cd9f', 7, 3,
 '[{"day":1,"channel":"sms"},{"day":3,"channel":"email"},{"day":7,"channel":"sms"}]'::jsonb,
 'continuation', 30, 'L5-WORKFLOW-ID',
 ARRAY['__RESOLVED__','POST_PROPOSAL_RESISTANCE.financing_pressure','POST_PROPOSAL_RESISTANCE.delay_request','DISENGAGEMENT.passive_cooling'],
 '{"appointment_booked":true}'::jsonb),

-- ─── POST_PROPOSAL_RESISTANCE cluster (priority 60) — W9.0 placeholders ───
('POST_PROPOSAL_RESISTANCE.financing_pressure', 'POST_PROPOSAL_RESISTANCE',
 'Post-Demo: Financing', 60,
 'W9.0-WORKFLOW-ID', 14, 3,
 '[{"day":1,"channel":"sms"},{"day":7,"channel":"email"},{"day":14,"channel":"sms"}]'::jsonb,
 'financing_objection', 180, 'L5-WORKFLOW-ID',
 ARRAY['__RESOLVED__','DISENGAGEMENT.passive_cooling','DISENGAGEMENT.soft_opt_out'],
 '{"appointment_booked":true,"financing_application_started":true}'::jsonb),

('POST_PROPOSAL_RESISTANCE.delay_request', 'POST_PROPOSAL_RESISTANCE',
 'Post-Demo: Delay Request', 60,
 'W9.0-WORKFLOW-ID', 14, 3,
 '[{"day":1,"channel":"sms"},{"day":7,"channel":"email"},{"day":14,"channel":"sms"}]'::jsonb,
 'delay_handler', 30, 'L5-WORKFLOW-ID',
 ARRAY['__RESOLVED__','DISENGAGEMENT.passive_cooling'],
 '{"appointment_booked":true}'::jsonb),

-- ─── DISENGAGEMENT cluster ───────────────────────────────────────────────
('DISENGAGEMENT.passive_cooling', 'DISENGAGEMENT',
 'Passive Cooling', 20,
 'L5-WORKFLOW-ID', 0, 0,
 '[]'::jsonb,
 'quiet_hold', NULL, NULL,
 ARRAY['APPOINTMENT_DISRUPTION.cancelled','APPOINTMENT_DISRUPTION.no_show','APPOINTMENT_FRICTION.spouse_uncertainty','__RESOLVED__'],
 '{"external_signal":true}'::jsonb),

('DISENGAGEMENT.soft_opt_out', 'DISENGAGEMENT',
 'Soft Opt-Out', 70,
 NULL, 0, 0, '[]'::jsonb, NULL, 180, NULL,
 ARRAY['DISENGAGEMENT.hard_loss','DISENGAGEMENT.passive_cooling'],
 '{}'::jsonb),

('DISENGAGEMENT.active_avoidance', 'DISENGAGEMENT',
 'Active Avoidance', 80,
 NULL, 0, 0, '[]'::jsonb, NULL, 365, NULL,
 ARRAY['DISENGAGEMENT.hard_loss','DISENGAGEMENT.passive_cooling'],
 '{}'::jsonb),

('DISENGAGEMENT.hard_loss', 'DISENGAGEMENT',
 'Hard Loss (DNC)', 100,
 NULL, 0, 0, '[]'::jsonb, NULL, NULL, NULL,
 ARRAY[]::text[],
 '{}'::jsonb);

COMMIT;

-- ----------------------------------------------------------------------------
-- Verification:
--   Expect: APPOINTMENT_FRICTION:6, APPOINTMENT_DISRUPTION:4,
--           POST_PROPOSAL_RESISTANCE:2, DISENGAGEMENT:4
-- ----------------------------------------------------------------------------
-- SELECT json_agg(row_to_json(t)) FROM (
--   SELECT parent_state, count(*) AS leaf_count
--   FROM objection_state_policies GROUP BY parent_state
-- ) t;
