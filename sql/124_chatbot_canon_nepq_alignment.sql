-- sql/124_chatbot_canon_nepq_alignment.sql
-- LP Supabase. DATA ONLY — no DDL. Apply AFTER the PR that ships this file is
-- merged and deployed (the /n8n/kb/reembed route this relies on ships with it).
--
-- WHY (2026-09-23, Mark's canon skills + rulings): the chatbot's knowledge
-- library carried retired canon wording and wrong product facts, and the bot
-- quotes this library back to leads:
--   - crews: "in-house" / "our own crews" / "no subcontractors" (they are
--     factory-trained, Reece-certified crews, never random subcontractors)
--   - warranty: "no fine print" (acts of God are excluded, a transfer needs the
--     new owner registered within 15 days of closing, glass breakage becomes
--     20 years for a new owner)
--   - insurance: "premium reductions", "save thousands" (the carrier decides;
--     we never promise a number)
--   - "steel-reinforced" (metal-alloy reinforced, 3x stronger than aluminum)
--   - the 30-Day Price Guarantee, which is NOT offered
--   - "$3,800" fused with "Tampa" / "$28K" in the proof-points doc
-- Install time stays "1 to 2 days" (owner override of the handoff's 2-3 days).
--
-- HOW TO APPLY
--   Run each statement on its own. Each is wrapped
--     WITH u AS (... RETURNING 1) SELECT count(*) FROM u;
--   and carries the expected count in a comment. A different count means stop
--   and look — do not re-run blind. Every statement is guarded so a second run
--   touches 0 rows.
--
-- BACKUPS: before a row is overwritten its old text goes into `notes`
-- ("Prior text (canon 2026-09-23): ..."). kb_embeddings has no notes column,
-- so the old chunk goes into metadata->'prior_text' (never overwritten by a
-- second run).
--
-- AFTER APPLYING
--   1. POST /n8n/kb/reembed {"faqs": true}                      (8 edited + 6 new FAQs)
--   2. POST /n8n/kb/reembed {"chunk_ids": [ ...ids below... ]}  (in-place chunk edits)
--   3. node scripts/ingest-concierge-kb.js --only=reece_faq_core,reece_objection_playbook,reece_offer_ladder,reece_compliance_guardrails
--      (docs with a repo source file are re-ingested from it, replace:true)
--   4. Run the audit at the bottom — expect 0 rows.

-- ═══════════════════════════════════════════════════════════════════
-- 1. kb_faqs — rewrite 8 answers
-- ═══════════════════════════════════════════════════════════════════
-- Both canonical_answer AND answer_short: the FAQ embedding is built from
-- question_pattern + answer_short first (tier1-semantic-core.js), so fixing
-- only canonical_answer would leave the old wording in the vector.
-- embedding_hash = NULL makes the next sweep re-embed the row.

-- expect 8
WITH v(id, ca, short) AS (VALUES
  (1,  $t$Most installs take 1 to 2 days. Factory-trained, Reece-certified crews who work only on Reece projects do the work, with daily clean-up and a final walkthrough.$t$,
       $t$Most installs take 1 to 2 days, done by factory-trained, Reece-certified crews, with daily clean-up and a final walkthrough.$t$),
  (3,  $t$We specialize in vinyl impact windows. The frames are metal-alloy reinforced, 3 times stronger than aluminum, and built for Florida's climate.$t$,
       $t$Vinyl impact windows only. Metal-alloy reinforced frames, 3 times stronger than aluminum, built for Florida's climate.$t$),
  (5,  $t$Protection is not what you install. It's what you can prove. Code-verified installation, factory-trained, Reece-certified crews (never random subcontractors), a transferable double lifetime warranty, and a family company doing this since 1972.$t$,
       $t$Code-verified installation, factory-trained, Reece-certified crews (never random subcontractors), a transferable double lifetime warranty, and a family company since 1972.$t$),
  (7,  $t$Our Transferable Double Lifetime Warranty covers parts AND labor for life. It includes vinyl defects, glass seal failure, dust or film between the glass, glass breakage (lifetime for the original owner, 20 years for the next), and operation mechanics, with free service for life and no labor fees on warranty work. Hurricane and other storm damage isn't covered, because the warranty excludes acts of God. If you sell, it transfers when the new owner is registered within 15 days of closing, and no-fault glass breakage becomes 20 years for the new owner.$t$,
       $t$Lifetime parts and labor, free service on covered repairs. Storm damage isn't covered (acts of God). Transfers on sale when the new owner registers within 15 days.$t$),
  (10, $t$That's a question for your insurance carrier. What we do is install to current Florida code and document the work, so you have a clear record of what's on your home. Your carrier decides any discount. We never promise a number.$t$,
       $t$That's a question for your insurance carrier. We install to current Florida code and document the work. Your carrier decides any discount.$t$),
  (13, $t$Reece Windows & Doors. Family-owned since 1972, serving Florida since 2005, with factory-trained, Reece-certified crews.$t$,
       $t$Reece Windows & Doors. Family-owned since 1972, serving Florida since 2005.$t$),
  (17, $t$We don't sell shutters. Impact windows protect around the clock with nothing to put up before a storm, including when you're away. Shutters only protect if someone installs them in time.$t$,
       $t$We don't sell shutters. Impact windows protect around the clock with nothing to put up before a storm.$t$),
  (18, $t$Every home is different, so there's no honest number without measuring. Our in-home assessment takes about an hour and a half and leaves you with written pricing that's good for a full year, no cost and no obligation.$t$,
       $t$No honest number without measuring. The in-home assessment takes about an hour and a half and leaves written pricing good for a full year.$t$)
), u AS (
  UPDATE kb_faqs f
     SET notes = concat_ws(E'\n', f.notes,
                   'Prior text (canon 2026-09-23): ' || f.canonical_answer || ' || short: ' || coalesce(f.answer_short, '')),
         canonical_answer = v.ca,
         answer_short = v.short,
         embedding_hash = NULL,
         updated_at = now()
    FROM v
   WHERE f.id = v.id AND f.active AND f.canonical_answer IS DISTINCT FROM v.ca
  RETURNING 1
) SELECT count(*) FROM u;

-- ═══════════════════════════════════════════════════════════════════
-- 2. kb_faqs — 6 new FAQs (embedded by the sweep: no hash yet)
-- ═══════════════════════════════════════════════════════════════════

-- expect 6
WITH v(q, ca, short, k) AS (VALUES
  ($t$Does the warranty cover hurricane damage?$t$,
   $t$No. The warranty excludes acts of God, which includes hurricane damage. Storm damage is a question for your insurance carrier. What it covers for life is the vinyl, the glass seal, and free labor on covered repairs.$t$,
   $t$No. The warranty excludes acts of God, including hurricane damage; that's a question for your carrier. It covers the vinyl, glass seal and labor on covered repairs for life.$t$,
   'warranty_hurricane'),
  ($t$Does the warranty transfer if I sell?$t$,
   $t$Yes. The new owner needs to be registered within 15 days of closing. Coverage carries over, and no-fault glass breakage becomes 20 years for the new owner.$t$,
   $t$Yes, when the new owner is registered within 15 days of closing. No-fault glass breakage becomes 20 years for them.$t$,
   'warranty_transfer'),
  ($t$Do you sell shutters or garage doors?$t$,
   $t$No. We focus on impact windows and doors, the permanent protection on the home itself. We don't sell or install shutters or garage doors.$t$,
   $t$No. We focus on impact windows and doors. We don't sell or install shutters or garage doors.$t$,
   'scope_shutters_garage'),
  ($t$Where are you located?$t$,
   $t$Our main office is in St. Petersburg, and we serve Fort Lauderdale, Tampa, St. Petersburg, Sarasota, Fort Myers, Lakeland, Orlando, Jacksonville and surrounding areas.$t$,
   $t$Main office in St. Petersburg, serving Fort Lauderdale, Tampa, Sarasota, Fort Myers, Lakeland, Orlando, Jacksonville and surrounding areas.$t$,
   'location'),
  ($t$Why is there fog or condensation on my windows?$t$,
   $t$It depends where it is. Moisture on the inside surface comes from indoor humidity, not a defect, and a fan, dehumidifier or open blinds usually fix it. Fog between the two panes means a seal issue, which the lifetime glass warranty covers, so let us know and we'll get it looked at.$t$,
   $t$Inside-surface moisture is indoor humidity, not a defect. Fog between the panes is a seal issue the lifetime glass warranty covers.$t$,
   'service_condensation'),
  ($t$How do I clean my windows?$t$,
   $t$Rinse with clean water, then use mild soap and a soft cloth, out of direct sun. Never use a pressure washer, razor, abrasive pad or harsh chemicals, since those can damage the window and may void the warranty. Clean at least once a year, or monthly near the coast.$t$,
   $t$Clean water, mild soap and a soft cloth, out of direct sun. No pressure washer, razor, abrasives or harsh chemicals. Yearly, or monthly near the coast.$t$,
   'service_cleaning')
), u AS (
  INSERT INTO kb_faqs (question_pattern, canonical_answer, answer_short, channel, tier, active, kb_key, notes)
  SELECT v.q, v.ca, v.short, 'both', 'factual', true, v.k, 'Added 2026-09-23 (Mark canon)'
    FROM v
   WHERE NOT EXISTS (SELECT 1 FROM kb_faqs f WHERE f.active AND lower(f.question_pattern) = lower(v.q))
  RETURNING 1
) SELECT count(*) FROM u;

-- ═══════════════════════════════════════════════════════════════════
-- 3. kb_proof_points
-- ═══════════════════════════════════════════════════════════════════

-- 10 / 48 / 86 — crews. expect 3
WITH u AS (
  UPDATE kb_proof_points SET
    notes = concat_ws(E'\n', notes, 'Prior text (canon 2026-09-23): ' || claim),
    claim = 'Factory-trained, Reece-certified crews dedicated exclusively to Reece projects, never random subcontractors',
    updated_at = now()
  WHERE id IN (10, 48, 86) AND active
    AND claim <> 'Factory-trained, Reece-certified crews dedicated exclusively to Reece projects, never random subcontractors'
  RETURNING 1
) SELECT count(*) FROM u;

-- 11 / 49 / 87 — install time (stays 1 to 2 days). expect 3
WITH u AS (
  UPDATE kb_proof_points SET
    notes = concat_ws(E'\n', notes, 'Prior text (canon 2026-09-23): ' || claim),
    claim = 'Most installs take 1 to 2 days',
    updated_at = now()
  WHERE id IN (11, 49, 87) AND active AND claim <> 'Most installs take 1 to 2 days'
  RETURNING 1
) SELECT count(*) FROM u;

-- 20 / 58 / 96 — the 30-Day Price Guarantee is not offered. expect 3
WITH u AS (
  UPDATE kb_proof_points SET
    active = false,
    notes = concat_ws(E'\n', notes, 'Not offered — Mark 2026-09-23'),
    updated_at = now()
  WHERE id IN (20, 58, 96) AND active
  RETURNING 1
) SELECT count(*) FROM u;

-- 24 / 62 / 100 — claim. expect 3
WITH u AS (
  UPDATE kb_proof_points SET
    notes = concat_ws(E'\n', notes, 'Prior text (canon 2026-09-23): ' || claim),
    claim = 'Metal-alloy reinforced frames (3× stronger than aluminum) with multi-point locking',
    updated_at = now()
  WHERE id IN (24, 62, 100) AND active AND claim ILIKE '%steel-reinforced%'
  RETURNING 1
) SELECT count(*) FROM u;

-- 22 / 60 / 98 — the claim is clean; the EVIDENCE column still said steel. expect 3
WITH u AS (
  UPDATE kb_proof_points SET
    notes = concat_ws(E'\n', notes, 'Prior evidence (canon 2026-09-23): ' || evidence),
    evidence = 'Metal-alloy reinforced vinyl frames (3× stronger than aluminum) built for Florida HVHZ',
    updated_at = now()
  WHERE id IN (22, 60, 98) AND active AND evidence ILIKE '%steel-reinforced%'
  RETURNING 1
) SELECT count(*) FROM u;

-- 29 / 67 / 105 — insurance savings claim. expect 3
WITH u AS (
  UPDATE kb_proof_points SET
    notes = concat_ws(E'\n', notes, 'Prior text (canon 2026-09-23): ' || claim),
    claim = 'Code-verified installation, documented so the homeowner has a clear record; the insurance carrier decides any discount',
    updated_at = now()
  WHERE id IN (29, 67, 105) AND active AND claim ILIKE '%premium reductions%'
  RETURNING 1
) SELECT count(*) FROM u;

-- 117 / 123 — word lists. expect 2
WITH u AS (
  UPDATE kb_proof_points SET
    notes = concat_ws(E'\n', notes, 'Prior text (canon 2026-09-23): ' || claim),
    claim = 'Words to use: family, team, experts, investment, protection, security, craftsmanship, peace of mind, energy savings, Protection Profile Review, In-Home Assessment, Florida-engineered, factory-trained, Reece-certified crews, transferable double lifetime warranty, free service for life',
    updated_at = now()
  WHERE id IN (117, 123) AND active AND claim ILIKE '%penny-accurate%'
  RETURNING 1
) SELECT count(*) FROM u;

-- 119 / 125 — these are the "penny-accurate pricing" CLAIM rows, not word
-- lists. Same meaning, canon wording (the written price is good for a year). expect 2
WITH u AS (
  UPDATE kb_proof_points SET
    notes = concat_ws(E'\n', notes, 'Prior text (canon 2026-09-23): ' || claim),
    claim = 'Written pricing after an in-home measure, good for a full year, never a guess',
    updated_at = now()
  WHERE id IN (119, 125) AND active AND claim ILIKE '%penny-accurate%'
  RETURNING 1
) SELECT count(*) FROM u;

-- 13 / 51 / 89 (the Reece App) are deliberately untouched.

-- ═══════════════════════════════════════════════════════════════════
-- 4. kb_product_specs 1 / 13 / 25 — expect 3
-- ═══════════════════════════════════════════════════════════════════
WITH u AS (
  UPDATE kb_product_specs SET
    notes = concat_ws(E'\n', notes, 'Prior value (canon 2026-09-23): ' || value),
    value = 'Vinyl, metal-alloy reinforced (3× stronger than aluminum)',
    updated_at = now()
  WHERE id IN (1, 13, 25) AND active AND value ILIKE '%steel-reinforced%'
  RETURNING 1
) SELECT count(*) FROM u;

-- ═══════════════════════════════════════════════════════════════════
-- 5. kb_objection_scripts
-- ═══════════════════════════════════════════════════════════════════

-- 4 / 14 / 24 (trust). expect 3
WITH u AS (
  UPDATE kb_objection_scripts SET
    notes = concat_ws(E'\n', notes, 'Prior body (canon 2026-09-23): ' || body_template),
    body_template = $t$Our crews are factory-trained, Reece-certified and work only on Reece projects, never random subcontractors. Family-owned since 1972, serving Florida since 2005, with an A+ BBB rating. The transferable double lifetime warranty is backed by a company that's still going to be here when you need a service call in 2046.$t$,
    updated_at = now()
  WHERE id IN (4, 14, 24) AND active AND body_template ILIKE '%own factory-trained crews%'
  RETURNING 1
) SELECT count(*) FROM u;

-- 7 / 17 / 27 (been burned). expect 3
WITH u AS (
  UPDATE kb_objection_scripts SET
    notes = concat_ws(E'\n', notes, 'Prior body (canon 2026-09-23): ' || body_template),
    body_template = $t$Our crews are factory-trained, Reece-certified and work only on Reece projects, never random subcontractors. The transferable double lifetime warranty covers parts AND labor for life, so even if something happens five years from now, there's no surprise labor bill on covered work. We've been serving Florida since 2005 and are not going anywhere.$t$,
    updated_at = now()
  WHERE id IN (7, 17, 27) AND active AND body_template ILIKE 'No subcontractors.%'
  RETURNING 1
) SELECT count(*) FROM u;

-- ═══════════════════════════════════════════════════════════════════
-- 6. kb_story_arcs 1 / 2 / 5
-- ═══════════════════════════════════════════════════════════════════

-- SA1. expect 1
WITH u AS (
  UPDATE kb_story_arcs SET
    notes = concat_ws(E'\n', notes, 'Prior text (canon 2026-09-23): ' || problem_named || ' || ' || proof_points::text || ' || ' || example_paragraphs::text),
    problem_named = replace(problem_named, 'Most South Florida homes', 'Many Florida homes'),
    example_paragraphs = replace(example_paragraphs::text, 'Most South Florida homes', 'Many Florida homes')::jsonb,
    proof_points = replace(proof_points::text, 'Steel-reinforced vinyl frames', 'Metal-alloy reinforced vinyl frames (3× stronger than aluminum)')::jsonb,
    updated_at = now()
  WHERE id = 1 AND active AND (problem_named ILIKE '%South Florida%' OR proof_points::text ILIKE '%steel-reinforced%')
  RETURNING 1
) SELECT count(*) FROM u;

-- SA2 — crews. The old example also called the crews "employees", which the
-- compliance crew-wording hard line forbids. expect 1
WITH u AS (
  UPDATE kb_story_arcs SET
    notes = concat_ws(E'\n', notes, 'Prior text (canon 2026-09-23): ' || proof_points::text || ' || ' || example_paragraphs::text),
    proof_points = replace(replace(proof_points::text,
        'Our own factory-trained installation teams — no subs', 'Factory-trained, Reece-certified crews, never random subcontractors'),
        '50+ years family-owned, 20+ years in Florida', 'Family-owned since 1972, serving Florida since 2005')::jsonb,
    example_paragraphs = replace(example_paragraphs::text,
        'Our crews are factory-trained employees, not subcontractors,', 'Our crews are factory-trained and Reece-certified, never random subcontractors,')::jsonb,
    updated_at = now()
  WHERE id = 2 AND active AND proof_points::text ILIKE '%no subs%'
  RETURNING 1
) SELECT count(*) FROM u;

-- SA5 — no 30-Day guarantee, no insurance ROI. Only the two allowed
-- references: 7–15% energy savings (U.S. DOE) and 72¢ per dollar recouped
-- at resale (2025 Cost vs. Value, vinyl). expect 1
WITH u AS (
  UPDATE kb_story_arcs SET
    notes = concat_ws(E'\n', notes, 'Prior text (canon 2026-09-23): ' || core_belief || ' || ' || problem_named || ' || ' || proof_points::text || ' || ' || openers::text || ' || ' || example_paragraphs::text || ' || ' || do_not_say::text),
    core_belief = 'Impact windows are an investment with measurable energy and resale value, not just a cost.',
    problem_named = 'Most families think of windows as an expense. The math is closer to a two-way return: energy and resale.',
    proof_points = $j$[
      {"tier": "factual", "claim": "7–15% energy savings (U.S. DOE)"},
      {"tier": "factual", "claim": "72¢ per dollar recouped at resale (2025 Cost vs. Value, vinyl)"},
      {"tier": "factual", "claim": "0% APR financing available"},
      {"tier": "factual", "claim": "Conservation Glass reflects 90% of solar rays"},
      {"tier": "factual", "claim": "Warranty transfers to new owner — adds resale value"}
    ]$j$::jsonb,
    openers = $j$[
      "The way most families end up looking at it is a return, not just a cost.",
      "If you ran this as a spreadsheet, energy savings and resale value, the math usually surprises people."
    ]$j$::jsonb,
    example_paragraphs = $j$[
      "Most families come in thinking of windows as an expense. The math runs two ways: energy savings, where the U.S. DOE puts ENERGY STAR windows at 7–15%, and resale, where the 2025 Cost vs. Value report shows about 72¢ per dollar recouped for vinyl, with the warranty transferring to the next owner. The specialist walks through what that looks like for your home at the visit, never a promised number."
    ]$j$::jsonb,
    do_not_say = $j$[
      "promise a specific dollar return",
      "cite any figure other than the two approved references",
      "mention insurance savings or premiums",
      "quote pricing"
    ]$j$::jsonb,
    updated_at = now()
  WHERE id = 5 AND active AND proof_points::text ILIKE '%30-Day Price Guarantee%'
  RETURNING 1
) SELECT count(*) FROM u;

-- ═══════════════════════════════════════════════════════════════════
-- 7. kb_embeddings — docs with NO repo source file: corrected in place
-- ═══════════════════════════════════════════════════════════════════
-- These were ingested from outside this repo, so there is no file to fix and
-- re-ingest. Each chunk is corrected by exact substring, the old chunk kept in
-- metadata->'prior_text', and the vectors refreshed afterwards by
-- POST /n8n/kb/reembed with the ids listed per block. Chunks overlap, so a
-- phrase that straddles two chunks is replaced in both by the same replace().

-- reece_canonical_kb — ids 3248-3254. expect 6 (3248, 3249, 3250, 3252, 3253, 3254)
WITH u AS (
  UPDATE kb_embeddings SET
    metadata = CASE WHEN metadata ? 'prior_text' THEN metadata
                    ELSE coalesce(metadata, '{}'::jsonb) || jsonb_build_object('prior_text', chunk_text) END,
    source_doc_version = '2026-09-23-canon',
    chunk_text =
      replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
      replace(replace(replace(replace(replace(replace(replace(chunk_text,
        'In-house factory-trained installation teams (NOT subcontractors)',
        'Factory-trained, Reece-certified crews dedicated exclusively to Reece projects, never random subcontractors'),
        $t$vinyl-only, steel-reinforced frames with multi-point$t$,
        $t$vinyl-only, metal-alloy reinforced frames (3× stronger than aluminum) with multi-point$t$),
        $t$30-DAY PRICE GUARANTEE
If within 30 days of contract date you find any replacement windows
with ALL matching Reece features at a lower price, Reece will refund
the difference.

$t$, ''),
        $t$Most projects are completed in 1-2 days by our factory-trained
teams.$t$,
        $t$Most installs take 1 to 2 days, done by factory-trained,
Reece-certified crews.$t$),
        $t$They're steel-reinforced
and built$t$,
        $t$They're metal-alloy reinforced
(3× stronger than aluminum) and built$t$),
        $t$(1) Our own factory-trained installation teams — not
random subcontractors. (2) The strongest warranty in the industry —
transferable double lifetime on parts AND labor. (3) 50+ years as a
family company with thousands of 5-star reviews.$t$,
        $t$(1) Factory-trained, Reece-certified crews who work only on
Reece projects, never random subcontractors. (2) A transferable
double lifetime warranty on parts AND labor. (3) A family company
since 1972.$t$),
        $t$"Our warranty covers parts AND labor for life — most companies only cover parts"$t$,
        $t$"Our warranty covers parts AND labor for life, in writing"$t$),
        $t$Impact windows provide 24/7 protection without any action needed.
No putting up shutters before a storm. They also reduce energy bills,
lower insurance costs, and increase home value. Shutters only protect
when you remember to install them.$t$,
        $t$We don't sell shutters. Impact windows protect around the clock with
nothing to put up before a storm, including when you're away. Shutters
only protect if someone installs them in time.$t$),
        $t$We provide a free in-home
inspection to give you accurate numbers, not guesses.$t$,
        $t$Our In-Home Assessment takes about an hour and a half and leaves
you written pricing that's good for a full year, no cost and no obligation.$t$),
        $t$so we do a complimentary in-home inspection for accurate
numbers. The Review Session is the quick first step to get that
scheduled.$t$,
        $t$so we do an In-Home Assessment for accurate
numbers. The Protection Profile Review is the quick first step to get that
scheduled.$t$),
        'A quick Review Session can save hours of research',
        'A quick Protection Profile Review can save hours of research'),
        $t$We use our own factory-trained crews, not random
subcontractors.$t$,
        $t$Our crews are factory-trained and Reece-certified,
never random subcontractors.$t$),
        $t$Want to schedule a Review Session when you're both
available?$t$,
        $t$Want to schedule a Protection Profile Review when you're both
available?$t$),
        $t$Actually, certified impact windows can lower premiums
significantly. Plus, it's prevention your insurance company can't
deny — unlike waiting for a claim that might get rejected. The
savings start the day we install.$t$,
        $t$That's a question for your insurance carrier. What we do is install
to current Florida code and document the work, so you have a clear
record of what's on your home. Your carrier decides any discount.$t$),
        $t$Plus, insurance savings start the day
we install. Want to at least lock in your spot?$t$,
        $t$Want me to find a time that works?$t$),
        $t$Reece has been in Florida for 20+ years (NC since 1972)$t$,
        $t$Reece has been family-owned since 1972 and serving Florida since 2005$t$),
        $t$using your actual
