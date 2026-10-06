-- 2026-10-06 — no long dashes in the locked lines, and the old price script retired.
--
-- WHY (the user, 2026-10-06): "remove the long dashes in the locked lines".
-- The bot was told to quote LOCKED lines verbatim "em dashes included", and
-- humanizeReply kept any dash it found in the prompt. That exception matched
-- more than locked lines: the old price script in reece_canonical_kb
-- ("Every home is different — window sizes, … — so we do an In-Home
-- Assessment … The Protection Profile Review is the quick first step …")
-- was copied with its dashes (bot gate 2026-10-06: financing/livechat
-- human_voice:em_dash) and pulled the price answer toward the phone Review,
-- against the visit-first rule (Mark, 2026-10-02/03; the Review is only the
-- backup when a lead asks for a call). The code no longer keeps any dash
-- (src/agentic/human-voice.js); these rows lose theirs at the source.
--
--   reece_belief_stack   3295        12 dashes (the Three Secrets among them)
--   reece_category_truth 3291, 3292  19 dashes (labels and notes; the quoted
--                                    lines themselves had none)
--   reece_canonical_kb   3252        the price objection script + the
--                                    "How much do impact windows cost?" answer
-- The Secrets keep their words: "underprotected. The industry sold you…",
-- "opposite outcomes, because of paperwork." data/kb/concierge/reece_belief_stack.md
-- carries the same text, so a re-ingest cannot bring the dashes back.
-- reece_category_truth has no repo source file.
--
-- HOW TO APPLY: run each statement on its own; each returns the row count it
-- changed and is guarded so a second run changes 0. The old text goes into
-- metadata->'prior_text_2026_10_06'.
--
-- AFTER APPLYING:
--   POST /n8n/kb/reembed {"chunk_ids": [3291, 3292, 3295, 3252]}
--   then run the check at the bottom (expect 0 dashes, 0 "quick first step").
--
-- ROLLBACK (per row):
--   UPDATE kb_embeddings SET chunk_text = metadata->>'prior_text_2026_10_06',
--          metadata = metadata - 'prior_text_2026_10_06'
--    WHERE id IN (3291, 3292, 3295, 3252) AND metadata ? 'prior_text_2026_10_06';
--   then the reembed above.

-- reece_belief_stack 3295. expect 1
WITH u AS (
  UPDATE kb_embeddings SET
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('prior_text_2026_10_06', chunk_text),
    chunk_text = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(chunk_text,
        $t$REECE BELIEF STACK — LOCKED CANON$t$,
        $t$REECE BELIEF STACK: LOCKED CANON$t$),
        $t$after an objection — the chatbot is the rep surface in chat.$t$,
        $t$after an objection. The chatbot is the rep surface in chat.$t$),
        $t$"Price is too high" — they think$t$,
        $t$"Price is too high": they think$t$),
        $t$"I'll wait" — they think$t$,
        $t$"I'll wait": they think$t$),
        $t$"I'll get other quotes" — they're$t$,
        $t$"I'll get other quotes": they're$t$),
        $t$"I don't need new windows yet" — they assume$t$,
        $t$"I don't need new windows yet": they assume$t$),
        $t$Secret #1 — Internal$t$,
        $t$Secret #1, Internal$t$),
        $t$underprotected — the industry sold$t$,
        $t$underprotected. The industry sold$t$),
        $t$Secret #2 — External$t$,
        $t$Secret #2, External$t$),
        $t$Secret #3 — Universal$t$,
        $t$Secret #3, Universal$t$),
        $t$lived storm pattern — Ian, Charley, Irma)$t$,
        $t$lived storm pattern: Ian, Charley, Irma)$t$),
        $t$opposite outcomes — because of paperwork.$t$,
        $t$opposite outcomes, because of paperwork.$t$)
  WHERE active AND id IN (3295)
    AND chunk_text LIKE $t$%underprotected — the industry%$t$
    AND NOT coalesce(metadata ? 'prior_text_2026_10_06', false)
  RETURNING 1
) SELECT count(*) FROM u;

