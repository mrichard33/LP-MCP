-- ============================================================================
-- Seed: LEAD_STATE_REACTIVE_REENGAGE agent_rule (S4.5 v2 Phase 2b — reactive)
-- Date: 2026-06-02
-- PR:   #324 (Lead-State Auto-Eligibility) — companion DB config
-- ----------------------------------------------------------------------------
-- WHY THIS FILE:
--   Phase 2's sweep (src/agentic/lead-state/sweep.js) feeds S4.5 within <=6h.
--   This rule lets a re-engaging dormant contact be reclassified IMMEDIATELY
--   (REAWAKENED -> S4.5 sequence_position 5) instead of waiting for the sweep,
--   by firing the classify_lead_state action handler
--   (src/actions/handlers/lead-state.js) on a substantive inbound reply.
--
--   SHIPS DISABLED (enabled=false). The decision engine only caches rules with
--   enabled=true (src/decision-engine.js:253), so this row is fully inert until
--   someone runs `UPDATE agent_rules SET enabled=true WHERE
--   rule_key='LEAD_STATE_REACTIVE_REENGAGE'` AND reloads the engine
--   (POST .../n8n/decision-engine/reload-rules). Enrollment itself stays gated
--   by S45_ENROLLMENT_ENABLED (enrollment.js:184) regardless — the handler runs
--   classifyLeadState then enrollIfEligible, which shadow-no-ops while the flag
--   is off. So enabling this rule before go-live only adds classification load,
--   never an enrollment.
--
-- TRIGGER CORRECTION vs the Phase 2 runbook:
--   The runbook's draft used {"event_type": "engagement.link_clicked"}, which
--   does NOT exist — src/behavioral-emitter.js never emits an `engagement.*`
--   event. Its engagement events are ghl.link_clicked / ghl.email_opened /
--   ghl.reply_received / ghl.vsl_watched / ghl.engagement_signal.
--   We use ghl.reply_received (rarest strong signal: inbound reply) and SCOPE
--   it to event_subtype='pending_analysis'. handleReply emits three subtypes
--   (behavioral-emitter.js:434/469/487): 'dnc' (opt-outs), 'trivial' (one-word
--   noise), and 'pending_analysis' (substantive replies, incl. agentic-owned
--   short replies that fall through to the analyzer). Scoping to
--   pending_analysis:
--     (1) removes the go-live race where a "STOP" reply (subtype 'dnc') could
--         classify->enroll before the async DNC suppression tag lands, and
--     (2) keeps the "lowest volume" rationale intact — trivial "ok"/"yes"
--         replies do not each trigger a ~3-4 GHL-call buildLeadContext.
--   Nothing REAWAKENED-relevant is lost: substantive re-engagement is
--   classified as 'pending_analysis'.
--
-- SCHEMA NOTES (verified live):
--   agent_rules base schema: sql/006_agentic_system.sql (has created_by
--   default 'claude'); rule_type + context_conditions added by
--   sql/019_mvi_antifragile_v2.5.sql (rule_type DEFAULT 'pattern'). The engine
--   reads `const ruleType = rule.rule_type || 'pattern'` (decision-engine.js:672).
--   This is a pure event_pattern match with context_conditions = NULL, so
--   rule_type='pattern' is correct; we set it explicitly to match the
--   convention of sql/seeds/2026-05-20_state_classification_rules_v2.sql.
-- ============================================================================

BEGIN;

INSERT INTO agent_rules
  (rule_key, rule_name, category, rule_type, event_pattern, context_conditions,
   action_template, requires_approval, enabled, priority, created_by, notes)
VALUES
('LEAD_STATE_REACTIVE_REENGAGE',
 'Lead-State: reactive classify on re-engagement (REAWAKENED)',
 'STATE_CLASSIFICATION', 'pattern',
 '{"event_type": "ghl.reply_received", "event_subtype": "pending_analysis"}'::jsonb,
 NULL,
 '[{"action_type": "classify_lead_state", "target_system": "lp", "target_entity": "contact",
    "params": {"trigger_source": "event"}}]'::jsonb,
 FALSE,
 FALSE,            -- SHIP DISABLED (enable later via UPDATE + reload-rules)
 90,
 'claude',
 'Phase 2b. Fires classify_lead_state on a substantive inbound reply so a dormant contact that just re-engaged is reclassified immediately (REAWAKENED -> S4.5 position 5) instead of waiting for the 6h sweep. Trigger corrected from the runbook draft: engagement.link_clicked does not exist; uses ghl.reply_received scoped to event_subtype=pending_analysis (excludes dnc/trivial to avoid the STOP-reply enrollment race and the trivial-reply GHL firehose). Enrollment stays gated by S45_ENROLLMENT_ENABLED.')

ON CONFLICT (rule_key) DO UPDATE SET
  rule_name          = EXCLUDED.rule_name,
  category           = EXCLUDED.category,
  rule_type          = EXCLUDED.rule_type,
  event_pattern      = EXCLUDED.event_pattern,
  context_conditions = EXCLUDED.context_conditions,
  action_template    = EXCLUDED.action_template,
  requires_approval  = EXCLUDED.requires_approval,
  -- NOTE: `enabled` is deliberately NOT overwritten on conflict, so re-running
  -- this seed never re-disables a rule the operator has since activated.
  priority           = EXCLUDED.priority,
  notes              = EXCLUDED.notes,
  updated_at         = NOW();

COMMIT;

-- ----------------------------------------------------------------------------
-- Verification
-- ----------------------------------------------------------------------------
--   SELECT rule_key, enabled, rule_type, event_pattern, priority
--   FROM agent_rules
--   WHERE rule_key = 'LEAD_STATE_REACTIVE_REENGAGE';
--
--   Expect exactly one row:
--     enabled       = false
--     rule_type     = 'pattern'
--     event_pattern = {"event_type":"ghl.reply_received","event_subtype":"pending_analysis"}
--     priority      = 90
--
-- To activate later (go-live, out of scope for this seed):
--   UPDATE agent_rules SET enabled = true, updated_at = now()
--   WHERE rule_key = 'LEAD_STATE_REACTIVE_REENGAGE';
--   -- then reload the decision engine (rules are cached at load):
--   --   curl -X POST $LP/n8n/decision-engine/reload-rules
-- ----------------------------------------------------------------------------
