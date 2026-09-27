-- 133_inbound_caller_capture.sql
-- Results table + daily summary view for src/jobs/inbound-caller-capture.js (2026-09-27).
--
-- WHY. v_new_callers_no_lp_30d (sql/127) finds new callers who talked 2+ minutes
-- with an agent and never became an LP lead: 234 in the 30 days to 2026-09-26,
-- 159 through LightFire, 6 with an appointment set. Nothing acted on them. The
-- job labels each one and, when INBOUND_CAPTURE_MODE allows, creates the lead
-- through workflow 8e30ff37. One row per CALL (caller_phone, call_at).
--
-- Every row carries campaign, team, agent_name, call_at and disposition so the
-- payroll engine (sql/132) can later attribute LightFire work that has no LP lead.
--
-- label (first match wins — src/inbound-caller-classify.js):
--   dnc | unverified | already_in_lp | existing_customer   never actioned
--   has_ghl_contact | no_ghl_contact                      capture candidates
--
-- action_taken:
--   none               not a candidate
--   shadow             candidate, shadow mode — nothing created
--   skipped_duplicate  the same caller is (or was) actioned on another call
--   in_progress        claimed by a pass; being actioned
--   approval_queued    agent_actions row agent_action_id waits for a person
--   enrolled | contact_created_enrolled | already_enrolled   done
--   not_a_candidate    re-checked at action time and no longer a candidate
--   failed             the attempt failed before anything was created; retried
--
-- The UNIQUE key is the idempotency record: a row in in_progress,
-- approval_queued, enrolled, contact_created_enrolled or already_enrolled is
-- never actioned again, and neither is any other call from that phone.
--
-- APPLY FROM THE DASHBOARD, LP instance — steps 1 and 2 as separate executions.
-- Mirrored in src/admin/startup-mirrors.js ('sql/133') so a fresh deploy
-- self-heals. Additive only: no existing table or view is altered, and
-- v_new_callers_no_lp_30d is read, never modified.
--
-- Must be applied BEFORE INBOUND_CAPTURE_MODE leaves shadow. Until it exists
-- the job logs, stores nothing and creates nothing.
--
-- NO INDEX STEP. The UNIQUE constraint's index (caller_phone, call_at) serves
-- the job's per-phone reads.

-- 1 ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inbound_capture_daily (
  id bigserial PRIMARY KEY,
  run_at timestamptz NOT NULL,
  caller_phone text NOT NULL,
  call_at timestamptz NOT NULL,
  campaign text,
  team text,
  agent_name text,
  disposition text,
  minutes numeric,
  label text NOT NULL,
  mode text NOT NULL,
  action_taken text NOT NULL DEFAULT 'none',
  ghl_contact_id text,
  agent_action_id bigint,
  created_at timestamptz DEFAULT now(),
  UNIQUE (caller_phone, call_at)
);

-- 2 ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_inbound_capture_summary AS
SELECT (run_at AT TIME ZONE 'America/New_York')::date AS run_date,
       label,
       team,
       count(DISTINCT caller_phone) AS callers
  FROM inbound_capture_daily
 GROUP BY 1, 2, 3;