bills and premiums.$t$,
        $t$using your actual
energy bills.$t$)
  WHERE source_doc = 'reece_canonical_kb' AND active AND id IN (3248, 3249, 3250, 3252, 3253, 3254)
    AND NOT coalesce(metadata ? 'prior_text', false)
  RETURNING 1
) SELECT count(*) FROM u;

-- reece_avatar_company — ids 3257-3260. expect 4
WITH u AS (
  UPDATE kb_embeddings SET
    metadata = CASE WHEN metadata ? 'prior_text' THEN metadata
                    ELSE coalesce(metadata, '{}'::jsonb) || jsonb_build_object('prior_text', chunk_text) END,
    source_doc_version = '2026-09-23-canon',
    -- This doc came from a PDF: labels are followed by private-use glyphs
    -- (U+E090-E09D), so anchors avoid them and the timeline line, which has
    -- them INSIDE it ("1<glyph>2 days"), uses a one-character wildcard.
    chunk_text = regexp_replace(
      replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
      replace(replace(chunk_text,
        'In-house factory installation teams, never random subcontractors',
        'Factory-trained, Reece-certified crews, never random subcontractors'),
        'Penny-accurate pricing (exact quotes, no estimates)',
        'Written pricing after an in-home measure, good for a full year'),
        $t$Steel reinforced frames
Multi-point$t$,
        $t$Metal-alloy reinforced frames (3× stronger than aluminum)
Multi-point$t$),
        'Vinyl only - steel-reinforced, energy efficient)',
        'Vinyl only - metal-alloy reinforced, energy efficient)'),
        'Provides penny-accurate quote same day.',
        'Leaves written pricing, good for a full year.'),
        'Steel-reinforced frames',
        'Metal-alloy reinforced frames (3× stronger than aluminum)'),
        ' Own crews, never random subcontractors.',
        ' Factory-trained, Reece-certified crews, never random subcontractors.'),
        'Energy savings + insurance discounts flip the math long-term.',
        'Energy savings and resale value flip the math long-term.'),
        'Provides exact quote down to the penny',
        'Leaves written pricing, good for a full year'),
        'Window Protection Estimate Details',
        'In-Home Assessment Details'),
        'energy savings, complimentary estimate, Window Protection Estimate,',
        'energy savings, Protection Profile Review, In-Home Assessment,'),
        'penny-accurate pricing, Florida-engineered, in-house team, transferable double',
        'Florida-engineered, factory-trained, Reece-certified crews, transferable double'),
      'Most homes done in 1.2 days\. 8.12 weeks', 'Most homes done in 1 to 2 days. 8 to 12 weeks')
  WHERE source_doc = 'reece_avatar_company' AND active AND id IN (3257, 3258, 3259, 3260)
    AND NOT coalesce(metadata ? 'prior_text', false)
  RETURNING 1
) SELECT count(*) FROM u;

