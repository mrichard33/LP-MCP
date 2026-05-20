-- ============================================================================
-- Seed: STATE_CLASSIFICATION agent_rules (S5.2 v2, Spec v1.2 — schema-corrected)
-- Date: 2026-05-20
-- Supersedes: sql/seeds/2026-05-14_state_classification_rules.sql
-- ----------------------------------------------------------------------------
-- WHY THIS FILE:
--   The 2026-05-14 seed inserts into agent_rules using columns
--   (trigger_event_type, trigger_conditions, action_type, action_payload, active).
--   The live agent_rules schema (sql/006_agentic_system.sql + 019) uses
--   (event_pattern, context_conditions, action_template, enabled). The live
--   decision engine (src/decision-engine.js:646) reads only the live names,
--   so the 2026-05-14 seed has never successfully applied — it would error
--   on first INSERT with "column does not exist".
--
-- WHAT'S DIFFERENT FROM v1:
--   1. Schema-correct column names + types.
--   2. context_conditions verbs limited to those actually implemented in
--      src/decision-engine.js evaluateContextConditions() — see the verb
--      switch starting at line 505. Unknown verbs short-circuit the rule
--      silently; using only-real verbs keeps classification deterministic.
--   3. LP disposition family unified into a single rule per target state
--      via lp_disposition_in (reads lp_leads.disposition_code; the sync
--      writes lp_leads BEFORE emitting lp.disposition_changed so the read
--      is consistent — see src/sync-leads.js).
--   4. Message-analyzer proposals matched on event_subtype (message-analyzer
--      sets event_subtype = proposed_state — see src/message-analyzer.js).
--   5. Adds LAYER3_OVERWHELMED — fills a gap in v1 where
--      ACTION_TO_STATE_MAP.objection_overwhelmed had no rule to consume the
--      resulting proposal.
--   6. Tag-based rules split into one-per-tag (no event_subtype_in verb
--      exists in the engine; cheap to add but out of scope here).
-- ============================================================================

BEGIN;

-- ─── LP disposition rules (priority 100) ────────────────────────────────────
-- All four DISRUPTION + the post-demo financing rule. Use rule_type=contextual
-- so the engine evaluates context_conditions (lp_disposition_in is implemented
-- at src/decision-engine.js:570).

INSERT INTO agent_rules
  (rule_key, rule_name, category, rule_type, event_pattern, context_conditions,
   action_template, requires_approval, enabled, priority, notes)
VALUES
('LP_DISP_CXL_TO_CANCELLED',
 'LP CXL/CCC disposition → APPOINTMENT_DISRUPTION.cancelled',
 'STATE_CLASSIFICATION', 'contextual',
 '{"event_type": "lp.disposition_changed"}'::jsonb,
 '{"lp_disposition_in": ["CXL", "CCC"]}'::jsonb,
 '[{"action_type": "transition_objection_state", "target_system": "lp", "target_entity": "contact",
    "params": {"proposed_state": "APPOINTMENT_DISRUPTION.cancelled", "trigger_source": "LP_WEBHOOK"}}]'::jsonb,
 FALSE, TRUE, 100,
 'Routes LP cancellation dispositions to the S5.2 v2 cancelled branch via the state handler.'),

('LP_DISP_NS_OR_NOHOME_TO_NOSHOW',
 'LP NS/NoHome/NOC/NIS/NIS2 disposition → APPOINTMENT_DISRUPTION.no_show',
 'STATE_CLASSIFICATION', 'contextual',
 '{"event_type": "lp.disposition_changed"}'::jsonb,
 '{"lp_disposition_in": ["NS", "NoHome", "NOC", "NIS", "NIS2"]}'::jsonb,
 '[{"action_type": "transition_objection_state", "target_system": "lp", "target_entity": "contact",
    "params": {"proposed_state": "APPOINTMENT_DISRUPTION.no_show", "trigger_source": "LP_WEBHOOK",
               "nuance_tags_conditional": {"if_disposition_in": ["NoHome", "NIS", "NIS2"], "tags": ["nuance:rep_traveled"]}}}]'::jsonb,
 FALSE, TRUE, 100,
 'Reece-fault no-show. Subsumes the legacy Rule 227 no_show path — disable Rule 227 (see 2026-05-20_disable_legacy_state_rules.sql) after this rule verifies.'),

