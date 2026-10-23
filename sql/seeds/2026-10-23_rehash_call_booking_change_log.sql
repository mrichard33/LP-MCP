-- 2026-10-23: bot_change_log rows for the Rehash Call booking fixes (Mark, from
-- the Kim Turko review, contact fnGjYEvok31f46ZmnZQW). Each change is behind its
-- own switch. bot_change_log is append-only (trg_bot_change_log_immutable). Run
-- once; the NOT EXISTS guard makes a second run insert nothing.
WITH rows(action, reason, after) AS (
  VALUES
    ('rehash_owned_answer_only',
     'Once John owns a rehash lead (Rehash Call booked, LP visit set, or rehash-owned), the bot sends nothing proactive; a direct question gets a 1-2 sentence answer with no question back, no times and no companion action; a move or cancel request gets "Got it, I''ll let John know." and a #contact-rehash card; anything else no reply.',
     jsonb_build_object('framework', 'nepq_rehash', 'flag', 'REHASH_OWNED_ANSWER_MODE', 'requires', 'REHASH_OWNED_MODE=live', 'date', '2026-10-23', 'undo', 'REHASH_OWNED_ANSWER_MODE=off (REHASH_OWNED_MODE=shadow undoes the ownership skip too)')),
    ('rehash_call_no_email_ask',
     'No post-booking email ask after a Rehash Call is booked.',
     jsonb_build_object('framework', 'booking', 'flag', null, 'date', '2026-10-23', 'undo', 'code revert')),
    ('rehash_call_title',
     'A Rehash Call appointment is titled "Reece Best-Offer Call: {First Last}" (the calendar keeps its name "Rehash Call").',
     jsonb_build_object('framework', 'booking', 'flag', 'REHASH_CALL_TITLE_MODE', 'date', '2026-10-23', 'undo', 'REHASH_CALL_TITLE_MODE=off')),
    ('rehash_call_auto_confirm',
     'Every booking on the Rehash Call calendar is created confirmed; every other calendar is still created new.',
     jsonb_build_object('framework', 'booking', 'flag', 'REHASH_CALL_AUTO_CONFIRM', 'date', '2026-10-23', 'undo', 'REHASH_CALL_AUTO_CONFIRM=off')),
    ('rehash_call_internal_note',
     'Every Rehash Call the bot books gets an internal appointment note starting "Booked by Reece Chatbot", with the call, the rep on the visit, the demo date and a short conversation summary (under 700 characters). Never the description.',
     jsonb_build_object('framework', 'booking', 'flag', 'REHASH_CALL_NOTES_MODE', 'date', '2026-10-23', 'undo', 'REHASH_CALL_NOTES_MODE=off'))
), ins AS (
  INSERT INTO bot_change_log (actor, action, target_table, target_id, reason, before, after)
  SELECT 'system:claude_code_handoff', r.action, 'code', 'rehash_call', r.reason, NULL, r.after
  FROM rows r
  WHERE NOT EXISTS (SELECT 1 FROM bot_change_log b WHERE b.action = r.action AND b.after->>'date' = '2026-10-23')
  RETURNING 1
)
SELECT count(*) AS inserted FROM ins;
