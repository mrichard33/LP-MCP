-- rule_target_checks (2026-10-12, F-L)
--
-- WHAT: one row per checked target per nightly run of src/jobs/rule-target-check.js
-- (02:10 ET). For every enabled agent_rules row: each add_to_workflow /
-- remove_from_workflow action (action_index = its position in action_template) and,
-- for a ghl.workflow_completed rule, the workflow it listens to (action_index NULL,
-- target_kind 'event_trigger'). status is ok | draft_target | inactive_trigger |
-- missing_target | mismatch | unresolvable | dead_trigger | dynamic; severity is
-- high | low | info (NULL for ok). All rows of one run share run_at.
--
-- WHY: rule 164 sent 64 contacts to a draft workflow's switched-off webhook trigger.
-- GHL answered 200 each time, so every add read "completed" and nobody moved. The old
-- audit checked params.workflow_id only and never resolved params.webhook_url.
--
-- READ BY: the 08:00 ops digest reads the job's job_runs.detail, not this table; this
-- table is the history (which rules were dead, since when).
--
-- RLS on with no policies, like every system table here: service_role only.
--
-- ROLLBACK: DROP TABLE rule_target_checks; (the job then records a failed write in
-- job_runs and still returns its findings).

CREATE TABLE IF NOT EXISTS rule_target_checks (
  id bigserial PRIMARY KEY,
  run_at timestamptz NOT NULL,
  rule_id integer,
  rule_key text,
  action_index integer,
  target_kind text NOT NULL,
  target_id text,
  resolved_workflow_id text,
  status text NOT NULL,
  severity text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rule_target_checks_run_at_idx ON rule_target_checks (run_at DESC);
CREATE INDEX IF NOT EXISTS rule_target_checks_rule_idx ON rule_target_checks (rule_id, run_at DESC);

ALTER TABLE rule_target_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE rule_target_checks FROM anon, authenticated;
REVOKE ALL ON SEQUENCE rule_target_checks_id_seq FROM anon, authenticated;
