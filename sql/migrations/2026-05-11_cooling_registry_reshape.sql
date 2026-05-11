-- Reshape cooling_registry to use existing add_to_workflow handler (Route B).
-- The previous shape used action_type:fire_inbound_webhook which has no handler.
-- After this migration, the Decision Engine can fire cooling enrollments by
-- creating agent_actions with action_type=add_to_workflow and the payload
-- below — the existing executor handles it.
--
-- format:'json' is intentional. The 7 I.COOL-* GHL workflows read fields via
-- {{inboundWebhookRequest.<snake_case>}} and accept JSON bodies; keeping
-- snake_case end-to-end is simpler than mixing form-encoded camelCase.
--
-- The runtime payload (contact_id, cooling_*, timestamps, enrollment_event_id)
-- is NOT in the agent_rules entry — it's built at enrollment time by
-- src/cooling-enrollment.js. This template provides the static lookup data
-- (webhook_url, workflow_id, canonical_code, duration_days).

WITH u AS (
  UPDATE agent_rules
  SET action_template = jsonb_build_array(
    jsonb_build_object(
      'action_type', 'add_to_workflow',
      'target_system', 'ghl',
      'target_entity', 'contact',
      'params', jsonb_build_object(
        'webhook_url', (action_template->0->'params'->>'webhook_url'),
        'workflow_id', (action_template->0->'params'->>'workflow_id'),
        'canonical_code', (action_template->0->'params'->>'canonical_code'),
        'canonical_name', (action_template->0->'params'->>'canonical_code') || ' Cooling Hold',
        'duration_code', (action_template->0->'params'->>'duration_code'),
        'duration_days', (action_template->0->'params'->'duration_days')::int,
        'format', 'json'
      )
    )
  ),
  updated_at = now()
  WHERE category = 'cooling_registry'
  RETURNING rule_key
)
SELECT count(*) FROM u;

-- Verification (run separately after applying):
--
-- SELECT json_agg(row_to_json(s)) FROM (
--   SELECT rule_key,
--          action_template->0->>'action_type'              AS action_type,
--          action_template->0->'params'->>'duration_code'  AS duration_code,
--          action_template->0->'params'->>'webhook_url'    AS webhook_url,
--          action_template->0->'params'->>'format'         AS format
--   FROM agent_rules
--   WHERE category = 'cooling_registry'
--   ORDER BY (action_template->0->'params'->>'duration_days')::int
-- ) s;
--
-- Expect 7 rows, all action_type=add_to_workflow, all format=json.
