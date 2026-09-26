-- 2026-09-25 — Golden KB v1: the corpus the shadow search was missing.
--
-- WHY. Shadow mode gave a WRONG top match on 4 of 9 real questions. The cause
-- was not the similarity floor — it was corpus gaps. Ask about a pressure
-- rating when no pressure-rating FAQ exists and the search does not return
-- nothing; it returns the nearest row, confidently. "What is the pressure
-- rating of your windows?" matched "Do you sell aluminum or vinyl windows?" at
-- 0.515, and a DP rating is a code claim — the worst place to be confidently
-- wrong.
--
-- SOURCE. Two documents supplied by Mark 2026-09-25: Golden KB Core 5 (the
-- five gap-fills, written against exactly those wrong matches) and Golden KB
-- Library v1.1 (31 more). Both reviewed against antifragile-copywriter and
-- canon on that date.
--
-- ONE ROW PER TOPIC. 16 live rows are retired here rather than left beside
-- their golden replacements. A near-duplicate row is not harmless: two rows
-- competing for the same question is precisely what produced the junk matches
-- in the shadow data. Nothing is deleted — `active = false` is the same
-- retirement the 36 older versions already carry.
--
-- ALTERNATE PHRASINGS. buildFaqEmbedText (src/knowledge/tier1-semantic-core.js)
-- embeds `question_pattern` plus the first 240 chars of the answer. So every
-- "Also asked as" line is folded into question_pattern, pipe-separated: one
-- row, one embedding, every phrasing represented.
--
-- MARK'S RULINGS, 2026-09-25:
--   * Replace duplicates rather than keep both.
--   * KEEP the 0% APR financing claim — LIB-X06 below is amended to state it,
--     departing from the source document, which asked for confirmation.
--   * No solar product and no referral partner — confirmed.
--   * Roofing is no longer offered — confirmed, so FAQ #14 retires here too.
--   * Single-hung: NOT confirmed either way. The answer below lists the line
--     without claiming single-hung is unavailable, so it cannot state anything
--     false in either case. If single-hung IS offered, add it to KB-02.
--
-- Embeddings are NOT set here. The sweep (embedFaqsSweep) picks up any active
-- row whose content hash changed, so these embed on its next pass.

BEGIN;

-- ── 1. Retire the 16 rows the golden set replaces ────────────────────────
-- #14 (roofing) has no golden replacement: it retires because the service
-- ended, and because KB-03/LIB-P10 now say "impact windows and doors" only.
UPDATE kb_faqs SET active = false, updated_at = now()
WHERE id IN (1, 3, 4, 7, 8, 10, 14, 18, 55, 57, 58, 59, 60, 61, 62, 63)
  AND active = true;

-- ── 2. The 36 golden entries ─────────────────────────────────────────────
INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, channel, tier, active, notes) VALUES

-- ===== Core 5: the gap-fills, one per observed wrong match =====
('KB-01',
 $$What is the pressure (DP) rating? | What's the DP rating? | What pressure are they rated for? | What's the wind load rating? | Do they meet code? | What's the design pressure?$$,
 $$Our impact windows are approved for Florida's strictest code zone, the High Velocity Hurricane Zone, including Miami-Dade. The exact rating depends on each window's size and spot on your home, so we don't guess. A specialist pulls the numbers for every opening. Want me to set that up?$$,
 'both', 'factual', true,
 $$Safety claim. NEVER give a DP number in chat. Source: product knowledge ch03 (HVHZ / Miami-Dade approval). Fixes the 0.515 wrong match to "aluminum or vinyl".$$),

('KB-02',
 $$What window styles do you offer? | Single hung or double hung? | Do you have sliders? | What kinds of windows do you sell? | Do you do casement windows? | What styles come in impact?$$,
 $$We offer double-hung, sliders, casements, awnings, picture, bay and bow, and garden windows, plus sliding patio doors. On a double-hung both sashes move and tilt in for easy cleaning. Which rooms are you thinking about?$$,
 'both', 'factual', true,
 $$Source: product ch01. Single-hung is absent from the list but NOT denied — Mark did not confirm the drop 2026-09-25, so the answer stays true either way. Add it if it is in the line.$$),

