-- ════════════════════════════════════════════════════════════════════
-- 014_kb_keyed_updates.sql  (REVISED — schema-correct)
-- SEED: Mark's KEY-based reference content (Avatar/Objection/Handler docs)
-- ════════════════════════════════════════════════════════════════════
-- Apply via Supabase SQL editor AFTER 010, 011, 012, 013 have been applied.
-- Idempotent — uses ON CONFLICT and IF NOT EXISTS guards.
--
-- v2 fixes (vs the failed first attempt):
--   - kb_intent_handlers uses correct schema: bucket_type='intent_router'
--     (not 'router'), action_type='generate_response' (not 'route_*'),
--     gate_priority (not priority), single trigger_keywords TEXT[]
--     (no separate trigger_phrases column — short kw + phrase both go
--     in trigger_keywords; classifier handles short-vs-long matching).
--   - Skips CALLBACK_CALM insert (existing CALLBACK row already maps
--     to HDL-CALLBACK-01; we just enrich its trigger_keywords below).
-- ════════════════════════════════════════════════════════════════════


-- ─── Schema additions: kb_key columns for KEY traceability ──────────

ALTER TABLE kb_intent_handlers   ADD COLUMN IF NOT EXISTS kb_key TEXT;
ALTER TABLE kb_objection_scripts ADD COLUMN IF NOT EXISTS kb_key TEXT;
ALTER TABLE kb_faqs              ADD COLUMN IF NOT EXISTS kb_key TEXT;
ALTER TABLE kb_proof_points      ADD COLUMN IF NOT EXISTS kb_key TEXT;
ALTER TABLE kb_pricing_anchors   ADD COLUMN IF NOT EXISTS kb_key TEXT;

CREATE INDEX IF NOT EXISTS idx_kb_intent_handlers_key   ON kb_intent_handlers(kb_key)   WHERE kb_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kb_objection_scripts_key ON kb_objection_scripts(kb_key) WHERE kb_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kb_faqs_key              ON kb_faqs(kb_key)              WHERE kb_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kb_proof_points_key      ON kb_proof_points(kb_key)      WHERE kb_key IS NOT NULL;


-- ─── Buying-signal handlers — new intent classes ────────────────────
-- These are intent_router (NOT compliance_gate) with action_type=
-- generate_response. The response generator reads handler_code and
-- description to know "skip discovery, go to scheduling".
--
-- gate_priority 105 places them BETWEEN APPT_STATUS (100) and the
-- generic BOOK (110), so a "what's next" or "I want a quote" hits the
-- specific handler before falling through to generic BOOK.

INSERT INTO kb_intent_handlers (
  intent_class, handler_code, bucket_type, gate_priority, description,
  trigger_keywords, action_type, ghl_handoff_tag, disqualifier, kb_key, notes
) VALUES

('BOOK_NEXTSTEP', 'HDL-NEXTSTEP-01', 'intent_router', 105,
 'Lead asking what happens next or how to proceed. BUYING SIGNAL — they''re ready. Do NOT re-pitch. Do NOT mention financing. Do NOT explain the company. Answer directly and offer two specific calendar slots from the in-home Window Estimate calendar.',
 ARRAY['proceed','next','schedule',
       'what''s next','what are the next steps','what happens now','how do we proceed','what do I do now','how do I get started','what now'],
 'generate_response', 'hdl:book-nextstep', false,
 'HDL-NEXTSTEP-01',
 'Buying signal. Skip discovery, go to two calendar slot offers.'),

('BOOK_QUOTE_READY', 'HDL-QUOTE-READY-01', 'intent_router', 105,
 'Lead asking for "a quote" or "an estimate". BUYING SIGNAL — they want to schedule the in-home, not get a phone-quote. Do NOT pivot to discovery (that''s OBJ-PRICE-01 territory for "how much does it cost?"). Move directly to scheduling with two specific calendar slots from the in-home Window Estimate calendar.',
 ARRAY['quote','estimate',
       'I want a quote','can I get an estimate','I''d like a quote','ready for a quote','want an estimate','get me a quote','need an estimate','looking to get a quote','can you give me a quote','interested in a quote','schedule an estimate'],
 'generate_response', 'hdl:book-quote-ready', false,
 'HDL-QUOTE-READY-01',
 'CRITICAL distinction: "quote" = ready (book), "how much?" = price-shopping (PRICING/OBJ-PRICE-01 pivot).'),

('FAST_TRACK_FRUSTRATED', 'HDL-FRUSTRATED-01', 'intent_router', 108,
 'Lead is impatient and wants to skip the conversation. Match urgency. Skip remaining qualification. Go directly to two calendar slots. Brief acknowledgment then action.',
 ARRAY['too many questions','just schedule me','get to the point','how much longer','this is taking forever','can we just','stop asking','enough questions','just book it'],
 'generate_response', 'hdl:fast-track-frustrated', false,
 'HDL-FRUSTRATED-01',
 'Match the urgency, do not apologize at length. Distinct from ANGRY (compliance gate, hand to human).')

