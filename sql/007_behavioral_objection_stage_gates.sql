-- =============================================================================
-- BEHAVIORAL OBJECTION RULES — STAGE GATE (Ed Keller finding)
-- Run in: LP MCP Supabase → SQL Editor
-- Date: 2026-04-08
-- =============================================================================
--
-- Context:
--   Ed Keller raised that W9.0 objection handling is a post-demo playbook —
--   a pre-appointment "my spouse said no" is NOT the same signal as a post-
--   demo spouse objection. Firing W9.0 objection rules on pre-appointment
--   contacts routes them down the wrong treatment path; those cases should
--   instead go to W5.2 Appointment Rescue.
--
--   This migration adds a stage gate to the 6 BEHAVIORAL_*_OBJECTION rules
--   requiring that the contact has a post-demo LP disposition:
--     FDNS    — Follow-up Demo No Sale
--     BO      — Be-Back Out (demo done, no sale, no follow-up)
--     1Leg    — One Leg (single-decision-maker demo)
--     NIS     — Not In Service (post-demo NIS)
--     OPPFDN  — Opportunity Follow-Down (long-term post-demo nurture)
--
--   Rules with rule_type='contextual' evaluate the `conditions` jsonb against
--   lead_intelligence + event payload before firing. The new operator
--   `lp_disposition_in` (added in decision-engine.js v2.5) queries lp_leads
--   for the most recent disposition_code and gates the rule on allowlist
--   membership.
--
-- Open decision (deferred):
--   The original ask mentioned "post-demo LP disposition OR P1 Stage 7+".
--   The condition evaluator is AND-only today; expressing the OR would need
--   a second operator (pipeline_stage_gte) and multi-condition OR support.
--   Practical resolution: gate on LP disposition alone — post-demo contacts
--   reliably get one of the 5 dispositions above, so the false-negative rate
--   is acceptable. Revisit if reports surface of valid post-demo objections
--   being blocked.
--
-- Verification:
--   1. After running, query agent_rules where rule_key LIKE 'BEHAVIORAL_%_OBJECTION'
--      and confirm each has lp_disposition_in in conditions and rule_type='contextual'.
--   2. Trigger a BEHAVIORAL_SPOUSE_OBJECTION event against a contact with no
--      LP disposition (or a pre-demo one like Hot/WRM/NCR) and confirm the
--      decision-engine logs: [Context] BLOCKED: lp_disposition "..." not in [...]
--   3. Trigger against a contact with disposition_code='FDNS' and confirm the
--      rule fires normally.
-- =============================================================================

UPDATE agent_rules
SET conditions = COALESCE(conditions, '{}'::jsonb) || '{"lp_disposition_in": ["FDNS", "BO", "1Leg", "NIS", "OPPFDN"]}'::jsonb,
    rule_type  = 'contextual',
    updated_at = now()
WHERE rule_key = 'BEHAVIORAL_SPOUSE_OBJECTION';

UPDATE agent_rules
SET conditions = COALESCE(conditions, '{}'::jsonb) || '{"lp_disposition_in": ["FDNS", "BO", "1Leg", "NIS", "OPPFDN"]}'::jsonb,
    rule_type  = 'contextual',
    updated_at = now()
WHERE rule_key = 'BEHAVIORAL_PRICE_OBJECTION';

UPDATE agent_rules
SET conditions = COALESCE(conditions, '{}'::jsonb) || '{"lp_disposition_in": ["FDNS", "BO", "1Leg", "NIS", "OPPFDN"]}'::jsonb,
    rule_type  = 'contextual',
    updated_at = now()
WHERE rule_key = 'BEHAVIORAL_TIMING_OBJECTION';

UPDATE agent_rules
SET conditions = COALESCE(conditions, '{}'::jsonb) || '{"lp_disposition_in": ["FDNS", "BO", "1Leg", "NIS", "OPPFDN"]}'::jsonb,
    rule_type  = 'contextual',
    updated_at = now()
WHERE rule_key = 'BEHAVIORAL_TRUST_OBJECTION';

UPDATE agent_rules
SET conditions = COALESCE(conditions, '{}'::jsonb) || '{"lp_disposition_in": ["FDNS", "BO", "1Leg", "NIS", "OPPFDN"]}'::jsonb,
    rule_type  = 'contextual',
    updated_at = now()
WHERE rule_key = 'BEHAVIORAL_COMPETITOR_OBJECTION';

UPDATE agent_rules
SET conditions = COALESCE(conditions, '{}'::jsonb) || '{"lp_disposition_in": ["FDNS", "BO", "1Leg", "NIS", "OPPFDN"]}'::jsonb,
    rule_type  = 'contextual',
    updated_at = now()
WHERE rule_key = 'BEHAVIORAL_DIY_OBJECTION';
