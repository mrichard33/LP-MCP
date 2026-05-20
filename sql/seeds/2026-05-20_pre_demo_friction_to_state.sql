-- ============================================================================
-- Seed: pre-demo concern tag → APPOINTMENT_FRICTION.* state transition
-- Date: 2026-05-20
-- ----------------------------------------------------------------------------
-- WHY:
--   The existing pre-demo rules (181-184) fire when a contact gets a
--   pre-demo-concern:* / concern-expressed:* tag added. Those rules apply
--   tags, queue rep tasks, and send notifications, but do NOT propose an
--   objection_state transition — so the contact never gets enrolled in
--   S5.2 v2 from a pre-demo friction signal.
--
--   These rules layer on top of 181-184. They fire on the same trigger
--   (ghl.tag_added with the concern tag) and additionally emit a
--   transition_objection_state action with the matching
--   APPOINTMENT_FRICTION.* code. The state handler then mirrors state to
--   GHL + enqueues the S5.2 v2 enrollment via add_to_workflow.
--
--   The decision engine supports multiple matching rules firing
--   independently (each becomes a separate agent_action row), so this is
--   purely additive — Rules 181-184 keep working unchanged.
--
-- POST-DEMO GATE:
--   Pre-demo concerns only. Each rule context-gates on
--   not_has_any_tag for the post-demo markers so that a contact who
--   already completed a demo does not get downgraded into S5.2 v2 by a
--   late-firing pre-demo tag.
--
--   This matches the gating pattern in existing rules 181-184 (per
--   2026-05-20 handoff). The post-demo equivalent rules (64, 65, 66, 67)
--   route to O.0 via Rule 214 and are NOT touched by this seed.
-- ----------------------------------------------------------------------------

BEGIN;

INSERT INTO agent_rules
  (rule_key, rule_name, category, rule_type, event_pattern, context_conditions,
   action_template, requires_approval, enabled, priority, notes)
VALUES
('PRE_DEMO_CONCERN_SPOUSE_TO_STATE',
 'pre-demo-concern:spouse → APPOINTMENT_FRICTION.spouse_uncertainty',
 'STATE_CLASSIFICATION', 'contextual',
 '{"event_type": "ghl.tag_added", "event_subtype": "pre-demo-concern:spouse"}'::jsonb,
 '{"not_has_any_tag": ["lp-demo-completed", "stage:post-appointment", "stage:booked-main-appointment", "buyer:post-decision"]}'::jsonb,
 '[{"action_type": "transition_objection_state", "target_system": "lp", "target_entity": "contact",
    "params": {"proposed_state": "APPOINTMENT_FRICTION.spouse_uncertainty", "trigger_source": "BEHAVIORAL_RULE"}}]'::jsonb,
 FALSE, TRUE, 90,
 'Layered with existing Rule 183 (pre-demo spouse). 183 tags + notifies; this rule additionally enrolls in S5.2 v2 via the state handler.'),

('PRE_DEMO_CONCERN_TIMING_TO_STATE',
 'pre-demo-concern:timing → APPOINTMENT_FRICTION.timing_delay',
 'STATE_CLASSIFICATION', 'contextual',
 '{"event_type": "ghl.tag_added", "event_subtype": "pre-demo-concern:timing"}'::jsonb,
 '{"not_has_any_tag": ["lp-demo-completed", "stage:post-appointment", "stage:booked-main-appointment", "buyer:post-decision"]}'::jsonb,
 '[{"action_type": "transition_objection_state", "target_system": "lp", "target_entity": "contact",
    "params": {"proposed_state": "APPOINTMENT_FRICTION.timing_delay", "trigger_source": "BEHAVIORAL_RULE"}}]'::jsonb,
 FALSE, TRUE, 90,
 'Layered with existing Rule 182 (pre-demo timing).'),

('PRE_DEMO_CONCERN_TRUST_TO_STATE',
 'pre-demo-concern:trust → APPOINTMENT_FRICTION.trust_hesitation',
 'STATE_CLASSIFICATION', 'contextual',
 '{"event_type": "ghl.tag_added", "event_subtype": "pre-demo-concern:trust"}'::jsonb,
 '{"not_has_any_tag": ["lp-demo-completed", "stage:post-appointment", "stage:booked-main-appointment", "buyer:post-decision"]}'::jsonb,
 '[{"action_type": "transition_objection_state", "target_system": "lp", "target_entity": "contact",
    "params": {"proposed_state": "APPOINTMENT_FRICTION.trust_hesitation", "trigger_source": "BEHAVIORAL_RULE"}}]'::jsonb,
 FALSE, TRUE, 90,
 'Layered with existing Rule 184 (pre-demo trust).'),

('PRE_DEMO_CONCERN_PRICE_TO_STATE',
 'pre-demo-concern:price → APPOINTMENT_FRICTION.price_anxiety_pre_demo',
 'STATE_CLASSIFICATION', 'contextual',
 '{"event_type": "ghl.tag_added", "event_subtype": "pre-demo-concern:price"}'::jsonb,
 '{"not_has_any_tag": ["lp-demo-completed", "stage:post-appointment", "stage:booked-main-appointment", "buyer:post-decision"]}'::jsonb,
 '[{"action_type": "transition_objection_state", "target_system": "lp", "target_entity": "contact",
    "params": {"proposed_state": "APPOINTMENT_FRICTION.price_anxiety_pre_demo", "trigger_source": "BEHAVIORAL_RULE"}}]'::jsonb,
 FALSE, TRUE, 90,
 'Layered with existing Rule 181 (pre-demo price). Note: post-demo price concerns are POST_PROPOSAL_RESISTANCE.financing_pressure and are handled by LP_DISP_OPPFDN_TO_FINANCING, not by this rule.'),

