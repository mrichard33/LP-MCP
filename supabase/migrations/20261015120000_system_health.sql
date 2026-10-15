-- System health monitoring: registry, results, incidents (2026-10-15)
--
-- Applied to prod 2026-10-14 via LP MCP. Idempotent; re-running is a no-op.
-- applied by hand first: Mark 2026-10-14
-- Every object below was created in the dashboard by Mark on 2026-10-14/15 and
-- was missing from supabase_migrations.schema_migrations. This file is the
-- repo's history of it, copied from the live catalog (pg_constraint, pg_indexes,
-- pg_get_viewdef) on 2026-10-15, so the drift check stops seeing them as
-- prod-only and a fresh replay builds the same schema.
--
-- Version 20261015120000, not the handoff's 20261014220000: prod already lists
-- 20261014233000, and `supabase db push` refuses a file older than the newest
-- applied version.
--
-- WHAT:
--   health_checks         the registry (73 rows seeded in sql/seeds/health_checks.sql).
--                         THE DATABASE IS THE SOURCE OF TRUTH; code reads it
--                         (src/health/registry.js) and never upserts it at boot.
--   health_results        one row per check evaluation (src/health/record.js).
--   health_results_daily  30-day rollup written by the health-retention job.
--   incidents             one row per open problem; the partial unique index
--                         keeps one non-terminal incident per fingerprint.
--   incident_events       the append-only timeline of an incident.
--   investigation_runs    Phase 3 (AI investigation); empty until then.
--   n8n_execution_log     Phase 2 (n8n execution poller); empty until then.
--   synthetic_runs        Phase 3 (synthetic canaries); empty until then.
--   escalation_policy     P1..P4 ack / remind / escalate rules.
--   alert_conditions.incident_id, agent_actions.incident_id: nullable links.
--
-- The one change this file makes to prod: the four views are owned by postgres,
-- so they read the tables PAST row level security, and anon / authenticated
-- held every privilege on them (and on the tables). health_results.detail and
-- incidents.detail name leads (first name, last initial, last 4 of the phone).
-- Like every system table here (see rehash_stage), access is service_role only:
-- the REVOKEs at the end. The dashboard reads with the service-role client.
--
-- ROLLBACK: the tables are additive. Drop order if ever needed:
--   views, then incident_events / investigation_runs, the two incident_id
--   columns, incidents, health_results, health_results_daily, health_checks,
--   escalation_policy, n8n_execution_log, synthetic_runs.