-- reece_category_truth 3291, 3292 (each pair applies only where its text is). expect 2
WITH u AS (
  UPDATE kb_embeddings SET
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('prior_text_2026_10_06', chunk_text),
    chunk_text = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(chunk_text,
        $t$REECE CATEGORY & VEHICLE — LOCKED CANON$t$,
        $t$REECE CATEGORY & VEHICLE: LOCKED CANON$t$),
        $t$THE CATEGORY TRUTH — LOCKED:$t$,
        $t$THE CATEGORY TRUTH (LOCKED):$t$),
        $t$THE CATEGORY — LOCKED: Documented$t$,
        $t$THE CATEGORY (LOCKED): Documented$t$),
        $t$wrong category — that is the move this line makes.$t$,
        $t$wrong category. That is the move this line makes.$t$),
        $t$"Claim Protection" — implies$t$,
        $t$"Claim Protection": implies$t$),
        $t$"Home Protection Intelligence" — overstates$t$,
        $t$"Home Protection Intelligence": overstates$t$),
        $t$"Insurance Approval System" — same problem$t$,
        $t$"Insurance Approval System": same problem$t$),
        $t$"Hurricane Protection" — commoditized$t$,
        $t$"Hurricane Protection": commoditized$t$),
        $t$"Impact Windows and Doors" — that is the product$t$,
        $t$"Impact Windows and Doors": that is the product$t$),
        $t$THE VEHICLE — LOCKED: The Documented$t$,
        $t$THE VEHICLE (LOCKED): The Documented$t$),
        $t$already true at Reece — this is not aspirational$t$,
        $t$already true at Reece. This is not aspirational$t$),
        $t$Code-Verified Installation — every install$t$,
        $t$Code-Verified Installation: every install$t$),
        $t$(never random subcontractors) — crews are$t$,
        $t$(never random subcontractors): crews are$t$),
        $t$Lifetime Warranty — transferable$t$,
        $t$Lifetime Warranty: transferable$t$),
        $t$Standing Power — founded 1972$t$,
        $t$Standing Power: founded 1972$t$),
        $t$"never random subcontractors" — the word "random"$t$,
        $t$"never random subcontractors". The word "random"$t$),
        $t$asking what makes Reece different — you answer in terms$t$,
        $t$asking what makes Reece different. You answer in terms$t$)
  WHERE active AND id IN (3291, 3292)
    AND chunk_text LIKE $t$% — %$t$
    AND NOT coalesce(metadata ? 'prior_text_2026_10_06', false)
  RETURNING 1
) SELECT count(*) FROM u;

-- reece_canonical_kb 3252: the price script. expect 1
WITH u AS (
  UPDATE kb_embeddings SET
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('prior_text_2026_10_06', chunk_text),
    chunk_text = replace(replace(chunk_text,
        $t$Response: "Every home is different — window sizes, openings, glass
type — so we do an In-Home Assessment for accurate
numbers. The Protection Profile Review is the quick first step to get that
scheduled. Can I ask a couple quick questions about your home?"$t$,
        $t$Response: "Every home is different. Window sizes, openings, and glass type
all change the number, so a number now would just be a guess. We measure
at an In-Home Assessment, at no cost, and leave you written pricing.
What's got you looking at your windows right now?"$t$),
        $t$Every home is different — the investment depends on size, number$t$,
        $t$Every home is different. The investment depends on size, number$t$)
  WHERE active AND id IN (3252)
    AND chunk_text LIKE $t$%quick first step to get that%$t$
    AND NOT coalesce(metadata ? 'prior_text_2026_10_06', false)
  RETURNING 1
) SELECT count(*) FROM u;

-- Check: expect dashes = 0 on 3291, 3292, 3295 (3252 keeps one, in the
-- "just researching" script, which this change does not touch) and price_ppr = false.
SELECT json_agg(row_to_json(s)) FROM (
  SELECT id, source_doc,
         (length(chunk_text) - length(replace(chunk_text, '—', ''))) AS dashes,
         chunk_text LIKE '%quick first step to get that%' AS price_ppr
    FROM kb_embeddings WHERE id IN (3291, 3292, 3295, 3252) ORDER BY id) s;
