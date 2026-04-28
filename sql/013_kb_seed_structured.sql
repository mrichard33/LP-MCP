-- ════════════════════════════════════════════════════════════════════
-- 013_kb_seed_structured.sql
-- SEED: Reece-specific structured KB content (Mark's GHL KB extract)
-- ════════════════════════════════════════════════════════════════════
-- Sourced from Mark's 2026-04-28 KB drop covering:
--   - 18 canonical FAQs
--   - 10 objection response scripts
--   - Transferable Double Lifetime Warranty details
--   - Company info (1972 NC / 8 FL offices / licenses / hours)
--   - Vinyl-only product positioning, no aluminum, no shutters
--   - Government grants (MSFH + VA SAH)
--   - QMID for Regency tax credit (E1P4)
--
-- Apply via Supabase SQL editor. Idempotent (ON CONFLICT DO UPDATE
-- where unique constraints exist; INSERT-only otherwise — re-run will
-- create duplicates so check counts before re-applying).
--
-- Prerequisites:
--   - 010_knowledge_base.sql (creates the kb_* tables)
--   - 011_kb_seed_intent_handlers.sql (compliance gates / intent routing)
-- ════════════════════════════════════════════════════════════════════


-- ─── kb_faqs (18 rows from Mark's FAQ) ──────────────────────────────

INSERT INTO kb_faqs (question_pattern, canonical_answer, answer_short, story_arc, channel, tier, notes) VALUES

('How long does installation take?',
 'Most projects are completed in 1-2 days by our factory-trained teams. We do daily clean-up and a white-glove walkthrough when finished.',
 'Most installs are 1-2 days. Factory teams, daily cleanup, white-glove walkthrough at the end.',
 NULL, 'both', 'factual',
 'Logistics question — usually Stage 4-5 lead'),

('Does Reece repair old windows?',
 'Reece installs new, complete impact window and door systems — we don''t do repairs on existing windows. Full-system replacement is what gives you the warranty, code compliance, and insurance benefits.',
 'We don''t repair old windows — only full impact-system replacement. That''s what gets you the warranty + insurance benefits.',
 'SA2', 'both', 'factual', NULL),

('Do you sell aluminum or vinyl windows?',
 'We specialize in vinyl impact windows only — they''re steel-reinforced and built specifically for Florida''s climate, so you get strength AND energy efficiency in one system. Most homeowners find they don''t need to choose between the two.',
 'Vinyl impact only — steel-reinforced for FL hurricane zones. Strength + energy efficiency in one system.',
 'SA2', 'both', 'factual',
 'Critical: NEVER tell a lead we sell aluminum. We don''t.'),

('What areas do you serve?',
 'We serve the entire state of Florida with 8 offices statewide — Fort Lauderdale, Tampa, Orlando, Sarasota, Fort Myers, Jacksonville, Lakeland, and St. Petersburg.',
 'All of Florida. 8 offices: Fort Lauderdale, Tampa, Orlando, Sarasota, Fort Myers, Jacksonville, Lakeland, St. Petersburg.',
 NULL, 'both', 'factual', NULL),

('How is Reece different from other window companies?',
 'Three things that matter: (1) Our own factory-trained installation teams — not random subcontractors. (2) The strongest warranty in the industry — transferable double lifetime on parts AND labor. (3) 50+ years as a family company with thousands of 5-star reviews. We''re not going anywhere.',
 'Own factory teams (no subs), transferable lifetime warranty on parts AND labor, 50+ years family-owned.',
 'SA2', 'both', 'factual', NULL),

('Do you provide help from the government?',
 'Two programs we help homeowners navigate: My Safe Florida Home (MSFH) offers matching grants for impact upgrades after a wind-mitigation inspection. Florida''s Specially Adapted Housing (SAH) and related veteran programs may help qualifying veterans fund safety or accessibility upgrades. Eligibility shifts year to year — the easiest path is to talk with one of our agents who can confirm what you qualify for.',
 'Two: My Safe Florida Home (matching grants for impact upgrades) and VA SAH for qualifying veterans. Our team can confirm what you qualify for.',
 NULL, 'both', 'factual',
 'MSFH: https://mysafeflhome.com/  |  VA SAH: https://www.va.gov/housing-assistance/disability-housing-grants/'),

('What does the warranty cover?',
 'Our Transferable Double Lifetime Warranty covers parts AND labor for life — most companies only cover parts. It transfers to the new owner if you sell. Includes vinyl defects, glass seal failure, dust/film between glass, glass breakage (lifetime for original owner, 20 years for the next), and operation mechanics. Free service for life — no labor fees on warranty work, ever.',
 'Lifetime parts AND labor. Transfers when you sell. Glass breakage covered. Free service for life — no labor fees, ever.',
 'SA2', 'both', 'factual', NULL),

('Do you offer financing?',
 'Yes — we offer 0% APR financing so you can protect your home now and pay over time. Most families find the energy and insurance savings offset the monthly payment.',
 '0% APR financing available. Most families find the energy + insurance savings offset the monthly payment.',
 'SA5', 'both', 'factual', NULL),

('Is the price from your online estimate accurate?',
 'Your online estimate is a solid starting point — but most come back lower once we measure in person. That''s why the in-home verification is free. Want us to confirm your real number?',
 'Online estimate is a starting point — most come back lower after in-home measurement. The verification is free.',
 NULL, 'both', 'factual', NULL),

('Do impact windows help with insurance?',
 'Yes — many Florida homeowners see significant insurance premium reductions, often saving thousands after installing impact-rated windows. We provide all the documentation your insurance company needs for the wind-mitigation credit.',
 'Yes — many Florida homeowners save thousands on premiums after installing. We provide the wind-mitigation documentation your insurer needs.',
 'SA4', 'both', 'factual',
 'Premium reduction is real but varies by carrier — never quote a specific %.'),

('Why do I need my spouse or partner there?',
 'If even one detail is missed, it can change product choice and final price. Having both decision-makers there ensures accuracy and avoids surprises later.',
 'Missing one detail can change product or price. Having both of you there avoids surprises.',
 NULL, 'both', 'factual', NULL),

('Why does the appointment take about 90 minutes?',
 'The Specialist measures to exact Florida code requirements, reviews all the options that fit your home, and answers questions thoroughly. We''d rather take the time than rush you into a wrong choice.',
 'Code-precise measuring + reviewing your options + answering questions. We''d rather take time than rush you.',
 NULL, 'both', 'factual', NULL),

('What is the company name?',
 'Reece Windows & Doors. Family-owned, over 50 years protecting families, and we use only our own factory-trained installation teams.',
 'Reece Windows & Doors — family-owned, 50+ years, our own installation teams.',
 NULL, 'both', 'factual', NULL),

('Is roofing available statewide?',
 'Roofing services are currently limited to Southeast Florida only. Impact windows and doors are statewide.',
 'Roofing is Southeast Florida only. Impact windows and doors are statewide.',
 NULL, 'both', 'factual', NULL),

('Can I install impact windows myself?',
 'Improper installation voids the warranty and can create structural issues — for safety and compliance, our team handles everything start to finish. The warranty depends on it.',
 'No — DIY voids the warranty and can create structural issues. Our team handles everything start to finish.',
 'SA2', 'both', 'factual', NULL),

('What is your QMID for tax credit?',
 'The QMID for Reece Windows Regency product is E1P4. That''s the qualified manufacturer ID you''ll need for the federal energy-efficient home improvement tax credit.',
 'QMID for the Regency product is E1P4 — that''s what you''ll need for the federal tax credit.',
 NULL, 'both', 'factual',
 'Only Regency product line qualifies for the QMID code listed.'),

('Impact windows vs hurricane shutters?',
 'Impact windows protect 24/7 with no action needed — no putting up shutters before a storm. They also reduce energy bills, lower insurance costs, and increase home value. Shutters only protect when you remember to install them, and most homeowners realize that''s the wrong moment to be on a ladder.',
 'Impact windows protect 24/7 — no shutter setup before a storm. Plus energy savings, insurance savings, and home value.',
 'SA1', 'both', 'factual', NULL),

('How much do impact windows cost?',
 'Every home is different — the investment depends on size, number of openings, glass type, and more. We provide a free in-home inspection to give you accurate numbers, not guesses. Want to schedule one?',
 'Every home is different — windows, openings, glass type. The free in-home inspection gives real numbers, not guesses.',
 NULL, 'both', 'factual',
 'CRITICAL: never quote prices, ranges, ballparks, or "typical" costs.')

ON CONFLICT DO NOTHING;


-- ─── kb_objection_scripts (10 rows from Mark's objection list) ──────
-- buyer_stage:  1=Indifferent, 2=Curious, 3=Comparing, 4=Negotiating, 5=Committed
-- trust_level:  1=Attention, 2=Credibility, 3=Solution, 4=Commitment, 5=Experience, 6=Ownership

INSERT INTO kb_objection_scripts (objection_type, buyer_stage, trust_level, channel, story_arc, opener, body_template, soft_next_step, do_not_use, priority, notes) VALUES

('price', 4, 3, 'both', 'SA5',
 'Totally hear you on the investment side.',
 'Every home is different — sizes, openings, glass type — so we do a complimentary in-home inspection for accurate numbers instead of a guess. That same Specialist also walks through the 0% APR financing options. Most families find the insurance + energy savings offset the monthly payment.',
 'Want me to grab a slot on the calendar so you can see your real number?',
 ARRAY['quote a number', 'mention a range', 'say "ballpark"', 'compare to a competitor''s price', 'apologize for cost'],
 100,
 'Mark''s rule: NEVER provide pricing under any circumstances. The opener acknowledges the concern, the body redirects to the in-home inspection.'),

('timing', 2, 4, 'both', 'SA1',
 'Hurricane season has a way of speeding up these decisions.',
 'Lead times stretch fast right now — getting on the schedule now means you''re actually protected before the next storm window. The other thing: insurance savings start the day we install, so waiting costs you on the back end too.',
 'Want to at least lock in a spot? You can always shift the date if life gets in the way.',
 ARRAY['create false urgency', 'say "limited time"', 'use exclamation marks'],
 100, NULL),

('spouse', 4, 4, 'both', NULL,
 'Of course — a decision like this only works when you''re both on the same page.',
 'When can you both be home for an hour and a half? The Specialist needs both decision-makers there because missing one detail can change the product choice or final price. We''d rather have you both in the room than redo the whole conversation later.',
 'What evening this week works for both of you?',
 ARRAY['suggest one of you decides without the other', 'rush'],
 100, NULL),

('trust', 2, 2, 'both', 'SA2',
 'I hear you — and that''s exactly why Reece does things differently.',
 'We use our own factory-trained crews, not random subcontractors. Family-owned in Florida for over 20 years (NC since 1972), thousands of 5-star reviews, A+ BBB rating. The transferable double lifetime warranty is backed by a company that''s still going to be here when you need a service call in 2046.',
 'Want me to send a few recent reviews from your area before we book anything?',
 ARRAY['get defensive', 'say "all companies say that"', 'name competitors negatively'],
 100,
 'SA2 = code/expertise. Pair with social proof from local reviews when possible.'),

('competitor', 3, 3, 'both', 'SA3',
 'It''s smart to get more than one set of eyes on a project this size.',
 'Couple things to ask whoever else you talk to: do they install with their own crews or subs? Is the warranty parts-AND-labor for life, or just parts? Does it transfer if you sell? Most families come back to us once they ask those three questions because the answers matter once something needs service.',
 'Want me to send a "questions to ask other companies" checklist before your other appointments?',
 ARRAY['attack the competitor', 'name the competitor', 'badmouth their product', 'imply they''re dishonest'],
 100,
 'Position through QUESTIONS, never attacks. Mark''s rule.'),

('diy', 2, 2, 'both', 'SA2',
 'I get the instinct — and you''re obviously handy.',
 'The catch is the warranty: improper installation voids it, and the Florida hurricane code has very specific anchor and flashing requirements that the inspector signs off on. If anything ever needed to be replaced under warranty, a self-install would not qualify. The financing also lets a lot of folks treat it like buying time back rather than spending a weekend.',
 'Want to see what the actual code requirements look like? I can send the Florida HVHZ install spec.',
 ARRAY['call them unqualified', 'lecture', 'condescend'],
 100, NULL),

('been_burned', 3, 2, 'both', 'SA2',
 'I hear that a lot — and honestly it''s the reason we built Reece the way we did.',
 'No subcontractors. Our crews are factory-trained and have been with us for years. The transferable double lifetime warranty covers parts AND labor for life — so even if something happens five years from now, there''s no surprise labor bill. We''ve been in Florida 20+ years and are not going anywhere.',
 'Want a few addresses near you where we''ve installed recently? You can drive by and see the work.',
 ARRAY['dismiss their experience', 'say "we''re not like that" without proof'],
 100, NULL),

('thinking_about_it', 3, 3, 'both', NULL,
 'Totally get it — what specifically are you turning over?',
 'No pressure either way. If it''s the financing piece, we have 0% APR options. If it''s the timing, we can schedule the in-home now and push the install date. If it''s something else entirely, I''d rather know so I can actually help instead of guessing.',
 'What''s the part that''s sitting with you most?',
 ARRAY['push for an answer', 'use scarcity'],
 100,
 'NEPQ-style: ask what specifically before assuming.'),

('savings_skeptical', 3, 3, 'both', 'SA5',
 'Fair — most companies overpromise on the savings side.',
 'We don''t hand-wave it. The Specialist runs a custom projection using your actual electric bill and current insurance premium, plus shows before-and-after numbers from local Reece customers. You''ll see the real math before you decide anything.',
 'Want to see a sample projection before booking? I can send one from a similar-sized home.',
 ARRAY['promise a specific dollar figure', 'cite generic stats'],
 100, NULL),

('company_disappears', 3, 2, 'both', 'SA2',
 'A fair concern — we''ve seen plenty of window companies come and go.',
 'Reece has been in Florida 20+ years (NC since 1972 — 50+ years total) with 8 offices statewide. The transferable double lifetime warranty is backed by a family company that''s been honoring it for decades. If we close up shop in 30 years your kids will probably still be calling us for a glass-pack swap.',
 'Want me to send the BBB profile and a few recent customer videos so you can see for yourself?',
 ARRAY['claim "we''ll always be here" without proof'],
 100, NULL)

ON CONFLICT DO NOTHING;


-- ─── kb_proof_points (Reece-specific facts the bot can cite) ────────

INSERT INTO kb_proof_points (category, claim, evidence, source_url, tier, use_for_arcs, notes) VALUES

-- Company longevity / character
('company', 'Founded in North Carolina in 1972', 'Family-owned since founding', 'https://reecewindows.com/', 'factual', ARRAY['SA2','SA3'], NULL),
('company', 'Florida operations since 2005 — over 20 years protecting Florida homes', NULL, NULL, 'factual', ARRAY['SA2','SA3'], NULL),
('company', 'Over 50 years in business as a family company', NULL, NULL, 'factual', ARRAY['SA2','SA3'], NULL),
('company', '8 offices across Florida', 'Fort Lauderdale, Tampa, Orlando, Sarasota, Fort Myers, Jacksonville, Lakeland, St. Petersburg', NULL, 'factual', ARRAY['SA2'], NULL),
('company', 'A+ BBB rating', NULL, NULL, 'factual', ARRAY['SA2','SA3'], NULL),
('company', 'Florida General Contractor License #CGC1524586', NULL, NULL, 'factual', ARRAY['SA2'], 'Cite when license/credentialing comes up'),
('company', 'Florida Roofing Contractor License #CCC1330607', NULL, NULL, 'factual', ARRAY['SA2'], 'Roofing only available in Southeast Florida'),
('company', 'Phone: (866) 717-8582', NULL, 'https://reecewindows.com/', 'factual', NULL, NULL),
('company', 'Hours: Mon-Fri 9am-8pm, Sat 9am-5pm, Sun 9am-3pm', NULL, NULL, 'factual', NULL, NULL),

-- Crews / install quality
('process', 'Our own factory-trained installation teams — no subcontractors', NULL, NULL, 'factual', ARRAY['SA2','SA3'], 'Critical differentiator. Most competitors sub out installs.'),
('process', 'Most projects are completed in 1-2 days', NULL, NULL, 'factual', NULL, NULL),
('process', 'Daily clean-up during installation and a white-glove walkthrough at completion', NULL, NULL, 'factual', NULL, NULL),
('process', 'The Reece App provides real-time project tracking', NULL, NULL, 'marketing', NULL, NULL),
('process', 'In-home Window Estimate appointment runs about 90 minutes', 'Specialist measures to FL code, reviews options, answers questions', NULL, 'factual', NULL, NULL),
('process', 'In-home inspection is complimentary — no charge for the verification', NULL, NULL, 'factual', NULL, NULL),

-- Warranty
('warranty', 'Transferable Double Lifetime Warranty covering parts AND labor for life', 'Most competitors cover parts only — labor is the real long-tail expense', NULL, 'factual', ARRAY['SA2','SA3'], NULL),
('warranty', 'Warranty transfers to the new owner if you sell the home', 'Adds resale value', NULL, 'factual', ARRAY['SA2','SA5'], 'Transfer requires written notification within 15 days; converts to 20-year for subsequent owner'),
('warranty', 'Free service for the life of the product — no labor fees on warranty work', NULL, NULL, 'factual', ARRAY['SA2','SA3'], NULL),
('warranty', 'Glass breakage covered for lifetime (original owner) / 20 years (subsequent owner)', NULL, NULL, 'factual', ARRAY['SA2'], 'Excludes acts of God: hurricanes, floods, earthquakes'),
('warranty', '30-Day Price Guarantee — find a matching window with all Reece features for less and we refund the difference', NULL, NULL, 'factual', ARRAY['SA3','SA5'], NULL),
('warranty', 'Warranty does NOT cover acts of God (hurricanes, floods, earthquakes), pre-existing condensation conditions, or damage from improper use', NULL, NULL, 'factual', NULL, 'Disclosure point — be honest about exclusions'),

-- Product
('product', 'Vinyl impact windows only — not aluminum', 'Steel-reinforced vinyl frames built for Florida HVHZ', NULL, 'factual', ARRAY['SA2'], 'Reece does NOT sell aluminum. Never tell a lead we do.'),
('product', 'Conservation Glass reflects 90% of solar rays and exceeds ENERGY STAR guidelines', NULL, NULL, 'factual', ARRAY['SA5'], NULL),
('product', 'Steel-reinforced frames with multi-point locking', NULL, NULL, 'factual', ARRAY['SA2'], NULL),
('product', 'Designed for Florida High Velocity Hurricane Zones (HVHZ)', NULL, NULL, 'factual', ARRAY['SA1','SA2'], NULL),
('product', 'Impact doors via Jeld-Wen, Shwinco, Euro-craft, BHI, ETI', NULL, NULL, 'factual', NULL, NULL),
('product', 'Roofing uses CertainTeed materials, available Southeast Florida only', NULL, NULL, 'factual', NULL, NULL),
('product', 'QMID E1P4 for Regency product line — qualifies for federal energy-efficient home improvement tax credit', NULL, NULL, 'factual', ARRAY['SA5'], NULL),

-- Insurance / financial
('insurance', 'Many Florida homeowners see significant insurance premium reductions after installing impact-rated windows', 'Wind-mitigation credit through carrier; Reece provides the documentation', NULL, 'marketing', ARRAY['SA4','SA5'], 'Premium reductions vary by carrier — never quote a specific %.'),
('financing', '0% APR financing available', 'Most families find the energy and insurance savings offset the monthly payment', NULL, 'factual', ARRAY['SA5'], NULL),

-- Government programs
('grants', 'My Safe Florida Home (MSFH) offers matching grants for impact upgrades after a wind-mitigation inspection', 'Eligibility shifts year to year', 'https://mysafeflhome.com/', 'factual', NULL, NULL),
('grants', 'VA Specially Adapted Housing (SAH) and related programs may help qualifying veterans fund safety / accessibility upgrades', NULL, 'https://www.va.gov/housing-assistance/disability-housing-grants/', 'factual', NULL, NULL),

-- Negative space (what we don''t do — for honest framing)
('scope', 'Reece does NOT work on mobile or manufactured homes', NULL, NULL, 'factual', NULL, 'Disqualifier — route to HDL-DQ-MOBILE-01'),
('scope', 'Reece works with homeowners only — not renters', NULL, NULL, 'factual', NULL, 'Disqualifier — route to HDL-DQ-RENTER-01'),
('scope', 'Reece does NOT repair existing windows — full system replacement only', NULL, NULL, 'factual', NULL, NULL),
('scope', 'Reece does NOT replace glass only — replaces full window/door systems', NULL, NULL, 'factual', NULL, NULL),
('scope', 'Reece does NOT sell hurricane shutters of any type', NULL, NULL, 'factual', NULL, 'Common misconception — be clear we do impact systems instead'),
('scope', 'Reece serves Florida only', NULL, NULL, 'factual', NULL, NULL)

ON CONFLICT DO NOTHING;


-- ─── kb_pricing_anchors (the "no quote" rule, encoded) ──────────────
-- Mark''s policy: NEVER provide pricing under any circumstance — no
-- ranges, ballparks, "typical" costs, dollar figures. The anchoring
-- message redirects every price question to the in-home inspection.

INSERT INTO kb_pricing_anchors
  (window_count_min, window_count_max, typical_range_low, typical_range_high,
   anchoring_message, roi_framing, payment_framing, notes) VALUES

(1, 999, NULL, NULL,
 'Every home is different — window sizes, openings, glass type, hurricane code requirements — so we do a complimentary in-home inspection for accurate numbers instead of a guess.',
 'Most families look at it as a three-way return: (1) insurance premium drops with the wind-mitigation credit, (2) energy bill reduction from Conservation Glass, (3) home value increase at resale. The Specialist runs a custom projection using your actual bill and premium during the in-home.',
 '0% APR financing is available so the upfront isn''t the whole picture. Most families find the insurance + energy savings offset the monthly payment.',
 'CATCH-ALL anchor. Never quote a number. Always redirect to the in-home inspection.')

ON CONFLICT DO NOTHING;


-- ─── kb_product_specs (anchor product attributes) ───────────────────

INSERT INTO kb_product_specs (product_line, attribute, value, comparison_context, notes) VALUES

('Reece Conservation Glass', 'frame_material', 'Vinyl, steel-reinforced',
 'Most window companies offer aluminum or wood. Reece is vinyl-only — built for FL climate.', NULL),
('Reece Conservation Glass', 'glass_solar_reflection', '90% of solar rays reflected',
 'Exceeds ENERGY STAR guidelines for the Southeast region.', NULL),
('Reece Conservation Glass', 'design_zone', 'Florida High Velocity Hurricane Zone (HVHZ)', NULL, NULL),
('Reece Conservation Glass', 'locking', 'Multi-point locking system', NULL, NULL),
('Reece Conservation Glass', 'energy_star_compliance', 'Exceeds ENERGY STAR Southeast guidelines', NULL, NULL),

('Reece Regency', 'qmid', 'E1P4',
 'Qualified Manufacturer ID for federal energy-efficient home improvement tax credit', NULL),

('Impact Doors — Jeld-Wen', 'category', 'Fiberglass and steel exterior entry systems', NULL, NULL),
('Impact Doors — Shwinco', 'category', 'Sliding glass doors with reinforced frames', NULL, NULL),
('Impact Doors — Euro-craft', 'category', 'Impact entry/sliding systems', NULL, NULL),
('Impact Doors — BHI', 'category', 'Impact door systems', NULL, NULL),
('Impact Doors — ETI', 'category', 'Impact door systems', NULL, NULL),

('Roofing — CertainTeed', 'category', 'High-wind resistant roofing systems',
 'Roofing service area: Southeast Florida ONLY. Statewide for windows/doors.', NULL)

ON CONFLICT DO NOTHING;


-- ─── kb_story_arcs UPDATE — fill in playbooks (was placeholders) ────
-- Existing rows from 011 had placeholders. Upsert with full content.

INSERT INTO kb_story_arcs (
  arc_id, arc_name, core_belief, problem_named,
  proof_points, openers, example_paragraphs, do_not_say,
  best_for_buyer_stages, best_for_objections, active, notes
) VALUES

('SA1', 'Hurricane Damage Stories',
 'Homes built before current Florida code are unprotected, even from moderate storms.',
 'Most South Florida homes were built before HVHZ code tightened — the windows are the weakest point during a storm.',
 '[
   {"claim":"Steel-reinforced vinyl frames designed for HVHZ","tier":"factual"},
   {"claim":"Conservation Glass exceeds ENERGY STAR Southeast guidelines","tier":"factual"}
 ]'::jsonb,
 '["After Idalia, the calls we got were all from homes built before 2002.","Hurricane season has a way of speeding up these decisions."]'::jsonb,
 '["Most South Florida homes were built before the current Florida code went into effect — which means the windows are usually the weakest point during a storm. Our team has been in homes after damage where the structure was fine but the windows let go and took the rest with them. Impact systems built to HVHZ are designed for that exact moment."]'::jsonb,
 '["claim a specific hurricane caused specific dollar damage", "name a customer who was hit", "use scare tactics about loss of life"]'::jsonb,
 ARRAY[1,2], ARRAY['timing','too_busy'], true,
 'Use Randy voice when ac_voice_eligible and personal anecdote lands.'),

('SA2', 'Code Compliance & Expertise',
 'Florida hurricane code is specific. Most contractors don''t know the difference between impact-resistant and code-compliant.',
 'Lots of products call themselves "impact-resistant" but only HVHZ-rated systems pass the actual code test.',
 '[
   {"claim":"Florida General Contractor License #CGC1524586","tier":"factual"},
   {"claim":"Designed for HVHZ","tier":"factual"},
   {"claim":"Our own factory-trained installation teams — no subs","tier":"factual"},
   {"claim":"50+ years family-owned, 20+ years in Florida","tier":"factual"}
 ]'::jsonb,
 '["The thing most homeowners don''t realize is the gap between ''impact-resistant'' and HVHZ-code-compliant.","License-wise, Reece runs General Contractor #CGC1524586 — the install crews work to the spec the inspector signs off on."]'::jsonb,
 '["There''s a real gap between ''impact-resistant'' and HVHZ-compliant. The first is marketing language. The second is what passes the Florida inspector. Reece installs to HVHZ — every job. Our crews are factory-trained employees, not subcontractors, and the install is exactly what the warranty depends on."]'::jsonb,
 '["disparage other companies by name","claim competitors are unlicensed","get technical to the point of overwhelming"]'::jsonb,
 ARRAY[2,3], ARRAY['trust','diy','been_burned'], true, NULL),

('SA3', 'Cheap Window Regret',
 'Going with the cheapest bid leads to replacement within 5-10 years and lost insurance benefits.',
 'The cheapest bid usually means subcontracted install, parts-only warranty, or non-HVHZ glass — and the homeowner finds out 5 years later.',
 '[
   {"claim":"Transferable Double Lifetime Warranty — parts AND labor","tier":"factual"},
   {"claim":"Most competitors warranty parts only","tier":"factual"},
   {"claim":"Free service for life","tier":"factual"}
 ]'::jsonb,
 '["The replacement jobs we get called on are almost never the original Reece installs.","Cheapest bid is usually the most expensive long-term — we end up replacing them five years in."]'::jsonb,
 '["I''ll be honest — the replacement work we get called for is almost never on jobs we did. It''s usually a homeowner who took the cheapest bid five or six years ago. The frames pitted, the seals failed, or the company that installed them isn''t around to honor the warranty. By the time we get there, they''re paying for the second install. The warranty is the real story."]'::jsonb,
 '["name a competitor as the cheap option","disparage another company","be smug"]'::jsonb,
 ARRAY[3,4], ARRAY['price','competitor'], true,
 'Use Randy voice when ac_voice_eligible — Randy has the personal stories from replacement jobs.'),

