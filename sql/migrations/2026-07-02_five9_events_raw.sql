-- ─── Five9 ESS Raw Event Capture ──────────────────────────────────
-- 2026-07-02_five9_events_raw.sql
--
-- Phase 1 ingestion substrate for the Five9 Event Subscription Service
-- (ESS) webhook receiver. The endpoint POST /webhook/five9-event
-- authenticates the request, writes the FULL raw body here (fast ack),
-- then normalizes asynchronously and emits system_events.
--
-- This table is the SOURCE OF TRUTH. Field extraction (event_type,
-- call_id, ani, dnis, disposition) is best-effort with null fallback —
-- we do NOT yet know Five9's exact payload schema, so the jsonb
-- `payload` column always carries the complete body regardless of
-- whether the scalar columns could be extracted.
--
-- Application logic: src/five9-events.js (handler + normalizer)
-- Silence watchdog:  src/five9-silence-watchdog.js
-- Registration:      src/rest-api.js (route), src/index.js (watchdog)

create table if not exists five9_events_raw (
  id bigint generated always as identity primary key,
  received_at timestamptz not null default now(),
  event_type text,                 -- extracted best-effort from payload
  call_id text,                    -- extracted best-effort (Five9 call/interaction id)
  ani text,                        -- caller phone if present
  dnis text,                       -- dialed number if present
  disposition text,                -- if present
  payload jsonb not null,          -- full raw body, always
  headers jsonb,                   -- request headers (secret header redacted)
  processed boolean not null default false,
  processed_at timestamptz,
  processing_error text,
  emitted_event_id bigint          -- FK-style pointer to system_events, nullable
);

-- Observability: newest-first raw feed (watchdog reads max(received_at)).
create index if not exists idx_five9_raw_received on five9_events_raw (received_at desc);

-- Reprocessing sweep target (a future phase): partial index over the
-- small set of rows that never emitted.
create index if not exists idx_five9_raw_unprocessed on five9_events_raw (processed) where processed = false;

-- Dedup guard + call-timeline lookups.
create index if not exists idx_five9_raw_call on five9_events_raw (call_id);

comment on table five9_events_raw is
  'Raw capture of Five9 ESS webhook deliveries (POST /webhook/five9-event). jsonb payload is source of truth; scalar columns are best-effort extractions. Written + normalized by src/five9-events.js.';
