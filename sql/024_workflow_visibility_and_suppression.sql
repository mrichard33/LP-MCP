-- ─────────────────────────────────────────────────────────────────────────────
-- 024 — Workflow visibility + channel-aware suppression (S1.3 audit remediation)
-- ─────────────────────────────────────────────────────────────────────────────
-- Pairs with code changes:
--   • src/agentic/lead-selection/suppression-sources.js — gate suppression reads
--   • src/agentic/lead-selection/select.js — hardened evaluateExclusion()
--   • src/events-router.js — new ghl.* workflow telemetry event types
--   • src/jobs/workflow-projection.js — system_events → membership/suppression sweep
--   • scripts/backfill-s13-membership.js — one-time cohort seed
--
-- Run in: LP MCP Supabase → SQL Editor (same database as the rest of the
-- agentic schema). Additive + idempotent — no drops, safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 2.1 Channel-aware suppression registry ───────────────────────────────────
-- Single source of truth the eligibility gate reads. Complements
-- lp_prospect_denylist (failure-based, LP-prospect-keyed) and quarantine_pool
-- (validator holds) with per-CHANNEL consent/eligibility state keyed on GHL contact.
CREATE TABLE IF NOT EXISTS contact_suppression (
  id              BIGSERIAL PRIMARY KEY,
  ghl_contact_id  TEXT NOT NULL,
  channel         TEXT NOT NULL,           -- 'sms' | 'email' | 'call' | 'canvass' | 'all'
  reason          TEXT NOT NULL,           -- 'dnc' | 'opt_out' | 'out_of_area' | 'no_contact_method' | 'hard_bounce' | 'converted' | 'complaint'
  source_system   TEXT NOT NULL,           -- 'ghl' | 'lp' | 'agentic' | 'manual'
  detail          JSONB DEFAULT '{}'::jsonb,
  active          BOOLEAN NOT NULL DEFAULT true,
  set_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ,             -- NULL = permanent
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ghl_contact_id, channel, reason)
);
CREATE INDEX IF NOT EXISTS idx_contact_suppression_lookup
  ON contact_suppression (ghl_contact_id) WHERE active;

COMMENT ON TABLE contact_suppression IS
  'Per-channel consent/eligibility state keyed on GHL contact. Read by the lead-selection gate (suppression-sources.js) to exclude DNC / opt-out / out-of-area / converted / complaint contacts before enrollment. Written by the workflow-projection sweep and manual seeds.';


