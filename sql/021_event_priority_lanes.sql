-- =============================================================================
-- 021_event_priority_lanes.sql
--
-- Adds priority lanes to system_events so the decision engine's pull query
-- can pick up live-conversation AI events ahead of bulk webhook spikes.
--
-- Background:
-- The decision engine pulls pending events with:
--   .order('priority', { ascending: true }).limit(50)
-- The priority column is text. Postgres sorts text alphabetically:
--   'critical' < 'high' < 'low' < 'normal'
-- so 'normal' events sort LAST. On 2026-05-07 22:43 a bulk agentic-active
-- tag application across 348 contacts fired 392 agentic.handoff_started
-- webhook events at priority='high'. With a 50-event cron limit, the
-- 'normal'-priority ai.analysis_completed event for a real customer reply
-- (Mark Test event 57267) would have waited ~10 cron ticks (~50 min) for
-- a response. Unacceptable for live agentic conversations.
--
-- Fix: int priority_lane column. Lower lane = higher priority. Trigger
-- assigns lanes on insert based on event_type (ai.* events get lane 5,
-- above explicit 'high' at lane 10). Pull query orders by priority_lane.
--
-- Default lanes (set by trigger when caller does not provide one):
--    0 — explicit priority='critical' (DNC, urgent escalations)
--    5 — ai.* events (live conversation analysis → agentic responses)
--   10 — explicit priority='high' (webhooks, score changes, intent, handoffs)
--  100 — default (everything else)
--  200 — explicit priority='low' (background scoring, telemetry)
--
-- Callers can override the default by passing an explicit `priority_lane`
-- value on insert; the trigger only fills NULL.
--
-- Run in: LP MCP Supabase -> SQL Editor (same database as the rest of the
-- agentic schema). Idempotent — safe to re-run.
--
-- Pairs with:
--   src/decision-engine.js     — processEvents query updated to order by lane
--   src/message-analyzer.js    — analyzePendingReplies query updated to order by lane
--
-- Date: 2026-05-07
-- =============================================================================

-- 1. Column. NULL allowed at first so the trigger can fill it for new rows
--    and the backfill UPDATE can fill it for existing rows.
ALTER TABLE system_events
  ADD COLUMN IF NOT EXISTS priority_lane INT;

-- 2. Default-priority-lane function. BEFORE INSERT trigger; only fills when
--    caller did not supply an explicit value, mirroring 020's pattern.
CREATE OR REPLACE FUNCTION system_events_default_priority_lane()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.priority_lane IS NOT NULL THEN
    RETURN NEW;
  END IF;

  NEW.priority_lane := CASE
    -- Explicit critical wins outright.
    WHEN NEW.priority = 'critical' THEN 0
    -- AI analysis events represent active conversations. They MUST process
    -- ahead of bulk handoff/score webhooks. Lane 5 ensures a single
    -- ai.analysis_completed jumps the queue past any number of 'high'
    -- bulk events.
    WHEN NEW.event_type LIKE 'ai.%' THEN 5
    WHEN NEW.priority = 'high' THEN 10
    WHEN NEW.priority = 'low' THEN 200
    ELSE 100
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_system_events_default_priority_lane ON system_events;
CREATE TRIGGER trg_system_events_default_priority_lane
  BEFORE INSERT ON system_events
  FOR EACH ROW
  EXECUTE FUNCTION system_events_default_priority_lane();

-- 3. Backfill existing rows with the same lane logic the trigger uses.
--    Touches every row, but only writes when priority_lane is currently NULL,
--    so re-running the migration is a no-op once seeded.
UPDATE system_events
SET priority_lane = CASE
  WHEN priority = 'critical' THEN 0
  WHEN event_type LIKE 'ai.%' THEN 5
  WHEN priority = 'high' THEN 10
  WHEN priority = 'low' THEN 200
  ELSE 100
END
WHERE priority_lane IS NULL;

-- 4. Partial index for the pull query. The decision engine pickup is
--    .eq('processed', false).order('priority_lane').order('created_at')
--    so this index covers it exactly. Partial on processed=false keeps
--    the index small and hot-path fast (the table grows fast — historical
--    rows are processed=true and don't need to be in this index).
CREATE INDEX IF NOT EXISTS idx_se_lane_pull
  ON system_events (priority_lane ASC, created_at ASC)
  WHERE processed = false;

-- 5. NOT NULL constraint after backfill. We intentionally do NOT set a
--    column DEFAULT — the trigger handles defaults and is the single
--    source of truth for lane assignment. NOT NULL guards against
--    inserts that somehow bypass the trigger.
ALTER TABLE system_events
  ALTER COLUMN priority_lane SET NOT NULL;

-- =============================================================================
-- Verification (informational; safe to run repeatedly):
--   SELECT priority_lane, COUNT(*) FROM system_events
--     WHERE processed = false GROUP BY priority_lane ORDER BY priority_lane;
--
--   SELECT event_type, priority, priority_lane, COUNT(*)
--     FROM system_events WHERE processed = false
--     GROUP BY 1,2,3 ORDER BY 3, 4 DESC;
-- =============================================================================
