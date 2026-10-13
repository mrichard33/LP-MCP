-- 2026-10-13 — kb_faqs LIB-P16 / LIB-P17 / LIB-P18 (the user's ruling):
--   "We do not work on commercial properties or rental units. We also have a
--    3-opening requirement, but if someone says they only want a quote for one
--    window, we can say, 'No problem. We can give you the quote for the one
--    window, and we'll give you quotes for the other windows as well in case
--    you decide you want to do more in the future.'"
--
-- Rulings the same day: a rental is a no whoever is asking (the tenant AND
-- the owner who rents it out); an investment property that is NOT rented out
-- is a normal lead; a church, an HOA or a condo association still goes to a
-- person; the minimum itself is never told to the lead.
--
-- Code refuses the wrong answer too (src/agentic/property-scope.js,
-- non-owner.js, small-job.js); these rows give the model the right one to word.
-- Each question_pattern LEADS with the customer's own words (CLAUDE.md: the
-- leading phrase dominates the vector). LIB-P15 was already taken.
--
-- DATA ONLY. IDEMPOTENT (each insert only when its key is absent).
--
-- AFTER RUNNING:
--   POST /n8n/kb/reembed {"faqs":true}, then (read would_match):
--   GET /n8n/kb/faq-probe?q=do you do commercial buildings
--   GET /n8n/kb/faq-probe?q=can you do windows on my rental property
--   GET /n8n/kb/faq-probe?q=can I get a quote for just one window
--
-- ROLLBACK:
--   UPDATE kb_faqs SET active = false WHERE kb_key IN ('LIB-P16','LIB-P17','LIB-P18');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'LIB-P16',
       $$Do you do commercial buildings? | Do you work on commercial properties? | Can you do windows for my business? | Our office building needs new windows | Do you do storefronts? | Can you replace windows at our restaurant?$$,
       $$Sorry, we only work on homes, so a commercial property is outside what we can do.$$,
       NULL, 'both', 'factual', true,
       $$Scope boundary (the user, 2026-10-13): Reece does NOT work on commercial properties. A polite no and nothing more: no visit, no question after it. Churches, HOAs and condo associations are NOT covered here; they still go to a person.$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'LIB-P16');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'LIB-P17',
       $$Can you do windows on my rental property? | Do you work on rental units? | I rent it out, can you replace the windows? | Can renters get new windows? | Do you do Airbnb properties? | I own a rental house$$,
       $$Sorry, we don't work on rental units, so we can't set up a visit for a home that's rented out.$$,
       NULL, 'both', 'factual', true,
       $$Scope boundary (the user, 2026-10-13): Reece does NOT work on rental units, whoever is asking: the tenant AND the owner who rents it out. Never send a tenant to the owner. An investment property that is not rented out (a flip, a second home they use) is a normal lead; a home they used to rent out and now live in is a normal home.$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'LIB-P17');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'LIB-P18',
       $$Can I get a quote for just one window? | I only need one window replaced | Do you replace a single window? | Can you do just two windows? | How much for one window?$$,
       $$No problem. We can give you the quote for the one window, and we'll give you quotes for the other windows as well in case you decide you want to do more in the future.$$,
       NULL, 'both', 'factual', true,
       $$Small jobs (the user, 2026-10-13): Reece has a three-opening minimum, but the minimum is NEVER told to the lead. Say this line once, then carry on as usual (the next question, or the times when it is time to book). No price, as always.$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'LIB-P18');
