-- 2026-10-14 (Jose Perez, QMUh8zptDpiydvUZIDsg). Applied live and the engine reloaded.
-- Rule 330 FOLLOW_UP_CLEARED_ON_REPLY removed follow-up:1week two minutes after it was set,
-- because the lead's next text was "Appreciate it, thank you again". A bare thank-you is not
-- the lead re-engaging early, so it no longer clears the promise.
UPDATE agent_rules
SET context_conditions = context_conditions || jsonb_build_object(
      'payload_message_not_matches',
      '^[\s\W]*(?:ok(?:ay)?|k|thanks?|thank\s*(?:you|u)|ty|thx|appreciate\s+(?:it|you|that)|got\s+it|will\s+do|sounds\s+(?:good|great)|you\s+too)\b[^?]{0,30}$'),
    version = version + 1,
    updated_at = now()
WHERE id = 330;
