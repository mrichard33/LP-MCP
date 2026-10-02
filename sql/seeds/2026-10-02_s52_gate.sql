-- 2026-10-02 — S5.2 entry gate, rule side (Mark). The code side is src/s52-entry-gate.js, which
-- checks every cancel / no-show / 1Leg / be-back / ghost-after-booking S5.2 entry no matter which
-- rule queued it. These edits stop the rules asking in the first place.
--
-- 1. Canvassing contacts never enter S5.2. The any_of block let a canvassing contact through when
--    it had a prior inbound; it is dropped, and all three canvassing markers are now hard blocks.
--    Rules: 171 GHL_APPT_CANCELLED_REBOOK_COLD, 227 ENROLL_S5_2_v2_NO_SHOW_ON_US,
--           271 LP_DISP_CANCEL_COLD_TO_S5_2, 295 ENROLL_S5_2_v2_NO_SHOW_REP_TRAVELED.
-- 2. "Issue waits until LP updates it": 240 BEHAVIORAL_GHOST_AFTER_BOOKING skips a contact whose
--    current lead is Issue (JpiqgbqDqpdfA7AAglEY 10/2, 4CHRyON3E1H4M27eBax7 10/1 got in).
-- 397 S52_EXIT_REBOOKED_OR_DEMOED is unchanged.
--
-- Uses only operators that already exist (not_has_any_tag, lp_current_lead_match). Safe to apply
-- before or after the deploy; the gate does not depend on it.

-- Expect 4.
WITH u AS (
  UPDATE agent_rules SET
    context_conditions = (context_conditions - 'any_of') || jsonb_build_object('not_has_any_tag',
      (SELECT jsonb_agg(DISTINCT t) FROM jsonb_array_elements_text(
        coalesce(context_conditions->'not_has_any_tag', '[]'::jsonb)
        || '["active-entry:canvassing","entry:canvassing","source:canvass"]'::jsonb) t)),
    version = coalesce(version,1) + 1, updated_at = now(),
    notes = coalesce(notes,'') || E'\n2026-10-02: canvassing contacts never enter S5.2 (Mark) — dropped the any_of has_prior_inbound exception; not_has_any_tag += active-entry:canvassing, entry:canvassing, source:canvass. Backstopped by src/s52-entry-gate.js.'
  WHERE id IN (171, 227, 271, 295)
    AND rule_key IN ('GHL_APPT_CANCELLED_REBOOK_COLD','ENROLL_S5_2_v2_NO_SHOW_ON_US',
                     'LP_DISP_CANCEL_COLD_TO_S5_2','ENROLL_S5_2_v2_NO_SHOW_REP_TRAVELED')
  RETURNING 1)
SELECT count(*) FROM u;

-- Expect 1.
WITH u AS (
  UPDATE agent_rules SET
    context_conditions = jsonb_set(context_conditions, '{lp_current_lead_match,disposition_not_in}',
      coalesce(context_conditions #> '{lp_current_lead_match,disposition_not_in}', '[]'::jsonb) || '["Issue"]'::jsonb),
    version = coalesce(version,1) + 1, updated_at = now(),
    notes = coalesce(notes,'') || E'\n2026-10-02: current lead Issue never enters S5.2 — "Issue waits until LP updates it" (Mark). disposition_not_in += Issue.'
  WHERE id = 240 AND rule_key = 'BEHAVIORAL_GHOST_AFTER_BOOKING'
    AND NOT (coalesce(context_conditions #> '{lp_current_lead_match,disposition_not_in}', '[]'::jsonb) ? 'Issue')
  RETURNING 1)
SELECT count(*) FROM u;

-- Then reload: POST https://lp-mcp-production.up.railway.app/n8n/decision-engine/reload-rules

-- Check:
-- SELECT id, rule_key, context_conditions FROM agent_rules WHERE id IN (171,227,240,271,295) ORDER BY id;

-- ROLLBACK (restores the pre-2026-10-02 any_of; leaves the extra not_has_any_tag entries, which
-- only block canvassing contacts):
-- UPDATE agent_rules SET context_conditions = context_conditions
--     || '{"any_of":[{"not_has_tag":"active-entry:canvassing"},{"has_prior_inbound":true}]}'::jsonb,
--   updated_at = now() WHERE id IN (171, 227, 271, 295);
-- UPDATE agent_rules SET context_conditions = jsonb_set(context_conditions,
--     '{lp_current_lead_match,disposition_not_in}',
--     (context_conditions #> '{lp_current_lead_match,disposition_not_in}') - 'Issue'),
--   updated_at = now() WHERE id = 240;
