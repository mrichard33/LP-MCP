-- 2026-10-05 — kb_faqs LIB-P13: we do NOT work on manufactured or mobile homes.
--
-- WHY: a website chat visitor asked "do you work on manufactured homes?" and
-- the live chat answered "Yes, we work on manufactured homes." (agent_actions
-- 546914). The fact lived only in kb_proof_points (category 'scope'), which the
-- reply writer never saw, and there was no FAQ for retrieval to find. Code now
-- refuses the wrong answer too (src/agentic/property-scope.js); this row gives
-- the model the right one to word.
--
-- The question_pattern LEADS with the customer's own words (CLAUDE.md: the
-- leading phrase dominates the vector). Modular homes are left out on purpose:
-- nobody has ruled on them.
--
-- DATA ONLY. IDEMPOTENT (inserts only when LIB-P13 is absent).
--
-- AFTER RUNNING:
--   POST /n8n/kb/reembed {"faqs":true}, then
--   GET /n8n/kb/faq-probe?q=do you work on manufactured homes   (read would_match)
--
-- ROLLBACK:
--   UPDATE kb_faqs SET active = false WHERE kb_key = 'LIB-P13';

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'LIB-P13',
       $$Do you work on manufactured homes? | Do you do mobile homes? | Can you put windows in a mobile home? | I have a manufactured home | Do you work on double wides? | Do you install in trailer homes?$$,
       $$No, we don't work on manufactured or mobile homes, sorry about that. We specialize in single-family homes, townhomes, and condos.$$,
       NULL, 'both', 'factual', true,
       $$Scope boundary (2026-10-05): Reece does NOT work on manufactured or mobile homes. Never imply we do. Added after the live chat told a visitor "Yes, we work on manufactured homes." Modular homes are not ruled on and are not covered here.$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'LIB-P13');

-- Check: expect one active row.
SELECT json_agg(row_to_json(s)) FROM (SELECT id, kb_key, active, canonical_answer FROM kb_faqs WHERE kb_key = 'LIB-P13') s;
