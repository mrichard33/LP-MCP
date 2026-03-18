-- LP MCP Server — Supabase Schema v3.0
-- Reece Windows & Doors Revenue Intelligence Infrastructure
-- Run in Supabase SQL Editor

-- =============================================================
-- 1. lp_leads (Core Lead Records)
-- =============================================================
CREATE TABLE IF NOT EXISTS lp_leads (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lp_lead_id          TEXT UNIQUE NOT NULL,
  ghl_contact_id      TEXT,
  first_name          TEXT,
  last_name           TEXT,
  email               TEXT,
  phone               TEXT,
  phone_alt           TEXT,
  address             TEXT,
  city                TEXT,
  state               TEXT,
  zip                 TEXT,
  lead_source         TEXT,          -- raw LP 'source' field (parent category)
  lead_source_detail  TEXT,          -- raw LP 'sourcesubdescr' field (sub-source, PRIMARY intent signal)
  ghl_intent_bucket   TEXT,          -- normalized: risk-report | estimate-calculator | chatbot | canvassing | referral | other
  ghl_entry_tag       TEXT,          -- entry:risk-report | entry:estimate-calculator | etc
  ghl_tag_applied     BOOLEAN DEFAULT FALSE,
  disposition_code    TEXT,
  disposition_label   TEXT,
  rep_id              TEXT,
  rep_name            TEXT,
  call_count          INTEGER DEFAULT 0,
  last_call_date      TIMESTAMPTZ,
  last_contact_date   TIMESTAMPTZ,
  appointment_set     BOOLEAN DEFAULT FALSE,
  appointment_date    TIMESTAMPTZ,
  demo_completed      BOOLEAN DEFAULT FALSE,
  demo_date           TIMESTAMPTZ,
  days_to_demo        INTEGER,       -- calculated: demo_date - created_at_lp
  closed_won          BOOLEAN DEFAULT FALSE,
  close_date          TIMESTAMPTZ,
  job_value           NUMERIC(12,2),
  lp_day15_triggered  BOOLEAN DEFAULT FALSE,
  created_at_lp       TIMESTAMPTZ,
  updated_at_lp       TIMESTAMPTZ,
  synced_at           TIMESTAMPTZ DEFAULT now(),
  raw_lp_data         JSONB
);

CREATE INDEX IF NOT EXISTS idx_lp_leads_phone   ON lp_leads(phone);
CREATE INDEX IF NOT EXISTS idx_lp_leads_email   ON lp_leads(email);
CREATE INDEX IF NOT EXISTS idx_lp_leads_ghl_id  ON lp_leads(ghl_contact_id);
CREATE INDEX IF NOT EXISTS idx_lp_leads_disp    ON lp_leads(disposition_code);
CREATE INDEX IF NOT EXISTS idx_lp_leads_rep     ON lp_leads(rep_id);
CREATE INDEX IF NOT EXISTS idx_lp_leads_created ON lp_leads(created_at_lp);
CREATE INDEX IF NOT EXISTS idx_lp_leads_source  ON lp_leads(lead_source);
CREATE INDEX IF NOT EXISTS idx_lp_leads_detail  ON lp_leads(lead_source_detail);
CREATE INDEX IF NOT EXISTS idx_lp_leads_bucket  ON lp_leads(ghl_intent_bucket);
CREATE INDEX IF NOT EXISTS idx_lp_leads_day15   ON lp_leads(lp_day15_triggered);