-- ── Tables ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS health_checks (
  check_id        text PRIMARY KEY,
  family          text NOT NULL,
  system          text NOT NULL,
  label           text NOT NULL,
  question        text NOT NULL,
  severity        text NOT NULL CONSTRAINT health_checks_severity_check
                    CHECK (severity = ANY (ARRAY['P1'::text, 'P2'::text, 'P3'::text, 'P4'::text])),
  cadence         text NOT NULL,
  active_window   text,
  stale_after_min integer NOT NULL,
  warn_rule       text NOT NULL,
  fail_rule       text NOT NULL,
  config          jsonb NOT NULL DEFAULT '{}'::jsonb,
  mode            text NOT NULL DEFAULT 'shadow'::text CONSTRAINT health_checks_mode_check
                    CHECK (mode = ANY (ARRAY['off'::text, 'shadow'::text, 'live'::text])),
  owner_job_id    text,
  runbook         text,
  business_impact text,
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS health_results (
  id          bigserial PRIMARY KEY,
  check_id    text NOT NULL CONSTRAINT health_results_check_id_fkey REFERENCES health_checks(check_id),
  observed_at timestamptz NOT NULL DEFAULT now(),
  status      text NOT NULL CONSTRAINT health_results_status_check
                CHECK (status = ANY (ARRAY['pass'::text, 'warn'::text, 'fail'::text, 'unknown'::text, 'skipped'::text])),
  value       numeric,
  summary     text,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  fingerprint text,
  job_run_id  bigint CONSTRAINT health_results_job_run_id_fkey REFERENCES job_runs(id),
  elapsed_ms  integer
);

CREATE TABLE IF NOT EXISTS health_results_daily (
  day            date NOT NULL,
  check_id       text NOT NULL,
  passes         integer,
  warns          integer,
  fails          integer,
  unknowns       integer,
  minutes_red    integer,
  minutes_yellow integer,
  first_fail_at  timestamptz,
  last_fail_at   timestamptz,
  CONSTRAINT health_results_daily_pkey PRIMARY KEY (day, check_id)
);

CREATE TABLE IF NOT EXISTS incidents (
  id                 bigserial PRIMARY KEY,
  fingerprint        text NOT NULL,
  check_id           text NOT NULL CONSTRAINT incidents_check_id_fkey REFERENCES health_checks(check_id),
  system             text NOT NULL,
  severity           text NOT NULL CONSTRAINT incidents_severity_check
                       CHECK (severity = ANY (ARRAY['P1'::text, 'P2'::text, 'P3'::text, 'P4'::text])),
  status             text NOT NULL DEFAULT 'open'::text CONSTRAINT incidents_status_check
                       CHECK (status = ANY (ARRAY['open'::text, 'acknowledged'::text, 'investigating'::text,
                         'fix_proposed'::text, 'approved'::text, 'fixing'::text, 'verifying'::text,
                         'resolved'::text, 'closed_no_action'::text, 'snoozed'::text])),
  title              text NOT NULL,
  summary            text,
  business_impact    text,
  est_value_at_risk  numeric,
  occurrence_count   integer NOT NULL DEFAULT 1,
  opened_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  acknowledged_at    timestamptz,
  acknowledged_by    text,
  investigated_at    timestamptz,
  resolved_at        timestamptz,
  resolved_by        text,
  verified_at        timestamptz,
  verified_by        text,
  snooze_until       timestamptz,
  known_issue_id     integer CONSTRAINT incidents_known_issue_id_fkey REFERENCES claude_known_issues(id),
  slack_channel      text,
  slack_ts           text,
  escalation_level   integer NOT NULL DEFAULT 0,
  next_escalation_at timestamptz,
  data               jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS incident_events (
  id          bigserial PRIMARY KEY,
  incident_id bigint NOT NULL CONSTRAINT incident_events_incident_id_fkey
                REFERENCES incidents(id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  actor       text NOT NULL,
  kind        text NOT NULL CONSTRAINT incident_events_kind_check
                CHECK (kind = ANY (ARRAY['opened'::text, 'result'::text, 'reopened'::text, 'acknowledged'::text,
                  'investigation_started'::text, 'investigated'::text, 'fix_proposed'::text, 'approved'::text,
                  'rejected'::text, 'executed'::text, 'verified'::text, 'resolved'::text,
                  'closed_no_action'::text, 'snoozed'::text, 'escalated'::text, 'note'::text, 'slack_posted'::text])),
  body        text,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS investigation_runs (
  id                  bigserial PRIMARY KEY,
  incident_id         bigint NOT NULL CONSTRAINT investigation_runs_incident_id_fkey
                        REFERENCES incidents(id) ON DELETE CASCADE,
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  agent               text NOT NULL,
  model               text,
  status              text NOT NULL DEFAULT 'running'::text CONSTRAINT investigation_runs_status_check
                        CHECK (status = ANY (ARRAY['running'::text, 'done'::text, 'failed'::text, 'timed_out'::text])),
  playbook            text,
  finding             text,
  likely_cause        text,
  confidence          numeric CONSTRAINT investigation_runs_confidence_check
                        CHECK ((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)),
  impact              text,
  recommended_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence            jsonb NOT NULL DEFAULT '[]'::jsonb,
  tokens_in           integer,
  tokens_out          integer,
  cost_usd            numeric
);

CREATE TABLE IF NOT EXISTS n8n_execution_log (
  execution_id  text PRIMARY KEY,
  workflow_id   text NOT NULL,
  workflow_name text,
  status        text NOT NULL,
  mode          text,
  started_at    timestamptz,
  stopped_at    timestamptz,
  error_node    text,
  error_message text,
  polled_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS synthetic_runs (
  id             bigserial PRIMARY KEY,
  scenario       text NOT NULL,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  status         text NOT NULL DEFAULT 'running'::text CONSTRAINT synthetic_runs_status_check
                   CHECK (status = ANY (ARRAY['running'::text, 'pass'::text, 'fail'::text, 'unknown'::text, 'cleaned'::text])),
  steps          jsonb NOT NULL DEFAULT '[]'::jsonb,
  ghl_contact_id text,
  lp_lead_id     text,
  five9_key      text,
  cleanup_due_at timestamptz,
  cleaned_at     timestamptz
);

CREATE TABLE IF NOT EXISTS escalation_policy (
  severity         text PRIMARY KEY,
  ack_within_min   integer,
  remind_every_min integer,
  escalate_to      jsonb NOT NULL DEFAULT '[]'::jsonb,
  channels         jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- ── Links from the existing tables ──────────────────────────────────────────

ALTER TABLE alert_conditions ADD COLUMN IF NOT EXISTS incident_id bigint;
ALTER TABLE agent_actions    ADD COLUMN IF NOT EXISTS incident_id bigint;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_conditions_incident_id_fkey') THEN
    ALTER TABLE alert_conditions
      ADD CONSTRAINT alert_conditions_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES incidents(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_actions_incident_id_fkey') THEN
    ALTER TABLE agent_actions
      ADD CONSTRAINT agent_actions_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES incidents(id);
  END IF;
END $$;

-- ── Indexes ───────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS health_results_check_observed_idx ON health_results (check_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS health_results_bad_idx ON health_results (observed_at)
  WHERE (status = ANY (ARRAY['fail'::text, 'warn'::text]));
-- One non-terminal incident per fingerprint. openOrTouchIncident catches 23505
-- from this index and touches the existing row instead.
CREATE UNIQUE INDEX IF NOT EXISTS incidents_open_fingerprint ON incidents (fingerprint)
  WHERE (status <> ALL (ARRAY['resolved'::text, 'closed_no_action'::text]));
CREATE INDEX IF NOT EXISTS incidents_status_sev_idx ON incidents (status, severity, opened_at DESC);
CREATE INDEX IF NOT EXISTS incident_events_incident_idx ON incident_events (incident_id, at);
CREATE INDEX IF NOT EXISTS n8n_execution_log_wf_idx ON n8n_execution_log (workflow_id, stopped_at DESC);

-- ── Views ─────────────────────────────────────────────────────────────────

-- The latest result per check and its color. A check with no result, or a
-- result older than stale_after_min, is red for P1 and yellow otherwise:
-- silence is never green.
CREATE OR REPLACE VIEW v_health_check_latest AS
 SELECT c.check_id,
    c.family,
    c.system,
    c.label,
    c.question,
    c.severity,
    c.cadence,
    c.active_window,
    c.stale_after_min,
    c.warn_rule,
    c.fail_rule,
    c.config,
    c.mode,
    c.owner_job_id,
    c.runbook,
    c.business_impact,
    c.enabled,
    r.status AS last_status,
    r.observed_at AS last_observed_at,
    r.summary AS last_summary,
    r.value AS last_value,
    r.fingerprint AS last_fingerprint,
    r.detail AS last_detail,
    (EXTRACT(epoch FROM (now() - r.observed_at)) / (60)::numeric) AS minutes_since,
        CASE
            WHEN ((NOT c.enabled) OR (c.mode = 'off'::text)) THEN 'disabled'::text
            WHEN (r.observed_at IS NULL) THEN
            CASE
                WHEN (c.severity = 'P1'::text) THEN 'red'::text
                ELSE 'yellow'::text
            END
            WHEN ((now() - r.observed_at) > make_interval(mins => c.stale_after_min)) THEN
            CASE
                WHEN (c.severity = 'P1'::text) THEN 'red'::text
                ELSE 'yellow'::text
            END
            WHEN ((r.status = 'fail'::text) AND (c.severity = ANY (ARRAY['P1'::text, 'P2'::text]))) THEN 'red'::text
            WHEN (r.status = ANY (ARRAY['fail'::text, 'warn'::text, 'unknown'::text])) THEN 'yellow'::text
            ELSE 'green'::text
        END AS color
   FROM (health_checks c
     LEFT JOIN LATERAL ( SELECT x.id,
            x.check_id,
            x.observed_at,
            x.status,
            x.value,
            x.summary,
            x.detail,
            x.fingerprint,
            x.job_run_id,
            x.elapsed_ms
           FROM health_results x
          WHERE (x.check_id = c.check_id)
          ORDER BY x.observed_at DESC
         LIMIT 1) r ON (true));

-- Live-mode checks only: what the platform officially reports.
CREATE OR REPLACE VIEW v_system_status AS
 SELECT system,
        CASE
            WHEN bool_or((color = 'red'::text)) THEN 'red'::text
            WHEN bool_or((color = 'yellow'::text)) THEN 'yellow'::text
            ELSE 'green'::text
        END AS color,
    count(*) FILTER (WHERE (color = 'red'::text)) AS red,
    count(*) FILTER (WHERE (color = 'yellow'::text)) AS yellow,
    count(*) FILTER (WHERE (color = 'green'::text)) AS green,
    count(*) FILTER (WHERE (mode = 'shadow'::text)) AS shadow,
    max(last_observed_at) AS last_observed_at
   FROM v_health_check_latest
  WHERE ((color <> 'disabled'::text) AND (mode = 'live'::text))
  GROUP BY system;

-- Every enabled check, shadow included: what the platform WOULD report.
CREATE OR REPLACE VIEW v_system_status_shadow AS
 SELECT system,
        CASE
            WHEN bool_or((color = 'red'::text)) THEN 'red'::text
            WHEN bool_or((color = 'yellow'::text)) THEN 'yellow'::text
            ELSE 'green'::text
        END AS color,
    count(*) FILTER (WHERE (color = 'red'::text)) AS red,
    count(*) FILTER (WHERE (color = 'yellow'::text)) AS yellow,
    count(*) FILTER (WHERE (color = 'green'::text)) AS green,
    max(last_observed_at) AS last_observed_at
   FROM v_health_check_latest
  WHERE (color <> 'disabled'::text)
  GROUP BY system;

CREATE OR REPLACE VIEW v_incident_board AS
 SELECT i.id,
    i.fingerprint,
    i.check_id,
    i.system,
    i.severity,
    i.status,
    i.title,
    i.summary,
    i.business_impact,
    i.est_value_at_risk,
    i.occurrence_count,
    i.opened_at,
    i.last_seen_at,
    i.acknowledged_at,
    i.acknowledged_by,
    i.investigated_at,
    i.resolved_at,
    i.resolved_by,
    i.verified_at,
    i.verified_by,
    i.snooze_until,
    i.known_issue_id,
    i.slack_channel,
    i.slack_ts,
    i.escalation_level,
    i.next_escalation_at,
    i.data,
    c.label AS check_label,
    c.family,
    ( SELECT count(*) AS count
           FROM incident_events e
          WHERE (e.incident_id = i.id)) AS event_count,
    ( SELECT r.finding
           FROM investigation_runs r
          WHERE (r.incident_id = i.id)
          ORDER BY r.started_at DESC
         LIMIT 1) AS latest_finding,
    ( SELECT count(*) AS count
           FROM agent_actions a
          WHERE ((a.incident_id = i.id) AND (a.status = 'pending'::text))) AS actions_waiting
   FROM (incidents i
     JOIN health_checks c USING (check_id))
  WHERE (i.status <> ALL (ARRAY['resolved'::text, 'closed_no_action'::text]))
  ORDER BY
        CASE i.severity
            WHEN 'P1'::text THEN 1
            WHEN 'P2'::text THEN 2
            WHEN 'P3'::text THEN 3
            ELSE 4
        END, i.opened_at;

-- ── Access: service_role only ─────────────────────────────────────────────

ALTER TABLE health_checks        ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_results       ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_results_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents            ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE investigation_runs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE n8n_execution_log    ENABLE ROW LEVEL SECURITY;
ALTER TABLE synthetic_runs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalation_policy    ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE health_checks, health_results, health_results_daily, incidents, incident_events,
  investigation_runs, n8n_execution_log, synthetic_runs, escalation_policy FROM anon, authenticated;
REVOKE ALL ON TABLE v_health_check_latest, v_system_status, v_system_status_shadow, v_incident_board
  FROM anon, authenticated;
REVOKE ALL ON SEQUENCE health_results_id_seq, incidents_id_seq, incident_events_id_seq,
  investigation_runs_id_seq, synthetic_runs_id_seq FROM anon, authenticated;
