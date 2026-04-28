-- ════════════════════════════════════════════════════════════════════
-- 014_kb_keyed_updates.sql
-- SEED: Mark's KEY-based reference content (Avatar/Objection/Handler docs)
-- ════════════════════════════════════════════════════════════════════
-- Sourced from Mark's 2026-04-28 keyed-reference KB drop:
--   - Avatar_and_Company_Info.pdf  (AVA-*, CO-*, FAQ-*, DIFF-*, APPT-*,
--                                   RULE-*, QUAL-*, LANG-*)
--   - Objection_Handling_Scripts.pdf (OBJ-*, WARRANTY-*, SERVICE-*)
--   - Situation_Handlers.pdf       (HDL-*, RSP-*, PERS-*, TONE-*)
--
-- Apply via Supabase SQL editor AFTER 013 has been applied.
--
-- Critical new content this seed adds:
--   1. BUYING-SIGNAL DISTINCTION — HDL-NEXTSTEP-01 / HDL-QUOTE-READY-01
--      "I want a quote" = ready to schedule (buying signal)
--      "How much?"      = price-shopping (needs pivot, OBJ-PRICE-01)
--      The classifier was treating both as price-objection. This fixes it.
--   2. OBJ-BUDGET-01 monthly-vs-total framing (better than old 'price' row)
--   3. OBJ-PRICE-02 / OBJ-PRICE-03 (persistent ask + competitor pricing)
--   4. OBJ-CANCEL-01 (we had no cancellation handler)
--   5. Avatars (Dave + Maria) and brand language as proof_points
--
-- Idempotent on UNIQUE constraints; ON CONFLICT DO NOTHING/UPDATE used.
-- ════════════════════════════════════════════════════════════════════


-- ─── Schema additions: kb_key columns for traceability ──────────────
-- Each row gets traceable back to Mark's KEY system so prompts can
-- cite specific keys (e.g. "Use OBJ-BUDGET-01 to handle this") and the
-- bot can look them up directly.

ALTER TABLE kb_intent_handlers   ADD COLUMN IF NOT EXISTS kb_key TEXT;
ALTER TABLE kb_objection_scripts ADD COLUMN IF NOT EXISTS kb_key TEXT;
ALTER TABLE kb_faqs              ADD COLUMN IF NOT EXISTS kb_key TEXT;
ALTER TABLE kb_proof_points      ADD COLUMN IF NOT EXISTS kb_key TEXT;
ALTER TABLE kb_pricing_anchors   ADD COLUMN IF NOT EXISTS kb_key TEXT;

CREATE INDEX IF NOT EXISTS idx_kb_intent_handlers_key  ON kb_intent_handlers(kb_key) WHERE kb_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kb_objection_scripts_key ON kb_objection_scripts(kb_key) WHERE kb_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kb_faqs_key             ON kb_faqs(kb_key) WHERE kb_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kb_proof_points_key     ON kb_proof_points(kb_key) WHERE kb_key IS NOT NULL;


-- ─── Buying-signal handlers (NOT compliance gates) ──────────────────
-- These fire when the lead is signaling readiness to schedule. They are
-- routed to response generation with a "skip discovery, go to scheduling"
-- guidance — distinct from OBJ-PRICE-01 which pivots from price-shopping.

INSERT INTO kb_intent_handlers (
  intent_class, bucket_type, handler_code, action_type, kb_key,
  trigger_keywords, trigger_phrases, description, priority, active
) VALUES

('BOOK_NEXTSTEP', 'router', 'HDL-NEXTSTEP-01', 'route_to_scheduling',
 'HDL-NEXTSTEP-01',
 ARRAY['proceed','next','schedule'],
 ARRAY['what''s next','what are the next steps','what happens now','how do we proceed','what do I do now','how do I get started'],
 'Lead is asking what happens next or how to proceed. This is a BUYING SIGNAL — they''re ready to move forward. Do NOT re-pitch value. Do NOT mention financing. Do NOT explain the company again. Answer the procedural question directly and offer two specific calendar slots.',
 50, true),

('BOOK_QUOTE_READY', 'router', 'HDL-QUOTE-READY-01', 'route_to_scheduling',
 'HDL-QUOTE-READY-01',
 ARRAY['quote','estimate'],
 ARRAY['I want a quote','can I get an estimate','I''d like a quote','ready for a quote','want an estimate','get me a quote','need an estimate','looking to get a quote','can you give me a quote','interested in a quote'],
 'CRITICAL: Lead asking for "a quote" or "an estimate" is a BUYING SIGNAL — they want to schedule the in-home, not a phone-quote. Do NOT pivot to discovery (that''s OBJ-PRICE-01 territory for "how much does it cost?"). Do NOT explain pricing rules. Move directly to scheduling with two specific calendar slot offers.',
 50, true),

