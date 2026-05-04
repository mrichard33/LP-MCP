-- =============================================================================
-- MVI Antifragile v2.5 — Tag-stacking & dispatch-gap fix
-- Run in: LP MCP Supabase → SQL Editor
-- Date: 2026-05-04
-- =============================================================================
--
-- This migration delivers the storage layer for the five-patch MVI:
--   1. processed_events       — inbound idempotency log
--   2. outbound_locks         — per-(contact, trigger) outbound dedup
--   3. layer3_action_dispatch — Layer 3 classification → action sequence map
--
-- And seeds the rules / dispatch rows that activate the system:
--   - layer3_action_dispatch: "suppress" (verified) + 3 inactive placeholders
--   - agent_rules:            LAYER3_DISPATCH + DRIFT_NOTIFY_GROUPME
--
-- All operations are idempotent. Re-running this file is safe.
--
-- Governing principle (do not violate when extending):
--   System-driven state changes derive from classified events.
--   Mutations triggered by proxy signals — lead score, tag presence,
--   raw time delays alone — are bugs, not features.
-- =============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. processed_events — Inbound idempotency
-- ─────────────────────────────────────────────────────────────────────────────
-- One row per (contact_id, message_id|event_id). The decision engine INSERTs
-- before processing; conflict = already processed = skip. Catches duplicate
-- webhook deliveries that produce two distinct system_events rows for the
-- same physical message.
--
-- Distinct from system_events.idempotency_key, which prevents duplicate event
-- *creation*; this table prevents duplicate event *processing*.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS processed_events (
  idempotency_key   TEXT PRIMARY KEY,
  contact_id        TEXT NOT NULL,
  message_id        TEXT,
  event_type        TEXT NOT NULL,
  source_event_id   BIGINT,
  processed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  result            JSONB
);

CREATE INDEX IF NOT EXISTS idx_processed_events_contact
  ON processed_events(contact_id, processed_at DESC);
CREATE INDEX IF NOT EXISTS idx_processed_events_message
  ON processed_events(message_id) WHERE message_id IS NOT NULL;