('SA4', 'Insurance Gaps',
 'Wind mitigation credits, claim denials, and code coverage are silently shaping homeowner exposure.',
 'Florida insurance is changing fast — wind-mitigation credits and HVHZ-code documentation are now the difference between a covered claim and a denied one.',
 '[
   {"claim":"Reece provides wind-mitigation documentation for your insurer","tier":"factual"},
   {"claim":"Many FL homeowners see significant premium reductions","tier":"marketing"}
 ]'::jsonb,
 '["The insurance side is the one most homeowners underestimate.","The carriers are paying way more attention to wind-mitigation documentation than they were five years ago."]'::jsonb,
 '["Florida insurance has shifted in the last few years — carriers want to see wind-mitigation documentation, and impact-rated windows are one of the biggest credits available. We provide all the paperwork your insurer needs. The premium savings start the day we install — they''re not contingent on a claim."]'::jsonb,
 '["quote a specific premium reduction percentage","promise a specific carrier will lower the rate","name carriers"]'::jsonb,
 ARRAY[1,2,4], ARRAY['timing','price'], false,
 'Active=false until Mark approves specific premium-reduction language.'),

('SA5', 'Home Value & ROI',
 'Impact windows are an investment with measurable resale and insurance ROI, not a cost.',
 'Most families think of windows as an expense. The math is closer to a three-way ROI: insurance, energy, and resale.',
 '[
   {"claim":"30-Day Price Guarantee","tier":"factual"},
   {"claim":"0% APR financing available","tier":"factual"},
   {"claim":"Conservation Glass reflects 90% of solar rays","tier":"factual"},
   {"claim":"Warranty transfers to new owner — adds resale value","tier":"factual"}
 ]'::jsonb,
 '["The way most families end up looking at it is three-way ROI, not cost.","If you ran this as a spreadsheet — insurance credit, energy savings, resale impact — the math usually surprises people."]'::jsonb,
 '["Most families come in thinking of windows as an expense. The math actually runs three ways: the wind-mitigation insurance credit, energy savings from Conservation Glass, and the resale impact when the warranty transfers to the next owner. The Specialist runs a real projection on the in-home using your actual electric bill and premium — not a generic estimate."]'::jsonb,
 '["promise a specific dollar return","cite a generic ''windows recoup X%'' stat","quote pricing"]'::jsonb,
 ARRAY[3,4], ARRAY['price','spouse'], true, NULL)