ON CONFLICT (intent_class) DO UPDATE SET
  handler_code     = EXCLUDED.handler_code,
  bucket_type      = EXCLUDED.bucket_type,
  gate_priority    = EXCLUDED.gate_priority,
  description      = EXCLUDED.description,
  trigger_keywords = EXCLUDED.trigger_keywords,
  action_type      = EXCLUDED.action_type,
  ghl_handoff_tag  = EXCLUDED.ghl_handoff_tag,
  disqualifier     = EXCLUDED.disqualifier,
  kb_key           = EXCLUDED.kb_key,
  notes            = EXCLUDED.notes,
  updated_at       = now();


-- ─── Enrich existing CALLBACK to absorb HDL-CALLBACK-01 phrases ─────
-- CALLBACK already exists from sql/011 with handler_code='HDL-CALLBACK-01'
-- and action_type='tag_and_handoff'. Just adding the broader phrase set
-- from the Situation Handlers doc and tagging with the kb_key.

UPDATE kb_intent_handlers
SET
  kb_key = 'HDL-CALLBACK-01',
  trigger_keywords = ARRAY[
    'call me','talk to someone','speak to a person','give me a ring',
    'speak to a rep','have someone call','can I talk to a person',
    'rather talk on the phone','can someone call me','prefer to talk',
    'call back','I''d rather talk','phone call'
  ],
  description = 'Lead calmly requesting a phone conversation. Tags contact for callback workflow (Bot 3). Distinct from ANGRY (compliance_gate — frustrated demand) and FAST_TRACK_FRUSTRATED (impatient in-text). Do NOT try to keep them in text.',
  notes = 'HDL-CALLBACK-01. Confirm phone number then hand off to Bot 3.',
  updated_at = now()
WHERE intent_class = 'CALLBACK';


-- ─── Backfill kb_key on existing intent handlers ────────────────────

UPDATE kb_intent_handlers SET kb_key = 'HDL-STOP-01'           WHERE handler_code = 'HDL-STOP-01'           AND kb_key IS NULL;
UPDATE kb_intent_handlers SET kb_key = 'HDL-DQ-MOBILE-01'      WHERE handler_code = 'HDL-DQ-MOBILE-01'      AND kb_key IS NULL;
UPDATE kb_intent_handlers SET kb_key = 'HDL-DQ-RENTER-01'      WHERE handler_code = 'HDL-DQ-RENTER-01'      AND kb_key IS NULL;
-- 2026-07-06: HDL-DQ-INVESTMENT-01 backfill removed — the INVESTMENT gate is
-- retired (investment properties are normal leads; see 011 and the
-- consolidation PR for the live-row cleanup task).
UPDATE kb_intent_handlers SET kb_key = 'HDL-WHO-01'            WHERE handler_code = 'HDL-WHO-01'            AND kb_key IS NULL;
UPDATE kb_intent_handlers SET kb_key = 'HDL-WRONG-01'          WHERE handler_code = 'HDL-WRONG-01'          AND kb_key IS NULL;
UPDATE kb_intent_handlers SET kb_key = 'HDL-HUMAN-01'          WHERE handler_code = 'HDL-HUMAN-01'          AND kb_key IS NULL;
UPDATE kb_intent_handlers SET kb_key = 'HDL-APPT-STATUS-01'    WHERE handler_code = 'HDL-APPT-STATUS-01'    AND kb_key IS NULL;


-- ════════════════════════════════════════════════════════════════════
-- kb_objection_scripts — keyed library
-- These columns ARE correct: kb_key, objection_type, buyer_stage,
-- trust_level, channel, story_arc, opener, body_template, soft_next_step,
-- do_not_use, priority, notes — all exist in 010 schema.
-- ════════════════════════════════════════════════════════════════════

INSERT INTO kb_objection_scripts
  (kb_key, objection_type, buyer_stage, trust_level, channel, story_arc,
   opener, body_template, soft_next_step, do_not_use, priority, notes) VALUES

('OBJ-PRICE-01', 'price_first_ask', 2, 2, 'both', 'SA5',
 NULL,
 'To give you an exact price that is actually accurate, we measure to Florida code. Before that, what matters more to you right now — keeping the home cooler and lowering energy costs, or having the strongest storm protection possible?',
 'End with the question. No additional explanation.',
 ARRAY['mention vinyl or aluminum by name','quote a number','say "ballpark"','say "every home is different"'],
 50,
 'OBJ-PRICE-01. We only sell vinyl which delivers BOTH benefits — let them state their priority first.'),

