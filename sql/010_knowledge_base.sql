-- ════════════════════════════════════════════════════════════════════
-- 010_knowledge_base.sql
-- KNOWLEDGE BASE TABLES — Tier 1 (Structured)
-- ════════════════════════════════════════════════════════════════════
-- Used by: src/knowledge/kb-queries.js
-- Editable via Supabase dashboard for hot-reload — no deploy needed.
--
-- Run this BEFORE the seed migrations 011-017.
-- ════════════════════════════════════════════════════════════════════

-- ─── kb_intent_handlers ─────────────────────────────────────────────
-- Bot 2's compliance gates + 9 intent buckets, ported.
-- HDL-* codes reference GHL knowledge base files (response content lives in GHL).
-- This table tells the agentic system WHICH handler to fire, GHL handles the body.

CREATE TABLE IF NOT EXISTS kb_intent_handlers (
  id BIGSERIAL PRIMARY KEY,
  intent_class TEXT NOT NULL UNIQUE,
  handler_code TEXT,                   -- HDL-* code (GHL KB reference)
  bucket_type TEXT NOT NULL,           -- 'compliance_gate' | 'intent_router'
  gate_priority INTEGER DEFAULT 100,   -- Lower = fires first; gates use 1-50
  description TEXT,
  trigger_keywords TEXT[],
  action_type TEXT NOT NULL DEFAULT 'tag_and_handoff',
                                       -- 'tag_and_handoff' | 'generate_response' | 'block_silently'
  ghl_handoff_tag TEXT,                -- Tag to apply for GHL workflow pickup
  disqualifier BOOLEAN DEFAULT false,  -- TRUE = no further sales messages
  notes TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kb_intent_handlers_class ON kb_intent_handlers(intent_class) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_kb_intent_handlers_bucket ON kb_intent_handlers(bucket_type, gate_priority) WHERE active = true;

-- ─── kb_story_arcs ──────────────────────────────────────────────────
-- Full SA1-SA5 playbooks. Replaces the one-line summaries in the system prompt.

CREATE TABLE IF NOT EXISTS kb_story_arcs (
  id BIGSERIAL PRIMARY KEY,
  arc_id TEXT NOT NULL UNIQUE,         -- SA1, SA2, SA3, SA4, SA5
  arc_name TEXT NOT NULL,
  core_belief TEXT NOT NULL,           -- Belief shift this arc creates
  problem_named TEXT,                   -- The unaware problem
  proof_points JSONB DEFAULT '[]'::jsonb,
  openers JSONB DEFAULT '[]'::jsonb,
  example_paragraphs JSONB DEFAULT '[]'::jsonb,
  do_not_say JSONB DEFAULT '[]'::jsonb,
  best_for_buyer_stages INTEGER[],
  best_for_objections TEXT[],
  active BOOLEAN DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kb_story_arcs_arc_id ON kb_story_arcs(arc_id) WHERE active = true;

-- ─── kb_objection_scripts ───────────────────────────────────────────
-- Canonical objection responses keyed on (objection, buyer_stage, channel).
-- Ported from W9.0 6-branch logic.

CREATE TABLE IF NOT EXISTS kb_objection_scripts (
  id BIGSERIAL PRIMARY KEY,
  objection_type TEXT NOT NULL,        -- price | timing | spouse | trust | competitor | diy
  buyer_stage INTEGER NOT NULL,        -- 1-5
  trust_level INTEGER NOT NULL,        -- 1-6
  channel TEXT NOT NULL,               -- sms | email | both
  story_arc TEXT,                       -- SA1-SA5
  opener TEXT,
  body_template TEXT,                   -- {{first_name}}, {{rep_name}}, {{lp_disposition}} placeholders
  soft_next_step TEXT,
  do_not_use TEXT[],
  priority INTEGER DEFAULT 100,
  active BOOLEAN DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kb_objection_scripts_lookup
  ON kb_objection_scripts(objection_type, buyer_stage, channel) WHERE active = true;

-- ─── kb_proof_points ────────────────────────────────────────────────
-- Citable facts the bot can reference. factual vs marketing tier.

CREATE TABLE IF NOT EXISTS kb_proof_points (
  id BIGSERIAL PRIMARY KEY,
  category TEXT NOT NULL,              -- 'company' | 'product' | 'safety' | 'savings' | 'warranty' | 'process'
  claim TEXT NOT NULL,
  evidence TEXT,
  source_url TEXT,
  tier TEXT NOT NULL DEFAULT 'factual', -- 'factual' | 'marketing'
  use_for_arcs TEXT[],
  use_for_trust_levels INTEGER[],
  active BOOLEAN DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kb_proof_points_category ON kb_proof_points(category) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_kb_proof_points_arcs ON kb_proof_points USING gin(use_for_arcs) WHERE active = true;

-- ─── kb_pricing_anchors ─────────────────────────────────────────────
-- Pricing context (no quotes). For framing not closing.

CREATE TABLE IF NOT EXISTS kb_pricing_anchors (
  id BIGSERIAL PRIMARY KEY,
  window_count_min INTEGER NOT NULL,
  window_count_max INTEGER NOT NULL,
  typical_range_low INTEGER,
  typical_range_high INTEGER,
  anchoring_message TEXT,
  roi_framing TEXT,
  payment_framing TEXT,
  notes TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kb_pricing_anchors_range
  ON kb_pricing_anchors(window_count_min, window_count_max) WHERE active = true;

-- ─── kb_competitor_intel ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS kb_competitor_intel (
  id BIGSERIAL PRIMARY KEY,
  competitor_name TEXT NOT NULL,
  market_segment TEXT,                  -- 'budget' | 'premium' | 'big-box' | 'national'
  weakness TEXT,
  talking_point TEXT,
  do_not_attack TEXT[],
  reece_advantage TEXT,
  active BOOLEAN DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kb_competitor_intel_name
  ON kb_competitor_intel(lower(competitor_name)) WHERE active = true;

-- ─── kb_product_specs ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS kb_product_specs (
  id BIGSERIAL PRIMARY KEY,
  product_line TEXT NOT NULL,
  attribute TEXT NOT NULL,
  value TEXT NOT NULL,
  comparison_context TEXT,
  source_url TEXT,
  active BOOLEAN DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kb_product_specs_line
  ON kb_product_specs(product_line, attribute) WHERE active = true;

-- ─── kb_faqs ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS kb_faqs (
  id BIGSERIAL PRIMARY KEY,
  question_pattern TEXT NOT NULL,
  canonical_answer TEXT NOT NULL,
  answer_short TEXT,                   -- SMS-length
  story_arc TEXT,
  channel TEXT NOT NULL DEFAULT 'both',
  tier TEXT NOT NULL DEFAULT 'factual',
  active BOOLEAN DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kb_faqs_pattern
  ON kb_faqs USING gin(to_tsvector('english', question_pattern)) WHERE active = true;

-- ─── kb_techniques ──────────────────────────────────────────────────
-- The 10 Antifragile copywriting techniques.

CREATE TABLE IF NOT EXISTS kb_techniques (
  id BIGSERIAL PRIMARY KEY,
  technique_number INTEGER NOT NULL UNIQUE,
  technique_name TEXT NOT NULL,
  when_to_use TEXT NOT NULL,
  buyer_stages INTEGER[],
  template TEXT,
  examples JSONB DEFAULT '[]'::jsonb,
  do_not_use_when TEXT,
  active BOOLEAN DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kb_techniques_number ON kb_techniques(technique_number) WHERE active = true;

-- ─── kb_handler_logs ────────────────────────────────────────────────
-- Audit trail for compliance gate / intent router decisions.
-- Every classification decision logged here for analytics + debugging.

CREATE TABLE IF NOT EXISTS kb_handler_logs (
  id BIGSERIAL PRIMARY KEY,
  ghl_contact_id TEXT NOT NULL,
  intent_class TEXT NOT NULL,
  handler_code TEXT,
  bucket_type TEXT NOT NULL,
  action_type TEXT NOT NULL,
  trigger_message TEXT,
  classifier_confidence NUMERIC(3,2),
  classifier_reasoning TEXT,
  channel TEXT,
  outcome TEXT,                        -- 'tagged' | 'generated' | 'blocked' | 'failed'
  outcome_detail JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kb_handler_logs_contact ON kb_handler_logs(ghl_contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_handler_logs_class ON kb_handler_logs(intent_class, created_at DESC);

-- ─── updated_at triggers ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION kb_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'kb_intent_handlers',
    'kb_story_arcs',
    'kb_objection_scripts',
    'kb_proof_points',
    'kb_pricing_anchors',
    'kb_competitor_intel',
    'kb_product_specs',
    'kb_faqs',
    'kb_techniques'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_updated_at ON %I', t, t);
    EXECUTE format(
      'CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION kb_set_updated_at()',
      t, t
    );
  END LOOP;
END $$;