ON CONFLICT (arc_id) DO UPDATE SET
  arc_name = EXCLUDED.arc_name,
  core_belief = EXCLUDED.core_belief,
  problem_named = EXCLUDED.problem_named,
  proof_points = EXCLUDED.proof_points,
  openers = EXCLUDED.openers,
  example_paragraphs = EXCLUDED.example_paragraphs,
  do_not_say = EXCLUDED.do_not_say,
  best_for_buyer_stages = EXCLUDED.best_for_buyer_stages,
  best_for_objections = EXCLUDED.best_for_objections,
  active = EXCLUDED.active,
  notes = EXCLUDED.notes,
  updated_at = now();


-- ════════════════════════════════════════════════════════════════════
-- Verification queries (run these to confirm seed succeeded)
-- ════════════════════════════════════════════════════════════════════
-- SELECT count(*) FROM kb_faqs WHERE active = true;             -- expect 18
-- SELECT count(*) FROM kb_objection_scripts WHERE active = true; -- expect 10
-- SELECT count(*) FROM kb_proof_points WHERE active = true;      -- expect ~40
-- SELECT count(*) FROM kb_pricing_anchors WHERE active = true;   -- expect 1
-- SELECT count(*) FROM kb_product_specs WHERE active = true;     -- expect 12
-- SELECT arc_id, arc_name, active FROM kb_story_arcs ORDER BY arc_id;
--   -- SA1, SA2, SA3, SA5 active=true; SA4 active=false (Mark approval)
