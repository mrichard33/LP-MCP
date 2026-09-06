-- =====================================================================
-- 2026-09-05 — Canvassing engagement gate on S5.2 enrollment
--
-- RUN ONLY AFTER decision-engine.js v2.20 (has_prior_inbound) IS LIVE.
-- The condition switch fails closed on an unknown operator, so landing
-- this early would silence every cancellation and no-show rescue rule.
--
-- WHAT: adds
--   any_of: [ {not_has_tag: "active-entry:canvassing"},
--             {has_prior_inbound: true} ]
-- to the four rules that enroll a contact into S5.2 Appointment Rescue.
-- Reads as: not canvassing, OR canvassing and they have messaged us.
--
-- WHY: 8 days to 2026-09-05 — canvassing SMS opt-outs 24/168 (14.3%) vs
-- 0–12% every other source. Split by engagement: 24/162 (14.8%) among
-- contacts who had never messaged us, 0/6 among those who had. Each of
-- the 15 canvassing opt-outs in the last 4 days had received exactly one
-- message from us, ever. Consent problem at the door, not cadence.
--
-- ROLLBACK is at the bottom of this file.
-- =====================================================================

-- Pre-check: confirm the four target rules and their current gates.
SELECT json_agg(row_to_json(s)) FROM (
  SELECT id, rule_key, enabled, priority,
         context_conditions ? 'any_of' AS already_has_any_of
  FROM agent_rules
  WHERE rule_key IN (
    'LP_DISP_CANCEL_COLD_TO_S5_2',
    'GHL_APPT_CANCELLED_REBOOK_COLD',
    'ENROLL_S5_2_v2_NO_SHOW_ON_US',
    'ENROLL_S5_2_v2_NO_SHOW_REP_TRAVELED'
  )
  ORDER BY rule_key
) s;

-- Apply.
WITH u AS (
  UPDATE agent_rules
  SET context_conditions = coalesce(context_conditions, '{}'::jsonb)
        || jsonb_build_object('any_of', jsonb_build_array(
             jsonb_build_object('not_has_tag', 'active-entry:canvassing'),
             jsonb_build_object('has_prior_inbound', true)
           )),
      notes = coalesce(notes, '') ||
        E'\n[2026-09-05 Claude] Added the canvassing engagement gate '
        '(any_of: not canvassing OR has_prior_inbound). Canvassing opt-outs '
        'were 14.3% vs 0-12% elsewhere; all 24 came from contacts who had '
        'never messaged us. Non-canvassing traffic is unaffected. Requires '
        'decision-engine v2.20.',
      version = version + 1
  WHERE rule_key IN (
    'LP_DISP_CANCEL_COLD_TO_S5_2',
    'GHL_APPT_CANCELLED_REBOOK_COLD',
    'ENROLL_S5_2_v2_NO_SHOW_ON_US',
    'ENROLL_S5_2_v2_NO_SHOW_REP_TRAVELED'
  )
  AND NOT (context_conditions ? 'any_of')   -- idempotent; skip if already gated
  RETURNING 1
)
SELECT count(*) AS rules_updated FROM u;   -- EXPECT 4

-- Post-check: the gate is present on all four.
SELECT json_agg(row_to_json(s)) FROM (
  SELECT rule_key, context_conditions -> 'any_of' AS gate
  FROM agent_rules
  WHERE rule_key IN (
    'LP_DISP_CANCEL_COLD_TO_S5_2',
    'GHL_APPT_CANCELLED_REBOOK_COLD',
    'ENROLL_S5_2_v2_NO_SHOW_ON_US',
    'ENROLL_S5_2_v2_NO_SHOW_REP_TRAVELED'
  )
  ORDER BY rule_key
) s;

-- Then reload the Decision Engine and assert the count is unchanged at 279:
--   POST https://lp-mcp-production.up.railway.app/n8n/decision-engine/reload-rules

-- =====================================================================
-- ROLLBACK
-- =====================================================================
-- WITH u AS (
--   UPDATE agent_rules
--   SET context_conditions = context_conditions - 'any_of',
--       version = version + 1
--   WHERE rule_key IN (
--     'LP_DISP_CANCEL_COLD_TO_S5_2',
--     'GHL_APPT_CANCELLED_REBOOK_COLD',
--     'ENROLL_S5_2_v2_NO_SHOW_ON_US',
--     'ENROLL_S5_2_v2_NO_SHOW_REP_TRAVELED'
--   )
--   RETURNING 1
-- )
-- SELECT count(*) FROM u;   -- then reload the engine
