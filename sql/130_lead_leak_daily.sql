-- 130_lead_leak_daily.sql
-- Results table + daily summary view for src/jobs/lead-leak-monitor.js (2026-09-26).
--
-- WHY. Nothing checked for LP leads we should be calling but are not. The job
-- finds every lead from the last LEAD_LEAK_WINDOW_DAYS that Five9 never
-- dialled (Five9 disposition history is the truth, NOT lp_leads.call_count),
-- labels WHY, and prices the real leaks. One row per uncalled lead per run.
--
-- reason (first match wins — src/lead-leak-classify.js):
--   already_progressed   Set/Sale/… with no Five9 call on record. NOT a leak —
--                        a gap in LP's call data. Tracked as a data-quality count.
--   dnc | missing_phone | duplicate | missing_source | data_undecided | dead_status
--   not_in_five9         callable, and Five9 holds no contact for the number
--   routing_or_automation_failure   callable, in Five9, never dialled — the real leak
--   unverified           callable, but not looked up in Five9 (over the daily cap)
--
-- est_value is an ESTIMATE (source close rate × average won job value, trailing
-- 180 days), set only for not_in_five9 / routing_or_automation_failure /
-- unverified. NULL everywhere else, and NULL on a run whose close-rate read failed.
--
-- The UNIQUE key makes a same-day rerun overwrite rather than double-count.
--
-- APPLY FROM THE DASHBOARD, LP instance — steps 1 and 2 as separate executions.
-- Mirrored in runMigrations() (src/index.js) so a fresh deploy self-heals.
-- Additive only: no existing table or view is altered.
--
-- NO INDEX STEP. five9_events_raw(lp_rec_key) is already indexed live
-- (idx_five9_raw_lp_rec, verified 2026-09-26), and lp_leads already carries
-- idx_lp_leads_phone10 and idx_lp_leads_created, which the job's reads use.

-- 1 ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lead_leak_daily (
  id bigserial PRIMARY KEY,
  run_date date NOT NULL,
  lp_lead_id text NOT NULL,
  lp_prospect_id text,
  lead_source text,
  disposition text,
  reason text NOT NULL,
  est_value numeric,
  detail jsonb,
  created_at timestamptz DEFAULT now(),
  UNIQUE (run_date, lp_lead_id)
);

-- 2 ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_lead_leak_summary AS
SELECT run_date,
       reason,
       count(*)        AS leads,
       sum(est_value)  AS est_value_at_risk
  FROM lead_leak_daily
 GROUP BY run_date, reason;