-- reece_situation_handlers — id 3278. "sleep easier during hurricane season"
-- becomes "peace of mind", which the same list already carries, so the
-- phrase is simply dropped. expect 1
WITH u AS (
  UPDATE kb_embeddings SET
    metadata = CASE WHEN metadata ? 'prior_text' THEN metadata
                    ELSE coalesce(metadata, '{}'::jsonb) || jsonb_build_object('prior_text', chunk_text) END,
    source_doc_version = '2026-09-23-canon',
    chunk_text = replace(replace(chunk_text,
        '"impact protection," "sleep easier during hurricane season"', '"impact protection"'),
        $t$impact testing, steel-
reinforced frames$t$,
        $t$impact testing, metal-alloy
reinforced frames (3× stronger than aluminum)$t$)
  WHERE source_doc = 'reece_situation_handlers' AND active AND id = 3278
    AND NOT coalesce(metadata ? 'prior_text', false)
  RETURNING 1
) SELECT count(*) FROM u;

-- reece_content_playbook — ids 2226, 2229, 2231, 2232, 2234, 2235, 2236, 2240, 2243, 2244.
-- The two "$28,000+" lines are an unapproved statistic and are deleted. The
-- two lines that tied "South Florida" to 1972 conflated the founding date
-- with Florida and get the canon brand line. expect 10
WITH u AS (
  UPDATE kb_embeddings SET
    metadata = CASE WHEN metadata ? 'prior_text' THEN metadata
                    ELSE coalesce(metadata, '{}'::jsonb) || jsonb_build_object('prior_text', chunk_text) END,
    source_doc_version = '2026-09-23-canon',
    chunk_text =
      replace(replace(replace(replace(replace(replace(replace(chunk_text,
        'Reece has been in South Florida since 1972. 50+ years.',
        'Reece has been family-owned since 1972 and serving Florida since 2005. 50+ years.'),
        'protecting South Florida families since 1972.',
        'family-owned since 1972, serving Florida since 2005.'),
        'South Florida', 'Florida'),
        'Review Session phone call', 'Protection Profile Review phone call'),
        E'Average property value increase after installation: $28,000+.\n', ''),
        'Average property value increase after installation: $28,000+.', ''),
        E'Property value increase: average $28,000+ on resale.\n', '')
  WHERE source_doc = 'reece_content_playbook' AND active
    AND id IN (2226, 2229, 2231, 2232, 2234, 2235, 2236, 2240, 2243, 2244)
    AND NOT coalesce(metadata ? 'prior_text', false)
  RETURNING 1
) SELECT count(*) FROM u;

