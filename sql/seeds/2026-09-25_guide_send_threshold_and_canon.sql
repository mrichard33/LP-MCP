-- ════════════════════════════════════════════════════════════════════
-- GUIDE_SEND DISPATCH — threshold 0.65 → 0.5, and prompt_hint canon cleanup
-- 2026-09-25  (pairs with the LAYER3_LOWCONF_FALLBACK code in this PR)
--
-- WHAT: layer3_action_dispatch id 17 (guide_send):
--   1. min_confidence 0.65 → 0.5.
--   2. prompt_hint: every exclamation mark removed ("Perfect!" dropped, the
--      rest become periods), "free service forever" → "free service for life".
--      Nothing else in the hint changes.
--   3. notes: the reason for (1), appended.
--
-- WHY (1): the dispatcher's confidence is max(*_confidence) from the analyzer
--   payload, and a plain "Yeah sure" to the bot's own guide offer scores 0.6
--   (Mark Test BazzY5Ihu2heR4osVlBF, action 497148; Alyce kMpGByubOHH9hk5yTxvv
--   on 2026-09-23 17:13Z, also 0.6). guide_send is in rule 106's
--   recommended_action_nin, so under 0.65 NOBODY replied and no
--   send-hurricane-guide tag went on. Same fix as callback_request on
--   2026-07-08 (0.7 → 0.5). A false-positive guide dispatch sends one
--   confirmation plus a guide; silence loses the lead. The code fallback in
--   this PR covers anything that still lands under 0.5.
--
-- WHY (2): house canon — no exclamation points in SMS, and the warranty line
--   is "free service for life".
--
-- ORDER: apply AFTER the PR deploys. The prompt_hint says "I'm sending that
--   hurricane guide to your email now"; the send-promise guard only accepts
--   that sentence once the deployed code stamps delivery_tags on the reply.
--
-- No agent_rules change → no Decision Engine reload needed. The dispatcher
-- reads layer3_action_dispatch live on every call (no cache).
--
-- SAFETY: guarded on the pre-change values (min_confidence 0.65 and the hint
--   still containing 'Perfect!'). If either was edited since this was written,
--   the UPDATE returns 0 — re-read the row before forcing anything.
-- ════════════════════════════════════════════════════════════════════

-- Pre-check: expect 1 row, min_confidence 0.65, bangs > 0.
SELECT id, min_confidence,
       length(a->'params'->>'prompt_hint') - length(replace(a->'params'->>'prompt_hint', '!', '')) AS bangs
FROM layer3_action_dispatch d, jsonb_array_elements(d.actions) a
WHERE d.id = 17 AND a->>'action_type' = 'send_message';

-- Apply. Expect count = 1.
WITH u AS (
  UPDATE layer3_action_dispatch
  SET min_confidence = 0.5,
      actions = (
        SELECT jsonb_agg(
          CASE WHEN a->>'action_type' = 'send_message'
               THEN jsonb_set(a, '{params,prompt_hint}', to_jsonb(
                 'GUIDE / INFO REQUEST (guide type in analysis payload). FLOW: if the guide needs email delivery and no email is on file, ask ONCE: ''One more thing, what''''s your best email I can send the [guide] to?'' (refusal: ''Unfortunately, I can''''t send you anything without a valid email address.'' — then leave the door open). CONFIRMATIONS (verbatim per type): DHP/vague/skeptical (flagship default): ''Want me to send our Documented Home Protection Guide? Takes a few minutes, shows you exactly what to check in your own home. No pitch.'' Hurricane: ''I''''m sending that hurricane guide to your email now. Take a look and text back anytime if you have questions.'' Energy: ''I''''m sending our Energy Savings breakdown to your email now. It shows how Conservation Glass cuts cooling costs. Text back if you have questions.'' Security: ''Sending our Home Security Guide to your email now. It covers how impact windows protect against break-ins, not just storms. Text back anytime.'' Warranty: ''I''''m sending our Warranty Overview to your email. Short version: double lifetime, transferable, free service for life. The email has all the details.'' Financing: ''Sending our Financing Options to your email now. We have 0% APR and work with various credit situations. Text back if you have questions.'' Reviews (no email needed): ''Here''''s what homeowners are saying about us: {{custom_values.review_link}} Take a look and text back if you have any questions.'' Booking link (only when they explicitly asked for a LINK): include the booking link from BOOKING CONTEXT with ''It''''s a quick visit to measure and give you exact numbers. No pressure.'' Never send more than the one confirmation message.'::text))
               ELSE a END
          ORDER BY ord)
        FROM jsonb_array_elements(actions) WITH ORDINALITY AS t(a, ord)
      ),
      notes = notes || ' | 2026-09-25: min_confidence 0.65→0.5 — "Yeah sure" to the bot''s own guide offer scored 0.6 (Mark Test BazzY5Ihu2heR4osVlBF action 497148; Alyce kMpGByubOHH9hk5yTxvv 2026-09-23). guide_send is in rule 106''s nin, so under 0.65 nobody replied and no send-hurricane-guide tag went on. A false-positive guide dispatch sends one confirmation plus a guide; silence loses the lead. Same fix as callback_request 2026-07-08. Anything still under 0.5 falls back to the responder (LAYER3_LOWCONF_FALLBACK). Canon: exclamation marks removed from prompt_hint; "free service forever" → "free service for life".',
      updated_at = now()
  WHERE id = 17
    AND recommended_action = 'guide_send'
    AND min_confidence = 0.65
    AND actions::text LIKE '%Perfect!%'
  RETURNING 1
)
SELECT count(*) AS rows_updated FROM u;

-- Post-check: expect min_confidence 0.5, bangs 0, has_for_life true, has_forever false.
SELECT id, min_confidence,
       length(a->'params'->>'prompt_hint') - length(replace(a->'params'->>'prompt_hint', '!', '')) AS bangs,
       (a->'params'->>'prompt_hint') LIKE '%free service for life%' AS has_for_life,
       (a->'params'->>'prompt_hint') LIKE '%forever%' AS has_forever,
       jsonb_array_length(d.actions) AS sub_actions
FROM layer3_action_dispatch d, jsonb_array_elements(d.actions) a
WHERE d.id = 17 AND a->>'action_type' = 'send_message';