COMMENT ON TABLE processed_events IS
  'Inbound idempotency log. idempotency_key format: "{contact_id}:{message_id}" for inbound messages, "{entity_id}:evt-{event_id}" otherwise. Retention: 90 days (manage via cron — not enforced here).';


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. outbound_locks — Outbound dedup
-- ─────────────────────────────────────────────────────────────────────────────
-- Hard lock: one outbound per (contact_id, trigger_id) within TTL. Catches
-- duplicate sends from the agentic action executor and any other internal
-- caller. Does NOT catch GHL native workflow sends — those bypass the
-- agentic layer entirely. See drift detector for after-the-fact catch.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS outbound_locks (
  lock_key          TEXT PRIMARY KEY,
  contact_id        TEXT NOT NULL,
  trigger_id        TEXT NOT NULL,
  sender            TEXT NOT NULL,
  message_preview   TEXT,
  acquired_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ NOT NULL,
  released_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_outbound_locks_active
  ON outbound_locks(contact_id, expires_at) WHERE released_at IS NULL;

COMMENT ON TABLE outbound_locks IS
  'Outbound dedup. lock_key format: "{contact_id}:{trigger_id}". TTL default 300s. Sender values: agent_executor | hl_mcp_send | manual | drift_detector.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. layer3_action_dispatch — Classification → action sequence
-- ─────────────────────────────────────────────────────────────────────────────
-- Single source of truth for what each Layer 3 recommended_action triggers.
-- Action specs match the agent_actions template format used elsewhere
-- (target_system, target_entity, params). New classifications can be added
-- without writing rules.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS layer3_action_dispatch (
  id                 BIGSERIAL PRIMARY KEY,
  recommended_action TEXT NOT NULL,
  min_confidence     NUMERIC(3,2) NOT NULL DEFAULT 0.70,
  actions            JSONB NOT NULL,
  active             BOOLEAN NOT NULL DEFAULT TRUE,
  notes              TEXT,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_layer3_dispatch_action_active
  ON layer3_action_dispatch(recommended_action) WHERE active = TRUE;

COMMENT ON TABLE layer3_action_dispatch IS
  'Layer 3 classification → action sequence. Each row maps a recommended_action to the agent_action template list the executor should queue.';


-- ─────────────────────────────────────────────────────────────────────────────
-- Schema safety: ensure agent_rules has rule_type + context_conditions
-- ─────────────────────────────────────────────────────────────────────────────
-- The engine (decision-engine.js v2.x) reads rule.rule_type and
-- rule.context_conditions. The 006 migration didn't include these columns
-- explicitly. Add them idempotently so this migration is self-contained.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE agent_rules ADD COLUMN IF NOT EXISTS rule_type TEXT DEFAULT 'pattern';
ALTER TABLE agent_rules ADD COLUMN IF NOT EXISTS context_conditions JSONB;


-- ─────────────────────────────────────────────────────────────────────────────
-- Seed: layer3_action_dispatch
-- ─────────────────────────────────────────────────────────────────────────────
-- Action template format matches what decision-engine.createActionsFromRule
-- consumes: { action_type, target_system, target_entity, params }.
-- The params block becomes agent_actions.action_payload, which the
-- handlers read as action.action_payload.{tag,...}.
--
-- start_cooling_timer is intentionally omitted — no executor handler exists
-- yet. Track via emit_event so a future handler / cron can act on it.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO layer3_action_dispatch (recommended_action, min_confidence, actions, active, notes)
VALUES (
  'suppress',
  0.70,
  '[
    {"action_type": "remove_tag",        "target_system": "ghl", "target_entity": "contact", "params": {"tag": "reactivation-eligible"}},
    {"action_type": "remove_tag",        "target_system": "ghl", "target_entity": "contact", "params": {"tag": "reactivation-tier-1"}},
    {"action_type": "remove_tag",        "target_system": "ghl", "target_entity": "contact", "params": {"tag": "reactivation-tier-2"}},
    {"action_type": "remove_tag",        "target_system": "ghl", "target_entity": "contact", "params": {"tag": "reactivation-tier-3"}},
    {"action_type": "remove_tag",        "target_system": "ghl", "target_entity": "contact", "params": {"tag": "cooling-active"}},
    {"action_type": "add_tag",           "target_system": "ghl", "target_entity": "contact", "params": {"tag": "p3:not-interested-now"}},
    {"action_type": "add_tag",           "target_system": "ghl", "target_entity": "contact", "params": {"tag": "loss-reason:not-interested"}},
    {"action_type": "add_tag",           "target_system": "ghl", "target_entity": "contact", "params": {"tag": "objection-confirmed:not-interested"}},
    {"action_type": "add_tag",           "target_system": "ghl", "target_entity": "contact", "params": {"tag": "suppress-outbound"}},
    {"action_type": "set_stage",         "target_system": "ghl", "target_entity": "contact", "params": {"tag": "stage:long-term-nurture"}},
    {"action_type": "move_opportunity",  "target_system": "ghl", "target_entity": "opportunity", "params": {"pipeline": "P3", "stage": "5"}},
    {"action_type": "emit_event",        "target_system": "lp",  "target_entity": "system",  "params": {"event_type": "lp.disposition_drift_check", "priority": "normal"}}
  ]'::jsonb,
  TRUE,
  'Hard polite refusal. Verified safe via Douglas / Bonnie Jennings (f7otLt70zOLbFopSQmUd) replay. start_cooling_timer omitted — no handler yet; tracked via emit_event.'
)
ON CONFLICT DO NOTHING;

INSERT INTO layer3_action_dispatch (recommended_action, min_confidence, actions, active, notes) VALUES
  ('busy_callback',  0.70, '[]'::jsonb, FALSE, 'Pending: define action sequence for "interested but busy / call back later".'),
  ('objection_price',0.70, '[]'::jsonb, FALSE, 'Pending: define action sequence for confirmed price objection.'),
  ('wrong_person',   0.80, '[]'::jsonb, FALSE, 'Pending: define action sequence for "wrong contact / not the homeowner".')
ON CONFLICT DO NOTHING;


-- ─────────────────────────────────────────────────────────────────────────────
-- Seed: agent_rules — LAYER3_DISPATCH consumer
-- ─────────────────────────────────────────────────────────────────────────────
-- Closes the "no_matching_rules" gap that ate event 18741. Fires on every
-- ai.analysis_completed that carries a recommended_action; the dispatch
-- handler does the data-driven action queueing.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO agent_rules
  (rule_key, rule_name, category, rule_type, event_pattern, context_conditions, action_template, requires_approval, enabled, priority, notes)
VALUES (
  'LAYER3_DISPATCH',
  'Layer 3 classification dispatcher',
  'INTENT',
  'contextual',
  '{"event_type": "ai.analysis_completed"}'::jsonb,
  '{"payload_field_not_null": "recommended_action"}'::jsonb,
  '[{"action_type": "layer3_dispatch", "target_system": "lp", "target_entity": "contact", "params": {}}]'::jsonb,
  FALSE,
  TRUE,
  100,
  'Consumes Layer 3 classifications and dispatches via layer3_action_dispatch table. Closes the no_matching_rules gap (event 18741, Douglas / Bonnie Jennings).'
)
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name          = EXCLUDED.rule_name,
  category           = EXCLUDED.category,
  rule_type          = EXCLUDED.rule_type,
  event_pattern      = EXCLUDED.event_pattern,
  context_conditions = EXCLUDED.context_conditions,
  action_template    = EXCLUDED.action_template,
  requires_approval  = EXCLUDED.requires_approval,
  enabled            = EXCLUDED.enabled,
  priority           = EXCLUDED.priority,
  notes              = EXCLUDED.notes,
  updated_at         = NOW();


-- ─────────────────────────────────────────────────────────────────────────────
-- Seed: agent_rules — DRIFT_NOTIFY_GROUPME
-- ─────────────────────────────────────────────────────────────────────────────
-- Routes drift detection events to GroupMe for human reconciliation. Never
-- auto-overwrites LP disposition. Pattern after existing send_notification
-- rules.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO agent_rules
  (rule_key, rule_name, category, rule_type, event_pattern, action_template, requires_approval, enabled, priority, notes)
VALUES (
  'DRIFT_NOTIFY_GROUPME',
  'Drift detected — notify GroupMe',
  'OBSERVABILITY',
  'pattern',
  '{"event_type": "system.drift_detected"}'::jsonb,
  '[{"action_type": "send_notification", "target_system": "lp", "target_entity": "system", "params": {"channel": "groupme", "template": "drift_detected"}}]'::jsonb,
  FALSE,
  TRUE,
  50,
  'Routes drift detection events to GroupMe for human reconciliation. Never auto-overwrites LP disposition.'
)
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name         = EXCLUDED.rule_name,
  category          = EXCLUDED.category,
  rule_type         = EXCLUDED.rule_type,
  event_pattern     = EXCLUDED.event_pattern,
  action_template   = EXCLUDED.action_template,
  requires_approval = EXCLUDED.requires_approval,
  enabled           = EXCLUDED.enabled,
  priority          = EXCLUDED.priority,
  notes             = EXCLUDED.notes,
  updated_at        = NOW();


-- ─────────────────────────────────────────────────────────────────────────────
-- Verification queries (run manually after applying)
-- ─────────────────────────────────────────────────────────────────────────────
--   SELECT count(*) FROM processed_events;                            -- expect 0
--   SELECT count(*) FROM outbound_locks;                              -- expect 0
--   SELECT recommended_action, active FROM layer3_action_dispatch;    -- expect 4 rows
--   SELECT rule_key, enabled FROM agent_rules
--     WHERE rule_key IN ('LAYER3_DISPATCH','DRIFT_NOTIFY_GROUPME');   -- expect 2 rows
-- =============================================================================