-- reece_proof_points — id 3290. Four references become five (the Irma line,
-- verbatim), and #1 stops fusing the $3,800 family with Tampa and a $28K
-- project: P3 carries no city and never shares a message with another story.
-- The "safe answer" also promised premium savings; it now uses the
-- insurance script. expect 1
WITH u AS (
  UPDATE kb_embeddings SET
    metadata = CASE WHEN metadata ? 'prior_text' THEN metadata
                    ELSE coalesce(metadata, '{}'::jsonb) || jsonb_build_object('prior_text', chunk_text) END,
    source_doc_version = '2026-09-23-canon',
    chunk_text =
      replace(replace(replace(replace(replace(replace(chunk_text,
        'THE FOUR PUBLIC REFERENCES', 'THE FIVE PUBLIC REFERENCES'),
        'these are the four — and only four — statistics', 'these are the five — and only five — statistics'),
        $t$Source: a Tampa family's own filing on a $28K project.$t$,
        $t$Source: that family's own filing. No city, and never in the same message as any other family's story.$t$),
        $t$("many Florida homeowners see meaningful reductions")$t$,
        $t$("that's a question for your insurance carrier; we install to code and document the work")$t$),
        $t$   Hard line: cite by name only. Never paraphrase the statute, never imply Reece interprets it or decides how it applies to anyone.$t$,
        $t$   Hard line: cite by name only. Never paraphrase the statute, never imply Reece interprets it or decides how it applies to anyone.

5. Hurricane Irma unpaid claims.
   "31.9% of Florida homeowner claims from Hurricane Irma went unpaid (Florida Office of Insurance Regulation)."
   Hard line: always "went unpaid", never "denied", never rounded, past event only.$t$),
        $t$"Many Florida homeowners save meaningfully on premiums after installing, and we give you the documentation your carrier needs — your carrier makes the final call on your number."$t$,
        $t$"That's a question for your insurance carrier. What we do is install to current Florida code and document the work, so you have a clear record of what's on your home. Your carrier decides any discount. We never promise a number."$t$)
  WHERE source_doc = 'reece_proof_points' AND active AND id = 3290
    AND NOT coalesce(metadata ? 'prior_text', false)
  RETURNING 1
) SELECT count(*) FROM u;

