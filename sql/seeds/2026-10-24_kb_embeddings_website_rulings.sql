-- 2026-10-24: the compliance excerpts follow the user's website rulings.
--
-- WHY (the user, 2026-10-24, review of the website answers): "use the website's words" for hurricane-proof, the
-- insurance answer ("may lower premiums or qualify for discounts"), the UV figure (95%) and the install time ("Most
-- Windows Installed In 6 Weeks"). sql/seeds/2026-10-24_website_faqs.sql puts those answers in kb_faqs, but the
-- vector tier still serves the compliance excerpts that forbid them, and an UNCLEAR turn always runs the vector tier
-- (the 2026-10-22 landlord incident: the bot copied an excerpt the FAQ seed never touched). This changes, in place:
--   3289 / 3293 / 3296 reece_compliance_guardrails  "hurricane-proof / storm-proof" is no longer a hard reject; the
--                      insurance line allows "may help lower" when the insurance company decides the final number.
--   3294 / 3297 reece_compliance_guardrails          the two website figures join the allowed references.
-- Everything else in those excerpts (crew wording, carriers, fake urgency, the five references) is unchanged.
--
-- HOW TO APPLY: run each UPDATE on its own (the MCP query tool refuses a data-modifying WITH); each changes 1 row
-- the first time and 0 after (guarded on the old text). The old text goes into metadata->'prior_text_2026_10_24'.
--
-- AFTER APPLYING:
--   POST /n8n/kb/reembed {"chunk_ids": [3289, 3293, 3294, 3296, 3297]}
--   then run the check at the bottom (expect every flag false).
--
-- ROLLBACK (per row):
--   UPDATE kb_embeddings SET chunk_text = metadata->>'prior_text_2026_10_24',
--          metadata = metadata - 'prior_text_2026_10_24'
--    WHERE id IN (3289, 3293, 3294, 3296, 3297) AND metadata ? 'prior_text_2026_10_24';
--   then the reembed above.

-- 3289 / 3293 / 3296: hurricane-proof and the insurance line. expect 3
UPDATE kb_embeddings SET
  metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('prior_text_2026_10_24', chunk_text),
  chunk_text = replace(replace(chunk_text,
    $$"Your premium will drop" / "Your claim will be paid" — never predict insurance outcomes. Say nothing about claim/premium outcomes.$$,
    $$"Your premium will drop" / "Your claim will be paid" — never promise an insurance outcome. Allowed (the user, 2026-10-24, from reecewindows.com): impact windows "may help lower your premium and can qualify you for wind-mitigation discounts", always with "your insurance company decides the final number".$$),
    $$"hurricane-proof" / "storm-proof" — no outcome guarantees on storm performance.$$,
    $$Hurricane-proof is allowed for the product, in the website's words (the user, 2026-10-24): our impact windows are built to be hurricane-proof, and the laminated glass is so strong a bowling ball can't break through it. Never promise what a storm will or won't do to their home.$$)
WHERE id IN (3289, 3293, 3296)
  AND chunk_text LIKE '%"hurricane-proof" / "storm-proof" — no outcome guarantees%';

-- 3294 / 3297: the two website figures join the allowed references. expect 2
UPDATE kb_embeddings SET
  metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('prior_text_2026_10_24', chunk_text),
  chunk_text = replace(chunk_text,
    $$Any other number is a hallucination$$,
    $$Also allowed (the user, 2026-10-24, from reecewindows.com): our glass blocks up to 95% of UV rays, and most windows are installed within about 6 weeks. Any other number is a hallucination$$)
WHERE id IN (3294, 3297)
  AND chunk_text NOT LIKE '%blocks up to 95% of UV%';

-- check (expect every flag false)
SELECT id,
       chunk_text LIKE '%no outcome guarantees on storm performance%' AS old_storm_line,
       chunk_text LIKE '%Say nothing about claim/premium outcomes%' AS old_insurance_line,
       (id IN (3294, 3297) AND chunk_text NOT LIKE '%blocks up to 95% of UV%') AS missing_figures
  FROM kb_embeddings WHERE id IN (3289, 3293, 3294, 3296, 3297) ORDER BY id;
