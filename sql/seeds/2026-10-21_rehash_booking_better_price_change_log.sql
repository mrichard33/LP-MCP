-- 2026-10-21: bot_change_log rows for the rehash booking + better-price handoff.
-- Two rehash-only changes (framework nepq_rehash), each behind its own switch.
-- bot_change_log is append-only (trg_bot_change_log_immutable). Run once; the
-- NOT EXISTS guard makes a second run insert nothing.
WITH rows(action, reason, after) AS (
  VALUES
    ('rehash_booking_fix',
     'Rehash call booking (2026-10-20 threads): a named call time ("9:30", "930am", "Thursday at 2pm") is booked on the rep''s Rehash Call calendar or answered with the two closest real times; the open pair is offered again; the confirm asks nothing; a buying signal gets the call; a firm decline is a first no.',
     jsonb_build_object('framework', 'nepq_rehash', 'flag', 'REHASH_BOOKING_FIX_ENABLED', 'date', '2026-10-21', 'undo', 'REHASH_BOOKING_FIX_ENABLED=false', 'generator_version', 'v2.14.0')),
    ('rehash_better_price_framing',
     'Rehash call reason: every call invitation says we may be able to get them a better price, in "if I could, would you?" form (price, other quotes, thinking it over, itemized estimate). No amount, percentage, discount or promise.',
     jsonb_build_object('framework', 'nepq_rehash', 'flag', 'REHASH_BETTER_PRICE_FRAMING_ENABLED', 'date', '2026-10-21', 'undo', 'REHASH_BETTER_PRICE_FRAMING_ENABLED=false', 'generator_version', 'v2.15.0'))
), ins AS (
  INSERT INTO bot_change_log (actor, action, target_table, target_id, reason, before, after)
  SELECT 'system:claude_code_handoff', r.action, 'code', 'nepq_rehash', r.reason, NULL, r.after
  FROM rows r
  WHERE NOT EXISTS (SELECT 1 FROM bot_change_log b WHERE b.action = r.action AND b.after->>'date' = '2026-10-21')
  RETURNING 1
)
SELECT count(*) AS inserted FROM ins;
