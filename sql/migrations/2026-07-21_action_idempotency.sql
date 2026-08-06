-- ============================================================================
-- Action Idempotency — 2026-07-21
-- ============================================================================
-- Context
--   agent_actions has no deduplication at creation time. Rules that fire on
--   repeated `ai.analysis_completed` events emit a fresh create_task and
--   send_notification on every pass. Observed 2026-07-20:
--
--     contact mcZ8OFDfZndBUgEdcnO2 (Mike Hak)      30 actions / 24h
--     contact TUGI07Od1vfQNugznyaf (Kristie Afonso) 16 actions / 24h
--
--   Contributing rules (NOT a single rule — this is a creation-layer defect):
--     LAYER3_DISPATCH                       4x create_task + 4x send_notification
--     OBJ_FAMILY_REPEAT_TRUST               4x create_task
--     ESC_EXISTING_CUSTOMER                 3x create_task + 3x send_notification
--     BEHAVIORAL_SPOUSE_OBJECTION_PRE_DEMO  1x + 1x
--     BEHAVIORAL_DISENGAGEMENT              1x
--
-- Scope
--   Only create_task and send_notification are constrained. These are
--   non-idempotent, human-facing, and carry no natural dedup key. Tag and
--   workflow actions are intentionally left alone: they are already
--   idempotent at the handler, and repeated add_tag is harmless.
--
-- Rollback
--   DROP INDEX CONCURRENTLY IF EXISTS agent_actions_idem_uniq;
--   ALTER TABLE agent_actions DROP COLUMN IF EXISTS idempotency_key;
--
-- HOW TO APPLY: see sql/README.md for the canonical rule. For this file
-- specifically: the BEGIN/COMMIT block below is additive and may go through MCP
-- apply_migration, but the CREATE INDEX CONCURRENTLY after it must NOT — that
-- keyword cannot run inside a transaction, and apply_migration wraps one. Use
-- MCP execute_sql or the dashboard for it. agent_actions is populated, so the
-- dashboard is the better call: the build holds a session while it runs.
--
-- (This note previously read "DDL is dashboard-only per project doctrine. Do
-- not execute via MCP." That was over-broad — it was really about the
-- CONCURRENTLY statement — and it contradicted sql/049 and four migrations
-- under sql/migrations/ that explicitly permit apply_migration. Corrected
-- 2026-08-06; the rule now lives in one place.)
-- ============================================================================

BEGIN;

-- 1. Key column ------------------------------------------------------------
ALTER TABLE agent_actions
  ADD COLUMN IF NOT EXISTS idempotency_key text;

COMMENT ON COLUMN agent_actions.idempotency_key IS
  'Dedup key for non-idempotent senders. Format: '
  '<target_id>:<rule_applied>:<action_type>:<YYYY-MM-DD>. '
  'NULL for action types outside the dedup scope. See '
  'sql/migrations/2026-07-21_action_idempotency.sql';

-- 2. Backfill so the unique index can be built without violation ----------
--    Existing duplicate rows are historical; we key them by id to keep them
--    distinct and let the constraint apply only to new writes.
UPDATE agent_actions
   SET idempotency_key = target_id
                      || ':' || COALESCE(rule_applied, 'norule')
                      || ':' || action_type
                      || ':' || to_char(created_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD')
                      || ':legacy-' || id::text
 WHERE action_type IN ('create_task', 'send_notification')
   AND idempotency_key IS NULL;

COMMIT;

-- 3. Unique partial index --------------------------------------------------
--    CONCURRENTLY cannot run inside a transaction block.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS agent_actions_idem_uniq
    ON agent_actions (idempotency_key)
 WHERE idempotency_key IS NOT NULL;

-- 4. Lookup index for the pre-insert guard --------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_actions_idem_lookup
    ON agent_actions (target_id, rule_applied, action_type, created_at DESC)
 WHERE action_type IN ('create_task', 'send_notification');
