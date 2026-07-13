-- 041_scorecard_rederive_reports.sql
-- Pollable report store for the closed-month per-market funnel RE-DERIVE
-- (src/jobs/scorecard-market-rederive.js). A full re-derive re-pulls ~90 days of
-- LP data per closed month, so the route runs fire-and-forget and writes its report
-- here by run_id; callers poll for status='done'. The job also creates this table
-- idempotently via exec_sql on first run, so applying this migration is optional.

CREATE TABLE IF NOT EXISTS scorecard_rederive_reports (
  run_id       text PRIMARY KEY,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  dry_run      boolean,
  status       text NOT NULL DEFAULT 'running',  -- running | done | error
  report       jsonb,                             -- full per-month gate report
  error        text
);
