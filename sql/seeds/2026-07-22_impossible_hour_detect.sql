-- sql/seeds/2026-07-22_impossible_hour_detect.sql
--
-- APPT_IMPOSSIBLE_HOUR_DETECT — companion tripwire to the reconciler's
-- impossible-hour guard (src/services/lp-ghl-appointment-reconciler.js).
--
-- The guard PREVENTS the LP→GHL mirror. This rule DETECTS the cases the
-- guard cannot reach: an appointment booked directly in GHL (booking
-- widget, manual UI, canvassing A.CC flow) at an impossible hour. It
-- tags + alerts; it does not and cannot block — the engine has no
-- rule-suppresses-rule mechanism (decision-engine.js v2.18) and the GHL
-- object already exists when this event fires.
--
-- Shape verified live 2026-07-22: 2,112/2,112 ghl.appointment_booked
-- events since June 1 are source='ghl_webhook' with payload.start_time
-- matching '^\d{1,2}:\d{2} (AM|PM)$' (non-padded). Padded variants are
-- included defensively. payload_field_in (engine v2.18) compares strings
-- case-insensitively; a null/absent field is a QUIET block.
--
-- EXECUTION: run against LP Supabase (dashboard SQL editor or MCP), then
--   POST .../n8n/decision-engine/reload-rules
-- and assert rules_loaded 269 → 270 (baseline verified 2026-07-22).
-- Committing this file does NOT execute it.

INSERT INTO agent_rules (
  rule_key, rule_name, category, rule_type, priority, enabled,
  requires_approval, event_pattern, conditions, context_conditions,
  action_template, created_by, notes
)
SELECT
  'APPT_IMPOSSIBLE_HOUR_DETECT',
  'Appointment booked outside business hours — detect, tag, alert',
  'appointment',
  'contextual',
  150,
  true,
  false,
  '{"event_type": "ghl.appointment_booked"}'::jsonb,
  NULL,
  '{
    "payload_field_in": {
      "field": "start_time",
      "values": [
        "12:00 AM","12:30 AM",
        "1:00 AM","1:30 AM","2:00 AM","2:30 AM","3:00 AM","3:30 AM",
        "4:00 AM","4:30 AM","5:00 AM","5:30 AM","6:00 AM","6:30 AM",
        "7:00 AM","7:30 AM",
        "01:00 AM","01:30 AM","02:00 AM","02:30 AM","03:00 AM","03:30 AM",
        "04:00 AM","04:30 AM","05:00 AM","05:30 AM","06:00 AM","06:30 AM",
        "07:00 AM","07:30 AM",
        "8:00 PM","8:30 PM","9:00 PM","9:30 PM",
        "10:00 PM","10:30 PM","11:00 PM","11:30 PM",
        "08:00 PM","08:30 PM","09:00 PM","09:30 PM"
      ]
    }
  }'::jsonb,
  '[
    {"action_type": "add_tag", "target_system": "ghl", "target_entity": "contact",
     "params": {"tag": "appt:hour-invalid"}},
    {"action_type": "send_notification", "target_system": "ghl", "target_entity": "contact",
     "priority": 20,
     "params": {"channel": "groupme", "notification_class": "priority",
       "message": "IMPOSSIBLE APPOINTMENT HOUR — a GHL appointment was booked outside business hours (08:00–20:00 ET). Verify the real time with the customer and correct LP FIRST (LP is system of record; Five9 lists repopulate at 6 AM), then fix the GHL event."}}
  ]'::jsonb,
  'claude',
  'Tripwire companion to the reconciler impossible-hour guard. Detection only — fires after the GHL object exists. String-enum match on :00/:30 slots (all 88 observed cases 2026-05→07 are on the hour); a producer emitting 24h or ISO times slips past this rule but is still caught by the reconciler guard on the LP side. Window mirrors the guard: blocked = before 8 AM or 8 PM and later.'
WHERE NOT EXISTS (
  SELECT 1 FROM agent_rules WHERE rule_key = 'APPT_IMPOSSIBLE_HOUR_DETECT'
);
