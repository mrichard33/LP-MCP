-- 2026-10-06 — kb_faqs LIB-P15: "Are your windows impact rated?" leads with YES.
--
-- WHY: with LIVE_CHAT_KB_INTENT_MODE=live the live chat finally used the FAQ
-- tier, and "Are your windows impact rated?" was won by LIB-P03 (0.773), whose
-- answer opens "Not every window in our line is impact-rated." That is true,
-- but to a visitor asking whether we sell impact windows it reads as a NO
-- (the same trap as single-hung in KB-02: an answer that never says yes is
-- heard as a denial). With the setting off, the model had guessed "Yes, all our
-- windows are impact rated", which is false. Both flags were rolled back.
--
-- This row says both facts in the order a buyer needs them: we DO offer
-- impact-rated windows and doors (LIB-P09, reece_avatar_company "WE DO Impact
-- windows"), and not every window in the line is impact-rated (LIB-P03). No
-- new fact. "Florida" is left out on purpose: Houston and Winston-Salem are
-- markets too.
--
-- LIB-P03 stays for "Are ALL your windows impact?" / "Do you sell non-impact
-- windows?". The question_pattern LEADS with the customer's own words
-- (CLAUDE.md: the leading phrase dominates the vector).
--
-- DATA ONLY. IDEMPOTENT (inserts only when LIB-P15 is absent).
--
-- AFTER RUNNING:
--   POST /n8n/kb/reembed {"faqs":true}, then
--   GET /n8n/kb/faq-probe?q=Are your windows impact rated?   (LIB-P15 first)
--   GET /n8n/kb/faq-probe?q=Are all your windows impact windows?   (LIB-P03 first)
--
-- ROLLBACK:
--   UPDATE kb_faqs SET active = false WHERE kb_key = 'LIB-P15';

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'LIB-P15',
       $$Are your windows impact rated? | Do you have impact windows? | Do you sell impact windows? | Do you offer impact-rated windows? | Are your windows impact?$$,
       $$Yes, we offer impact-rated windows and doors. Not every window in our line is impact-rated, so a specialist checks each opening and matches it to the right window for your home and your area's code.$$,
       NULL, 'both', 'factual', true,
       $$Lead with YES (2026-10-06): we sell impact-rated windows and doors. Never say all our windows are impact-rated (LIB-P03), and never open with "not every window", which reads as a no.$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'LIB-P15');

-- Check: expect one active row.
SELECT json_agg(row_to_json(s)) FROM (SELECT id, kb_key, active, canonical_answer FROM kb_faqs WHERE kb_key = 'LIB-P15') s;
