-- 2026-10-05 — kb_faqs LIB-P14: we only work on buildings two stories or lower.
--
-- WHY: the live chat answered "Do you service a 9 story condominium?" with
-- "Yes, we install impact windows and doors in condos … Is this for all nine
-- floors, or specific units?" (agent_actions 547004). The rule is Mark's
-- (2026-08-25, sql/seeds/2026-08-25_dq_above_2nd_floor.sql): the TOTAL
-- BUILDING must be two floors or less, so a ground-floor condo in a tall
-- building is a no too. The SMS rule only catches a lead who SAYS it; there
-- was no FAQ and no prompt line, and the live chat never runs rules. Code
-- now refuses the wrong answer (src/agentic/property-scope.js); this row
-- gives the model the right one to word.
--
-- The question_pattern LEADS with the customer's own words (CLAUDE.md).
--
-- DATA ONLY. IDEMPOTENT (inserts only when LIB-P14 is absent).
--
-- AFTER RUNNING:
--   POST /n8n/kb/reembed {"faqs":true}, then
--   GET /n8n/kb/faq-probe?q=do you service a 9 story condominium   (read would_match)
--
-- ROLLBACK:
--   UPDATE kb_faqs SET active = false WHERE kb_key = 'LIB-P14';

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'LIB-P14',
       $$Do you service a 3 story building? | Do you work on high-rise condos? | I live on the 5th floor of a condo | Do you do condos in a tall building? | How many stories can you install on? | Do you do mid-rise buildings?$$,
       $$Sorry, we only work on buildings that are two stories or lower, so a taller building is outside what we can do. That goes for the whole building, not just the floor your home is on.$$,
       NULL, 'both', 'factual', true,
       $$Scope boundary (Mark 2026-08-25, restated 2026-10-05): Reece installs ONLY where the TOTAL BUILDING is two stories or less. The building counts, not the unit. Never imply we do taller buildings. Added after the live chat said yes to a 9-story condominium.$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'LIB-P14');

-- Check: expect one active row.
SELECT json_agg(row_to_json(s)) FROM (SELECT id, kb_key, active, canonical_answer FROM kb_faqs WHERE kb_key = 'LIB-P14') s;