('LP_DISP_1LEG_TO_ONELEG',
 'LP 1Leg disposition → APPOINTMENT_DISRUPTION.one_leg',
 'STATE_CLASSIFICATION', 'contextual',
 '{"event_type": "lp.disposition_changed"}'::jsonb,
 '{"lp_disposition_in": ["1Leg"]}'::jsonb,
 '[{"action_type": "transition_objection_state", "target_system": "lp", "target_entity": "contact",
    "params": {"proposed_state": "APPOINTMENT_DISRUPTION.one_leg", "trigger_source": "LP_WEBHOOK",
               "nuance_tags": ["nuance:spouse_required"]}}]'::jsonb,
 FALSE, TRUE, 100,
 'Demo ran but only one partner present.'),

('LP_DISP_BO_TO_BEBACK',
 'LP BO disposition → APPOINTMENT_DISRUPTION.be_back',
 'STATE_CLASSIFICATION', 'contextual',
 '{"event_type": "lp.disposition_changed"}'::jsonb,
 '{"lp_disposition_in": ["BO"]}'::jsonb,
 '[{"action_type": "transition_objection_state", "target_system": "lp", "target_entity": "contact",
    "params": {"proposed_state": "APPOINTMENT_DISRUPTION.be_back", "trigger_source": "LP_WEBHOOK"}}]'::jsonb,
 FALSE, TRUE, 100,
 'Customer stated intent to return.'),

('LP_DISP_OPPFDN_TO_FINANCING',
 'LP OPPFDN/FDNS post-demo → POST_PROPOSAL_RESISTANCE.financing_pressure',
 'STATE_CLASSIFICATION', 'contextual',
 '{"event_type": "lp.disposition_changed"}'::jsonb,
 '{"lp_disposition_in": ["OPPFDN", "FDNS"], "has_any_tag": ["lp-demo-completed", "stage:post-appointment"]}'::jsonb,
 '[{"action_type": "transition_objection_state", "target_system": "lp", "target_entity": "contact",
    "params": {"proposed_state": "POST_PROPOSAL_RESISTANCE.financing_pressure", "trigger_source": "LP_WEBHOOK"}}]'::jsonb,
 FALSE, TRUE, 100,
 'Gated to post-demo contacts via has_any_tag — pre-demo OPPFDN should not land here.')

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


-- ─── Layer 3 (message_analyzer) rules (priority 90) ─────────────────────────
-- message-analyzer.js (line ~244 ACTION_TO_STATE_MAP) emits
-- message_analyzer_proposal events with event_subtype = proposed_state. We
-- match on event_subtype in event_pattern so no context_conditions evaluation
-- is required (these are pure 'pattern' rules).

INSERT INTO agent_rules
  (rule_key, rule_name, category, rule_type, event_pattern, context_conditions,
   action_template, requires_approval, enabled, priority, notes)
VALUES
('LAYER3_PRICE_ANXIETY',
 'Layer 3 proposal → APPOINTMENT_FRICTION.price_anxiety_pre_demo',
 'STATE_CLASSIFICATION', 'pattern',
 '{"event_type": "message_analyzer_proposal", "event_subtype": "APPOINTMENT_FRICTION.price_anxiety_pre_demo"}'::jsonb,
 NULL,
 '[{"action_type": "transition_objection_state", "target_system": "lp", "target_entity": "contact",
    "params": {"proposed_state": "APPOINTMENT_FRICTION.price_anxiety_pre_demo", "trigger_source": "MESSAGE_ANALYZER", "use_proposal_confidence": true}}]'::jsonb,
 FALSE, TRUE, 90,
 'Pre-demo price/budget concern detected by message-analyzer.'),

('LAYER3_TIMING_DELAY',
 'Layer 3 proposal → APPOINTMENT_FRICTION.timing_delay',
 'STATE_CLASSIFICATION', 'pattern',
 '{"event_type": "message_analyzer_proposal", "event_subtype": "APPOINTMENT_FRICTION.timing_delay"}'::jsonb,
 NULL,
 '[{"action_type": "transition_objection_state", "target_system": "lp", "target_entity": "contact",
    "params": {"proposed_state": "APPOINTMENT_FRICTION.timing_delay", "trigger_source": "MESSAGE_ANALYZER", "use_proposal_confidence": true}}]'::jsonb,
 FALSE, TRUE, 90,
 'Vague future deferral.'),

('LAYER3_SPOUSE_UNCERTAINTY',
 'Layer 3 proposal → APPOINTMENT_FRICTION.spouse_uncertainty',
 'STATE_CLASSIFICATION', 'pattern',
 '{"event_type": "message_analyzer_proposal", "event_subtype": "APPOINTMENT_FRICTION.spouse_uncertainty"}'::jsonb,
 NULL,
 '[{"action_type": "transition_objection_state", "target_system": "lp", "target_entity": "contact",
    "params": {"proposed_state": "APPOINTMENT_FRICTION.spouse_uncertainty", "trigger_source": "MESSAGE_ANALYZER", "use_proposal_confidence": true}}]'::jsonb,
 FALSE, TRUE, 90,
 'Spouse needs to be present / consulted (pre-appt).'),

