-- 2026-10-12 — F-L: the calculator-lane progression rules moved nobody.
--
-- 164 STAGE_4_ROUTE_W2_1_TO_W3_1_V2 (fires when 69fdc012 "S2.5 Pricing Accuracy Education", the old
--     W2.1, completes) posted to webhook-trigger b637c9fd, which belongs to S3.1 v1 142611f6 — a DRAFT
--     whose trigger is switched off. GHL answers 200 anyway: 64 adds read "completed", none enrolled.
--     → retargeted to the PUBLISHED "S3.1 Calculator Positioning Burst v3" (27407026, trigger
--       4465fb56, active). workflow_id is added next to webhook_url so both paths can be checked
--       (the executor still uses the webhook: Route B wins in executeAddToWorkflow).
-- 165 STAGE_5_ROUTE_W3_1_V2_TO_W4_1 fires when S3.1 v1 142611f6 completes. That draft never completes,
--     so the rule is dead. Its target (e5af8aab) IS S4.1 MV Booking's active trigger — the handoff said
--     nothing owned it because it searched workflows.raw_json, which does not hold triggers. The user
--     ruled (2026-10-12) that S3.1 v3 finishers go to S4.5 Seinfeld, and v3 already does that itself
--     (step 51 → webhook 4e07728e, "S4.5 Agentic Seinfeld Nurture (Shell)" f99fba97). Retargeting 165
--     to v3 would put every finisher in S4.5 AND S4.1, so it is DISABLED, not retargeted.
--
-- Guard against this class: src/jobs/rule-target-check.js (nightly 02:10 ET) and the MCP tool
-- check_rule_targets. Apply AFTER the PR that adds them merges, so the repo and the data agree.

-- ═══ BEFORE (live rows, 2026-10-12, both version 1) ══════════════════════════════════════════
-- 164 action_template:
--   [{"params": {"format": "form", "payload": {"source": "stage_4_complete", "entry_route_rule": "STAGE_4_ROUTE_W2_1_TO_W3_1_V2"},
--     "webhook_url": "https://services.leadconnectorhq.com/hooks/SsBG7j5KQAIP1SFP2Sca/webhook-trigger/b637c9fd-412d-4e78-9ec1-eec282c0e459",
--     "workflow_name": "S3.1 Calculator Solution Pitch", "canonical_code": "S3.1", "canonical_name": "S3.1 Calculator Solution Pitch"},
--     "action_type": "add_to_workflow", "target_entity": "contact", "target_system": "ghl"}]
-- 164 event_pattern: {"payload": {"workflow_id": "69fdc012-cefc-4917-b156-d6dbc8d13b7c"}, "event_type": "ghl.workflow_completed"}
-- 164 notes: "Created 2026-05-05 (Phase 2 EC Funnel Cutover, decision_log id 78). Routes EC funnel contacts from W2.1 (Pricing
--   Accuracy) to W3.1 V2 (Solution Pitch Authority and Positioning V2) via Route B. W2.1 v38 has 1 disabled add_to_workflow step
--   targeting W3.1 V2 (step #51) - Layer 3 webhook at #50 still fires and emits ghl.workflow_completed with workflow_id=69fdc012.
--   W3.1 V2 v11 confirmed published with inbound_webhook trigger b637c9fd-412d-4e78-9ec1-eec282c0e459 live."
--
-- 165 action_template:
--   [{"params": {"format": "form", "payload": {"source": "stage_5_complete", "entry_route_rule": "STAGE_5_ROUTE_W3_1_V2_TO_W4_1"},
--     "webhook_url": "https://services.leadconnectorhq.com/hooks/SsBG7j5KQAIP1SFP2Sca/webhook-trigger/e5af8aab-bdb3-4a3c-9e65-b594f68eace8",
--     "workflow_name": "S4.1 MV Booking", "canonical_code": "S4.1", "canonical_name": "S4.1 MV Booking"},
--     "action_type": "add_to_workflow", "target_entity": "contact", "target_system": "ghl"}]
-- 165 event_pattern: {"payload": {"workflow_id": "142611f6-52e2-4081-ac5a-2a3269b8807b"}, "event_type": "ghl.workflow_completed"}
-- 165 enabled: true
--
-- ═══ ROLLBACK (ready to run; expect 2) ═══════════════════════════════════════════════════════
-- WITH u AS (
--   UPDATE agent_rules SET
--     action_template = CASE id
--       WHEN 164 THEN '[{"params": {"format": "form", "payload": {"source": "stage_4_complete", "entry_route_rule": "STAGE_4_ROUTE_W2_1_TO_W3_1_V2"}, "webhook_url": "https://services.leadconnectorhq.com/hooks/SsBG7j5KQAIP1SFP2Sca/webhook-trigger/b637c9fd-412d-4e78-9ec1-eec282c0e459", "workflow_name": "S3.1 Calculator Solution Pitch", "canonical_code": "S3.1", "canonical_name": "S3.1 Calculator Solution Pitch"}, "action_type": "add_to_workflow", "target_entity": "contact", "target_system": "ghl"}]'::jsonb
--       ELSE action_template END,
--     enabled = CASE id WHEN 165 THEN true ELSE enabled END,
--     version = version + 1, updated_at = now(),
--     notes = coalesce(notes,'') || E'\n2026-10-12: F-L fix rolled back.'
--   WHERE id IN (164, 165)
--   RETURNING 1)
-- SELECT count(*) FROM u;

-- ═══ APPLY (expect 2) ════════════════════════════════════════════════════════════════════════
BEGIN;

WITH u AS (
  UPDATE agent_rules SET
    action_template = jsonb_set(action_template, '{0,params}',
      (action_template->0->'params')
        || jsonb_build_object(
             'webhook_url', 'https://services.leadconnectorhq.com/hooks/SsBG7j5KQAIP1SFP2Sca/webhook-trigger/4465fb56-2487-443b-bf6d-1f04925d8c3a',
             'workflow_id', '27407026-3896-464c-b6b9-a3b7f9021dbf',
             'workflow_name', 'S3.1 Calculator Positioning Burst v3',
             'canonical_name', 'S3.1 Calculator Positioning Burst v3')),
    version = coalesce(version, 1) + 1, updated_at = now(),
    notes = coalesce(notes, '') || E'\n2026-10-12 F-L fix: retargeted from draft S3.1 v1 142611f6 to published v3.'
  WHERE id = 164
    AND action_template->0->>'action_type' = 'add_to_workflow'
    AND action_template->0->'params'->>'webhook_url' LIKE '%/webhook-trigger/b637c9fd-412d-4e78-9ec1-eec282c0e459'
  RETURNING 1
), d AS (
  UPDATE agent_rules SET
    enabled = false,
    version = coalesce(version, 1) + 1, updated_at = now(),
    notes = coalesce(notes, '') || E'\n2026-10-12 F-L fix: disabled. Its trigger (draft S3.1 v1 142611f6) never completes. Per the user, S3.1 v3 finishers route to S4.5 Seinfeld, which v3 does itself (step 51 → webhook 4e07728e, S4.5 Shell f99fba97).'
  WHERE id = 165
    AND enabled = true
    AND event_pattern->'payload'->>'workflow_id' = '142611f6-52e2-4081-ac5a-2a3269b8807b'
  RETURNING 1
)
SELECT (SELECT count(*) FROM u) + (SELECT count(*) FROM d) AS updated;

COMMIT;