-- Chunk ids to re-embed after the blocks above:
--   {"chunk_ids": [3248,3249,3250,3252,3253,3254, 3257,3258,3259,3260, 3278,
--                  2226,2229,2231,2232,2234,2235,2236,2240,2243,2244, 3290]}

-- ═══════════════════════════════════════════════════════════════════
-- 8. agentic_messaging_prompts — CHECK ONLY
-- ═══════════════════════════════════════════════════════════════════
-- Read on 2026-09-23: the active S4.5 rows already keep P3 (the $3,800
-- Premium-Drop Family, no city) and P7 (the Tampa $28,000 denial) apart —
-- Mark re-versioned them to v3 that day — and no active row puts the two in
-- one line. The fusion the handoff describes was in the reece_proof_points
-- doc, fixed in section 7. This must return 0 rows; if it does not, fix the
-- named prompt through the bot-feedback draft/activate flow, not by SQL.
SELECT json_agg(row_to_json(s)) FROM (
  SELECT prompt_code, (regexp_matches(system_prompt || E'\n' || coalesce(user_prompt_template, ''),
    '([^\n]*(Tampa[^\n]*3,800|3,800[^\n]*Tampa|3,800[^\n]*28,000|28,000[^\n]*3,800)[^\n]*)', 'g'))[1] AS line
  FROM agentic_messaging_prompts WHERE active
) s;

