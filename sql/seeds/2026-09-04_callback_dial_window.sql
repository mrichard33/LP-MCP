-- ════════════════════════════════════════════════════════════════════
-- CALLBACK_REQUEST — promise a call only when the dialer is open
-- 2026-09-04  (pairs with src/dial-window.js and the PHONE ROOM prompt
--              block added in this PR)
--
-- WHAT: rewrites actions[0].params.prompt_hint on the layer3_action_dispatch
--   row for recommended_action = 'callback_request'. No other row, no other
--   key, no schema change. The add_tag and add_note sub-actions are untouched.
--
-- WHY: the hint said "If they want it NOW and it is business hours" — and
--   nothing in the pipeline ever computed business hours. The model inferred
--   them, and the repo gave it six different answers to infer from:
--     src/agentic-callback-message.js          08:00-17:00 Mon-Fri
--     src/five9-silence-watchdog.js            09:00-18:00 Mon-Sat
--     src/services/quiet-hours.js              08:00-21:00 daily
--     src/reschedule-options.js                per-weekday appointment grid
--     src/services/lp-ghl-appointment-reconciler.js  08:00-20:00
--     sql/013_kb_seed_structured.sql:223       "Mon-Fri 9am-8pm, Sat 9am-5pm"
--   That last one is retrieved straight into the model's context, so the bot
--   could be told the office closes at 8 PM while the dialer actually runs to
--   9 PM — or refuse an immediate call at 8:15 AM when Five9 had been dialing
--   for fifteen minutes.
--
--   Robert Pederson (GHL zLDD7V1eosF8vldF5U7i, 2026-09-04) is the failure:
--   promised a call "within the next few minutes", waiting at home, no call.
--
--   Second change, per Mark: outside dial hours the old hint offered a
--   calendar slot ("Would tomorrow morning or afternoon work better?"). It now
--   promises first thing in the morning and offers no slot. A calendar offer
--   is a second ask at the exact moment we have already failed to deliver the
--   first one.
--
-- ORDER OF OPERATIONS — apply this only AFTER the code in this PR is live.
--   The new hint refers to a "PHONE ROOM" block that does not exist in the
--   prompt until src/response-generator.js ships the dialWindowHardRule line.
--   Applied early, the model is told to read a fact it cannot see, which is
--   worse than the guessing it replaces.
--
-- EXECUTION: run against LP Supabase (dashboard SQL editor or MCP).
--   Committing this file does NOT execute it. No rule reload is needed —
--   layer3_action_dispatch is read per dispatch (src/services/layer3-dispatch.js:154),
--   not cached at boot.
-- ════════════════════════════════════════════════════════════════════

UPDATE layer3_action_dispatch
SET actions = jsonb_set(
      actions,
      '{0,params,prompt_hint}',
      to_jsonb($hint$CALM CALLBACK REQUEST (they asked for a phone call, not upset). Read the PHONE ROOM line above before promising any timing — it is the only source for whether a call can actually go out, and it is computed from the live Five9 dial schedule. Never infer our hours from anything else in this prompt. Base: 'Happy to get a call set up. When works best?' If they want it NOW and PHONE ROOM is OPEN: 'I can have someone ring you in the next few minutes - is this still the best number?' (an immediate callback is flagged for the team - do NOT book a calendar slot for it: 'You're flagged for an immediate callback. Someone will ring you shortly.'). If they named a time window that falls while PHONE ROOM is open, echo THEIR words back exactly ('Calling in about 30 minutes then - is this still the best number?') and do NOT refine with more questions. If PHONE ROOM is CLOSED, never offer an immediate call and do NOT offer a calendar slot - promise the morning: 'We're done for the day here, so I've got you down for first thing in the morning - is this still the best number?' Same answer if the window they named lands after we close. Only if they ask to pick a specific day themselves: offer exactly two Confirmation Call slots from CALENDAR AVAILABILITY, one morning and one afternoon. The call is 1-2 minutes; never oversell it.$hint$::text)
    )
WHERE recommended_action = 'callback_request';

-- Verification — expect 1 row, active = true, and the hint containing
-- 'PHONE ROOM' and 'first thing in the morning', and no longer containing
-- 'business hours' or 'Keep your phone handy'.
SELECT
  recommended_action,
  active,
  (actions #>> '{0,params,prompt_hint}') LIKE '%PHONE ROOM%'              AS mentions_phone_room,
  (actions #>> '{0,params,prompt_hint}') LIKE '%first thing in the morning%' AS promises_morning,
  (actions #>> '{0,params,prompt_hint}') LIKE '%business hours%'          AS still_says_business_hours,
  (actions #>> '{0,params,prompt_hint}') LIKE '%Keep your phone handy%'   AS still_says_phone_handy,
  jsonb_array_length(actions)                                            AS action_count
FROM layer3_action_dispatch
WHERE recommended_action = 'callback_request';
-- Expected: 1 | true | true | true | false | false | 3


-- ── ROLLBACK ────────────────────────────────────────────────────────
-- Restores the hint exactly as it stood on 2026-09-04 before this ran.
-- Safe to apply on its own; it does not depend on the code being rolled back
-- first, because the old hint never referenced the PHONE ROOM block. If the
-- code IS still live, the model simply goes back to inferring hours — the
-- pre-existing defect, not a new one.
--
-- UPDATE layer3_action_dispatch
-- SET actions = jsonb_set(
--       actions,
--       '{0,params,prompt_hint}',
--       to_jsonb($old$CALM CALLBACK REQUEST (they asked for a phone call, not upset). Base: 'Happy to get a call set up. When works best?' If they want it NOW and it is business hours: 'I can have someone ring you in the next few minutes - is this still the best number?' (an immediate callback is flagged for the team - do NOT book a calendar slot for it: 'Perfect, I'm flagging you for an immediate callback. Someone will ring you within the next few minutes. Keep your phone handy!'). If they named a time window, echo THEIR words back exactly ('Calling in about 30 minutes then - is this still the best number?') and do NOT refine with more questions. If scheduling: offer exactly two Confirmation Call slots from CALENDAR AVAILABILITY, one morning and one afternoon. Outside business hours never offer an immediate call: 'Our team is done for today, but I'd love to get you scheduled. Would tomorrow morning or afternoon work better?' The call is 1-2 minutes; never oversell it.$old$::text)
--     )
-- WHERE recommended_action = 'callback_request';
