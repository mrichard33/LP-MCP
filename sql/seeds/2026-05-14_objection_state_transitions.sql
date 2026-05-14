-- ============================================================================
-- Seed: objection_state_transitions (S5.2 v2, Spec v1.2)
-- Date: 2026-05-14
-- ----------------------------------------------------------------------------
-- Allowed/forbidden transitions. Specific (from, to) rows beat wildcards.
-- Wildcards: '*' in from_state or to_state matches any.
--
-- v1.2 — no_home rows removed; nuance:rep_traveled tag is carried instead.
-- ============================================================================

BEGIN;

INSERT INTO objection_state_transitions (from_state, to_state, allowed, requires_approval, notes) VALUES
-- ─── Initial entries (15) ────────────────────────────────────────────────
('__INITIAL__', 'APPOINTMENT_DISRUPTION.cancelled',                true,  false, 'LP CXL/CCC'),
('__INITIAL__', 'APPOINTMENT_DISRUPTION.no_show',                  true,  false, 'LP NS or NoHome (NoHome adds nuance:rep_traveled)'),
('__INITIAL__', 'APPOINTMENT_DISRUPTION.one_leg',                  true,  false, 'LP 1Leg'),
('__INITIAL__', 'APPOINTMENT_DISRUPTION.be_back',                  true,  false, 'LP BO'),
('__INITIAL__', 'APPOINTMENT_FRICTION.spouse_uncertainty',         true,  false, 'Layer 3 / behavioral'),
('__INITIAL__', 'APPOINTMENT_FRICTION.timing_delay',               true,  false, 'Layer 3'),
('__INITIAL__', 'APPOINTMENT_FRICTION.trust_hesitation',           true,  false, 'Layer 3'),
('__INITIAL__', 'APPOINTMENT_FRICTION.overwhelmed',                true,  false, 'Layer 3'),
('__INITIAL__', 'APPOINTMENT_FRICTION.price_anxiety_pre_demo',     true,  false, 'Layer 3'),
('__INITIAL__', 'APPOINTMENT_FRICTION.ghost_after_booking',        true,  false, 'Behavioral'),
('__INITIAL__', 'POST_PROPOSAL_RESISTANCE.financing_pressure',     true,  false, 'LP OPPFDN/FDNS post-demo'),
('__INITIAL__', 'POST_PROPOSAL_RESISTANCE.delay_request',          true,  false, 'LP NOC post-demo'),
('__INITIAL__', 'DISENGAGEMENT.passive_cooling',                   true,  false, 'Default cold contact'),
('__INITIAL__', 'DISENGAGEMENT.soft_opt_out',                      true,  false, 'Tag-based'),
('__INITIAL__', 'DISENGAGEMENT.hard_loss',                         true,  false, 'DNC'),

-- ─── Recovery exits → __RESOLVED__ (10) ──────────────────────────────────
('APPOINTMENT_FRICTION.spouse_uncertainty',     '__RESOLVED__', true, false, 'Rebooked'),
('APPOINTMENT_FRICTION.timing_delay',           '__RESOLVED__', true, false, 'Rebooked'),
('APPOINTMENT_FRICTION.trust_hesitation',       '__RESOLVED__', true, false, 'Rebooked'),
('APPOINTMENT_FRICTION.overwhelmed',            '__RESOLVED__', true, false, 'Engagement signal'),
('APPOINTMENT_FRICTION.price_anxiety_pre_demo', '__RESOLVED__', true, false, 'Calculator OR booked'),
('APPOINTMENT_FRICTION.ghost_after_booking',    '__RESOLVED__', true, false, 'Confirmation reply'),
('APPOINTMENT_DISRUPTION.cancelled',            '__RESOLVED__', true, false, 'Rebooked'),
('APPOINTMENT_DISRUPTION.no_show',              '__RESOLVED__', true, false, 'Rebooked (confirmation required if nuance:rep_traveled)'),
('APPOINTMENT_DISRUPTION.one_leg',              '__RESOLVED__', true, false, 'Rebooked with both DMs'),
('APPOINTMENT_DISRUPTION.be_back',              '__RESOLVED__', true, false, 'Rebooked'),

