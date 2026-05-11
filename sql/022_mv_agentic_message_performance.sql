-- ═══════════════════════════════════════════════════════════════════
-- 022_mv_agentic_message_performance.sql
-- ═══════════════════════════════════════════════════════════════════
--
-- §10.3 of the S4.5 v1.0 Agentic Seinfeld Architecture spec.
--
-- Materialized view that rolls up agentic_messages into per-prompt
-- performance numbers: how many were sent, suppressed, opened,
-- clicked, replied to, unsubscribed from, and ultimately attributed
-- to a booking. Powers all three of the §14 learning loops:
--
--   Loop 1 — prompt-level performance review (kill bottom 20%,
--            A/B test top 20%)
--   Loop 2 — confidence threshold calibration (compare engagement
--            of 0.70-0.78 sends vs 0.78+ sends)
--   Loop 3 — story arc deployment validation (which arcs convert
--            at which buyer stage)
--
-- Window: last 90 days, per the spec. Adjust the WHERE clause if a
-- longer view is needed later.
--
-- Refresh: daily via the LP MCP `/n8n/agentic/refresh-performance-mv`
-- endpoint, which calls the refresh_agentic_performance_mv() function
-- defined at the bottom of this file. n8n cron hits the LP MCP
-- endpoint once per day. Non-concurrent refresh is fine — the view
-- is small enough (a few hundred rows max at scale) that the lock
-- is invisible.
--
-- Apply once via Supabase SQL editor.
-- ═══════════════════════════════════════════════════════════════════

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_agentic_message_performance AS
SELECT
  prompt_code,
  workflow_code,
  sequence_position,
  channel,

  -- Volume
  COUNT(*)                                                  AS total_count,
  COUNT(*) FILTER (WHERE send_status = 'sent')              AS sent_count,
  COUNT(*) FILTER (WHERE send_status = 'generated_ready')   AS generated_ready_count,
  COUNT(*) FILTER (WHERE send_status LIKE 'suppressed%')    AS suppressed_count,
  COUNT(*) FILTER (WHERE send_status = 'pending'
                     AND suppressed_reason = 'awaiting_approval') AS awaiting_approval_count,
  COUNT(*) FILTER (WHERE send_status = 'failed_generation') AS failed_count,

  -- Quality (only across send-eligible rows)
  AVG(confidence_score) FILTER (WHERE send_status IN ('sent','generated_ready')) AS avg_confidence,
  AVG(retry_count)      FILTER (WHERE send_status IN ('sent','generated_ready')) AS avg_retries,

  -- Engagement raw counts
  COUNT(*) FILTER (WHERE opened_at        IS NOT NULL) AS opened_count,
  COUNT(*) FILTER (WHERE clicked_at       IS NOT NULL) AS clicked_count,
  COUNT(*) FILTER (WHERE replied_at       IS NOT NULL) AS replied_count,
  COUNT(*) FILTER (WHERE unsubscribed_at  IS NOT NULL) AS unsubscribed_count,
  COUNT(*) FILTER (WHERE booking_attributed = true)    AS bookings_attributed,

  -- Engagement rates (divide-by-zero protected)
  (COUNT(*) FILTER (WHERE opened_at IS NOT NULL))::numeric
    / NULLIF(COUNT(*) FILTER (WHERE send_status IN ('sent','generated_ready')), 0) AS open_rate,

  (COUNT(*) FILTER (WHERE clicked_at IS NOT NULL))::numeric
    / NULLIF(COUNT(*) FILTER (WHERE opened_at IS NOT NULL), 0)                    AS ctr_on_opens,

  (COUNT(*) FILTER (WHERE replied_at IS NOT NULL))::numeric
    / NULLIF(COUNT(*) FILTER (WHERE send_status IN ('sent','generated_ready')), 0) AS reply_rate,

  (COUNT(*) FILTER (WHERE booking_attributed = true))::numeric
    / NULLIF(COUNT(*) FILTER (WHERE send_status IN ('sent','generated_ready')), 0) AS booking_rate,

  (COUNT(*) FILTER (WHERE unsubscribed_at IS NOT NULL))::numeric
    / NULLIF(COUNT(*) FILTER (WHERE send_status IN ('sent','generated_ready')), 0) AS unsub_rate,

  -- Bookkeeping
  MIN(generated_at) AS first_generated_at,
  MAX(generated_at) AS last_generated_at,
  now()             AS refreshed_at

FROM agentic_messages
WHERE generated_at > now() - interval '90 days'
GROUP BY prompt_code, workflow_code, sequence_position, channel;

-- Query indexes for the weekly report + ad-hoc inspection.
CREATE INDEX IF NOT EXISTS idx_mv_agmsg_perf_workflow
  ON mv_agentic_message_performance (workflow_code, sequence_position);

CREATE INDEX IF NOT EXISTS idx_mv_agmsg_perf_booking
  ON mv_agentic_message_performance (bookings_attributed DESC)
  WHERE bookings_attributed > 0;

-- Initial population. After this runs once, the daily n8n cron handles
-- subsequent refreshes via the function below.
REFRESH MATERIALIZED VIEW mv_agentic_message_performance;

-- ═══════════════════════════════════════════════════════════════════
-- Refresh function (callable via supabase.rpc from LP MCP)
-- ═══════════════════════════════════════════════════════════════════
--
-- supabase-js has no raw-SQL escape hatch. To call REFRESH MATERIALIZED
-- VIEW from Node, we expose it as a SECURITY DEFINER function that the
-- service role can invoke via supabase.rpc('refresh_agentic_performance_mv').
--
-- Returns { refreshed_at, total_rows } so the calling endpoint has
-- something useful to log.
--
-- SECURITY DEFINER is required because the service role doesn't own the
-- matview by default — the function runs with the definer's privileges
-- (which DO own it). Locked down by REVOKE+GRANT below: only the
-- authenticator role (Supabase service role) can call it.

CREATE OR REPLACE FUNCTION refresh_agentic_performance_mv()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  row_count integer;
BEGIN
  REFRESH MATERIALIZED VIEW mv_agentic_message_performance;
  SELECT COUNT(*) INTO row_count FROM mv_agentic_message_performance;
  RETURN jsonb_build_object(
    'refreshed_at', now(),
    'total_rows',   row_count
  );
END;
$$;

REVOKE ALL ON FUNCTION refresh_agentic_performance_mv() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_agentic_performance_mv() TO service_role;

-- ═══════════════════════════════════════════════════════════════════
-- Quick sanity check after apply:
--
--   SELECT * FROM mv_agentic_message_performance
--   ORDER BY workflow_code, sequence_position;
--
--   SELECT refresh_agentic_performance_mv();
--     -- should return { "refreshed_at": "...", "total_rows": N }
--
-- ═══════════════════════════════════════════════════════════════════
