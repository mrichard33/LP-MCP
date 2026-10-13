-- 2026-10-13 — kb_faqs + kb_proof_points: no rentals, no commercial, the
-- three-opening minimum, and impact only (the user's rulings, 2026-10-13).
--
-- WHY:
--   * "We only sell hurricane impact windows." LIB-P03 and LIB-P15 both said
--     "Not every window in our line is impact-rated", and LIB-P15's notes told
--     the model never to say all are. Both now say every window and door we sell
--     is impact-rated, in every market (the user: every market, Houston and
--     Winston-Salem included).
--   * "We do not work with rental properties or any commercial properties."
--     No FAQ answered either, and kb_proof_points said only "homeowners only,
--     not renters" (a landlord read as a homeowner). LIB-P16 / LIB-P17.
--   * "A 3 window opening minimum ... we also will work on 1 single sliding
--     glass door, or 2 windows and a door." No FAQ, no prompt line. LIB-P18.
--     Any mix of three windows or doors, or one sliding glass door on its own.
--
-- The code guard that makes a wrong answer impossible to send is
-- src/agentic/job-scope.js; these rows put the right answer in the KB PACK.
-- Every question_pattern LEADS with the customer's own words (CLAUDE.md: the
-- leading phrase dominates the vector). No dashes in any answer (2026-10-06).
--
-- DATA ONLY. IDEMPOTENT (updates by kb_key; inserts only when absent).
--
-- AFTER RUNNING:
--   POST /n8n/kb/reembed {"faqs":true}, then read would_match on each:
--   GET /n8n/kb/faq-probe?q=Are all your windows impact windows?        (LIB-P03)
--   GET /n8n/kb/faq-probe?q=Are your windows impact rated?              (LIB-P15)
--   GET /n8n/kb/faq-probe?q=Do you work on rental properties?           (LIB-P16)
--   GET /n8n/kb/faq-probe?q=Do you do commercial buildings?             (LIB-P17)
--   GET /n8n/kb/faq-probe?q=Can you replace just one window?            (LIB-P18)
--   and re-probe the neighbours: "Do you do sliding glass doors?", "Do you
--   do doors?", "Do you work on condos?" must keep their own rows.
--
-- ROLLBACK:
--   UPDATE kb_faqs SET active = false WHERE kb_key IN ('LIB-P16','LIB-P17','LIB-P18');
--   LIB-P03 / LIB-P15 / proof points: re-run the old text from
--   sql/seeds/2026-09-25_golden_kb_v1.sql and 2026-10-06_impact_rated_yes.sql.

-- ── impact only ─────────────────────────────────────────────────────────
UPDATE kb_faqs
   SET canonical_answer = $$Yes. Every window and door we sell is a hurricane impact window or door. A specialist checks each opening and matches it to the right impact product for your home and your area's code.$$,
       notes = coalesce(notes, '') || $$ | 2026-10-13 (the user): we sell only hurricane impact windows and doors, in every market. Replaces "Not every window in our line is impact-rated".$$,
       updated_at = now()
 WHERE kb_key = 'LIB-P03';

UPDATE kb_faqs
   SET canonical_answer = $$Yes. Every window and door we sell is hurricane impact-rated, and a specialist matches each opening to the right one for your home and your area's code.$$,
       notes = $$Lead with YES (2026-10-06). 2026-10-13 (the user): we sell ONLY hurricane impact windows and doors, in every market, so say every one is impact-rated. Never say "not every window" or offer a non-impact option.$$,
       updated_at = now()
 WHERE kb_key = 'LIB-P15';

-- ── no rentals ──────────────────────────────────────────────────────────
INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'LIB-P16',
       $$Do you work on rental properties? | Can you do windows on my rental? | I rent it out, can you replace the windows? | Do you work with landlords? | Do you do investment properties? | Can renters get a quote? | It's an Airbnb, can you help?$$,
       $$No, sorry about that. We don't work on rental properties, whether you rent the home or rent it out. We only work on homes the owner isn't renting out.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-13 (the user): no rental properties of any kind: a tenant, a landlord, an investment rental, Airbnb or VRBO. An owner's own second home that is not rented out is fine. Guard: src/agentic/job-scope.js.$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'LIB-P16');

-- ── no commercial ───────────────────────────────────────────────────────
INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'LIB-P17',
       $$Do you do commercial buildings? | Do you do commercial work? | Can you do windows for my business? | Do you work on office buildings? | Do you do apartment complexes? | Can you quote our HOA or condo association? | Do you do churches?$$,
       $$No, sorry about that. We only work on homes, not commercial properties, so a business, an office or apartment building, a church, or an association's building is outside what we do.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-13 (the user): no commercial properties. A single condo owner in a building up to two stories is a homeowner (LIB-P14 covers height). Guard: src/agentic/job-scope.js.$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'LIB-P17');

-- ── the minimum ─────────────────────────────────────────────────────────
INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'LIB-P18',
       $$Can you replace just one window? | Do you do just one window? | I only need two windows | Is there a minimum? | Do you replace a single door? | What's your minimum job?$$,
       $$Our minimum is three windows or doors in any mix, like three windows or two windows and a door, or one sliding glass door on its own. Are there any other windows or doors you'd want us to look at?$$,
       NULL, 'both', 'factual', true,
       $$2026-10-13 (the user): three openings in any mix of windows and doors, or one sliding glass door alone. Ask once about other openings; a no means it is under the minimum and gets no visit. Guard: src/agentic/job-scope.js.$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'LIB-P18');

-- ── proof points: the renter row covers every rental now ─────────────────
UPDATE kb_proof_points
   SET claim = $$Reece works only on homes that are not rented out: no rental properties (tenant or landlord) and no commercial properties$$,
       notes = $$Disqualifier (the user, 2026-10-13). Guard: src/agentic/job-scope.js$$,
       updated_at = now()
 WHERE claim = 'Reece works with homeowners only — not renters';

-- Check: expect LIB-P03, LIB-P15, LIB-P16, LIB-P17, LIB-P18 active, none saying "not every".
SELECT json_agg(row_to_json(s)) FROM (
  SELECT kb_key, active, canonical_answer FROM kb_faqs
   WHERE kb_key IN ('LIB-P03','LIB-P15','LIB-P16','LIB-P17','LIB-P18') ORDER BY kb_key
) s;
