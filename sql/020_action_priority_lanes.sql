-- =============================================================================
-- 020_action_priority_lanes.sql
--
-- Adds priority lanes to agent_actions so customer-facing actions can skip
-- ahead of background batch work in the executor's pull queue.
--
-- Background:
-- The executor pulls pending actions strictly by created_at ASC. On
-- 2026-05-07 a bulk migration job (BULK_MIGRATION_2026_05_06, ~250
-- move_opportunity actions) monopolized the queue and blocked a
-- customer-facing send_message reply (action 49546) for ~30 minutes.
-- This migration adds a priority column, an INSERT trigger that auto-
-- sets priority based on action_type / rule_applied, an index for
-- efficient priority-ordered pulls, and backfills existing rows.
--
-- Smaller priority value = higher priority = pulled first.
--
-- Default lanes (set by the trigger when caller does not provide one):
--    10 — send_message, send_notification (customer-facing, time-sensitive)
--    15 — layer3_dispatch (gates customer-facing follow-on)
--    20 — add_tag / remove_tag / set_stage from AGENTIC_* rules (routing)
--    50 — update_custom_fields, update_contact_email, update_lp_dnc_status
--   100 — default for everything else
--   200 — anything from BULK_* or MIGRATION_* rules (background batch)
--
-- Callers can override the default by passing an explicit `priority`
-- value on insert; the trigger only fills NULL.
--
-- Run in: LP MCP Supabase -> SQL Editor (same database as the rest of
-- the agentic schema). Idempotent — safe to re-run.
--
-- Date: 2026-05-07
-- =============================================================================

-- 1. Column. NULL allowed at first so the trigger can fill it.
ALTER TABLE agent_actions
  ADD COLUMN IF NOT EXISTS priority INT;

-- 2. Default-priority function. BEFORE INSERT trigger; only fills when
--    caller did not supply an explicit value.
CREATE OR REPLACE FUNCTION agent_actions_default_priority()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.priority IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.rule_applied IS NOT NULL
     AND (NEW.rule_applied LIKE 'BULK_%' OR NEW.rule_applied LIKE 'MIGRATION_%') THEN
    NEW.priority := 200;
  ELSIF NEW.action_type IN ('send_message', 'send_notification') THEN
    NEW.priority := 10;
  ELSIF NEW.action_type = 'layer3_dispatch' THEN
    NEW.priority := 15;
  ELSIF NEW.action_type IN ('add_tag', 'remove_tag', 'set_stage')
        AND NEW.rule_applied IS NOT NULL
        AND NEW.rule_applied LIKE 'AGENTIC_%' THEN
    NEW.priority := 20;
  ELSIF NEW.action_type IN ('update_custom_fields', 'update_contact_email', 'update_lp_dnc_status') THEN
    NEW.priority := 50;
  ELSE
    NEW.priority := 100;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agent_actions_default_priority ON agent_actions;
CREATE TRIGGER trg_agent_actions_default_priority
  BEFORE INSERT ON agent_actions
  FOR EACH ROW
  EXECUTE FUNCTION agent_actions_default_priority();

-- 3. Partial index for the pull query. The executor's pickup is
--    .eq('status', 'pending').order('priority').order('created_at').order('sequence_order')
--    so this index covers it exactly.
CREATE INDEX IF NOT EXISTS idx_aa_priority_pull
  ON agent_actions (priority ASC, created_at ASC, sequence_order ASC)
  WHERE status = 'pending';

-- 4. Backfill existing rows with the same lane logic the trigger uses.
--    Touches every row, but only writes when priority is currently NULL,
--    so re-running the migration is a no-op once seeded.
UPDATE agent_actions
SET priority = CASE
  WHEN rule_applied IS NOT NULL AND (rule_applied LIKE 'BULK_%' OR rule_applied LIKE 'MIGRATION_%') THEN 200
  WHEN action_type IN ('send_message', 'send_notification') THEN 10
  WHEN action_type = 'layer3_dispatch' THEN 15
  WHEN action_type IN ('add_tag', 'remove_tag', 'set_stage')
       AND rule_applied IS NOT NULL AND rule_applied LIKE 'AGENTIC_%' THEN 20
  WHEN action_type IN ('update_custom_fields', 'update_contact_email', 'update_lp_dnc_status') THEN 50
  ELSE 100
END
WHERE priority IS NULL;

-- 5. NOT NULL constraint after backfill. We intentionally do NOT set a
--    column DEFAULT — the trigger handles defaults and is the single
--    source of truth for lane assignment. NOT NULL guards against
--    inserts that somehow bypass the trigger.
ALTER TABLE agent_actions
  ALTER COLUMN priority SET NOT NULL;

-- =============================================================================
-- Verification (informational; safe to run repeatedly):
--   SELECT priority, COUNT(*) FROM agent_actions
--     WHERE status = 'pending' GROUP BY priority ORDER BY priority;
--
--   SELECT action_type, rule_applied, priority, COUNT(*)
--     FROM agent_actions WHERE status = 'pending'
--     GROUP BY 1,2,3 ORDER BY 3, 4 DESC;
-- =============================================================================
