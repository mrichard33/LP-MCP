-- Seed v1 prompt library for the outbound nurture engine.
--
-- This file is a TEMPLATE. The system_prompt and user_prompt_template
-- bodies marked with $$ ... $$ placeholders are intentionally empty —
-- Mark drafts them using the antifragile-copywriter skill and pastes
-- the finalized prompt text in before executing.
--
-- All rows are inserted with active=false. Mark activates them one at
-- a time after review:
--
--   UPDATE agentic_messaging_prompts SET active = true
--   WHERE prompt_code = 'S4.5-FALLBACK-GENERIC-EMAIL-V1';
--
-- Minimum prompts for shadow-mode launch (5):
--   1. Stage-2 no-objection email
--   2. Stage-3 spouse-objection email
--   3. Stage-3 timing-objection email
--   4. Generic SMS
--   5. FALLBACK (catches everything else — always-eligible)
--
-- The FALLBACK prompt is critical — the orchestrator falls back to it
-- when no specific prompt matches (ilike '%FALLBACK%' on prompt_code).
-- It MUST be active before the orchestrator is enabled.

-- ─────────────────────────────────────────────────────────────────────
-- 1. Stage-2 no-objection email
-- ─────────────────────────────────────────────────────────────────────
INSERT INTO agentic_messaging_prompts (
  prompt_code, workflow_code, channel,
  sequence_position, buyer_stage_target, trust_level_target,
  objection_filter, story_arc, formula, technique_mix,
  system_prompt, user_prompt_template, output_schema,
  banned_phrases, required_elements,
  active, notes
) VALUES (
  'S4.5-STAGE2-NOOBJ-EMAIL-V1',
  'S4.5', 'email',
  NULL, 2, 3,
  ARRAY['none'], 'hso', 'pas', ARRAY['T5','T9'],
  $$TODO: paste Stage-2 no-objection system prompt from antifragile-copywriter skill$$,
  $$TODO: paste user_prompt_template with {{lead.first_name}} {{lead.city}} etc.$$,
  '{
    "type": "object",
    "required": ["subject","preheader","body_html","story_arc_used","formula_used","buyer_stage_targeted","trust_level_targeted","primary_belief_shift","booking_escape_hatch_position"]
  }'::jsonb,
  ARRAY['Dear valued customer','Don''t miss out','Act now','Limited time'],
  ARRAY['booking_link','first_name'],
  false,
  'Stage 2 (curious, no specific objection). Educate + build category awareness.'
);

-- ─────────────────────────────────────────────────────────────────────
-- 2. Stage-3 spouse-objection email
-- ─────────────────────────────────────────────────────────────────────
INSERT INTO agentic_messaging_prompts (
  prompt_code, workflow_code, channel,
  sequence_position, buyer_stage_target, trust_level_target,
  objection_filter, story_arc, formula, technique_mix,
  system_prompt, user_prompt_template, output_schema,
  banned_phrases, required_elements,
  active, notes
) VALUES (
  'S4.5-STAGE3-SPOUSE-EMAIL-V1',
  'S4.5', 'email',
  NULL, 3, 3,
  ARRAY['spouse'], 'hso', 'star', ARRAY['T3','T7'],
  $$TODO: paste Stage-3 spouse-objection system prompt$$,
  $$TODO: paste user_prompt_template$$,
  '{
    "type": "object",
    "required": ["subject","preheader","body_html","story_arc_used","formula_used","buyer_stage_targeted","trust_level_targeted","primary_belief_shift","booking_escape_hatch_position"]
  }'::jsonb,
  ARRAY['Dear valued customer','Don''t miss out','Act now','Limited time'],
  ARRAY['booking_link','first_name'],
  false,
  'Stage 3 with spouse-decision objection. Help frame the conversation; do not push close.'
);

-- ─────────────────────────────────────────────────────────────────────
-- 3. Stage-3 timing-objection email
-- ─────────────────────────────────────────────────────────────────────
INSERT INTO agentic_messaging_prompts (
  prompt_code, workflow_code, channel,
  sequence_position, buyer_stage_target, trust_level_target,
  objection_filter, story_arc, formula, technique_mix,
  system_prompt, user_prompt_template, output_schema,
  banned_phrases, required_elements,
  active, notes
) VALUES (
  'S4.5-STAGE3-TIMING-EMAIL-V1',
  'S4.5', 'email',
  NULL, 3, 3,
  ARRAY['timing'], 'hso', 'pas', ARRAY['T5','T8'],
  $$TODO: paste Stage-3 timing-objection system prompt$$,
  $$TODO: paste user_prompt_template$$,
  '{
    "type": "object",
    "required": ["subject","preheader","body_html","story_arc_used","formula_used","buyer_stage_targeted","trust_level_targeted","primary_belief_shift","booking_escape_hatch_position"]
  }'::jsonb,
  ARRAY['Dear valued customer','Don''t miss out','Act now','Limited time'],
  ARRAY['booking_link','first_name'],
  false,
  'Stage 3 with timing objection (not right now / wait until X). Cost-of-delay framing without fake urgency.'
);

-- ─────────────────────────────────────────────────────────────────────
-- 4. Generic SMS (any stage)
-- ─────────────────────────────────────────────────────────────────────
INSERT INTO agentic_messaging_prompts (
  prompt_code, workflow_code, channel,
  sequence_position, buyer_stage_target, trust_level_target,
  objection_filter, story_arc, formula, technique_mix,
  system_prompt, user_prompt_template, output_schema,
  banned_phrases, required_elements,
  active, max_tokens, notes
) VALUES (
  'S4.5-GENERIC-SMS-V1',
  'S4.5', 'sms',
  NULL, NULL, NULL,
  NULL, NULL, NULL, ARRAY['T9'],
  $$TODO: paste short-form SMS system prompt$$,
  $$TODO: paste user_prompt_template$$,
  '{
    "type": "object",
    "required": ["sms_body","story_arc_used","buyer_stage_targeted","trust_level_targeted"]
  }'::jsonb,
  ARRAY['Don''t miss out','Act now','Limited time'],
  ARRAY['first_name'],
  false, 400,
  'Generic SMS prompt. Short, conversational, no aggressive CTA.'
);

-- ─────────────────────────────────────────────────────────────────────
-- 5. FALLBACK — must remain always-eligible
-- ─────────────────────────────────────────────────────────────────────
INSERT INTO agentic_messaging_prompts (
  prompt_code, workflow_code, channel,
  sequence_position, buyer_stage_target, trust_level_target,
  objection_filter, story_arc, formula, technique_mix,
  system_prompt, user_prompt_template, output_schema,
  banned_phrases, required_elements,
  active, notes
) VALUES (
  'S4.5-FALLBACK-GENERIC-EMAIL-V1',
  'S4.5', 'email',
  NULL, NULL, NULL,
  NULL, NULL, NULL, ARRAY['T5','T9'],
  $$TODO: paste safe fallback system prompt$$,
  $$TODO: paste user_prompt_template$$,
  '{
    "type": "object",
    "required": ["subject","preheader","body_html","story_arc_used","formula_used","buyer_stage_targeted","trust_level_targeted","primary_belief_shift","booking_escape_hatch_position"]
  }'::jsonb,
  ARRAY['Dear valued customer','Don''t miss out','Act now','Limited time'],
  ARRAY['booking_link','first_name'],
  false,
  'Fallback when no specific prompt matches. Deliberately generic; safe. MUST be active before orchestrator is enabled in production.'
);
