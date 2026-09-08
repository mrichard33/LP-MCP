-- ============================================================================
-- Seed: INTAKE_ROUTE_BACKSTOP_OTHER widened to ap-intake-created (rule id 355)
--       + lp_source_mapping: classify 'Angie'
-- Date: 2026-09-08
-- Applied live: 2026-09-08 19:23 UTC via LP MCP:supabase_run_query
-- Reload: POST /n8n/decision-engine/reload-rules -> rules_loaded 279
--         (279 enabled before and after — a condition widening, not a new rule)
--
-- WHAT
--   1. Rule 355 context_conditions: `has_tag` was the backstop provenance tag;
--      it is now `active-entry:other`, and provenance moved to `has_any_tag`
--      with BOTH pipes that create purchased-lead contacts:
--        - lp-backstop-created  (LP intake backstop, src/services/lp-contact-backstop.js)
--        - ap-intake-created    (I.AP ActiveProspect Intake, n8n YOozjkCkeNEe4s3a)
--      Guards (suppress-outbound, DNC family, stop-bot, active-e.5) and the E.5
--      add_to_workflow action are unchanged.
--   2. lp_source_mapping row 'Angie' (lp_source_raw Internet) classified as a
--      purchased internet vendor — identical treatment to 'Modernize'.
--
-- WHY
--   I.AP creates the GHL contact seconds after ActiveProspect delivers the lead
--   (after AP's DNC/dup/litigator/TrustedForm gates and its own LP Form POST).
--   It writes the real source (LP Subsource / LP Source custom fields +
--   contact.source) and calls /webhook/ghl/ensure-routing-tags so the
--   map-driven resolver (entry-source-map.js) assigns entry:* from
--   lp_source_mapping. Contacts resolved to active-entry:other need the same
--   E.5 enrollment the backstop leads get; rule 355 was keyed on the backstop's
--   provenance tag alone, so they would have landed at stage:new-lead unrouted.
--
--   'Angie' was auto-discovered ("needs classification") and resolved to
--   entry:unmapped, which no route consumes. Mark ruled 2026-09-08: same as
--   Modernize.
--
-- USER-VISIBLE IMPACT
--   ActiveProspect vendor leads mapped to 'other' enter E.5 within one Decision
--   Engine tick of contact creation. Angie leads now carry entry:other /
--   active-entry:other / intent-bucket:other and route to E.5.
--
-- SCOPE / NOT COVERED
--   Vendors mapped to high-intent-digital / risk-report / chatbot are NOT this
--   rule's job — they route via the I.AC / ghl.contact_created hygiene family.
--   Note: the backstop itself still tags every "Internet" lead entry:other
--   (LP_BACKSTOP_TAG_MAP) regardless of lp_source_mapping — verified live
--   2026-09-08 on a source:internet-google-ppc-windows contact. Separate fix.
-- ============================================================================

-- 1. Rule 355 — widen provenance
UPDATE agent_rules
SET context_conditions = '{"has_tag": "active-entry:other",
    "has_any_tag": ["lp-backstop-created", "ap-intake-created"],
    "not_has_any_tag": ["suppress-outbound","stop-bot","dnc","dnc-sms","do-not-contact","stage:dnc","unsubscribed","active-e.5"]}'::jsonb,
    notes = notes || ' | Widened 2026-09-08: also fires for ap-intake-created (I.AP ActiveProspect Intake, n8n YOozjkCkeNEe4s3a). has_tag/has_any_tag swapped so active-entry:other is the single required tag and provenance is either backstop or AP intake. Same guards, same E.5 target.',
    updated_at = NOW()
WHERE rule_key = 'INTAKE_ROUTE_BACKSTOP_OTHER' AND id = 355;

-- 2. lp_source_mapping — classify Angie like Modernize
UPDATE lp_source_mapping
SET ghl_entry_tag = 'entry:other',
    ghl_intent_bucket = 'other',
    ghl_bridge_wf_id = 'a45db010-1935-4f33-a58f-9130440c4c6b',
    confidence = 'high',
    notes = 'Mapped 2026-09-08 (Mark): purchased internet lead vendor, same treatment as Modernize. Was entry:unmapped (auto-discovered).'
WHERE lp_source_subdetail = 'Angie';

-- After apply:
--   POST https://lp-mcp-production.up.railway.app/n8n/decision-engine/reload-rules
--   assert rules_loaded = enabled count (unchanged).
--   entry-source-map.js caches lp_source_mapping for 5 min (ENTRY_SOURCE_MAP_TTL_MS);
--   the Angie change is live on the next cache refresh.

-- Verify a firing (either provenance):
--   SELECT json_agg(row_to_json(s)) FROM (
--     SELECT status, execution_result, created_at FROM agent_actions
--     WHERE rule_applied = 'INTAKE_ROUTE_BACKSTOP_OTHER'
--     ORDER BY created_at DESC LIMIT 5) s;

-- ROLLBACK (rule only — restores the 2026-09-03 shape):
--   UPDATE agent_rules SET context_conditions = '{"has_tag": "lp-backstop-created",
--     "has_any_tag": ["active-entry:other"],
--     "not_has_any_tag": ["suppress-outbound","stop-bot","dnc","dnc-sms","do-not-contact","stage:dnc","unsubscribed","active-e.5"]}'::jsonb,
--     updated_at = NOW()
--   WHERE rule_key = 'INTAKE_ROUTE_BACKSTOP_OTHER';
--   then reload.
-- ROLLBACK (mapping): UPDATE lp_source_mapping SET ghl_entry_tag='entry:unmapped',
--   ghl_intent_bucket='unmapped', ghl_bridge_wf_id=NULL WHERE lp_source_subdetail='Angie';
