-- 2026-10-18 — A GHL cancel of an appointment left over after the demo is not a customer cancel.
--
-- Roberta Ritchie (GHL 0Hwk6Mw05TSkKfQDhssm). Our LP→GHL sync created her estimate at 10/17 10 AM;
-- LP moved the visit to 10/16 2 PM and she had her demo (lead 583833 OPPFDN). At 2026-10-16 23:22Z
-- a person cancelled the leftover 10/17 appointment in GHL. Rule 107 GHL_APPT_CANCELLED_REBOOK then
-- moved P1 to Reactivation, removed her from F.0, tagged appt-cancelled / rebook-reason:cancelled,
-- opened APPOINTMENT_DISRUPTION.cancelled and created a rebook task (undone by hand 2026-10-18,
-- batch roberta_repair_20261018). Rule 171 (the COLD twin) has the same trigger.
--
-- New verb `not_stale_post_demo_cancel` (src/decision-engine.js, pure logic in
-- src/appointments/stale-post-demo-cancel.js): suppress when the newest LP lead is post-demo with its
-- visit in the last 30 days and before the cancelled start, and no live lead holds that slot.
--
-- APPLY AFTER THE DEPLOY that carries the verb (an unknown verb fails closed and would stop both
-- rules firing at all). Then POST /n8n/decision-engine/reload-rules.

-- Expect 2.
WITH u AS (
  UPDATE agent_rules SET
    context_conditions = coalesce(context_conditions, '{}'::jsonb) || '{"not_stale_post_demo_cancel": true}'::jsonb,
    version = coalesce(version,1) + 1, updated_at = now(),
    notes = coalesce(notes,'') || E'\n2026-10-18: + not_stale_post_demo_cancel. A cancel of a leftover appointment after the demo is not a customer cancel (Roberta Ritchie, 2026-10-16).'
  WHERE rule_key IN ('GHL_APPT_CANCELLED_REBOOK', 'GHL_APPT_CANCELLED_REBOOK_COLD')
    AND NOT (coalesce(context_conditions, '{}'::jsonb) ? 'not_stale_post_demo_cancel')
  RETURNING 1)
SELECT count(*) FROM u;

-- Rollback:
-- UPDATE agent_rules SET context_conditions = context_conditions - 'not_stale_post_demo_cancel', updated_at = now()
--   WHERE rule_key IN ('GHL_APPT_CANCELLED_REBOOK', 'GHL_APPT_CANCELLED_REBOOK_COLD');