('KB-03',
 $$Do you sell solar? | Do you sell solar panels? | Do you do solar? | Looking into solar to save on electricity | Do you install solar?$$,
 $$No, we focus only on impact windows and doors. If lower bills are the goal, our glass is built to block heat and UV coming through your windows. Is energy the main goal, or is storm protection part of it too?$$,
 'both', 'factual', true,
 $$No savings promise. Mark confirmed 2026-09-25: no solar product, no referral partner. Fixes two wrong matches (0.452 to aluminum/vinyl, 0.387 to financing).$$),

('KB-04',
 $$Who does the install? | Who actually does the install? | Do you use subcontractors? | Are your installers your own people? | Who puts the windows in?$$,
 $$Every install is done by factory-trained, Reece-certified crews who work only on Reece projects. Never random subcontractors. Want me to set up a time for a specialist to walk you through it?$$,
 'both', 'factual', true,
 $$LOCKED crew wording (Canon Change Note v2.0). BANNED: "our own crews", "we don't subcontract". Replaces #57. Fixes the 0.501 wrong match to install duration.$$),

('KB-05',
 $$How long does installation take? | How many days is the install? | How long will you be at my house? | How long does it take to put them in? | How long is the job?$$,
 $$Most installs take 1 to 2 days, depending on how many windows and doors you're doing. How many openings are you thinking about?$$,
 'both', 'factual', true,
 $$Mark's ruling 2026-09-23: 1 to 2 days, not 2 to 3. Replaces #1.$$),

-- ===== Product & Performance (11) =====
('LIB-P01',
 $$Are your windows hurricane-proof? | Will they survive a hurricane? | Are they storm-proof? | Can a hurricane break them?$$,
 $$No window is hurricane-proof, and we won't tell you otherwise. Our impact glass is tested against several hits from a 9 lb 2x4 at 50 feet per second, and it's approved for the High Velocity Hurricane Zone, including Miami-Dade.$$,
 'both', 'factual', true,
 $$NEVER "hurricane-proof" or "storm-proof". Source: product ch03.$$),

('LIB-P02',
 $$What happens if something hits the glass? | Does impact glass break? | Will the glass shatter? | What if a branch hits it?$$,
 $$Impact glass can crack, but it's laminated, so it stays bonded together instead of shattering into your home. That helps keep wind, rain, and debris outside where they belong.$$,
 'both', 'factual', true, $$Source: product ch03.$$),

('LIB-P03',
 $$Are all your windows impact windows? | Is every window impact-rated? | Do I have to get impact? | Do you sell non-impact windows?$$,
 $$Not every window in our line is impact-rated. A specialist checks each opening and matches it to the right window for your home and your area's code. Want me to set that up?$$,
 'both', 'factual', true, $$Source: product ch03.$$),

('LIB-P04',
 -- The customer phrasing leads DELIBERATELY. With "Why vinyl instead of
 -- aluminum?" first, "Do you sell aluminum windows?" was won by LIB-P09
 -- (doors) at 0.510 — the LEADING phrase dominates the embedding, so the
 -- most-asked wording goes first. Verified 0.510 wrong -> 0.562 right.
 $$Do you sell aluminum or vinyl windows? | Why vinyl instead of aluminum? | Isn't aluminum stronger? | What are the frames made of? | Are vinyl frames strong enough? | I'm only interested in aluminum windows.$$,
 $$Our vinyl frames are reinforced with a metal alloy, and the manufacturer rates them 3 times stronger than aluminum. They're also backed for life against pitting, corroding, and cracking.$$,
 'both', 'factual', true,
 $$Attribute the strength claim to the MANUFACTURER. Source: product ch04/ch05. Replaces #3.$$),

('LIB-P05',
 $$Do impact windows help with noise? | Will it be quieter inside? | Do they block traffic noise? | Are they soundproof?$$,
 $$Yes, the laminated glass helps cut down outside noise. They aren't soundproof, but they do help keep the inside of your home quieter.$$,
 'both', 'factual', true,
 $$NEVER "soundproof". Do not attach STC or 50% figures to impact units.$$),

('LIB-P06',
 $$Will they stop my furniture from fading? | Do they block UV? | Will my floors fade? | Do they protect from the sun?$$,
 $$Yes. Our glass is built to block UV rays, a major cause of fading on floors, furniture, and drapes.$$,
 'both', 'factual', true,
 $$The 99% UV figure is for standard Conservation Glass — do NOT quote it for impact.$$),

('LIB-P07',
 $$What colors do the frames come in? | Do you have tan windows? | Can I get a wood look? | What colors are available?$$,
 $$Frames come in Euro-White, Solid Tan, White/Tan, White/Brown, and Woodgrain/White. Which look fits your home best?$$,
 'both', 'factual', true, $$Source: product ch01.$$),

('LIB-P08',
 $$Can I get grids or a decorative look? | Do you have grids? | Can I get colonial windows? | Do you do prairie style?$$,
 $$Yes. Grids sit inside the glass, so there's nothing extra to clean, and come in Colonial, Diamond, Prairie, and Classic Double Prairie patterns in white, tan, or dark oak.$$,
 'both', 'factual', true, $$Source: product ch01.$$),

('LIB-P09',
 $$Do you sell doors? | Do you do patio doors? | Do you have impact sliding doors? | Do you replace doors?$$,
 $$Yes, we do impact windows and doors, including sliding patio doors. A specialist can look at your doors and windows in the same visit. Are you thinking doors only, or windows too?$$,
 'both', 'factual', true, $$Source: canon company facts.$$),

('LIB-P10',
 $$Do you do shutters or garage doors? | Do you sell hurricane shutters? | Can you replace my garage door? | Do you do accordion shutters?$$,
 $$We don't offer shutters or garage doors. We focus on impact windows and doors, so there's nothing to put up before a storm.$$,
 'both', 'factual', true,
 $$Source: canon company facts (no shutters, no garage doors). Replaces #59. #17 (impact vs shutters comparison) is a different question and stays active.$$),

('LIB-P11',
 $$Do you check the windows I already have? | Can you tell if my windows are impact? | Is my window really impact-rated? | Can you inspect my current windows?$$,
 $$Yes. During the visit a specialist checks every opening for condition, age, install quality, seals, and code compliance, so you know exactly where your home stands. Want me to set that up?$$,
 'both', 'factual', true,
 $$Mark's ruling 2026-09-23 — Reece DOES inspect existing windows. NEVER frame it as an insurance-paperwork audit.$$),

-- ===== Company & Trust (4) =====
('LIB-C01',
 $$How long have you been in business? | Are you a new company? | How old is Reece? | When did you start?$$,
 $$Reece has been family-owned since 1972, when the business started in North Carolina, and we've been serving Florida homeowners since 2005.$$,
 'both', 'factual', true,
 $$NEVER conflate 1972 NC with 2005 FL. NEVER "founded in Florida".$$),

('LIB-C02',
 $$Are you licensed? | What's your license number? | Are you insured and licensed? | Are you a real contractor?$$,
 $$Yes. Reece is a licensed Florida contractor, CGC#1507607, with an A+ rating from the BBB.$$,
 'both', 'factual', true,
 $$Source: canon company facts. "Insured" is NOT in canon — do not add it.$$),

('LIB-C03',
 $$What areas do you serve? | Do you come to my area? | Do you work in Orlando? | Where are you located?$$,
 $$We're based in St. Petersburg and serve Fort Lauderdale, Tampa, St. Petersburg, Sarasota, Fort Myers, Lakeland, Orlando, and Jacksonville. Send me your zip code and I'll confirm we cover your home.$$,
 'both', 'factual', true,
 $$Bot should run the zip through check_service_area before confirming. Replaces #4 and #58.$$),

('LIB-C04',
 $$Are you a local company? | Are you a national chain? | Is this a franchise? | Is Reece family-owned?$$,
 $$Yes. Reece is family-owned and headquartered in St. Petersburg, and we've been serving Florida homeowners since 2005.$$,
 'both', 'factual', true, $$Source: canon company facts.$$),

-- ===== Warranty & Service (6) =====
('LIB-W01',
 $$What warranty do you offer? | Is there a lifetime warranty? | What's covered? | How long is the warranty? | What does the warranty cover?$$,
 $$You get a transferable double lifetime warranty. The vinyl and the insulated glass are covered for life, and our Free Service Pledge covers labor and materials on covered service for as long as you own them.$$,
 'both', 'factual', true, $$Source: product ch05. Replaces #7.$$),

('LIB-W02',
 $$Does the warranty transfer if I sell my home? | Is the warranty transferable? | Will the new owner be covered? | What if I move?$$,
 $$Yes, it transfers. Notice just needs to be sent within 15 days of closing, and glass breakage coverage becomes 20 years for the new owner.$$,
 'both', 'factual', true,
 $$Fine print REQUIRED (canon rule). Source: product ch05. Replaces #61.$$),

('LIB-W03',
 $$Does the warranty cover hurricane damage? | If a storm breaks it, are we covered? | Does it cover acts of God? | What if a hurricane damages them?$$,
 $$No. Acts of God, like hurricanes, are excluded. The warranty covers the product itself, like the frame and glass seals, for life.$$,
 'both', 'factual', true,
 $$Fine print REQUIRED. NEVER imply storm coverage. Replaces #62.$$),

('LIB-W04',
 $$What if my glass breaks by accident? | My kid hit the window with a ball | Is broken glass covered? | Accidental breakage?$$,
 $$Accidental glass breakage is covered for the original homeowner for life. Replacement glass is free, and the labor is covered under our Free Service Pledge.$$,
 'both', 'factual', true,
 $$Accidental breakage is NOT an act of God — the two answers must stay distinct. Source: product ch05.$$),

('LIB-W05',
 $$There's fog inside my window. Is that covered? | My window looks cloudy | There's moisture between the panes | Condensation on my windows$$,
 $$If the fog is between the two panes, that's a seal issue and it's covered under the glass warranty. If it's on the inside surface of the glass, that's humidity in the home, not a defect.$$,
 'both', 'factual', true,
 $$Source: product decision rules. Replaces #60.$$),

('LIB-W06',
 $$How do I clean my windows? | Can I pressure wash them? | What should I use to clean them? | How often should I clean them?$$,
 $$Rinse with clean water first, then use mild soap and a soft cloth. Never use a pressure washer, razor, or harsh chemicals. If you're near the coast, clean them monthly; otherwise at least once a year.$$,
 'both', 'factual', true,
 $$Source: product care rules. Replaces #63.$$),

-- ===== Insurance (compliance) (4) =====
('LIB-I01',
 $$Will insurance pay for new windows? | Can I file a claim for windows? | Does insurance cover replacement? | Will my insurance cover this? | Do impact windows help with insurance?$$,
 $$We're a contractor. We install, document, and warrant, but we don't interpret policies or predict what an insurer will cover. Your agent is the best person to ask about your policy.$$,
 'both', 'factual', true,
 $$NEVER predict claim outcomes. NEVER name a carrier. Replaces #10.$$),

('LIB-I02',
 $$Do impact windows get me a discount? | Is there a wind mitigation discount? | Will I save on my premium? | What is wind mitigation?$$,
 $$Florida has a wind mitigation discount law, Florida Statute 627.0629. Your agent can tell you how it applies to your policy.$$,
 'both', 'factual', true,
 $$Cite the statute by name, NEVER interpret it. No savings promise.$$),

('LIB-I03',
 $$Do you handle the insurance paperwork? | Will you file with my insurance? | Can you deal with my insurance company? | Do you do the wind mitigation form?$$,
 $$We don't handle insurance paperwork. Every Reece install is documented and code-verified, and you keep those records for your own files.$$,
 'both', 'factual', true,
 $$Canon Tier 4 language. NEVER offer "insurance paperwork" as a service.$$),

('LIB-I04',
 $$Which insurance company should I use? | Who's the best insurer? | Do you work with a certain insurance company? | Can you recommend an insurance agent?$$,
 $$We don't recommend or work with any specific insurance company. A licensed agent is the right person to help you compare options.$$,
 'both', 'factual', true, $$NEVER name a carrier.$$),

-- ===== Pricing & Process (6) =====
('LIB-X01',
 $$How much do impact windows cost? | Can you give me a price? | Ballpark cost? | How much for my house?$$,
 $$Every home is custom to Florida code, so we don't quote prices over text. A specialist measures at a no-cost in-home visit, and your pricing is good for a full year. Would mornings or afternoons work better?$$,
 'both', 'factual', true,
 $$NEVER quote numbers. Mark's ruling: the in-home visit is the offer for price shoppers. NEVER "free estimate". Replaces #18.$$),

('LIB-X02',
 $$How long is the in-home appointment? | How long will the visit take? | How much time do I need? | How long is the assessment?$$,
 $$Plan for about an hour and a half. A specialist checks every opening, walks you through your options, and you leave with pricing that's good for a full year.$$,
 'both', 'factual', true,
 $$Source: canon ch13. Replaces #55. #12 (WHY it takes 90 minutes) is a different question and stays active.$$),

('LIB-X03',
 $$Is there a cost for the appointment? | Do you charge to come out? | Is the visit free? | Is there any obligation?$$,
 $$There's no cost and no obligation. It's a chance to see exactly where your home stands. Want me to find you a time?$$,
 'both', 'factual', true,
 $$NEVER call it a "free estimate" or "free inspection".$$),

('LIB-X04',
 $$What is the Protection Profile Review? | What's the phone call about? | What happens on the call? | What is the 15-minute call?$$,
 $$It's a quick 15-minute call where a specialist walks you through where your home stands. No cost, no obligation. Want me to set one up?$$,
 'both', 'factual', true,
 $$LOCKED name: "Protection Profile Review". Source: canon ch14.$$),

('LIB-X05',
 $$How long is the price good for? | Does the quote expire? | Can I wait to decide? | How long do I have to decide?$$,
 $$The pricing from your in-home visit is good for a full year, so you can take the time you need.$$,
 'both', 'factual', true,
 $$Mark's ruling 2026-09-23. There is NO 30-Day Price Guarantee.$$),

('LIB-X06',
 $$Do you offer financing? | Can I make monthly payments? | Do you have payment plans? | Is there 0% financing?$$,
 $$Yes, we offer 0% APR financing so you can protect your home now and pay over time. A specialist walks you through the terms at the visit so you can pick a monthly amount that fits.$$,
 'both', 'factual', true,
 $$Mark's ruling 2026-09-25: KEEP the 0% APR claim. This DEPARTS from Golden KB Library v1.1, which asked for confirmation before stating it. Beyond 0% APR, quote no rates or terms in chat (canon ch13). Replaces #8.$$);

-- ── 3. Post-ingest corrections, found by re-probing ─────────────────────
-- #2 is a legacy row with no alternate phrasings, and it lost its own
-- question to LIB-P11 (inspect existing windows) by 0.009 — close, but the
-- right answer to a REPAIR question is this one, not the inspection one.
-- Verified 0.556 (2nd) -> 0.675 (1st, clear of LIB-P11 at 0.565).
UPDATE kb_faqs
SET question_pattern = $$Does Reece repair old windows? | Can you just fix the windows I already have? | Can you repair my windows? | Do you do window repair? | Can you fix my existing windows?$$,
    updated_at = now()
WHERE id = 2 AND active = true;

-- ── 4. Live-traffic corrections, 2026-09-26 ─────────────────────────────
-- Read from the first live `mode = 'live'` FAQ turns. Both answers that went
-- out were CORRECT, so nothing here is a customer-facing defect — but in both
-- cases being right depended on the model overruling what retrieval handed it,
-- which is a thin margin, not a design.

-- 4a. A pure garage-door question lost to LIB-P09 ("yes, we do doors") by
-- 0.015, because LIB-P10 led with the compound "shutters or garage doors"
-- phrasing. The leading phrase dominates the vector (buildFaqEmbedText), so
-- lead with what people actually type — same fix as LIB-P04 and #2 above.
-- Verified: 0.635 (2nd, behind LIB-P09 0.651) -> 0.681 (1st, LIB-P09 0.651).
-- Regression-checked: "Do you sell hurricane shutters?" still lands here
-- (0.725), and LIB-P09 still wins "Do you sell doors?" (0.701) and
-- "Do you do patio doors?" (0.757).
UPDATE kb_faqs
SET question_pattern = $$Do you sell garage doors? | Can you replace my garage door? | Do you do shutters or garage doors? | Do you sell hurricane shutters? | Do you do accordion shutters?$$,
    embedding = NULL, embedded_at = NULL, embedding_hash = NULL,
    updated_at = now()
WHERE id = 78 AND kb_key = 'LIB-P10';

-- 4b. Roofing had NO answer in the corpus at all: retiring #14 ("Roofing is
-- Southeast Florida only") in section 1 above left a hole, and a live lead
-- walked straight into it ("How about roofing? I saw an old ad many years ago
-- that you guys do roofing"). The three FAQs retrieval offered were all
-- irrelevant (top 0.405); the model answered "No roofing" from elsewhere.
-- Wording acknowledges the history rather than implying we never did it —
-- Mark's ruling 2026-09-26 — because leads still remember the old ads.
-- Verified: 0.405 (irrelevant row) -> 0.646 (1st, this row).
INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, channel, tier, active, notes) VALUES
('LIB-P12',
 $$Do you do roofing? | Do you still do roofs? | I saw an old ad that you do roofing | Can you replace my roof? | Do you do roofs too?$$,
 $$We did offer roofing in South Florida years back, but we don't anymore. Impact windows and doors are all we do now, and it's all we've focused on since.$$,
 'both', 'factual', true,
 $$Scope boundary. Roofing confirmed retired by Mark 2026-09-25; history-acknowledging wording is Mark's 2026-09-26 ruling. Replaces retired #14.$$);



-- ── 5. Single-hung IS offered — Mark, 2026-09-26 ────────────────────────
-- KB-02 deliberately omitted single-hung during the ingest above, because
-- Mark had not ruled on it and a list that never says "no single-hung" cannot
-- state anything false. That reasoning was wrong, and this is the correction.
-- A lead who asks "do you have single hung?" and gets back a list of seven
-- OTHER styles has been told no. An absent item in a "we offer X, Y, Z" answer
-- is an implied denial, so an unruled item needs a ruling, not silence.
-- Mark's words: "Yes, we offer single hung."
-- Verified: "Do you have single hung windows?" -> KB-02 first at 0.676, and
-- "What window styles do you offer?" still KB-02 at 0.758 (no regression).
-- Note: reece-product-knowledge, the skill KB-02 was written from, still never
-- mentions single-hung. That skill is synced and Mark's to edit.
UPDATE kb_faqs
SET canonical_answer = $$We offer single-hung, double-hung, sliders, casements, awnings, picture, bay and bow, and garden windows, plus sliding patio doors. On a double-hung both sashes move and tilt in for easy cleaning. Which rooms are you thinking about?$$,
    embedding = NULL, embedded_at = NULL, embedding_hash = NULL,
    updated_at = now()
WHERE id = 65 AND kb_key = 'KB-02';

COMMIT;