-- =============================================================
-- 2. lp_jobs (Post-Appointment Job Records)
-- =============================================================
CREATE TABLE IF NOT EXISTS lp_jobs (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lp_job_id              TEXT UNIQUE NOT NULL,
  lp_lead_id             TEXT REFERENCES lp_leads(lp_lead_id),
  ghl_contact_id         TEXT,
  job_status             TEXT,
  job_stage              TEXT,        -- permit | production | install | complete
  financing_status       TEXT,
  financing_company      TEXT,
  hoa_required           BOOLEAN,
  permit_required        BOOLEAN,
  permit_status          TEXT,
  install_date           TIMESTAMPTZ,
  install_completed      BOOLEAN DEFAULT FALSE,
  install_completed_date TIMESTAMPTZ,
  job_value              NUMERIC(12,2),
  rep_id                 TEXT,
  rep_name               TEXT,
  created_at_lp          TIMESTAMPTZ,
  updated_at_lp          TIMESTAMPTZ,
  synced_at              TIMESTAMPTZ DEFAULT now(),
  raw_lp_data            JSONB
);

-- =============================================================
-- 3. lp_job_milestones (W12.x Customer Journey Trigger State)
-- =============================================================
CREATE TABLE IF NOT EXISTS lp_job_milestones (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lp_job_id         TEXT REFERENCES lp_jobs(lp_job_id),
  lp_lead_id        TEXT REFERENCES lp_leads(lp_lead_id),
  ghl_contact_id    TEXT,
  mdt_id            TEXT NOT NULL,        -- LP milestone type code (R, M, O, H, K, etc.)
  datetype          TEXT,                 -- human-readable: 'Measure', 'Permit Issued', etc.
  est_date          TIMESTAMPTZ,
  act_date          TIMESTAMPTZ,          -- actual completion date (NULL until completed)
  ghl_tag_fired     BOOLEAN DEFAULT FALSE,
  entered_by        TEXT,
  entered_on        TIMESTAMPTZ,
  last_changed_by   TEXT,
  last_changed_on   TIMESTAMPTZ,
  synced_at         TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_milestone_job_type ON lp_job_milestones(lp_job_id, mdt_id);
CREATE INDEX IF NOT EXISTS idx_milestone_lead_id ON lp_job_milestones(lp_lead_id);
CREATE INDEX IF NOT EXISTS idx_milestone_mdt     ON lp_job_milestones(mdt_id);
CREATE INDEX IF NOT EXISTS idx_milestone_act     ON lp_job_milestones(act_date);
CREATE INDEX IF NOT EXISTS idx_milestone_tag     ON lp_job_milestones(ghl_tag_fired);

-- =============================================================
-- 4. lp_call_logs
-- =============================================================
CREATE TABLE IF NOT EXISTS lp_call_logs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lp_call_id        TEXT UNIQUE NOT NULL,
  lp_lead_id        TEXT REFERENCES lp_leads(lp_lead_id),
  ghl_contact_id    TEXT,
  call_date         TIMESTAMPTZ,
  call_duration_sec INTEGER,
  call_result       TEXT,          -- answered | voicemail | no_answer | busy
  call_direction    TEXT,          -- inbound | outbound
  rep_id            TEXT,
  rep_name          TEXT,
  call_notes        TEXT,
  recording_url     TEXT,
  synced_at         TIMESTAMPTZ DEFAULT now(),
  raw_lp_data       JSONB
);

-- =============================================================
-- 5. lp_notes
-- =============================================================
CREATE TABLE IF NOT EXISTS lp_notes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lp_note_id          TEXT UNIQUE NOT NULL,
  lp_lead_id          TEXT REFERENCES lp_leads(lp_lead_id),
  ghl_contact_id      TEXT,
  note_body           TEXT,
  note_type           TEXT,
  created_by_rep_id   TEXT,
  created_by_rep_name TEXT,
  created_at_lp       TIMESTAMPTZ,
  synced_at           TIMESTAMPTZ DEFAULT now(),
  raw_lp_data         JSONB
);

-- =============================================================
-- 6. lp_activities
-- =============================================================
CREATE TABLE IF NOT EXISTS lp_activities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lp_activity_id  TEXT UNIQUE NOT NULL,
  lp_lead_id      TEXT REFERENCES lp_leads(lp_lead_id),
  activity_type   TEXT,
  activity_detail TEXT,
  rep_id          TEXT,
  rep_name        TEXT,
  activity_date   TIMESTAMPTZ,
  synced_at       TIMESTAMPTZ DEFAULT now(),
  raw_lp_data     JSONB
);

