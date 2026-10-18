-- 2026-10-18 — An appointment our own LP→GHL sync created is not a booking GHL drove (Joseph Servis).
--
-- Rule 87 GHL_ATTR_APPT_BOOKED_VIA_GHL fires on every A.WE `appt:booked` handoff and tags ghl-attributed. In the 30 days to
-- 2026-10-18, 2,289 of its 2,302 handoffs were appointments the reconciler or the delegated booking endpoint created
-- (LP / call-center bookings). New verb `not_sync_created_appointment` (src/decision-engine.js) suppresses the rule when the
-- handoff's calendar.appointmentId has an appt.booking `created` event from our sync. The tags it already wrote are cleaned
-- by the MCP tool ghl_attribution_cleanup_run (the user, 2026-10-18).
--
-- APPLY AFTER THE DEPLOY that carries the verb, then POST /n8n/decision-engine/reload-rules.

-- Expect 1.
UPDATE agent_rules SET
  context_conditions = coalesce(context_conditions, '{}'::jsonb) || '{"not_sync_created_appointment": true}'::jsonb,
  version = coalesce(version,1) + 1, updated_at = now(),
  notes = coalesce(notes,'') || E'\n2026-10-18: + not_sync_created_appointment. A booking our LP→GHL sync created is an LP booking, not GHL attribution (Joseph Servis).'
WHERE rule_key = 'GHL_ATTR_APPT_BOOKED_VIA_GHL'
  AND NOT (coalesce(context_conditions, '{}'::jsonb) ? 'not_sync_created_appointment');

-- Read back:
-- SELECT id, context_conditions ? 'not_sync_created_appointment' FROM agent_rules WHERE rule_key = 'GHL_ATTR_APPT_BOOKED_VIA_GHL';
-- Rollback:
-- UPDATE agent_rules SET context_conditions = context_conditions - 'not_sync_created_appointment', updated_at = now()
--   WHERE rule_key = 'GHL_ATTR_APPT_BOOKED_VIA_GHL';
