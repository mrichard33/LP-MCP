-- 2026-10-24: the compliance excerpts follow the user's website rulings.
--
-- WHY (the user, 2026-10-24, review of the website answers): "use the website's words" for the UV figure (95%) and the
-- install time ("Most Windows Installed In 6 Weeks"). The hurricane-proof and insurance hard rejects STAY as they are
-- (the user, same day: "Keep this: old 'no window is hurricane-proof' and insurance wording"). sql/seeds/2026-10-24_website_faqs.sql puts those answers in kb_faqs, but the
-- vector tier still serves the compliance excerpts that forbid them, and an UNCLEAR turn always runs the vector tier
-- (the 2026-10-22 landlord incident: the bot copied an excerpt the FAQ seed never touched). This changes, in place:
--   3294 / 3297 reece_compliance_guardrails          the two website figures join the allowed references.
-- Everything else in those excerpts (hurricane-proof, insurance, crew wording, carriers, fake urgency, the five
-- references) is unchanged.
--
-- HOW TO APPLY: run each UPDATE on its own (the MCP query tool refuses a data-modifying WITH); each changes 1 row
-- the first time and 0 after (guarded on the old text). The old text goes into metadata->'prior_text_2026_10_24'.
--
-- AFTER APPLYING:
--   POST /n8n/kb/reembed {"chunk_ids": [3294, 3297]}
--   then run the check at the bottom (expect every flag false).
--
-- ROLLBACK (per row):
--   UPDATE kb_embeddings SET chunk_text = metadata->>'prior_text_2026_10_24',
--          metadata = metadata - 'prior_text_2026_10_24'
--    WHERE id IN (3294, 3297) AND metadata ? 'prior_text_2026_10_24';
--   then the reembed above.

-- 3294 / 3297: the two website figures join the allowed references. expect 2
UPDATE kb_embeddings SET
  metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('prior_text_2026_10_24', chunk_text),
  chunk_text = replace(chunk_text,
    $$Any other number is a hallucination$$,
    $$Also allowed (the user, 2026-10-24, from reecewindows.com): our glass blocks up to 95% of UV rays, and most windows are installed within about 6 weeks. Any other number is a hallucination$$)
WHERE id IN (3294, 3297)
  AND chunk_text NOT LIKE '%blocks up to 95% of UV%';

-- check (expect missing_figures false on both rows)
SELECT id, chunk_text NOT LIKE '%blocks up to 95% of UV%' AS missing_figures
  FROM kb_embeddings WHERE id IN (3294, 3297) ORDER BY id;