('OBJ-PRICE-02', 'price_persistent', 3, 2, 'both', NULL,
 'I get why you want a ballpark.',
 'In Florida, code requirements can change street by street, so ballparks usually end up wrong. We leave you with an exact quote after a quick measure.',
 'Does [time slot] work to take care of that?',
 ARRAY['say "every home is different"','quote a number','give a range','apologize'],
 60,
 'OBJ-PRICE-02. After OBJ-PRICE-01 pivot didn''t land. Insert ONE real calendar slot.'),

('OBJ-PRICE-03', 'competitor_pricing', 3, 3, 'both', 'SA3',
 'Makes sense to compare.',
 'When you look at quotes, ask who actually does the install, what the warranty really covers, and what happens if you need service years down the road. Those hidden details usually matter more than the number.',
 'Have any of the quotes walked you through that yet?',
 ARRAY['ask them to reveal competitor pricing','promise to match','badmouth the competitor','name the competitor'],
 60,
 'OBJ-PRICE-03. Plant doubt about competitor value through QUESTIONS, never attacks.'),

('OBJ-SPOUSE-02', 'discuss_with_spouse', 4, 4, 'both', NULL,
 'Of course.',
 'From what we talked about so far, what do you think {{contact.spouse_name}} would be most excited about?',
 'Conditional follow-up: if excitement → "Would it help to schedule a time when you are both there?" / if concern → "Would it be helpful if they could ask those questions directly during a visit?" / if budget → "Want me to get you exact numbers so you have something concrete to review together?" / if timing → "Do you want me to check back after you talk, or would you prefer something on the calendar you can both plan around?"',
 ARRAY['try to bypass the spouse','pressure','ask multiple questions at once','if no spouse name use the variable — substitute "they"'],
 70,
 'OBJ-SPOUSE-02. If no spouse_name captured, replace {{contact.spouse_name}} with "they". One question at a time.'),

('OBJ-BUSY-01', 'too_busy', 2, 3, 'both', NULL,
 'I get it — schedules get packed fast.',
 'The visit is straightforward. We measure, answer questions, and leave you with exact pricing to review later.',
 'Would [morning or afternoon] on [day] be easier?',
 ARRAY['say "whenever things settle down"','offer no specific day','push twice'],
 50,
 'OBJ-BUSY-01. Always offer a specific day, never vague.'),

('OBJ-TIMING-01', 'bad_timing_event', 2, 3, 'both', NULL,
 NULL,
 'No problem — [event/trip] should definitely come first.',
 'Want me to reach out after [date], or should we get something on the calendar for when you''re back?',
 ARRAY['be vague about timing','let them ghost without a follow-up commitment'],
 50,
 'OBJ-TIMING-01. Get a specific date if possible.'),

('HDL-BABY-01', 'baby_newborn', 2, 3, 'both', NULL,
 'Congrats on the baby!',
 'We keep this very simple. Our specialist comes out, measures everything, answers questions, and leaves you with exact pricing to review whenever you have a quiet moment.',
 'Would [specific day] work, or should I check back after things settle?',
 ARRAY['say "whenever things settle down" without offering a specific alternative','pressure'],
 50,
 'HDL-BABY-01. Always offer specific day even when checking back.'),

('OBJ-BUDGET-01', 'budget_concern', 3, 3, 'both', 'SA5',
 'That makes sense.',
 'When people mention budget, it usually means one of two things — is it the monthly payment that feels uncomfortable, or the overall scope of the project?',
 'Conditional follow-up: if monthly → "We do have financing options that can make the monthly very manageable. Would it help to see what that could look like for you?" / if scope → "A lot of families start with the most critical windows first and phase the rest over time. Would that approach be worth exploring?"',
 ARRAY['introduce financing before they confirm monthly concern','push pricing','offer multiple paths at once','say "expensive" or "cheap"'],
 70,
 'OBJ-BUDGET-01. Clarify constraint BEFORE solving. Monthly = financing. Scope = phased.'),

('OBJ-TRUST-02', 'just_shopping', 1, 2, 'both', NULL,
 'Makes sense — it''s smart to do your homework first.',
 'Is there anything specific you''re trying to figure out?',
 'Happy to answer questions without any pressure.',
 ARRAY['push for an appointment','use scarcity','assume they''re ready'],
 50,
 'OBJ-TRUST-02. Be helpful, stay in their consideration set.'),

('OBJ-CANCEL-01', 'cancel_appointment', 4, 3, 'both', NULL,
 'No problem at all.',
 'Is this more of a timing issue, or did you decide to pause the project for now?',
 'Conditional follow-up: if timing → "Got it. Would you like me to look for a better time, or should I check back with you later?" / if pause → "Understood. I will pause this on my end. If things change later, just reach out and we will take it from there." / ALWAYS append: "No pressure either way. I just want to handle this the right way for you."',
 ARRAY['try to save the appointment','ask multiple clarifying questions','pressure for a reason','skip the closing safety line'],
 80,
 'OBJ-CANCEL-01. ONE clarifying question. ALWAYS include closing safety line.')