('FAST_TRACK_FRUSTRATED', 'router', 'HDL-FRUSTRATED-01', 'route_to_scheduling',
 'HDL-FRUSTRATED-01',
 ARRAY['just','seriously'],
 ARRAY['too many questions','just schedule me','get to the point','how much longer','this is taking forever','can we just','stop asking'],
 'Lead is impatient and wants to skip the conversation. Match their urgency. Skip remaining qualification questions. Go directly to two calendar slot offers. Don''t apologize at length — brief acknowledgment then action.',
 60, true),

('CALLBACK_CALM', 'router', 'HDL-CALLBACK-01', 'route_to_human_callback',
 'HDL-CALLBACK-01',
 ARRAY['callback'],
 ARRAY['talk to someone','speak to a rep','call me','have someone call','can I talk to a person','rather talk on the phone','can someone call me','prefer to talk'],
 'Lead is calmly requesting a phone conversation. Different from HDL-HUMAN-01 (frustrated) and HDL-FRUSTRATED-01 (impatient). Confirm phone number, route to Bot 3 for callback scheduling, tag callback-requested. Do NOT try to keep them in text.',
 70, true)

ON CONFLICT (intent_class) DO UPDATE SET
  handler_code = EXCLUDED.handler_code,
  kb_key = EXCLUDED.kb_key,
  description = EXCLUDED.description,
  trigger_keywords = EXCLUDED.trigger_keywords,
  trigger_phrases = EXCLUDED.trigger_phrases,
  priority = EXCLUDED.priority,
  updated_at = now();


-- Backfill kb_key on existing intent handlers where we can identify them
UPDATE kb_intent_handlers SET kb_key = 'HDL-STOP-01'        WHERE handler_code = 'HDL-STOP-01';
UPDATE kb_intent_handlers SET kb_key = 'HDL-DQ-MOBILE-01'   WHERE handler_code = 'HDL-DQ-MOBILE-01';
UPDATE kb_intent_handlers SET kb_key = 'HDL-DQ-RENTER-01'   WHERE handler_code = 'HDL-DQ-RENTER-01';
UPDATE kb_intent_handlers SET kb_key = 'HDL-DQ-INVESTMENT-01' WHERE handler_code = 'HDL-DQ-INVESTMENT-01';


-- ─── New objection scripts from Mark's keyed library ────────────────

INSERT INTO kb_objection_scripts
  (kb_key, objection_type, buyer_stage, trust_level, channel, story_arc,
   opener, body_template, soft_next_step, do_not_use, priority, notes) VALUES

-- OBJ-PRICE-01: First pricing ask — pivot to discovery
('OBJ-PRICE-01', 'price_first_ask', 2, 2, 'both', 'SA5',
 NULL,
 'To give you an exact price that is actually accurate, we measure to Florida code. Before that, what matters more to you right now — keeping the home cooler and lowering energy costs, or having the strongest storm protection possible?',
 'End with the question. No additional explanation.',
 ARRAY['mention vinyl or aluminum by name','quote a number','say "ballpark"','say "every home is different"'],
 50,
 'OBJ-PRICE-01 from Mark''s keyed library. We only sell vinyl which delivers BOTH benefits — let them state their priority first.'),

-- OBJ-PRICE-02: Persistent pricing ask — validate and schedule
('OBJ-PRICE-02', 'price_persistent', 3, 2, 'both', NULL,
 'I get why you want a ballpark.',
 'In Florida, code requirements can change street by street, so ballparks usually end up wrong. We leave you with an exact quote after a quick measure.',
 'Does [time slot] work to take care of that?',
 ARRAY['say "every home is different"','quote a number','give a range','apologize'],
 60,
 'OBJ-PRICE-02. After OBJ-PRICE-01 pivot didn''t land. The appointment IS the answer. Insert ONE real calendar slot, not "morning or afternoon".'),

-- OBJ-PRICE-03: Competitor pricing — shift evaluation criteria
('OBJ-PRICE-03', 'competitor_pricing', 3, 3, 'both', 'SA3',
 'Makes sense to compare.',
 'When you look at quotes, ask who actually does the install, what the warranty really covers, and what happens if you need service years down the road. Those hidden details usually matter more than the number.',
 'Have any of the quotes walked you through that yet?',
 ARRAY['ask them to reveal competitor pricing','promise to match','badmouth the competitor','name the competitor'],
 60,
 'OBJ-PRICE-03. Don''t compete on price. Plant doubt about competitor value through QUESTIONS, never attacks.'),