-- ── concern-expressed:* parallel set (older convention; both tag families
-- exist in production per src/context-builder.js and appointment-body-generator.js)

('CONCERN_EXPRESSED_SPOUSE_TO_STATE',
 'concern-expressed:spouse → APPOINTMENT_FRICTION.spouse_uncertainty',
 'STATE_CLASSIFICATION', 'contextual',
 '{"event_type": "ghl.tag_added", "event_subtype": "concern-expressed:spouse"}'::jsonb,
 '{"not_has_any_tag": ["lp-demo-completed", "stage:post-appointment", "stage:booked-main-appointment", "buyer:post-decision"]}'::jsonb,
 '[{"action_type": "transition_objection_state", "target_system": "lp", "target_entity": "contact",
    "params": {"proposed_state": "APPOINTMENT_FRICTION.spouse_uncertainty", "trigger_source": "BEHAVIORAL_RULE"}}]'::jsonb,
 FALSE, TRUE, 90,
 NULL),

('CONCERN_EXPRESSED_TIMING_TO_STATE',
 'concern-expressed:timing → APPOINTMENT_FRICTION.timing_delay',
 'STATE_CLASSIFICATION', 'contextual',
 '{"event_type": "ghl.tag_added", "event_subtype": "concern-expressed:timing"}'::jsonb,
 '{"not_has_any_tag": ["lp-demo-completed", "stage:post-appointment", "stage:booked-main-appointment", "buyer:post-decision"]}'::jsonb,
 '[{"action_type": "transition_objection_state", "target_system": "lp", "target_entity": "contact",
    "params": {"proposed_state": "APPOINTMENT_FRICTION.timing_delay", "trigger_source": "BEHAVIORAL_RULE"}}]'::jsonb,
 FALSE, TRUE, 90,
 NULL),

('CONCERN_EXPRESSED_TRUST_TO_STATE',
 'concern-expressed:trust → APPOINTMENT_FRICTION.trust_hesitation',
 'STATE_CLASSIFICATION', 'contextual',
 '{"event_type": "ghl.tag_added", "event_subtype": "concern-expressed:trust"}'::jsonb,
 '{"not_has_any_tag": ["lp-demo-completed", "stage:post-appointment", "stage:booked-main-appointment", "buyer:post-decision"]}'::jsonb,
 '[{"action_type": "transition_objection_state", "target_system": "lp", "target_entity": "contact",
    "params": {"proposed_state": "APPOINTMENT_FRICTION.trust_hesitation", "trigger_source": "BEHAVIORAL_RULE"}}]'::jsonb,
 FALSE, TRUE, 90,
 NULL),

('CONCERN_EXPRESSED_PRICE_TO_STATE',
 'concern-expressed:price → APPOINTMENT_FRICTION.price_anxiety_pre_demo',
 'STATE_CLASSIFICATION', 'contextual',
 '{"event_type": "ghl.tag_added", "event_subtype": "concern-expressed:price"}'::jsonb,
 '{"not_has_any_tag": ["lp-demo-completed", "stage:post-appointment", "stage:booked-main-appointment", "buyer:post-decision"]}'::jsonb,
 '[{"action_type": "transition_objection_state", "target_system": "lp", "target_entity": "contact",
    "params": {"proposed_state": "APPOINTMENT_FRICTION.price_anxiety_pre_demo", "trigger_source": "BEHAVIORAL_RULE"}}]'::jsonb,
 FALSE, TRUE, 90,
 NULL)

ON CONFLICT (rule_key) DO UPDATE SET
  rule_name          = EXCLUDED.rule_name,
  category           = EXCLUDED.category,
  rule_type          = EXCLUDED.rule_type,
  event_pattern      = EXCLUDED.event_pattern,
  context_conditions = EXCLUDED.context_conditions,
  action_template    = EXCLUDED.action_template,
  requires_approval  = EXCLUDED.requires_approval,
  enabled            = EXCLUDED.enabled,
  priority           = EXCLUDED.priority,
  notes              = EXCLUDED.notes,
  updated_at         = NOW();

COMMIT;

-- ----------------------------------------------------------------------------
-- Out of scope (per 2026-05-20 handoff):
--   competitor / complexity-DIY pre-demo concerns (existing rules 185-186)
--   are NOT mapped to S5.2 v2 FRICTION codes. Those land in story-arc nurture
--   and have no equivalent state code in the v1.2 taxonomy. Leave them alone.
--   overwhelmed pre-demo: there's no concern-expressed:overwhelmed or
--   pre-demo-concern:overwhelmed tag in the existing convention. Layer 3
--   (message-analyzer) is the only path to APPOINTMENT_FRICTION.overwhelmed;
--   handled by LAYER3_OVERWHELMED in 2026-05-20_state_classification_rules_v2.sql.
-- ----------------------------------------------------------------------------