-- ── 2.2 Per-message delivery ledger ──────────────────────────────────────────
-- Captures message.failed (and optionally delivered/sent) webhook events so
-- delivery failures are queryable instead of buried in GHL. Feeds the
-- no_contact_method / hard_bounce suppression logic.
CREATE TABLE IF NOT EXISTS message_delivery (
  id              BIGSERIAL PRIMARY KEY,
  ghl_contact_id  TEXT NOT NULL,
  ghl_message_id  TEXT,
  channel         TEXT,                    -- 'sms' | 'email'
  status          TEXT NOT NULL,           -- 'delivered' | 'failed' | 'sent' | 'undelivered'
  error_code      TEXT,
  error_detail    TEXT,
  workflow_id     TEXT,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ghl_message_id, status)
);
CREATE INDEX IF NOT EXISTS idx_message_delivery_contact
  ON message_delivery (ghl_contact_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_delivery_failed
  ON message_delivery (ghl_contact_id) WHERE status IN ('failed','undelivered');

COMMENT ON TABLE message_delivery IS
  'Per-message delivery ledger projected from ghl.message_failed (and optionally delivered/sent) webhook events. Feeds the no_contact_method / hard_bounce suppression logic and the cohort report last_message_status.';


-- ── 2.3 Live workflow membership ─────────────────────────────────────────────
-- One row per (contact, workflow) enrollment. The "where is everyone right now"
-- table. Populated by the workflow.* webhook events via the events router.
-- agentic_lead_states.workflow_history (jsonb) remains the historical record;
-- this is the queryable live projection.
CREATE TABLE IF NOT EXISTS workflow_membership (
  id                 BIGSERIAL PRIMARY KEY,
  ghl_contact_id     TEXT NOT NULL,
  workflow_id        TEXT NOT NULL,
  canonical_code     TEXT,                 -- e.g. 'S1.3'
  entry_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  entry_reason       TEXT,                 -- enrollment rule/segment from resurrection_enrollment_log
  current_node       TEXT,                 -- last node name reported (e.g. 'Wait till name-normalized')
  wait_status        TEXT,                 -- 'none' | 'waiting' | 'timed_out'
  last_message_status TEXT,               -- mirrors latest message_delivery.status
  exit_at            TIMESTAMPTZ,
  exit_reason        TEXT,                 -- 'completed' | 'reply' | 'opt_out' | 'suppressed' | 'no_contact_method' | 'timeout' | 'manual'
  is_active          BOOLEAN NOT NULL DEFAULT true,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ghl_contact_id, workflow_id, entry_at)
);
CREATE INDEX IF NOT EXISTS idx_workflow_membership_active
  ON workflow_membership (workflow_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_workflow_membership_contact
  ON workflow_membership (ghl_contact_id);

COMMENT ON TABLE workflow_membership IS
  'Live (contact, workflow) enrollment projection — the "where is everyone right now" table. Populated by the workflow-projection sweep from ghl.* workflow webhook events. Historical record stays in agentic_lead_states.workflow_history.';


-- ── 2.4 Cohort report view ───────────────────────────────────────────────────
-- who entered · why qualified · where now · what happened · action required.
-- Parameterized by workflow via WHERE wm.canonical_code; S1.3 is the first consumer.
CREATE OR REPLACE VIEW v_s13_cohort_report AS
WITH last_event AS (
  SELECT DISTINCT ON (ghl_contact_id)
         ghl_contact_id, event_type, event_subtype, event_timestamp
  FROM system_events
  WHERE ghl_contact_id IS NOT NULL
  ORDER BY ghl_contact_id, event_timestamp DESC
),
last_msg AS (
  SELECT DISTINCT ON (ghl_contact_id)
         ghl_contact_id, status, channel, error_detail, occurred_at
  FROM message_delivery
  ORDER BY ghl_contact_id, occurred_at DESC
)
SELECT
  wm.ghl_contact_id,
  wm.canonical_code,
  wm.entry_at,
  wm.entry_reason,
  wm.current_node,
  wm.wait_status,
  wm.is_active,
  wm.exit_reason,
  c.disposition_code,
  c.segment,
  c.temperature,
  c.score,
  c.rank,
  lm.status        AS last_message_status,
  lm.channel       AS last_message_channel,
  lm.error_detail  AS last_message_error,
  le.event_type    AS last_event_type,
  le.event_subtype AS last_event_subtype,
  le.event_timestamp AS last_event_at,
  -- channel-aware suppression rollup
  EXISTS (SELECT 1 FROM contact_suppression s
          WHERE s.ghl_contact_id = wm.ghl_contact_id AND s.active) AS is_suppressed,
  (SELECT array_agg(DISTINCT s.reason) FROM contact_suppression s
          WHERE s.ghl_contact_id = wm.ghl_contact_id AND s.active) AS suppression_reasons,
  -- computed "action required" flag
  CASE
    WHEN wm.wait_status = 'waiting'
         AND wm.updated_at < now() - interval '6 hours'      THEN 'stuck-in-wait'
    WHEN lm.status IN ('failed','undelivered')
         AND NOT EXISTS (SELECT 1 FROM contact_suppression s
                         WHERE s.ghl_contact_id = wm.ghl_contact_id
                           AND s.reason IN ('no_contact_method','hard_bounce') AND s.active)
                                                              THEN 'delivery-failed-unsuppressed'
    WHEN le.event_type = 'ghl.reply_received'
         AND wm.is_active = false AND wm.exit_reason = 'reply' THEN 'hot-reply-check-handoff'
    WHEN wm.is_active = true
         AND EXISTS (SELECT 1 FROM contact_suppression s
                     WHERE s.ghl_contact_id = wm.ghl_contact_id AND s.active)
                                                              THEN 'active-but-suppressed-conflict'
    ELSE 'ok'
  END AS action_required
FROM workflow_membership wm
LEFT JOIN agentic_reengagement_candidates c ON c.contact_id = wm.ghl_contact_id
LEFT JOIN last_event le ON le.ghl_contact_id = wm.ghl_contact_id
LEFT JOIN last_msg   lm ON lm.ghl_contact_id = wm.ghl_contact_id
WHERE wm.canonical_code = 'S1.3';