-- ─── Cooling exits → DISENGAGEMENT.passive_cooling (10) ──────────────────
('APPOINTMENT_FRICTION.spouse_uncertainty',     'DISENGAGEMENT.passive_cooling', true, false, 'Window exhausted'),
('APPOINTMENT_FRICTION.timing_delay',           'DISENGAGEMENT.passive_cooling', true, false, 'Window exhausted'),
('APPOINTMENT_FRICTION.trust_hesitation',       'DISENGAGEMENT.passive_cooling', true, false, 'Window exhausted'),
('APPOINTMENT_FRICTION.overwhelmed',            'DISENGAGEMENT.passive_cooling', true, false, 'Window exhausted'),
('APPOINTMENT_FRICTION.price_anxiety_pre_demo', 'DISENGAGEMENT.passive_cooling', true, false, 'Window exhausted'),
('APPOINTMENT_FRICTION.ghost_after_booking',    'DISENGAGEMENT.passive_cooling', true, false, 'Window exhausted'),
('APPOINTMENT_DISRUPTION.cancelled',            'DISENGAGEMENT.passive_cooling', true, false, 'Window exhausted'),
('APPOINTMENT_DISRUPTION.no_show',              'DISENGAGEMENT.passive_cooling', true, false, 'Window exhausted'),
('APPOINTMENT_DISRUPTION.one_leg',              'DISENGAGEMENT.passive_cooling', true, false, 'Window exhausted'),
('APPOINTMENT_DISRUPTION.be_back',              'DISENGAGEMENT.passive_cooling', true, false, 'Window exhausted'),

-- ─── Intra-cluster + cross-cluster reveals (9) ───────────────────────────
('APPOINTMENT_FRICTION.trust_hesitation',  'APPOINTMENT_FRICTION.price_anxiety_pre_demo', true, false, 'Cost concern revealed'),
('APPOINTMENT_FRICTION.ghost_after_booking','APPOINTMENT_DISRUPTION.no_show',             true, false, 'Appt date passed'),
('APPOINTMENT_DISRUPTION.one_leg',         'APPOINTMENT_FRICTION.spouse_uncertainty',     true, false, 'Rebook fails on spouse'),
('APPOINTMENT_DISRUPTION.be_back',         'POST_PROPOSAL_RESISTANCE.financing_pressure', true, true,  'BO masked post-demo objection'),
('APPOINTMENT_DISRUPTION.be_back',         'POST_PROPOSAL_RESISTANCE.delay_request',      true, true,  'BO masked post-demo delay'),
('APPOINTMENT_DISRUPTION.cancelled',       'APPOINTMENT_FRICTION.spouse_uncertainty',     true, false, 'Cancel reason: spouse'),
('APPOINTMENT_DISRUPTION.cancelled',       'APPOINTMENT_FRICTION.timing_delay',           true, false, 'Cancel reason: timing'),
('DISENGAGEMENT.soft_opt_out',             'DISENGAGEMENT.hard_loss',                     true, false, 'Escalation to DNC'),
('DISENGAGEMENT.passive_cooling',          'DISENGAGEMENT.active_avoidance',              true, false, 'Repeated non-engagement'),

-- ─── Re-entry from cooling (external signal) (2) ─────────────────────────
('DISENGAGEMENT.passive_cooling', 'APPOINTMENT_DISRUPTION.cancelled', true, false, 'Rebooked then cancelled'),
('DISENGAGEMENT.passive_cooling', 'APPOINTMENT_DISRUPTION.no_show',   true, false, 'Rebooked then no-show or no-home (nuance preserves rep_traveled)'),

-- ─── Wildcards: any → DNC / soft opt-out (2) ─────────────────────────────
('*', 'DISENGAGEMENT.hard_loss',    true, false, 'DNC always wins'),
('*', 'DISENGAGEMENT.soft_opt_out', true, false, 'Soft opt-out reachable from any'),

-- ─── Approval-required re-entry after active avoidance (2) ───────────────
('DISENGAGEMENT.active_avoidance', 'APPOINTMENT_DISRUPTION.cancelled',         true, true, 'Unusual re-entry'),
('DISENGAGEMENT.active_avoidance', 'APPOINTMENT_FRICTION.spouse_uncertainty',  true, true, 'Unusual re-entry'),

-- ─── Forbidden (4) ───────────────────────────────────────────────────────
('DISENGAGEMENT.hard_loss', '*', false, false, 'No re-entry without manual override'),
('POST_PROPOSAL_RESISTANCE.financing_pressure', 'APPOINTMENT_FRICTION.spouse_uncertainty',     false, false, 'Cannot regress past demo'),
('POST_PROPOSAL_RESISTANCE.financing_pressure', 'APPOINTMENT_FRICTION.price_anxiety_pre_demo', false, false, 'Cannot regress past demo'),
('POST_PROPOSAL_RESISTANCE.delay_request',      'APPOINTMENT_FRICTION.timing_delay',           false, false, 'Cannot regress past demo');

COMMIT;

-- ----------------------------------------------------------------------------
-- Verification: should be 54 rows
-- ----------------------------------------------------------------------------
-- SELECT count(*) FROM objection_state_transitions;
