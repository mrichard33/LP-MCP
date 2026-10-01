/**
 * The columns agent_actions REALLY has — src/live-chat/agent-actions-columns.js
 *
 * 2026-10-01 (fix/live-chat-service-area-and-markets). Every live chat reply
 * since the lane shipped lost its row: the insert named `idempotency_key`,
 * which sql/migrations/2026-07-21_action_idempotency.sql adds but which was
 * never applied to the live database. PostgREST refused the whole insert
 * ("Could not find the 'idempotency_key' column … in the schema cache"), the
 * lane logged a warning and carried on, and 21 replies left no draft, no
 * timing and nothing for Bot Review.
 *
 * This list is the LIVE column set, read from information_schema.columns on
 * 2026-10-01 — not the set the repo's SQL implies. scripts/test-live-chat-
 * fast-lane.js fails if the lane's insert row carries any other key. Add a
 * name here only after confirming the column exists in production.
 */
export const AGENT_ACTIONS_COLUMNS = Object.freeze([
  'id', 'event_id', 'action_type', 'target_system', 'target_entity', 'target_id',
  'action_payload', 'rollback_payload', 'reasoning', 'confidence', 'rule_applied',
  'status', 'requires_approval', 'approved_by', 'approved_at', 'rejection_reason',
  'executed_at', 'execution_result', 'error_message', 'retry_count', 'max_retries',
  'batch_id', 'sequence_order', 'created_at', 'updated_at', 'decision_point',
  'variant_id', 'context_snapshot', 'priority', 'retry_at',
]);
