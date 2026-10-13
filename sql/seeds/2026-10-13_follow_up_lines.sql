-- 2026-10-13 — layer3_action_dispatch id 18 (follow_up_scheduled): no bare
-- "Enjoy!" in the bucket lines (Erica Hilts, nwMyouutw3Y65lYiEmsH).
--
-- WHY:
--   The 1week and 2weeks lines end "Enjoy!". stripExclamations
--   (discovery-discipline.js) turns that into a bare "Enjoy.", which read as no
--   goodbye at all: nothing knew it closed the message, so the visit times were
--   glued on after it ("No problem, Erica. I'll check back next week. Enjoy.
--   Which works better, tomorrow at 10:00 AM ET or Thu, Oct 15 at 6:00 PM ET?").
--   The code now reads a bare "Enjoy." as a sign-off too (isSignOffLine) and
--   never appends after one; these lines say what to enjoy, so they read as a
--   goodbye on their own.
--
-- DATA ONLY. IDEMPOTENT (the WHERE no longer matches after one run).
-- Takes effect on the next layer3 dispatch read; no reload needed.

-- The stored hint carries its quotes doubled ("I''ll"), so the match is on
-- the words after it. The MCP SQL tool refuses a WITH … UPDATE, so the row
-- count is read back by the verify query below (applied 2026-10-13: 1 row).
UPDATE layer3_action_dispatch
   SET actions = jsonb_set(
         actions,
         '{0,params,prompt_hint}',
         to_jsonb(
           replace(
             replace(actions->0->'params'->>'prompt_hint',
               'next week. Enjoy!', 'next week. Enjoy your week!'),
             'couple weeks. Enjoy!', 'couple weeks. Enjoy the next couple of weeks!')
         )
       ),
       updated_at = now()
 WHERE id = 18
   AND recommended_action = 'follow_up_scheduled'
   AND actions->0->'params'->>'prompt_hint' LIKE '%weeks. Enjoy!%';

-- Verify: still_bare false, fixed_1w and fixed_2w true.
-- SELECT (actions->0->'params'->>'prompt_hint' LIKE '%. Enjoy!''%') AS still_bare,
--        (actions->0->'params'->>'prompt_hint' LIKE '%Enjoy your week!%') AS fixed_1w,
--        (actions->0->'params'->>'prompt_hint' LIKE '%Enjoy the next couple of weeks!%') AS fixed_2w
--   FROM layer3_action_dispatch WHERE id = 18;