-- ═══════════════════════════════════════════════════════════════════
-- 9. AUDIT — every text column, active rows only. Expect 0 rows.
-- ═══════════════════════════════════════════════════════════════════
-- Whole-row text minus the columns that hold backups or vectors (notes,
-- metadata->prior_text, embedding*), so a phrase hiding in a secondary column
-- (evidence, answer_short, comparison_context, do_not_use, ...) is caught.
-- Word-start anchored (\m) so a lead's own question "your own crews" is not
-- read as our claim "our own crews". Excluded on purpose: reece_category_truth
-- and the banned-phrase lists in reece_compliance_guardrails, which name
-- these words in order to ban them.
WITH src AS (
  SELECT 'kb_faqs' t, id::text id, (to_jsonb(x) - 'notes' - 'embedding' - 'embedding_hash' - 'embedded_at')::text txt FROM kb_faqs x WHERE active
  UNION ALL SELECT 'kb_proof_points', id::text, (to_jsonb(x) - 'notes')::text FROM kb_proof_points x WHERE active
  UNION ALL SELECT 'kb_product_specs', id::text, (to_jsonb(x) - 'notes')::text FROM kb_product_specs x WHERE active
  UNION ALL SELECT 'kb_objection_scripts', id::text, (to_jsonb(x) - 'notes')::text FROM kb_objection_scripts x WHERE active
  UNION ALL SELECT 'kb_story_arcs', id::text, (to_jsonb(x) - 'notes')::text FROM kb_story_arcs x WHERE active
  UNION ALL SELECT 'kb_embeddings:' || source_doc, id::text, chunk_text || ' ' || coalesce((metadata - 'prior_text')::text, '')
    FROM kb_embeddings
   WHERE active AND source_doc LIKE 'reece_%'
     AND source_doc NOT IN ('reece_category_truth', 'reece_compliance_guardrails')
  -- The guardrails doc is audited too, minus its banned-phrase lists: only
  -- the part after the hard-reject list (the statistics rule) is checked.
  UNION ALL SELECT 'kb_embeddings:reece_compliance_guardrails', id::text,
         substring(chunk_text from position('NO INVENTED STATISTICS' in chunk_text))
    FROM kb_embeddings
   WHERE active AND source_doc = 'reece_compliance_guardrails' AND chunk_text LIKE '%NO INVENTED STATISTICS%'
), pats(p) AS (VALUES
  ('in-house'), ('our own crews'), ('own factory-trained'), ('no subcontractors'), ('we don''t subcontract'),
  ('no fine print'), ('free in-home'), ('free estimate'), ('free inspection'), ('complimentary estimate'),
  ('steel-reinforced'), ('steel reinforced'), ('30-Day Price Guarantee'), ('premium reductions'), ('save thousands'),
  ('penny-accurate'), ('Review Session'), ('sleep easier'), ('28,000\+'), ('four public references')
)
SELECT t, p, string_agg(id, ',' ORDER BY id) ids
  FROM src JOIN pats ON src.txt ~* ('\m' || p)
 GROUP BY t, p
 ORDER BY t, p;
