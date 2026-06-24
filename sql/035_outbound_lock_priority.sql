-- =============================================================================
-- 035_outbound_lock_priority.sql
--
-- Makes outbound-lock arbitration deterministic by action PRIORITY rather than
-- race/insertion order.
--
-- Background (Mark Test repro, June 2026):
-- On one ai.analysis_completed event, multiple send_message actions can target
-- the same (contact_id, trigger_id). The fast-path fires each as a concurrent
-- fire-and-forget executeActionById, so they race on the outbound_locks INSERT —
-- whichever hits Postgres first wins the single slot, regardless of which send
-- is the intended primary. That awarded the slot to the wrong send (e.g. the
-- S1.3 Lane-5 "give me a moment" filler instead of the agentic lane's real
-- reply).
--
-- This migration records the lock holder's action priority so the application
-- (src/services/outbound-locks.js) can let a strictly-higher-priority challenger
-- (lower priority number) preempt a lower-priority live holder. Additive and
-- backward-compatible: existing rows and callers that don't pass a priority
-- leave holder_priority NULL, which never preempts and is never preempted.
--
-- Smaller priority value = higher priority (matches agent_actions.priority,
-- see 020_action_priority_lanes.sql).
-- =============================================================================

ALTER TABLE outbound_locks
  ADD COLUMN IF NOT EXISTS holder_priority INT;

COMMENT ON COLUMN outbound_locks.holder_priority IS
  'Action priority of the current lock holder (smaller = higher priority). A challenger with a strictly smaller priority preempts a live holder. NULL = unknown priority (never preempts / never preempted).';