ON CONFLICT DO NOTHING;


-- Backfill kb_key on existing objection rows
UPDATE kb_objection_scripts SET kb_key = 'OBJ-TRUST-01'   WHERE objection_type = 'been_burned'        AND kb_key IS NULL;
UPDATE kb_objection_scripts SET kb_key = 'OBJ-COMPANY-01' WHERE objection_type = 'company_disappears' AND kb_key IS NULL;


-- ════════════════════════════════════════════════════════════════════
-- kb_proof_points — Avatars + brand language + appointment specs
-- ════════════════════════════════════════════════════════════════════

INSERT INTO kb_proof_points (kb_key, category, claim, evidence, tier, use_for_arcs, notes) VALUES

('AVA-DAVE-01', 'avatar',
 'Primary buyer is "Dave": 55-65, Florida coastal, single-family home owned 10+ years, married',
 'Lives with: storm anxiety, financial frustration over energy bills, trust wounds from past contractors. Needs: math/logic, proof, no-pressure language, control. Runs from: price pressure, urgency tactics, salesy language, scripted feel.',
 'reference', NULL,
 'AVA-DAVE-01 — primary avatar.'),

('AVA-MARIA-01', 'avatar',
 'Secondary buyer is "Maria": Dave''s spouse, key influencer on budget/timing/trust',
 'Remembers contractor nightmares MORE vividly than Dave. Controls or heavily influences budget. Needs warranty/service guarantees more than features.',
 'reference', NULL,
 'AVA-MARIA-01. When spouse name is captured, reference by name.'),

('LANG-USE-01', 'brand_language',
 'Words to use: family, team, experts, investment, protection, security, craftsmanship, peace of mind, energy savings, complimentary estimate, Window Protection Estimate, penny-accurate pricing, Florida-engineered, in-house team, transferable double lifetime warranty, free service for life',
 NULL, 'reference', NULL,
 'LANG-USE-01. Default vocabulary for the bot.'),

('LANG-AVOID-01', 'brand_language',
 'Words to avoid: cost, price, expense, deal, locked in, limited time, act now, workers, staff, cheap, affordable, discount',
 NULL, 'reference', NULL,
 'LANG-AVOID-01. Substitute: "investment" for cost, "team" for workers/staff, "complimentary" for free.'),

('CO-DIFF-01-PENNY', 'process',
 'Penny-accurate pricing — exact quotes after in-home measure, not estimates',
 'Differentiator vs competitors who give ranges. Aligns with no-pricing rule because the only accurate price comes from the in-home.',
 'factual', ARRAY['SA2','SA3','SA5'],
 'CO-DIFF-01 sub-point. Positive frame for the no-pricing-without-measure rule.'),

('APPT-ESTIMATE-01', 'process',
 'Window Protection Estimate runs about 90 minutes; quote is valid for 1 year',
 'No pressure to decide on the spot. Both homeowners should be present for accurate specs.',
 'factual', NULL,
 'APPT-ESTIMATE-01. Use "about an hour and a half" instead of "90 minutes" per HDL-PROCESS-01 voice guidance.')

ON CONFLICT DO NOTHING;


-- ════════════════════════════════════════════════════════════════════
-- kb_faqs — appointment-duration FAQ row
-- ════════════════════════════════════════════════════════════════════

INSERT INTO kb_faqs
  (kb_key, question_pattern, canonical_answer, answer_short, story_arc, channel, tier, notes)
VALUES
('HDL-PROCESS-01', 'How long does the in-home appointment take?',
 'About an hour and a half. We measure everything to Florida code, answer your questions, and leave you with exact pricing that is good for a full year. There is no pressure to decide during the visit.',
 'About an hour and a half. We measure to FL code, answer questions, leave you with exact pricing good for a full year. No pressure to decide on the spot.',
 NULL, 'both', 'factual',
 'HDL-PROCESS-01. Use "about an hour and a half" not "90 minutes" — sounds less clinical.')

ON CONFLICT DO NOTHING;


-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION (run these after applying)
-- ════════════════════════════════════════════════════════════════════
-- SELECT intent_class, kb_key, handler_code, gate_priority FROM kb_intent_handlers
--   WHERE kb_key IS NOT NULL ORDER BY gate_priority, kb_key;
-- SELECT kb_key, objection_type, buyer_stage FROM kb_objection_scripts
--   WHERE kb_key IS NOT NULL ORDER BY kb_key;
-- SELECT kb_key, category, left(claim,60) FROM kb_proof_points
--   WHERE kb_key IS NOT NULL ORDER BY kb_key;