-- OBJ-SPOUSE-02: Need to discuss with spouse — surface motivation
('OBJ-SPOUSE-02', 'discuss_with_spouse', 4, 4, 'both', NULL,
 'Of course.',
 'From what we talked about so far, what do you think {{contact.spouse_name}} would be most excited about?',
 'Conditional follow-up: if excitement → "Would it help to schedule a time when you are both there?" / if concern → "Would it be helpful if they could ask those questions directly during a visit?" / if budget → "Want me to get you exact numbers so you have something concrete to review together?" / if timing → "Do you want me to check back after you talk, or would you prefer something on the calendar you can both plan around?"',
 ARRAY['try to bypass the spouse','pressure','ask multiple questions at once','if no spouse name use the variable — substitute "them"'],
 70,
 'OBJ-SPOUSE-02 has a rich conditional flow. If no spouse_name captured, replace {{contact.spouse_name}} with "they". One question at a time. Let them do the persuading.'),

-- OBJ-BUSY-01: Too busy generally
('OBJ-BUSY-01', 'too_busy', 2, 3, 'both', NULL,
 'I get it — schedules get packed fast.',
 'The visit is straightforward. We measure, answer questions, and leave you with exact pricing to review later.',
 'Would [morning or afternoon] on [day] be easier?',
 ARRAY['say "whenever things settle down"','offer no specific day','push twice'],
 50,
 'OBJ-BUSY-01. Make it feel manageable with a SPECIFIC offer. NEVER vague.'),

-- OBJ-TIMING-01: Bad timing — vacation or life event
('OBJ-TIMING-01', 'bad_timing_event', 2, 3, 'both', NULL,
 NULL,
 'No problem — [event/trip] should definitely come first.',
 'Want me to reach out after [date], or should we get something on the calendar for when you''re back?',
 ARRAY['be vague about timing','let them ghost without a follow-up commitment'],
 50,
 'OBJ-TIMING-01. Get a specific date if possible. Don''t let it go vague.'),

-- HDL-BABY-01: Baby/newborn timing conflict
('HDL-BABY-01', 'baby_newborn', 2, 3, 'both', NULL,
 'Congrats on the baby!',
 'We keep this very simple. Our specialist comes out, measures everything, answers questions, and leaves you with exact pricing to review whenever you have a quiet moment.',
 'Would [specific day] work, or should I check back after things settle?',
 ARRAY['say "whenever things settle down" without offering a specific alternative','pressure'],
 50,
 'HDL-BABY-01. Acknowledge situation, make it feel effortless. Always offer specific day even when checking back.'),

-- OBJ-BUDGET-01: General budget — clarify monthly vs total
('OBJ-BUDGET-01', 'budget_concern', 3, 3, 'both', 'SA5',
 'That makes sense.',
 'When people mention budget, it usually means one of two things — is it the monthly payment that feels uncomfortable, or the overall scope of the project?',
 'Conditional follow-up: if monthly → "We do have financing options that can make the monthly very manageable. Would it help to see what that could look like for you?" / if scope → "A lot of families start with the most critical windows first and phase the rest over time. Would that approach be worth exploring?"',
 ARRAY['introduce financing before they confirm monthly concern','push pricing','offer multiple paths at once','say "expensive" or "cheap"'],
 70,
 'OBJ-BUDGET-01. Clarify the real constraint BEFORE solving. Monthly = financing path. Scope = phased path. One follow-up only based on their answer.'),

-- OBJ-TRUST-02: Just shopping / not ready
('OBJ-TRUST-02', 'just_shopping', 1, 2, 'both', NULL,
 'Makes sense — it''s smart to do your homework first.',
 'Is there anything specific you''re trying to figure out?',
 'Happy to answer questions without any pressure.',
 ARRAY['push for an appointment','use scarcity','assume they''re ready'],
 50,
 'OBJ-TRUST-02. Don''t push. Be helpful. Stay in their consideration set.'),

-- OBJ-CANCEL-01: Wants to cancel appointment
('OBJ-CANCEL-01', 'cancel_appointment', 4, 3, 'both', NULL,
 'No problem at all.',
 'Is this more of a timing issue, or did you decide to pause the project for now?',
 'Conditional follow-up: if timing → "Got it. Would you like me to look for a better time, or should I check back with you later?" / if pause → "Understood. I will pause this on my end. If things change later, just reach out and we will take it from there." / ALWAYS append: "No pressure either way. I just want to handle this the right way for you."',
 ARRAY['try to save the appointment','ask multiple clarifying questions','pressure for a reason','skip the closing safety line'],
 80,
 'OBJ-CANCEL-01. ONE clarifying question only. ALWAYS include the closing safety line on either path to prevent ghosting.')

ON CONFLICT DO NOTHING;


-- Backfill kb_key on existing rows where I can identify the intent
UPDATE kb_objection_scripts SET kb_key = 'OBJ-TRUST-01' WHERE objection_type = 'been_burned' AND kb_key IS NULL;
UPDATE kb_objection_scripts SET kb_key = 'OBJ-COMPANY-01' WHERE objection_type = 'company_disappears' AND kb_key IS NULL;


