-- Agentic Messaging Prompts — Outbound Nurture Prompt Registry
--
-- Central registry of versioned, activatable prompts that drive the
-- outbound nurture message generator (src/nurture/*). One row = one
-- prompt. The selector (src/nurture/nurture-prompt-selector.js) matches
-- prompts by workflow_code + sequence_position + buyer_stage_target +
-- objection_filter at generation time and picks the highest-scoring
-- eligible row.
--
-- Sibling table:
--   agentic_messages — audit log of every generation (see
--   agentic_messages.sql). Joined via prompt_id.
--
-- This table is created in Supabase via the Supabase SQL editor (or via
-- LP MCP supabase_run_query). The .sql file lives in the repo for
-- reproducibility; execution does not happen from code.

CREATE TABLE IF NOT EXISTS agentic_messaging_prompts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_code           TEXT UNIQUE NOT NULL,
  workflow_code         TEXT NOT NULL,
  channel               TEXT NOT NULL
    CHECK (channel IN ('email','sms','email+sms')),
  sequence_position     INTEGER,
  buyer_stage_target    INTEGER CHECK (buyer_stage_target BETWEEN 1 AND 5),
  trust_level_target    INTEGER CHECK (trust_level_target BETWEEN 1 AND 6),
  objection_filter      TEXT[],
  story_arc             TEXT,
  formula               TEXT,
  technique_mix         TEXT[],
  system_prompt         TEXT NOT NULL,
  user_prompt_template  TEXT NOT NULL,
  output_schema         JSONB NOT NULL,
  model                 TEXT,
  judge_model           TEXT,
  max_tokens            INTEGER DEFAULT 1500,
  temperature           NUMERIC DEFAULT 0.7,
  confidence_threshold  NUMERIC DEFAULT 0.78,
  banned_phrases        TEXT[],
  required_elements     TEXT[],
  active                BOOLEAN DEFAULT false,
  version               INTEGER DEFAULT 1,
  variant_label         TEXT,
  variant_weight        INTEGER DEFAULT 100,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now(),
  notes                 TEXT
);

CREATE INDEX IF NOT EXISTS idx_prompts_workflow
  ON agentic_messaging_prompts(workflow_code, channel, active);

CREATE INDEX IF NOT EXISTS idx_prompts_stage
  ON agentic_messaging_prompts(buyer_stage_target, active);

COMMENT ON TABLE agentic_messaging_prompts IS
  'Central prompt registry for outbound nurture messaging. Each row is a versioned, activatable prompt with selection criteria. Prompts are matched at generation time by workflow_code + sequence_position + buyer_stage_target + objection_filter.';
