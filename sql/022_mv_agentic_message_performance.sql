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
-- Refresh: daily via n8n cron (`POST /n8n/agentic-mv-refresh` style
-- or direct Supabase node). Non-concurrent refresh is fine — the
-- view is small enough (a few hundred rows max at scale) that a
-- couple-second lock is invisible.
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

-- Initial population. After this runs once, the n8n cron handles refresh.
REFRESH MATERIALIZED VIEW mv_agentic_message_performance;

-- ═══════════════════════════════════════════════════════════════════
-- Quick sanity check after apply:
--
--   SELECT * FROM mv_agentic_message_performance
--   ORDER BY workflow_code, sequence_position;
--
-- Should return one row per (prompt_code, workflow_code,
-- sequence_position, channel) combination that has at least one
-- agentic_messages row in the last 90 days.
-- ═══════════════════════════════════════════════════════════════════
