-- ════════════════════════════════════════════════════════════════════
-- LAYER3 CHANNEL DEFAULT REMOVAL — the key asserted something false
-- 2026-08-13  (agentic email channel fidelity; pairs with the
--              executeLayer3Dispatch / channelExplicit fixes in this PR)
--
-- WHAT: drops the hardcoded "channel": "sms" from the send_message params of
--   the six layer3_action_dispatch rows that carry one: busy_callback,
--   callback_request, follow_up_scheduled, frustrated_fast_track, guide_send,
--   wrong_person. These are the ONLY dispatch rows with a send_message
--   sub-action, and they are exactly the classifications rule 106
--   (AGENTIC_RESPOND_POST_CHATBOT) stands down from via
--   context_conditions.recommended_action_nin — so Layer 3 owns their replies
--   outright.
--
-- WHY: the key was never a channel DECISION. It was a template default from
--   when every agentic reply was an SMS, and the fan-out path had no way to
--   correct it. executeLayer3Dispatch copied dispatch params verbatim into
--   action_payload and never resolved the channel from the triggering event —
--   unlike decision-engine.createActionsFromRule, which has called
--   inferChannelFromEvent on the rule-template path since 2026-07-03. So every
--   email inbound Layer 3 owned was answered by SMS: all 4 follow_up_scheduled
--   email replies in the 90 days to 2026-08-13, most recently Andrea on
--   2026-08-12 — she emailed "Hi. I will decide before Monday. Thank you." and
--   the bot texted back. The other five rows had simply not fired on email yet.
--
--   The damage was not only delivery. send-message-handler gates the EMAIL
--   THREAD CONTEXT block and the email generation constraints on
--   channel === 'email', so these replies were WRITTEN for SMS too: no
--   subject, no opener bridge, no signature.
--
-- ORDER OF OPERATIONS — this is a NO-OP on its own. Apply it only AFTER the
--   code in this PR is deployed. executeSendMessage defaults an absent
--   payload.channel to 'sms' before resolveReplyContext is ever called, so
--   removing the key without the handler fix leaves requestedChannel = 'sms'
--   and the same origin_email_requested_other branch fires. Two changes make
--   this seed meaningful:
--     1. executeLayer3Dispatch now stamps the event channel at fan-out
--        (src/actions/index.js) — this alone fixes all six rows.
--     2. executeSendMessage passes requestedChannel: null when the payload
--        never specified one (src/send-message-handler.js), so an unset
--        channel stops masquerading as a request for SMS.
--   With (1) in place the stamped value overwrites whatever the row says, so
--   this seed is belt-and-braces: it removes a false assertion from config so
--   the row stops claiming a channel decision it was never entitled to make.
--
-- SAFETY: jsonb_agg rebuilds the actions array in order; non-send_message
--   sub-actions (add_tag, issue_hold, create_task, add_note,
--   send_notification) pass through byte-identical. Rows whose send_message
--   params carry no channel key are unaffected — `-` on a missing key is a
--   no-op, not an error.
-- ════════════════════════════════════════════════════════════════════
BEGIN;

UPDATE layer3_action_dispatch
SET actions = (
      SELECT jsonb_agg(
        CASE WHEN a->>'action_type' = 'send_message'
             THEN jsonb_set(a, '{params}', (a->'params') - 'channel')
             ELSE a END
        ORDER BY ord)
      FROM jsonb_array_elements(actions) WITH ORDINALITY AS t(a, ord)
    ),
    updated_at = now()
WHERE recommended_action IN (
  'busy_callback','callback_request','follow_up_scheduled',
  'frustrated_fast_track','guide_send','wrong_person'
);

COMMIT;

-- ── Verify ──────────────────────────────────────────────────────────
-- Expect 6 rows, every payload_channel NULL, and sub-action counts unchanged
-- (2, 3, 3, 5, 2, 4 respectively).
--
-- SELECT recommended_action,
--        jsonb_array_length(actions) AS sub_actions,
--        (SELECT a->'params'->>'channel'
--           FROM jsonb_array_elements(actions) a
--          WHERE a->>'action_type' = 'send_message'
--          LIMIT 1) AS payload_channel
-- FROM layer3_action_dispatch
-- WHERE recommended_action IN (
--   'busy_callback','callback_request','follow_up_scheduled',
--   'frustrated_fast_track','guide_send','wrong_person')
-- ORDER BY recommended_action;

-- ── Rollback ────────────────────────────────────────────────────────
-- Restores "channel": "sms" on the send_message sub-action of all six rows.
-- Only needed if the code fixes are reverted and Layer 3 goes back to
-- copying params verbatim.
--
-- BEGIN;
-- UPDATE layer3_action_dispatch
-- SET actions = (
--       SELECT jsonb_agg(
--         CASE WHEN a->>'action_type' = 'send_message'
--              THEN jsonb_set(a, '{params,channel}', '"sms"'::jsonb)
--              ELSE a END
--         ORDER BY ord)
--       FROM jsonb_array_elements(actions) WITH ORDINALITY AS t(a, ord)
--     ),
--     updated_at = now()
-- WHERE recommended_action IN (
--   'busy_callback','callback_request','follow_up_scheduled',
--   'frustrated_fast_track','guide_send','wrong_person'
-- );
-- COMMIT;