('LAYER3_TRUST_HESITATION',
 'Layer 3 proposal → APPOINTMENT_FRICTION.trust_hesitation',
 'STATE_CLASSIFICATION', 'pattern',
 '{"event_type": "message_analyzer_proposal", "event_subtype": "APPOINTMENT_FRICTION.trust_hesitation"}'::jsonb,
 NULL,
 '[{"action_type": "transition_objection_state", "target_system": "lp", "target_entity": "contact",
    "params": {"proposed_state": "APPOINTMENT_FRICTION.trust_hesitation", "trigger_source": "MESSAGE_ANALYZER", "use_proposal_confidence": true}}]'::jsonb,
 FALSE, TRUE, 90,
 'Comparison-shop / credentials / skepticism (pre-appt).'),

('LAYER3_OVERWHELMED',
 'Layer 3 proposal → APPOINTMENT_FRICTION.overwhelmed',
 'STATE_CLASSIFICATION', 'pattern',
 '{"event_type": "message_analyzer_proposal", "event_subtype": "APPOINTMENT_FRICTION.overwhelmed"}'::jsonb,
 NULL,
 '[{"action_type": "transition_objection_state", "target_system": "lp", "target_entity": "contact",
    "params": {"proposed_state": "APPOINTMENT_FRICTION.overwhelmed", "trigger_source": "MESSAGE_ANALYZER", "use_proposal_confidence": true}}]'::jsonb,
 FALSE, TRUE, 90,
 '2026-05-20 NEW — Closes the gap in 2026-05-14 seed: ACTION_TO_STATE_MAP already maps objection_overwhelmed → APPOINTMENT_FRICTION.overwhelmed but no STATE_CLASSIFICATION rule consumed it. Without this rule the proposal fell on the floor.'),

('LAYER3_DISENGAGEMENT',
 'Layer 3 proposal → DISENGAGEMENT.passive_cooling',
 'STATE_CLASSIFICATION', 'pattern',
 '{"event_type": "message_analyzer_proposal", "event_subtype": "DISENGAGEMENT.passive_cooling"}'::jsonb,
 NULL,
 '[{"action_type": "transition_objection_state", "target_system": "lp", "target_entity": "contact",
    "params": {"proposed_state": "DISENGAGEMENT.passive_cooling", "trigger_source": "MESSAGE_ANALYZER", "use_proposal_confidence": true}}]'::jsonb,
 FALSE, TRUE, 90,
 'Passive disengagement / cooling signal.')

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


-- ─── Behavioral rules (priority 80) ─────────────────────────────────────────

INSERT INTO agent_rules
  (rule_key, rule_name, category, rule_type, event_pattern, context_conditions,
   action_template, requires_approval, enabled, priority, notes)
VALUES
('BEHAVIORAL_GHOST_AFTER_BOOKING',
 'confirmation_unacknowledged → APPOINTMENT_FRICTION.ghost_after_booking',
 'STATE_CLASSIFICATION', 'pattern',
 '{"event_type": "confirmation_unacknowledged"}'::jsonb,
 NULL,
 '[{"action_type": "transition_objection_state", "target_system": "lp", "target_entity": "contact",
    "params": {"proposed_state": "APPOINTMENT_FRICTION.ghost_after_booking", "trigger_source": "BEHAVIORAL_RULE"}}]'::jsonb,
 FALSE, TRUE, 80,
 'Fed by src/objection-state-ghost-sweep.js (4h cadence) which finds contacts past appointment with no disposition and no inbound reply within GHOST_MIN_HOURS–GHOST_MAX_HOURS window.')

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


-- ─── Tag-based rules (one rule per tag — no event_subtype_in verb exists) ──

INSERT INTO agent_rules
  (rule_key, rule_name, category, rule_type, event_pattern, context_conditions,
   action_template, requires_approval, enabled, priority, notes)
VALUES
('TAG_DNC_TO_HARDLOSS',
 'dnc tag → DISENGAGEMENT.hard_loss',
 'STATE_CLASSIFICATION', 'pattern',
 '{"event_type": "ghl.tag_added", "event_subtype": "dnc"}'::jsonb,
 NULL,
 '[{"action_type": "transition_objection_state", "target_system": "lp", "target_entity": "contact",
    "params": {"proposed_state": "DISENGAGEMENT.hard_loss", "trigger_source": "BEHAVIORAL_RULE"}}]'::jsonb,
 FALSE, TRUE, 100,
 'Hard exit. Highest priority — preempts any open friction/disruption state.'),

