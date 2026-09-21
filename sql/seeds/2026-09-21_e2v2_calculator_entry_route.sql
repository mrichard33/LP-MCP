-- ════════════════════════════════════════════════════════════════════
-- E.2 v2 calculator entry route — 2026-09-21 (APPLIED LIVE 21:24 UTC, reload 289 → 289)
--
-- ROOT CAUSE
--   E.0 Master Router (407ec6f2) step 112 is labelled "Add to E.2 Calculator
--   Bridge v2" but posts to the LEGACY E.2 webhook 3828733e (workflow
--   74c90736). Mark moved legacy E.2 to Draft at 17:17 ET 2026-09-21, so new
--   calculator leads would have entered no bridge at all.
--   Separately, ENTRY_ROUTE_CALCULATOR fired off the legacy E.2 exit webhook
--   and, since 2026-09-16, enrolled those leads in E.2 v2 — a second bridge
--   after the first (e.g. X71ekf8xl9zQgjy4RVSB).
--
-- FIX
--   1. E0_CALC_ROUTE_E2V2 — on ghl.e0_branch_fired/estimate-calculator (E.0
--      step 113, fires right after step 112) enroll in E.2 v2 via hook
--      5352aa9e. Duplicate-safe if step 112 is later repointed to v2:
--      v2 step 5 exits on active-e.2 and executor SI-3 rejects re-enrollment.
--   2. ENTRY_ROUTE_CALCULATOR disabled (event source retired; double bridge).
--
-- VERIFIED: event 3835460 on Mark Test hZOcPk6XmMvWVvjZJ7mz → completed,
--   added_to_workflow_via_webhook (v2 then exited on its booked-contact gate,
--   as designed).
-- ════════════════════════════════════════════════════════════════════
BEGIN;

INSERT INTO agent_rules (rule_key, rule_name, category, rule_type, event_pattern, conditions,
  context_conditions, action_template, requires_approval, enabled, priority, notes, created_by)
VALUES ('E0_CALC_ROUTE_E2V2',
 'E.0 calculator branch fired — enroll in E.2 Calculator Bridge v2',
 'integration', 'contextual',
 '{"event_type":"ghl.e0_branch_fired","event_subtype":"estimate-calculator"}'::jsonb,
 NULL,
 '{"not_has_any_tag":["stop-bot","dnc","dnc-sms","dnc-all","do-not-contact","stage:dnc","unsubscribed","lp-dnc","active-e.2"]}'::jsonb,
 '[{"action_type":"add_to_workflow","target_system":"ghl","target_entity":"contact","params":{"format":"form","payload":{"source":"calculator","entry_route_rule":"E0_CALC_ROUTE_E2V2"},"webhook_url":"https://services.leadconnectorhq.com/hooks/SsBG7j5KQAIP1SFP2Sca/webhook-trigger/5352aa9e-5cc8-42ec-b65c-d527e208865a","workflow_name":"E.2 Calculator Bridge v2","canonical_code":"E.2","canonical_name":"E.2 Calculator Bridge v2"}}]'::jsonb,
 FALSE, TRUE, 50,
 'See seed header 2026-09-21. Disable once E.0 step 112 points at v2 hook 5352aa9e and one live lead is verified.',
 'claude')
ON CONFLICT (rule_key) DO UPDATE SET event_pattern=EXCLUDED.event_pattern,
  context_conditions=EXCLUDED.context_conditions, action_template=EXCLUDED.action_template,
  enabled=TRUE, updated_at=NOW();

UPDATE agent_rules SET enabled = FALSE, updated_at = NOW()
 WHERE rule_key = 'ENTRY_ROUTE_CALCULATOR';

COMMIT;

-- After apply: POST /n8n/decision-engine/reload-rules — rules_loaded unchanged (+1 −1).
-- Rollback:
--   UPDATE agent_rules SET enabled=FALSE, updated_at=NOW() WHERE rule_key='E0_CALC_ROUTE_E2V2';
--   (re-enabling ENTRY_ROUTE_CALCULATOR is NOT a rollback — its source workflow is in Draft)
--   then reload.
