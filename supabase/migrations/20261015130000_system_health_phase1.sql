-- System health Phase 1 (2026-10-15)
--
-- 1. lead_leak_daily_summary: the per-day, per-reason totals of lead_leak_daily
--    (the same aggregates as v_lead_leak_summary), MATERIALIZED, so the raw
--    rows can be deleted after 90 days without losing the trend. Written by the
--    health-retention job (src/jobs/health-retention.js) before it deletes;
--    the open follow-up from the Lead Leak Monitor.
-- 2. The ci.recording_archive check (Phase 1.4): the legacy alert key
--    'ci:recording_archive_unreachable' maps onto it, so the CI worker's alarm
--    shows up as an incident. Inserted only if absent: the registry is
--    database config and a tuned row is never overwritten.
--
-- Additive only. RLS on, service_role only, like every system table.
-- ROLLBACK: DROP TABLE lead_leak_daily_summary; DELETE FROM health_checks
--   WHERE check_id = 'ci.recording_archive' (after its incidents are closed).

CREATE TABLE IF NOT EXISTS lead_leak_daily_summary (
  run_date          date NOT NULL,
  reason            text NOT NULL,
  leads             integer NOT NULL,
  est_value_at_risk numeric,
  summarized_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_leak_daily_summary_pkey PRIMARY KEY (run_date, reason)
);

ALTER TABLE lead_leak_daily_summary ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE lead_leak_daily_summary FROM anon, authenticated;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window,
  stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('ci.recording_archive', 'sync', 'supabase', 'Call recording archive reachable',
  'Can the call-intelligence worker reach the recording archive?', 'P3', 'existing', NULL,
  1500, 'existing', 'legacy alert ci:recording_archive_unreachable firing',
  '{"source": "alert_conditions ci:recording_archive_unreachable (src/ci/worker.js)"}'::jsonb,
  'shadow', NULL, NULL, 'Calls are not analyzed while the archive is unreachable', true)
ON CONFLICT (check_id) DO NOTHING;
