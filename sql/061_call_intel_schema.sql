-- ============================================================================
-- 061 — Call Intelligence pipeline substrate (PR 1 of 6, 2026-08-19 handoff)
--
-- WHY: agents' post-call notes are incomplete/inaccurate and the Five9→LP
-- note transfer is unreliable; recordings are the only authoritative record
-- of the conversation. This subsystem generates CRM notes from recordings
-- with a full audit trail. Ships inert: CALL_INTEL_MODE=shadow, all write
-- flags false — nothing writes to any CRM until Mark flips flags after the
-- shadow gates pass.
--
-- WHAT THIS IS: the complete ci_* schema. ci_calls is the spine (one row per
-- Five9 call, compact status machine); recording bytes, transcript, AI
-- output, match decision, and per-CRM sync each live in their own table
-- keyed to the call. Per-CRM state lives ONLY in ci_syncs.status, so one CRM
-- failing can never block or falsely complete the other. Everything is
-- additive and ci_-prefixed.
--
-- WHAT THIS IS NOT: no existing table, view, route, or worker is modified.
-- Nothing here writes to system_events / agent_actions / agent_rules. The
-- pipeline code that populates these tables lands in PRs 2–6; until then the
-- schema is unreachable. Storage bucket creation is deliberately NOT here
-- (Storage is not SQL) — see scripts/setup-ci-audio-bucket.js.
--
-- Mirrored in runMigrations() (src/index.js) so a fresh deploy self-heals.
-- This file is the source of truth. DDL executes in the Supabase dashboard,
-- LP MCP instance, as TWO separate executions: everything below first, then
-- the CONCURRENTLY index under the RUN SEPARATELY banner at the bottom on
-- its own (it cannot run inside a transaction). See sql/README.md.
--
-- ROLLBACK: DROP VIEW v_ci_review_queue; DROP VIEW v_ci_pipeline_health;
-- then DROP TABLE in FK-child-first order: ci_qa_reviews, ci_events,
-- ci_syncs, ci_matches, ci_summaries, ci_transcripts, ci_recordings,
-- ci_calls; then the standalone maps: ci_agent_map, ci_campaign_map,
-- ci_transfer_target_map. Nothing else references any of these.
--
-- AFTER RUNNING: run scripts/setup-ci-audio-bucket.js (private bucket
-- 'ci-audio'), then scripts/seed-ci-maps.js (dry-run first; --execute only
-- after Mark confirms the proposed rows, including the exact live campaign
-- string matched for canvass_correlation).
-- ============================================================================

-- ─── ci_calls — the spine: one row per Five9 call ───────────────────────────
-- status is the only pipeline state machine; per-CRM state physically cannot
-- live here (it lives in ci_syncs), which is what guarantees CRM independence.

CREATE TABLE IF NOT EXISTS ci_calls (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  five9_call_id     text NOT NULL,
  five9_session_id  text,
  call_start        timestamptz NOT NULL,
  call_end          timestamptz,
  duration_seconds  integer,
  direction         text,                      -- inbound|outbound|internal per Five9
  ani               text,
  dnis              text,
  customer_phone    text,                      -- raw
  customer_phone_e164 text,                    -- normalized
  campaign          text,
  skill             text,
  disposition       text,
  agent_five9_id    text,
  agent_name        text,
  team              text NOT NULL DEFAULT 'unknown',  -- reece|lightfire|north_carolina|ftm|unknown
  was_transferred   boolean DEFAULT false,
  raw_metadata      jsonb,                     -- full call-log row(s), verbatim
  eligible          boolean NOT NULL DEFAULT true,
  ineligible_reason text,
  status            text NOT NULL DEFAULT 'discovered'
                    CHECK (status IN ('discovered','fetched','transcribed','analyzed',
                                      'matched','syncing','completed','skipped','review','failed')),
  status_detail     text,
  review_reason     text,
  attempts          integer NOT NULL DEFAULT 0,
  next_retry_at     timestamptz,
  locked_until      timestamptz,
  locked_by         text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (five9_call_id)
);

-- ─── per-stage artifact tables, each keyed to the call ──────────────────────

CREATE TABLE IF NOT EXISTS ci_recordings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id          uuid NOT NULL REFERENCES ci_calls(id),
  five9_recording_id text,
  source           text NOT NULL CHECK (source IN ('sftp','manual','five9_api')),
  source_filename  text,
  file_sha256      text,
  file_bytes       bigint,
  mime             text,
  channels         integer,                    -- 1 mono | 2 stereo (agent/customer split)
  storage_path     text,                       -- private bucket 'ci-audio'
  fetched_at       timestamptz DEFAULT now(),
  purged_at        timestamptz,
  UNIQUE (call_id, source_filename)
);

CREATE TABLE IF NOT EXISTS ci_transcripts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id            uuid NOT NULL UNIQUE REFERENCES ci_calls(id),
  engine             text NOT NULL,            -- 'openai'
  engine_model       text NOT NULL,
  language           text,
  diarization_method text NOT NULL CHECK (diarization_method IN ('stereo_channels','none')),
  transcript_text    text NOT NULL,
  segments           jsonb,                    -- [{speaker,start_s,end_s,text}]
  confidence         numeric,
  low_confidence     boolean NOT NULL DEFAULT false,
  audio_seconds      integer,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ci_summaries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id         uuid NOT NULL REFERENCES ci_calls(id),
  model           text NOT NULL,
  prompt_version  text NOT NULL,
  schema_version  text NOT NULL,
  output          jsonb NOT NULL,              -- validated against the §7 schema
  summary_text    text NOT NULL,
  outcome         text NOT NULL,
  outcome_confidence numeric NOT NULL,
  review_flags    text[] NOT NULL DEFAULT '{}',
  usage           jsonb,                       -- token counts for cost tracking
  is_current      boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ci_summaries_current_uq
  ON ci_summaries (call_id) WHERE is_current;

