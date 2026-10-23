-- 20261023233000_lp_sales_reconcile_progress — let the LP sales reconcile resume after a deploy.
--
-- 2026-10-23: a month's reconcile is ~40 minutes of LP paging, and four passes in a row were cut
-- short by other deploys (src/jobs/lp-sales-reconcile.js). A run is now a row; each day of LP's
-- lead list it finished is a row, with the lead ids LP returned that day (the by-id check of
-- leads LP did not list needs them). The scheduler resumes an open run within 5 minutes of a
-- restart and skips the days already done.

CREATE TABLE IF NOT EXISTS lp_sales_reconcile_runs (
  id            bigserial PRIMARY KEY,
  period_from   date        NOT NULL,
  period_to     date        NOT NULL,
  dry_run       boolean     NOT NULL DEFAULT true,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  detail        jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS lp_sales_reconcile_runs_one_open
  ON lp_sales_reconcile_runs (period_from, period_to, dry_run) WHERE finished_at IS NULL;

CREATE TABLE IF NOT EXISTS lp_sales_reconcile_days (
  run_id         bigint      NOT NULL REFERENCES lp_sales_reconcile_runs(id) ON DELETE CASCADE,
  day            date        NOT NULL,
  done_at        timestamptz NOT NULL DEFAULT now(),
  seen_lead_ids  text[]      NOT NULL DEFAULT '{}',
  stats          jsonb,
  PRIMARY KEY (run_id, day)
);
