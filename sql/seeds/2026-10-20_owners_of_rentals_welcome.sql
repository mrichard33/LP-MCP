-- 2026-10-20 — kb_faqs LIB-P16, kb_proof_points (scope), kb_intent_handlers RENTER:
-- an owner is a lead whatever they do with the home; a renter is not.
--
-- WHY (the user, 2026-10-20): "We do not need to turn investment properties away.
-- However, we only work with owners not the renters. So renters we turn away."
-- This supersedes the 2026-10-13 rental and investment rule
-- (sql/seeds/2026-10-13_scope_rules_impact_only.sql), which declined landlords,
-- Airbnb owners, investors and flippers.
--   * LIB-P16 answered "No, sorry about that. We don't work on rental or
--     investment properties". It now says yes to an owner and asks a renter to
--     have the owner reach out. The question_pattern still LEADS with the
--     customer's words (CLAUDE.md: the leading phrase dominates the vector).
--   * Three kb_proof_points rows said "Reece works only on homes that are not
--     rented out". They now say homeowners only, not renters.
--   * The RENTER intent handler matched the bare words rent / renting / lease /
--     landlord, so "we rent it out" and "my tenants" tagged a LANDLORD
--     hdl:dq-renter at 0.95. Keywords are now a renter's own phrases only (all
--     longer than 6 characters, so intent-classifier.js matches them as
--     substrings); "my renters" / "my tenant" from a landlord no longer match.
--
-- The code that makes a wrong answer impossible to send is
-- src/agentic/non-owner.js (TENANT_LINE) and src/agentic/job-scope.js (no
-- rental or investment block any more). No dashes in any answer (2026-10-06).
--
-- DATA ONLY. IDEMPOTENT (updates by key or by the old text).
--
-- AFTER RUNNING:
--   POST /n8n/kb/reembed {"faqs":true}, then read would_match on each:
--   GET /n8n/kb/faq-probe?q=Do you work on rental properties?   (LIB-P16)
--   GET /n8n/kb/faq-probe?q=I'm renting, can I get a quote?      (LIB-P16)
--   and reload the intent handlers (they load at boot; a redeploy reloads them).

UPDATE kb_faqs
   SET question_pattern = $$Do you work on rental properties? | Can you do windows on my rental? | I rent it out, can you replace the windows? | Do you work with landlords? | Do you do investment properties? | It's a flip, can you do the windows? | It's an Airbnb, can you help? | I'm renting, can I get a quote? | Can renters get a quote?$$,
       canonical_answer = $$Yes, if you own the home. We work with homeowners, including homes you rent out, Airbnbs, investment properties and flips. If you rent the home you live in, the owner would need to reach out to us.$$,
       notes = $$2026-10-20 (the user): "we only work with owners not the renters". An owner of a rental, an Airbnb, an investment home or a flip is a lead; a tenant is turned away and the owner is welcome to reach out. Supersedes 2026-10-13. Guard: src/agentic/non-owner.js.$$,
       updated_at = now()
 WHERE kb_key = 'LIB-P16';

UPDATE kb_proof_points
   SET claim = $$Reece works with homeowners only, not renters (an owner who rents the home out is welcome), and no commercial properties$$,
       notes = $$Disqualifier: a renter or a commercial property (the user, 2026-10-20; supersedes 2026-10-13's no rentals). Guards: src/agentic/non-owner.js, src/agentic/job-scope.js$$,
       updated_at = now()
 WHERE claim = $$Reece works only on homes that are not rented out: no rental properties (tenant or landlord) and no commercial properties$$;

UPDATE kb_intent_handlers
   SET trigger_keywords = ARRAY['i''m a renter', 'i am a renter', 'we''re renters', 'we are renters', 'can renters', 'as a renter', 'i''m a tenant', 'i am a tenant', 'we''re tenants', 'we are tenants', 'i''m renting', 'i am renting', 'we''re renting', 'we are renting', 'im renting', 'my landlord', 'my rent '],
       notes = 'Disqualify: a renter is not the owner (the user, 2026-10-20). A landlord who rents the home out is an owner and a lead, so rent / renting / lease / landlord no longer match on their own.',
       updated_at = now()
 WHERE intent_class = 'RENTER';

-- Check: LIB-P16 says yes to owners, three proof points updated, RENTER keywords narrowed.
SELECT json_agg(row_to_json(s)) FROM (
  SELECT 'faq' AS k, kb_key AS id, left(canonical_answer, 60) AS v FROM kb_faqs WHERE kb_key = 'LIB-P16'
  UNION ALL SELECT 'proof', id::text, left(claim, 60) FROM kb_proof_points WHERE claim LIKE 'Reece works with homeowners only, not renters%'
  UNION ALL SELECT 'handler', intent_class, array_to_string(trigger_keywords, ',') FROM kb_intent_handlers WHERE intent_class = 'RENTER'
) s;