CREATE TABLE IF NOT EXISTS ci_matches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id      uuid NOT NULL UNIQUE REFERENCES ci_calls(id),
  lp_cst_id    integer,
  lp_lds_id    integer,
  ghl_contact_id text,
  method       text NOT NULL,                  -- e.g. 'phone_exact_single','list_carried_id'
  tier         text NOT NULL CHECK (tier IN ('exact','high','probable','ambiguous','none')),
  confidence   numeric,
  candidates   jsonb,                          -- all candidates considered, with evidence
  evidence     jsonb,
  decided_by   text NOT NULL DEFAULT 'auto' CHECK (decided_by IN ('auto','human')),
  decided_at   timestamptz NOT NULL DEFAULT now()
);

-- Idempotency is structural: the UNIQUE constraints below make a duplicate
-- write attempt a constraint violation, not a duplicate CRM note.
CREATE TABLE IF NOT EXISTS ci_syncs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id         uuid NOT NULL REFERENCES ci_calls(id),
  target          text NOT NULL CHECK (target IN ('lp','ghl')),
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','shadow','synced','failed','skipped')),
  idempotency_key text NOT NULL UNIQUE,        -- '{call_id}:{target}'
  note_body       text,                        -- exact body composed (shadow keeps it too)
  request         jsonb,
  response        jsonb,
  external_ref    text,
  error           text,
  attempts        integer NOT NULL DEFAULT 0,
  synced_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, target)
);

-- ─── mapping tables (seeded by scripts/seed-ci-maps.js from live sources) ───

CREATE TABLE IF NOT EXISTS ci_agent_map (
  agent_five9_id  text PRIMARY KEY,
  agent_name      text,
  lp_emp_id       integer,
  team            text NOT NULL DEFAULT 'reece',
  active          boolean NOT NULL DEFAULT true,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ci_campaign_map (
  campaign          text PRIMARY KEY,
  team              text,
  eligible          boolean NOT NULL DEFAULT true,
  excluded_dispositions text[] NOT NULL DEFAULT '{}',
  match_strategy    text NOT NULL DEFAULT 'phone',   -- 'phone' | 'canvass_correlation'
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ci_transfer_target_map (
  dnis        text PRIMARY KEY,               -- 10-digit transfer-leg destination
  team        text NOT NULL,                  -- e.g. 'lightfire'
  label       text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ─── audit + review ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ci_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  call_id    uuid REFERENCES ci_calls(id),
  stage      text NOT NULL,
  event      text NOT NULL,                    -- 'transition','error','retry','review','resolve'
  detail     jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ci_qa_reviews (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id       uuid NOT NULL REFERENCES ci_calls(id),
  reviewer      text NOT NULL,
  transcript_ok boolean, summary_ok boolean, outcome_ok boolean, match_ok boolean,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ─── views (Five9 report output stores as UTC; render ET) ───────────────────

CREATE OR REPLACE VIEW v_ci_pipeline_health AS
SELECT status, count(*) AS calls,
       min(call_start AT TIME ZONE 'America/New_York') AS oldest_et,
       max(call_start AT TIME ZONE 'America/New_York') AS newest_et
FROM ci_calls GROUP BY status;

CREATE OR REPLACE VIEW v_ci_review_queue AS
SELECT c.id, c.five9_call_id, c.call_start AT TIME ZONE 'America/New_York' AS call_et,
       c.agent_name, c.team, c.customer_phone_e164, c.disposition,
       c.review_reason, s.summary_text, s.outcome, m.tier, m.candidates
FROM ci_calls c
LEFT JOIN ci_summaries s ON s.call_id = c.id AND s.is_current
LEFT JOIN ci_matches   m ON m.call_id = c.id
WHERE c.status = 'review'
ORDER BY c.call_start;

-- ============================================================================
-- RUN SEPARATELY — its own execution, NOT inside a transaction, NEVER via
-- apply_migration (sql/README.md). The worker claim query orders on
-- (status, next_retry_at, call_start). runMigrations() mirrors this as a
-- plain CREATE INDEX IF NOT EXISTS, which is safe there because on any
-- deploy where the mirror creates the schema the table is empty; the
-- CONCURRENTLY form below is for applying to an already-populated table.
-- ============================================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS ci_calls_status_retry_idx
  ON ci_calls (status, next_retry_at, call_start);

-- ─── Verification ────────────────────────────────────────────────────────────
-- All 11 tables present:
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public' AND table_name LIKE 'ci\_%' ESCAPE '\'
--   ORDER BY table_name;
--   -- expect: ci_agent_map, ci_calls, ci_campaign_map, ci_events,
--   --         ci_matches, ci_qa_reviews, ci_recordings, ci_summaries,
--   --         ci_syncs, ci_transcripts, ci_transfer_target_map
-- Views exist and return 0 rows on a fresh install:
--   SELECT * FROM v_ci_pipeline_health;   -- 0 rows
--   SELECT * FROM v_ci_review_queue;      -- 0 rows
-- Structural idempotency in place:
--   SELECT conname FROM pg_constraint
--   WHERE conrelid IN ('ci_calls'::regclass, 'ci_syncs'::regclass)
--     AND contype = 'u';
--   -- expect uniques on five9_call_id, idempotency_key, (call_id, target)
-- Claim-path index present (after the RUN SEPARATELY execution):
--   SELECT indexname FROM pg_indexes WHERE tablename = 'ci_calls';
--   -- expect ci_calls_status_retry_idx
