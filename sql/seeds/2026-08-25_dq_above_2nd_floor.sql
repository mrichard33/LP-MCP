-- =====================================================================
-- 2026-08-25 — DQ: BUILDING ABOVE 2ND FLOOR
-- =====================================================================
-- Applied live 2026-08-25 15:15Z via LP MCP supabase_run_query.
-- Reload asserted: POST /n8n/decision-engine/reload-rules -> rules_loaded 278
-- (enabled count 278, was 276). This file is the durable record and the
-- rollback vehicle; it did not gate the live change.
--
-- OWNER RULE (Mark, 2026-08-25):
--   Reece installs ONLY where the TOTAL BUILDING is two floors or less.
--   This is about the BUILDING, not the unit. A ground-floor condo in a
--   seven-story tower is a DQ.
--
-- TWO ROWS, ON PURPOSE:
--   119  DQ_ABOVE_2ND_FLOOR_INTERIM   fires off raw message text (regex).
--                                     Live TODAY. No code dependency.
--   120  DQ_ABOVE_2ND_FLOOR_DETECTED  fires off payload.dq_detected.
--                                     INERT until the message-analyzer
--                                     patch in this same PR deploys.
--
-- Both carry not_has_any_tag [dq-above-2nd-floor, hard-disqualified], so
-- whichever fires first blocks the other. Once the analyzer patch is live,
-- DISABLE the interim row (see ROLLBACK / CUTOVER at the bottom).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Row 1 — INTERIM (message-text regex). Priority 119.
-- ---------------------------------------------------------------------
-- Regex verified against 15 positive and 20 negative cases before install,
-- including every real message in the Linda Hunter thread.
--   MATCHES:     "We are on the 7th floor", "we're on the 3rd floor",
--                "floor 12", "seventh floor", "high rise", "high-rise",
--                "highrise", "mid-rise", "15-story building", "8 stories",
--                "three story building", "penthouse"
--   DOES NOT:    "1st floor", "2nd floor", "ground floor", "first floor",
--                "second floor", "two story house", "one story home",
--                "single story ranch", "I have 3 windows on the floor",
--                "2 32 in, 1 52 in, 2 36 in" (her window specs),
--                "14671 Bonaire Blvd. #703", "10 am this Thursday"
--
-- The negatives matter as much as the positives: a false DQ refuses a
-- qualified homeowner and there is no re-engagement path out of a HARD tier.

INSERT INTO agent_rules (
  rule_key, rule_name, category, rule_type, enabled, priority,
  event_pattern, conditions, context_conditions, action_template,
  requires_approval, created_by, notes
) VALUES (
  'DQ_ABOVE_2ND_FLOOR_INTERIM',
  'DQ — Building Above 2nd Floor (Interim, message-text regex)',
  'disqualification',
  'contextual',
  true,
  119,
  '{"event_type":"ai.analysis_completed"}'::jsonb,
  NULL,
  '{"not_has_tag":"stop-bot","not_has_any_tag":["dq-above-2nd-floor","hard-disqualified"],"payload_message_matches":"\\b(?:[3-9]|[1-9]\\d)(?:st|nd|rd|th)?\\s*-?\\s*floor\\b|\\bfloor\\s*#?\\s*(?:[3-9]|[1-9]\\d)\\b|\\b(?:third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth)\\s+floor\\b|\\b(?:[3-9]|[1-9]\\d)\\s*-?\\s*stor(?:y|ey|ies)\\b|\\b(?:three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)\\s*-?\\s*stor(?:y|ey|ies)\\b|\\bhigh[-\\s]?rise\\b|\\bhighrise\\b|\\bmid[-\\s]?rise\\b|\\bpenthouse\\b"}'::jsonb,
  '[
   {"action_type":"send_message","target_entity":"contact","target_system":"ghl","priority":10,"params":{"channel":"sms","message":"Thanks for that detail — it saves us both time. We install impact windows up to two stories, so a building taller than that is outside what we can do. For a high-rise, your association usually keeps a list of approved installers — that is the fastest place to start. Sorry we are not the right fit."}},
   {"action_type":"add_tag","target_entity":"contact","target_system":"ghl","params":{"tag":"loss-reason:bad-fit"}},
   {"action_type":"update_custom_fields","target_entity":"contact","target_system":"ghl","params":{"fields":[{"id":"I9CbRV0dKMfwaSlge9uU","value":"Bad Fit (Preference)"}]}},
   {"action_type":"add_tag","target_entity":"contact","target_system":"ghl","params":{"tag":"dq-above-2nd-floor"}},
   {"action_type":"add_tag","target_entity":"contact","target_system":"ghl","params":{"tag":"hard-disqualified"}},
   {"action_type":"send_notification","params":{"notification_class":"system","action_verb":"DISQUALIFIED","status":"Disqualified","tier":"Cold","message":"BUILDING HEIGHT DQ (interim regex) — lead mentioned a building above 2 floors; exit script sent, hard-disqualified. CHECK FOR AN EXISTING APPOINTMENT AND CANCEL IT MANUALLY — this interim rule does not cancel.","narrative":"Interim building-height DQ fired off message text (analyzer enum patch not yet deployed). Verify no rep is dispatched."}}
  ]'::jsonb,
  false,
  'claude',
  'See sql/seeds/2026-08-25_dq_above_2nd_floor.sql. Interim message-text gate; disable once DQ_ABOVE_2ND_FLOOR_DETECTED is live.'
)
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category,
  enabled = EXCLUDED.enabled, priority = EXCLUDED.priority,
  event_pattern = EXCLUDED.event_pattern, conditions = EXCLUDED.conditions,
  context_conditions = EXCLUDED.context_conditions,
  action_template = EXCLUDED.action_template,
  requires_approval = EXCLUDED.requires_approval, updated_at = now();


