-- 2026-10-22: the knowledge-base excerpts follow "owners yes, renters no" too.
--
-- WHY (the user, 2026-10-20): "We do not need to turn investment properties away. However, we only work with owners
-- not the renters." sql/seeds/2026-10-20_owners_of_rentals_welcome.sql fixed kb_faqs, kb_proof_points and
-- kb_intent_handlers, but not kb_embeddings. The live chat answered landlord_lead ("Hi, I need new windows on a house
-- I rent out to tenants") with three turn-aways in two days, each one a copy of an old excerpt the vector search put
-- in its prompt (the message classifies UNCLEAR, and UNCLEAR always runs the vector tier):
--   "We work with homeowners on their primary residences ... wouldn't be the right fit"   <- 3276, 3254, 3255
--   "Our estimates are for homeowners since the work involves permanent improvements ...
--    If you own a home in the future, feel free to reach back out."                      <- 3275, word for word
-- The code guard (job-scope.js owner_rental_declined / owner_redirected) caught each wording only after it shipped.
-- This removes the contradiction at the source:
--   3275 reece_situation_handlers  HDL-DQ-RENTER-01: "landlord" is no longer a renter trigger; a note says an owner
--                                  who rents the home out is a lead. The renter response stays: it is right for a renter.
--   3276 reece_situation_handlers  HDL-DQ-INVESTMENT-01 (decline an investment/rental property) is replaced by the
--                                  owner-of-a-rental rule: qualified, never ask about a primary residence.
--   3254 reece_canonical_kb        "Owner-occupied" + "Primary residence (NOT investment or rental property)".
--   3255 reece_canonical_kb        question 3 "Is this your primary residence?" and the investment decline.
--   3249 reece_canonical_kb        "No work with renters (homeowners only)" says who is a lead.
-- 3259 (reece_avatar_company) names renters only and is right as it is. The repo has no source file for these docs
-- (sql/011 and sql/014 are frozen history), so a re-ingest cannot bring the old text back.
--
-- HOW TO APPLY: run each statement on its own; each returns the row count it changed (expect 1) and is guarded so a
-- second run changes 0. The MCP query tool refuses a data-modifying WITH: there, run the inner UPDATE and read the
-- check at the bottom (applied 2026-10-22, all five rewritten). The old text goes into metadata->'prior_text_2026_10_22'.
--
-- AFTER APPLYING:
--   POST /n8n/kb/reembed {"chunk_ids": [3249, 3254, 3255, 3275, 3276]}
--   then run the check at the bottom (expect every flag false).
--
-- ROLLBACK (per row):
--   UPDATE kb_embeddings SET chunk_text = metadata->>'prior_text_2026_10_22',
--          metadata = metadata - 'prior_text_2026_10_22'
--    WHERE id IN (3249, 3254, 3255, 3275, 3276) AND metadata ? 'prior_text_2026_10_22';
--   then the reembed above.

-- reece_situation_handlers 3275 (HDL-DQ-RENTER-01). expect 1
WITH u AS (
  UPDATE kb_embeddings SET
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('prior_text_2026_10_22', chunk_text),
    -- The labels (TRIGGERS, NOTES) are followed by a private-use character from the PDF ingest, so match the text
    -- after them, never the label.
    chunk_text = replace(replace(chunk_text,
        $t$"renting," "not the owner," "landlord," "apartment," "lease"$t$,
        $t$"I'm renting," "not the owner," "my landlord," "my apartment," "my lease"$t$),
        $t$Leave door open for future homeownership.$t$,
        $t$Leave door open for future homeownership. Only for someone who rents the home they live in. An owner
who rents the home OUT to tenants is not a renter: a normal lead (the user, 2026-10-20).$t$)
  WHERE active AND id = 3275
    AND chunk_text LIKE $t$%"not the owner," "landlord," "apartment,"%$t$
    AND NOT coalesce(metadata ? 'prior_text_2026_10_22', false)
  RETURNING 1
) SELECT count(*) FROM u;

-- reece_situation_handlers 3276 (HDL-DQ-INVESTMENT-01 → owner of a rental). expect 1
WITH u AS (
  UPDATE kb_embeddings SET
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('prior_text_2026_10_22', chunk_text),
    chunk_text = regexp_replace(chunk_text,
        'KEY: HDL-DQ-INVESTMENT-01.*?May have other properties that qualify\.',
        $t$KEY: HDL-OWNER-RENTAL-01
NAME Owner of a rental or investment property: QUALIFIED
CONTEXT The person owns the home and rents it out, or owns it as an investment, a second home or a flip.
RULE A normal lead (the user, 2026-10-20). Never ask whether it is their primary residence and never turn them
away for renting it out. Go on with the usual questions and offer the visit.
NOTES Different from HDL-DQ-RENTER-01: a renter does not own the home. A property manager is not the owner either.$t$)
  WHERE active AND id = 3276
    AND chunk_text LIKE '%KEY: HDL-DQ-INVESTMENT-01%May have other properties that qualify.%'
    AND NOT coalesce(metadata ? 'prior_text_2026_10_22', false)
  RETURNING 1
) SELECT count(*) FROM u;

-- reece_canonical_kb 3254 (QUALIFICATION RULES). expect 1
WITH u AS (
  UPDATE kb_embeddings SET
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('prior_text_2026_10_22', chunk_text),
    chunk_text = replace(chunk_text,
        $t$- Owner-occupied (they own the home, not renting)
- Primary residence (NOT investment or rental property)$t$,
        $t$- They own the home (a renter is not the owner; an owner who rents it out, a second home
  and an investment property all qualify)$t$)
  WHERE active AND id = 3254
    AND chunk_text LIKE '%Primary residence (NOT investment or rental property)%'
    AND NOT coalesce(metadata ? 'prior_text_2026_10_22', false)
  RETURNING 1
) SELECT count(*) FROM u;

-- reece_canonical_kb 3255 (QUALIFICATION QUESTIONS + DISQUALIFICATION RESPONSES). expect 1
WITH u AS (
  UPDATE kb_embeddings SET
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('prior_text_2026_10_22', chunk_text),
    chunk_text = replace(replace(chunk_text,
        $t$3. "Is this your primary residence?"
   - Investment/rental property = NOT QUALIFIED$t$,
        $t$3. (No residence question: an owner who rents the home out or owns it as an investment
   is qualified.)$t$),
        $t$Investment Property: "We focus on primary residences. Best of luck
with your investment property!"$t$,
        $t$Owns a rental or investment property: qualified, carry on with the questions.$t$)
  WHERE active AND id = 3255
    AND chunk_text LIKE '%Is this your primary residence?%'
    AND NOT coalesce(metadata ? 'prior_text_2026_10_22', false)
  RETURNING 1
) SELECT count(*) FROM u;

-- reece_canonical_kb 3249 (WHAT REECE DOES NOT DO). expect 1
WITH u AS (
  UPDATE kb_embeddings SET
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('prior_text_2026_10_22', chunk_text),
    chunk_text = replace(chunk_text,
        $t$- No work with renters (homeowners only)$t$,
        $t$- No work with renters (the owner must be part of it; an owner who rents the home out is a lead)$t$)
  WHERE active AND id = 3249
    AND chunk_text LIKE '%- No work with renters (homeowners only)%'
    AND NOT coalesce(metadata ? 'prior_text_2026_10_22', false)
  RETURNING 1
) SELECT count(*) FROM u;

-- Check: expect every flag false, and rewritten = true on all five.
SELECT json_agg(row_to_json(s)) FROM (
  SELECT id, source_doc,
         metadata ? 'prior_text_2026_10_22' AS rewritten,
         chunk_text ILIKE '%primary residence (NOT%' OR chunk_text ILIKE '%Is this your primary residence%' AS primary_q,
         chunk_text ILIKE '%owner-occupied%' AS owner_occupied,
         chunk_text LIKE '%HDL-DQ-INVESTMENT-01%May have other%' AS investment_dq,
         chunk_text LIKE '%"not the owner," "landlord,"%' AS landlord_trigger
    FROM kb_embeddings WHERE id IN (3249, 3254, 3255, 3275, 3276) ORDER BY id) s;
