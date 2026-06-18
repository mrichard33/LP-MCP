-- ============================================================================
-- OBJECTION_ROUTE_POST_DEMO — dedup guard against the legacy O.0 enrollment tag
-- 2026-06-18
-- ============================================================================
-- WHAT:
--   Add 'active-w9.0' to OBJECTION_ROUTE_POST_DEMO.context_conditions.not_has_any_tag.
--
-- WHY:
--   BEHAVIORAL_COMPETITOR_OBJECTION enrolls contacts in O.0 and tags them
--   'active-w9.0' (legacy naming). OBJECTION_ROUTE_POST_DEMO's dedup guard only
--   listed 'active-w-O.0' (the new naming), so the two strings never matched and
--   the post-demo rule could re-enroll a contact already in O.0. This is newly
--   relevant because the resolveDemoState change (decision-engine.js, 2026-06-18)
--   now resolves demo_state='post' for Showed-but-undispositioned contacts —
--   exactly the competitor-objection population BEHAVIORAL_COMPETITOR_OBJECTION
--   already routes — so without this guard a competitor objector (e.g. Nancy
--   PpypnQog2pCs6kIRwH5a, who carries active-w9.0) could match both rules and
--   double-enroll in O.0.
--
-- IMPACT:
--   A contact already enrolled in O.0 via the legacy active-w9.0 path is no longer
--   re-routed to O.0 by OBJECTION_ROUTE_POST_DEMO. No change for contacts not
--   carrying active-w9.0.
--
-- NOTE: Idempotent — only appends active-w9.0 when absent; preserves demo_state_eq
--   and every existing not_has_any_tag entry. Engine self-reloads (~1-2 min); force
--   with POST .../n8n/decision-engine/reload-rules for immediate effect.
-- ============================================================================

WITH u AS (
  UPDATE agent_rules
  SET context_conditions = jsonb_set(
        context_conditions,
        '{not_has_any_tag}',
        (context_conditions->'not_has_any_tag') || '["active-w9.0"]'::jsonb
      ),
      updated_at = now()
  WHERE rule_key = 'OBJECTION_ROUTE_POST_DEMO'
    AND NOT (context_conditions->'not_has_any_tag' ? 'active-w9.0')
  RETURNING rule_key
) SELECT count(*) AS updated FROM u;

-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- UPDATE agent_rules
-- SET context_conditions = jsonb_set(
--       context_conditions,
--       '{not_has_any_tag}',
--       (context_conditions->'not_has_any_tag') - 'active-w9.0'
--     ),
--     updated_at = now()
-- WHERE rule_key = 'OBJECTION_ROUTE_POST_DEMO';
-- Then POST /n8n/decision-engine/reload-rules
-- ============================================================================