('TAG_LPDNC_TO_HARDLOSS',
 'lp-dnc tag → DISENGAGEMENT.hard_loss',
 'STATE_CLASSIFICATION', 'pattern',
 '{"event_type": "ghl.tag_added", "event_subtype": "lp-dnc"}'::jsonb,
 NULL,
 '[{"action_type": "transition_objection_state", "target_system": "lp", "target_entity": "contact",
    "params": {"proposed_state": "DISENGAGEMENT.hard_loss", "trigger_source": "BEHAVIORAL_RULE"}}]'::jsonb,
 FALSE, TRUE, 100,
 'LP-side DNC mirror.'),

('TAG_UNSUBSCRIBED_TO_HARDLOSS',
 'unsubscribed tag → DISENGAGEMENT.hard_loss',
 'STATE_CLASSIFICATION', 'pattern',
 '{"event_type": "ghl.tag_added", "event_subtype": "unsubscribed"}'::jsonb,
 NULL,
 '[{"action_type": "transition_objection_state", "target_system": "lp", "target_entity": "contact",
    "params": {"proposed_state": "DISENGAGEMENT.hard_loss", "trigger_source": "BEHAVIORAL_RULE"}}]'::jsonb,
 FALSE, TRUE, 100,
 'Email/SMS unsubscribe.'),

('TAG_NOT_INTERESTED_TO_SOFT_OPTOUT',
 'objection:not-interested tag → DISENGAGEMENT.soft_opt_out',
 'STATE_CLASSIFICATION', 'pattern',
 '{"event_type": "ghl.tag_added", "event_subtype": "objection:not-interested"}'::jsonb,
 NULL,
 '[{"action_type": "transition_objection_state", "target_system": "lp", "target_entity": "contact",
    "params": {"proposed_state": "DISENGAGEMENT.soft_opt_out", "trigger_source": "BEHAVIORAL_RULE"}}]'::jsonb,
 FALSE, TRUE, 90,
 'Polite not-now.')

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


-- ─── Timer-driven rules (priority 50) ───────────────────────────────────────

INSERT INTO agent_rules
  (rule_key, rule_name, category, rule_type, event_pattern, context_conditions,
   action_template, requires_approval, enabled, priority, notes)
VALUES
('STALE_TO_PASSIVE_COOLING',
 'Nightly stale-state sweep → DISENGAGEMENT.passive_cooling',
 'STATE_CLASSIFICATION', 'pattern',
 '{"event_type": "nightly_state_sweep"}'::jsonb,
 NULL,
 '[{"action_type": "transition_objection_state", "target_system": "lp", "target_entity": "contact",
    "params": {"proposed_state": "DISENGAGEMENT.passive_cooling", "trigger_source": "TIMER_EXPIRY"}}]'::jsonb,
 FALSE, TRUE, 50,
 'Catch-all when a contact sits in an open state past the policy threshold. The hours_in_state check is enforced by the sweep emitter itself, not by a context verb (none of the existing verbs cover that case).')

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
-- Verification
-- ----------------------------------------------------------------------------
-- Expect 16 STATE_CLASSIFICATION rules:
--   5 LP_DISP_* + 6 LAYER3_* + 1 BEHAVIORAL_* + 4 TAG_* + 1 STALE_*
--
--   SELECT rule_key, priority, enabled FROM agent_rules
--   WHERE category = 'STATE_CLASSIFICATION'
--   ORDER BY priority DESC, rule_key;
--
-- Decision-engine consumption path:
--   src/decision-engine.js:646  matchesPattern(event, rule.event_pattern)
--   src/decision-engine.js:648  rule_type='contextual' triggers
--                               evaluateContextConditions(rule.context_conditions, ...)
--   Verbs used here (all confirmed live):
--     lp_disposition_in     (line 570)
--     has_any_tag           (line 530)
--
-- Operator notes:
--   - Pre-condition: the objection_state substrate must be applied. Run, in
--     order: sql/migrations/2026-05-14_objection_state_substrate.sql,
--     sql/seeds/2026-05-14_objection_state_policies.sql,
--     sql/seeds/2026-05-14_objection_state_transitions.sql. Without those,
--     the transition_objection_state action handler will throw at first
--     invocation (no row in objection_state_policies).
--   - The 2026-05-14_state_classification_rules.sql seed is obsolete. It
--     cannot be applied against the live schema. Do not re-run it.
-- ----------------------------------------------------------------------------
