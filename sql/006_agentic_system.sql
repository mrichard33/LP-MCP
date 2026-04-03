-- =============================================================================
-- REECE AGENTIC SYSTEM — Supabase Schema
-- Run in: LP MCP Supabase → SQL Editor (same database as claude_* tables)
-- Date: 2026-04-02
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE 1: system_events
-- The event bus. Every meaningful state change across GHL, LP, and n8n
-- gets logged here. The decision engine polls unprocessed events.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS system_events (
  id              bigserial PRIMARY KEY,
  event_type      text NOT NULL,
  event_subtype   text,
  source          text NOT NULL,
  entity_type     text NOT NULL,
  entity_id       text NOT NULL,
  ghl_contact_id  text,
  lp_lead_id      text,
  lp_prospect_id  text,
  payload         jsonb NOT NULL DEFAULT '{}',
  previous_state  jsonb,
  new_state       jsonb,
  processed       boolean DEFAULT false,
  processed_by    text,
  processed_at    timestamptz,
  action_taken    text,
  priority        text DEFAULT 'normal' CHECK (priority IN ('critical', 'high', 'normal', 'low')),
  idempotency_key text UNIQUE,
  event_timestamp timestamptz,
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX idx_se_unprocessed ON system_events (priority, created_at) WHERE processed = false;
CREATE INDEX idx_se_entity ON system_events (entity_type, entity_id);
CREATE INDEX idx_se_type ON system_events (event_type, created_at DESC);
CREATE INDEX idx_se_ghl_contact ON system_events (ghl_contact_id) WHERE ghl_contact_id IS NOT NULL;
CREATE INDEX idx_se_lp_lead ON system_events (lp_lead_id) WHERE lp_lead_id IS NOT NULL;
CREATE INDEX idx_se_created ON system_events (created_at DESC);
CREATE INDEX idx_se_source ON system_events (source, event_type);


-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE 2: agent_actions
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_actions (
  id              bigserial PRIMARY KEY,
  event_id        bigint REFERENCES system_events(id),
  action_type     text NOT NULL,
  target_system   text NOT NULL,
  target_entity   text NOT NULL,
  target_id       text NOT NULL,
  action_payload  jsonb NOT NULL,
  rollback_payload jsonb,
  reasoning       text,
  confidence      numeric(3,2),
  rule_applied    text,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','pending_approval','approved','rejected','executing','completed','failed','rolled_back','skipped')),
  requires_approval boolean DEFAULT false,
  approved_by     text,
  approved_at     timestamptz,
  rejection_reason text,
  executed_at     timestamptz,
  execution_result jsonb,
  error_message   text,
  retry_count     integer DEFAULT 0,
  max_retries     integer DEFAULT 3,
  batch_id        text,
  sequence_order  integer DEFAULT 0,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

CREATE INDEX idx_aa_status ON agent_actions (status, created_at) WHERE status IN ('pending', 'pending_approval', 'approved', 'executing');
CREATE INDEX idx_aa_event ON agent_actions (event_id);
CREATE INDEX idx_aa_target ON agent_actions (target_system, target_entity, target_id);
CREATE INDEX idx_aa_batch ON agent_actions (batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX idx_aa_approval ON agent_actions (status, requires_approval) WHERE status = 'pending_approval';
CREATE INDEX idx_aa_created ON agent_actions (created_at DESC);


-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE 3: agent_rules
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_rules (
  id              bigserial PRIMARY KEY,
  rule_key        text UNIQUE NOT NULL,
  rule_name       text NOT NULL,
  category        text NOT NULL,
  event_pattern   jsonb NOT NULL,
  conditions      jsonb,
  action_template jsonb NOT NULL,
  requires_approval boolean DEFAULT false,
  enabled         boolean DEFAULT true,
  priority        integer DEFAULT 100,
  version         integer DEFAULT 1,
  created_by      text DEFAULT 'claude',
  notes           text,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

CREATE INDEX idx_ar_category ON agent_rules (category, enabled) WHERE enabled = true;
CREATE INDEX idx_ar_key ON agent_rules (rule_key);


-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE 4: agent_metrics
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_metrics (
  id              bigserial PRIMARY KEY,
  metric_date     date NOT NULL,
  metric_type     text NOT NULL,
  metric_value    numeric,
  dimensions      jsonb DEFAULT '{}',
  created_at      timestamptz DEFAULT now(),
  UNIQUE(metric_date, metric_type, dimensions)
);

CREATE INDEX idx_am_date ON agent_metrics (metric_date DESC, metric_type);


-- ─────────────────────────────────────────────────────────────────────────────
-- VIEW: agent_approval_queue
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW agent_approval_queue AS
SELECT 
  aa.id as action_id, aa.action_type, aa.target_system, aa.target_entity,
  aa.target_id, aa.action_payload, aa.reasoning, aa.confidence,
  aa.rule_applied, aa.created_at,
  se.event_type, se.source as event_source, se.ghl_contact_id,
  se.lp_lead_id, se.payload as event_payload
FROM agent_actions aa
JOIN system_events se ON aa.event_id = se.id
WHERE aa.status = 'pending_approval'
ORDER BY aa.created_at ASC;


-- ─────────────────────────────────────────────────────────────────────────────
-- TRIGGERS: auto-update updated_at
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_agent_actions_timestamp()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_agent_actions_updated
  BEFORE UPDATE ON agent_actions FOR EACH ROW
  EXECUTE FUNCTION update_agent_actions_timestamp();

CREATE OR REPLACE FUNCTION update_agent_rules_timestamp()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_agent_rules_updated
  BEFORE UPDATE ON agent_rules FOR EACH ROW
  EXECUTE FUNCTION update_agent_rules_timestamp();