-- =============================================================
-- 7. lp_dispositions (Reference Table)
-- =============================================================
CREATE TABLE IF NOT EXISTS lp_dispositions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  disposition_code   TEXT UNIQUE NOT NULL,
  disposition_label  TEXT NOT NULL,
  category           TEXT,         -- active | closed_won | closed_lost | deferred | dead
  is_recoverable     BOOLEAN DEFAULT TRUE,
  reactivation_track TEXT,
  synced_at          TIMESTAMPTZ DEFAULT now()
);

-- =============================================================
-- 8. lp_sync_log (Operational Health — one row per entity per sync)
-- =============================================================
CREATE TABLE IF NOT EXISTS lp_sync_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type     TEXT NOT NULL,                  -- leads, calls, notes, jobs, milestones, activities, dispositions, sources, ghl_backfill
  sync_type       TEXT NOT NULL DEFAULT 'full',   -- full, incremental, webhook_*
  status          TEXT NOT NULL DEFAULT 'running', -- running, completed, failed
  records_synced  INTEGER DEFAULT 0,
  error_message   TEXT,
  started_at      TIMESTAMPTZ DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sync_log_entity ON lp_sync_log(entity_type);
CREATE INDEX IF NOT EXISTS idx_sync_log_status ON lp_sync_log(status);

-- =============================================================
-- 9. lp_source_mapping (sourcesubdescr/source → GHL intent bucket)
-- =============================================================
CREATE TABLE IF NOT EXISTS lp_source_mapping (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lp_source_subdetail TEXT,                  -- LP sourcesubdescr value (PRIMARY lookup key)
  lp_source_raw       TEXT,                  -- LP source value (FALLBACK when subdetail is empty)
  ghl_intent_bucket   TEXT NOT NULL,          -- risk-report | estimate-calculator | chatbot | canvassing | referral | other
  ghl_entry_tag       TEXT NOT NULL,          -- entry:risk-report | entry:estimate-calculator | etc
  ghl_bridge_wf_id    TEXT,                  -- W0.x workflow ID this bucket routes to
  notes               TEXT,
  confidence          TEXT DEFAULT 'high',    -- high | medium | low | manual-review
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_src_map_subdetail ON lp_source_mapping(lp_source_subdetail)
  WHERE lp_source_subdetail IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_src_map_raw ON lp_source_mapping(lp_source_raw)
  WHERE lp_source_subdetail IS NULL;
CREATE INDEX IF NOT EXISTS idx_src_map_bucket ON lp_source_mapping(ghl_intent_bucket);

-- =============================================================
-- Supplemental: lp_trigger_log (GHL trigger audit trail)
-- =============================================================
CREATE TABLE IF NOT EXISTS lp_trigger_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lp_lead_id      TEXT,
  ghl_contact_id  TEXT,
  event           TEXT NOT NULL,
  tag_fired       TEXT,
  status          TEXT DEFAULT 'success',  -- success | failed
  error_detail    TEXT,
  fired_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trigger_log_lead ON lp_trigger_log(lp_lead_id);
CREATE INDEX IF NOT EXISTS idx_trigger_log_event ON lp_trigger_log(event);

-- =============================================================
-- Supplemental: lp_unmapped_sources (weekly review queue)
-- =============================================================
CREATE TABLE IF NOT EXISTS lp_unmapped_sources (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_subdetail    TEXT,
  source_raw          TEXT,
  sample_lp_lead_id   TEXT,
  lead_count          INTEGER DEFAULT 1,
  first_seen          TIMESTAMPTZ DEFAULT now(),
  reviewed            BOOLEAN DEFAULT FALSE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_unmapped_src ON lp_unmapped_sources(source_subdetail, source_raw);