-- ---------------------------------------------------------------------
-- Row 2 — PERMANENT (analyzer dq_detected). Priority 120.
-- ---------------------------------------------------------------------
-- HARD tier: a building does not get shorter. No cooldown, no
-- re-engagement — same tier as DQ_MOBILE_HOME_DETECTED and
-- DQ_LANAI_ONLY_DETECTED, NOT the 90-day soft tier used for renters.
--
-- THIS ROW CARRIES cancel_appointment, WHICH THE EXISTING DQ FAMILY DOES
-- NOT. Linda was already booked when the disqualifier arrived. Run through
-- DQ_MOBILE_HOME_DETECTED or DQ_LANAI_ONLY_DETECTED as they stand today,
-- she would have been exit-scripted and hard-disqualified with a rep still
-- scheduled to drive to a 7th-floor condo on Thursday. A DQ that can arrive
-- after a booking must be able to undo the booking.
--
-- DEPENDENCY: executeCancelAppointment (src/actions/handlers/appointments.js)
-- currently THROWS when the contact has no active appointment — the common
-- DQ case. The patch in this PR makes that a no-op success. Without it,
-- every DQ without a booking leaves a failed action row.

INSERT INTO agent_rules (
  rule_key, rule_name, category, rule_type, enabled, priority,
  event_pattern, conditions, context_conditions, action_template,
  requires_approval, created_by, notes
) VALUES (
  'DQ_ABOVE_2ND_FLOOR_DETECTED',
  'DQ — Building Above 2nd Floor Detected',
  'disqualification',
  'contextual',
  true,
  120,
  '{"event_type":"ai.analysis_completed"}'::jsonb,
  NULL,
  '{"not_has_tag":"stop-bot","not_has_any_tag":["dq-above-2nd-floor","hard-disqualified"],"payload_field_eq":{"field":"dq_detected","value":"above-2nd-floor"}}'::jsonb,
  '[
   {"action_type":"send_message","target_entity":"contact","target_system":"ghl","priority":10,"params":{"channel":"sms","message":"Thanks for that detail — it saves us both time. We install impact windows up to two stories, so a building taller than that is outside what we can do. For a high-rise, your association usually keeps a list of approved installers — that is the fastest place to start. Sorry we are not the right fit."}},
   {"action_type":"cancel_appointment","target_entity":"contact","target_system":"ghl","priority":10,"params":{"status":"cancelled","reason":"Hard DQ — above-2nd-floor. Reece installs only where the total building height is two floors or less."}},
   {"action_type":"add_tag","target_entity":"contact","target_system":"ghl","params":{"tag":"loss-reason:bad-fit"}},
   {"action_type":"update_custom_fields","target_entity":"contact","target_system":"ghl","params":{"fields":[{"id":"I9CbRV0dKMfwaSlge9uU","value":"Bad Fit (Preference)"}]}},
   {"action_type":"add_tag","target_entity":"contact","target_system":"ghl","params":{"tag":"dq-above-2nd-floor"}},
   {"action_type":"add_tag","target_entity":"contact","target_system":"ghl","params":{"tag":"hard-disqualified"}},
   {"action_type":"send_notification","params":{"notification_class":"system","action_verb":"DISQUALIFIED","status":"Disqualified","tier":"Cold","message":"BUILDING HEIGHT DQ — building above 2 floors. Exit script sent, any appointment cancelled, hard-disqualified.","narrative":"Analyzer set dq_detected=above-2nd-floor. Reece installs only where the total building is two floors or less."}}
  ]'::jsonb,
  false,
  'claude',
  'See sql/seeds/2026-08-25_dq_above_2nd_floor.sql. Permanent building-height gate. Inert until the message-analyzer above-2nd-floor patch deploys.'
)
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category,
  enabled = EXCLUDED.enabled, priority = EXCLUDED.priority,
  event_pattern = EXCLUDED.event_pattern, conditions = EXCLUDED.conditions,
  context_conditions = EXCLUDED.context_conditions,
  action_template = EXCLUDED.action_template,
  requires_approval = EXCLUDED.requires_approval, updated_at = now();


-- =====================================================================
-- CUTOVER — run AFTER the message-analyzer patch is deployed and a
-- DQ_ABOVE_2ND_FLOOR_DETECTED firing has been observed in agent_actions.
-- =====================================================================
-- Verify the permanent rule has actually fired before disabling the
-- interim one. Never disable on "should be working" (the rule 233 lesson).
--
--   SELECT count(*) FROM agent_actions
--   WHERE rule_applied = 'DQ_ABOVE_2ND_FLOOR_DETECTED';
--
-- Only when that is > 0:
--
--   WITH u AS (
--     UPDATE agent_rules SET enabled = false, updated_at = now()
--     WHERE rule_key = 'DQ_ABOVE_2ND_FLOOR_INTERIM' RETURNING 1
--   ) SELECT count(*) FROM u;   -- expect 1
--
-- Then reload and assert the count dropped by exactly one:
--   POST /n8n/decision-engine/reload-rules
--
-- =====================================================================
-- ROLLBACK — disable both rows and reload.
-- =====================================================================
--   WITH u AS (
--     UPDATE agent_rules SET enabled = false, updated_at = now()
--     WHERE rule_key IN ('DQ_ABOVE_2ND_FLOOR_INTERIM',
--                        'DQ_ABOVE_2ND_FLOOR_DETECTED') RETURNING 1
--   ) SELECT count(*) FROM u;   -- expect 2
--
-- Rolling back returns the system to the state that told Linda Hunter
-- "Seven floors is no problem at all." Do it only with a replacement in
-- hand.
