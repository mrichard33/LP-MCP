-- ============================================================================
-- Seed: INTAKE_ROUTE_BACKSTOP_E0 — skip leads that are already routed
-- Date: 2026-09-25
--
-- Needs the add_to_workflow v2.3 entry guard (src/actions/handlers/workflows.js,
-- entryGuardMatch). Safe to apply before that deploys: older code ignores the
-- three new params, so this is inert until then.
--
-- WHY
--   The rule's not_has_any_tag list is read when contact.created fires, before
--   any routing tag exists, and the executor's live check looked only at
--   active-e.0 — which E.0 removes ~2 minutes into its run. So nothing stopped a
--   second E.0 post for a lead that was already routed or booked.
--
-- WHAT THE DATA SAID (HL lead_events, 2026-09-24)
--   * At the moment this rule posts (~30s after creation) all 90 intake leads
--     since it shipped carried stage:new-lead and no other stage — the guard
--     below blocks none of them.
--   * None of those 90 entered E.0 twice. The repeat E.0 entries (3-5 a day)
--     come hours later (7-28h) to leads already booked/confirmed — GHL
--     I.LP-IN's "Send to E.0 Webhook" on an LP status change. That half is a
--     GHL edit (docs/ghl-e0-double-entry-guide.md), not this rule.
--   This is insurance so our side can never be the second post.
-- ============================================================================

BEGIN;

WITH u AS (
  UPDATE agent_rules
  SET action_template = jsonb_set(
        action_template, '{0,params}',
        (action_template->0->'params') || '{
          "skip_if_any_tag": ["active-e.5","active-e.7","active-w07","stage:entry-bridge",
                              "lp-route:appt-confirmed","lp-lead-confirmed"],
          "skip_if_tag_prefix": ["stage:"],
          "skip_allow_tags": ["stage:new-lead"]
        }'::jsonb),
      notes = notes || ' | 2026-09-25: live entry guard — skips a lead already carrying a bridge/booked/confirmed tag or any stage: other than stage:new-lead (v2.3 entryGuardMatch).',
      updated_at = NOW()
  WHERE rule_key = 'INTAKE_ROUTE_BACKSTOP_E0'
    AND action_template->0->>'action_type' = 'add_to_workflow'
    AND NOT (action_template->0->'params' ? 'skip_if_any_tag')
  RETURNING 1
)
SELECT count(*) AS rows_updated FROM u;   -- expect 1 (0 on a re-run)

COMMIT;

-- After apply:
--   SELECT action_template->0->'params'->'skip_if_any_tag' FROM agent_rules
--    WHERE rule_key = 'INTAKE_ROUTE_BACKSTOP_E0';   -- expect the 6 tags
--   POST https://lp-mcp-production.up.railway.app/n8n/decision-engine/reload-rules