-- ─── Avatars as proof_points (vector handles full content) ──────────

INSERT INTO kb_proof_points (kb_key, category, claim, evidence, tier, use_for_arcs, notes) VALUES

('AVA-DAVE-01', 'avatar', 'Primary buyer is "Dave": 55-65, Florida coastal, single-family home owned 10+ years, married',
 'Lives with: storm anxiety, financial frustration over energy bills, trust wounds from past contractors. Needs: math/logic, proof, no-pressure language, control. Runs from: price pressure, urgency tactics, salesy language, scripted feel.',
 'reference', NULL,
 'AVA-DAVE-01 — primary avatar. The bot should write to Dave by default unless data suggests otherwise.'),

('AVA-MARIA-01', 'avatar', 'Secondary buyer is "Maria": Dave''s spouse, key influencer on budget/timing/trust',
 'Remembers contractor nightmares MORE vividly than Dave. Controls or heavily influences budget. Needs warranty/service guarantees more than features. Wants confirmation Dave isn''t being impulsive.',
 'reference', NULL,
 'AVA-MARIA-01. When spouse name is captured, reference by name. When spouse has concerns, address directly — don''t bypass.')

ON CONFLICT DO NOTHING;


-- ─── Brand language hints as proof_points ───────────────────────────

INSERT INTO kb_proof_points (kb_key, category, claim, tier, notes) VALUES

('LANG-USE-01', 'brand_language',
 'Words to use: family, team, experts, investment, protection, security, craftsmanship, peace of mind, energy savings, complimentary estimate, Window Protection Estimate, penny-accurate pricing, Florida-engineered, in-house team, transferable double lifetime warranty, free service for life',
 'reference',
 'LANG-USE-01. Default vocabulary for the bot. Pull from this list when constructing responses.'),

('LANG-AVOID-01', 'brand_language',
 'Words to avoid: cost, price, expense, deal, locked in, limited time, act now, workers, staff, cheap, affordable, discount',
 'reference',
 'LANG-AVOID-01. These words signal salesy/pushy/cheap — the OPPOSITE of how Dave-the-avatar wants to be sold to. Substitute "investment" for cost, "team" for workers/staff, "complimentary" for discount/free.')

ON CONFLICT DO NOTHING;


-- ─── Brand-language constants in proof_points (penny-accurate framing) ──

INSERT INTO kb_proof_points (kb_key, category, claim, evidence, tier, use_for_arcs, notes) VALUES

('CO-DIFF-01-PENNY', 'process',
 'Penny-accurate pricing — exact quotes after in-home measure, not estimates',
 'Differentiator vs competitors who give ranges. Aligns with no-pricing rule because the only accurate price comes from the in-home.',
 'factual', ARRAY['SA2','SA3','SA5'],
 'CO-DIFF-01 sub-point. Use this language as a positive frame for the no-pricing-without-measure rule.'),

('APPT-ESTIMATE-01', 'process',
 'Window Protection Estimate runs about 90 minutes; quote is valid for 1 year',
 'No pressure to decide on the spot. Both homeowners should be present for accurate specs.',
 'factual', NULL,
 'APPT-ESTIMATE-01. Use "about an hour and a half" instead of "90 minutes" per HDL-PROCESS-01 voice guidance.')

ON CONFLICT DO NOTHING;


-- ─── New FAQ row from APPT-ESTIMATE-01 / HDL-PROCESS-01 ─────────────

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, story_arc, channel, tier, notes) VALUES

('HDL-PROCESS-01', 'How long does the in-home appointment take?',
 'About an hour and a half. We measure everything to Florida code, answer your questions, and leave you with exact pricing that is good for a full year. There is no pressure to decide during the visit.',
 'About an hour and a half. We measure to FL code, answer questions, leave you with exact pricing good for a full year. No pressure to decide on the spot.',
 NULL, 'both', 'factual',
 'HDL-PROCESS-01. Use "about an hour and a half" not "90 minutes" — sounds less clinical.')

ON CONFLICT DO NOTHING;


-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES
-- ════════════════════════════════════════════════════════════════════
-- SELECT kb_key, intent_class, handler_code, priority FROM kb_intent_handlers
--   WHERE kb_key IS NOT NULL ORDER BY priority, kb_key;
-- SELECT kb_key, objection_type, buyer_stage, trust_level FROM kb_objection_scripts
--   WHERE kb_key IS NOT NULL ORDER BY kb_key;
-- SELECT kb_key, category, left(claim, 60) FROM kb_proof_points
--   WHERE kb_key IS NOT NULL ORDER BY kb_key;
