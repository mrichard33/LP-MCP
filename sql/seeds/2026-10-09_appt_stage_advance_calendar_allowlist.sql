-- 2026-10-09 — GHL_APPT_STAGE_ADVANCE: calendar allowlist (Mark ruling)
--
-- WHY: phone-call calendars were advancing leads as if the in-home appointment
-- were booked. A Confirmation Call booking (calendar gFWoSQrlKIdfRbAPV842) sends
-- ghl.appointment_booked through the A.CC handler's Layer 3 webhook, and this
-- rule then set stage:booked-main-appointment, moved P1 to Appointment Booked,
-- exited F.0 and stripped pause-workflow. 11 conf-call booked events since April;
-- 2 fired this rule (vPmcYX0HkFAo7FynbKRD 2026-08-11, Bxh2nFy2yO3nfbH5yKkc 2026-04-10).
-- The upcoming Rehash Call calendar (cloned from the conf-call handler) would hit
-- the same path and also wipe the pause-workflow tag it sets.
--
-- WHAT: allowlist by payload.calendar_id (the field the webhook handler writes;
-- calendarId in the GHL body is normalized to calendar_id):
--   aJj14ONxh1oFyDcQ706O  Window Estimate (3,543 booked events / 60d)
--   zEdPmkNccR2ovo3rQAd3  Measurement Verification (9 / 60d)
-- Allowlist, not denylist: the engine has no payload_field_not_in verb, and any
-- future phone-call calendar is excluded without another rule edit.
-- payload_field_in blocks when calendar_id is absent; all 3,557 booked events in
-- the last 60 days carried it.
--
-- APPLIED LIVE 2026-10-09 18:04 UTC, version 4 -> 5, reload rules_loaded 308 -> 308.

UPDATE agent_rules SET
  context_conditions = context_conditions || '{"payload_field_in": {"field": "calendar_id", "values": ["aJj14ONxh1oFyDcQ706O", "zEdPmkNccR2ovo3rQAd3"]}}'::jsonb,
  version = version + 1,
  updated_at = now()
WHERE rule_key = 'GHL_APPT_STAGE_ADVANCE'
  AND NOT (context_conditions ? 'payload_field_in');

-- Then: POST /n8n/decision-engine/reload-rules and assert rules_loaded is unchanged.

-- ROLLBACK:
-- UPDATE agent_rules SET context_conditions = context_conditions - 'payload_field_in',
--   version = version + 1, updated_at = now()
-- WHERE rule_key = 'GHL_APPT_STAGE_ADVANCE';
-- POST /n8n/decision-engine/reload-rules
