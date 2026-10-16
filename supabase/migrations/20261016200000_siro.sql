-- Siro integration (2026-10-16, Siro PR 1).
-- applied by hand first: the user asked for the Siro tables before deploy (every statement is idempotent; db push re-runs it on merge) 2026-10-16
--
-- One row per Siro recording of an in-home demo, matched to the LP lead.
-- Stored: summary, entity extractions and normalized moments. Never the
-- transcript (utterances) unless SIRO_STORE_UTTERANCES=true. Siro text is
-- customer-authored and untrusted: it is data for the bot, never instructions.
-- The reply path reads these rows (Supabase), never Siro live.
-- AIOS: CANON.K.051 (stored memory, not live calls), K.072 (claims for
-- idempotent side effects: event_emitted_at, ghl_note_action_id).

create table if not exists public.siro_recordings (
  recording_id            text primary key,
  siro_user_id            text,
  siro_team_id            text,
  rep_email               text,
  rep_name                text,
  conversation_type       text,
  recorded_at             timestamptz,
  updated_at_siro         timestamptz,
  deleted                 boolean not null default false,
  result                  text,              -- closed | not closed | in progress
  duration_sec            integer,
  summary                 jsonb,             -- [{id,name,content}]
  entity_extractions      jsonb,             -- raw
  moments                 jsonb,             -- normalized, ci-moments shape
  followup_score          smallint,
  followup_status         text,
  followup_action         text,
  crm                     jsonb,
  engagement_external_id  text,
  opportunity_external_id text,
  account_external_id     text,
  customer_phone          text,              -- 10 digits
  lp_lead_id              text,
  lp_prospect_id          text,
  ghl_contact_id          text,
  match_method            text,              -- engagement | account | opportunity | phone | none
  processed               boolean not null default false,
  linked                  boolean not null default false,
  source                  text not null,     -- webhook | poll | ensure
  event_emitted_at        timestamptz,
  ghl_note_action_id      bigint,            -- §6 claim, once per recording
  raw                     jsonb,
  ingested_at             timestamptz not null default now(),
  context_ready           boolean generated always as (processed and lp_lead_id is not null) stored
);
create index if not exists siro_recordings_lead_idx     on public.siro_recordings (lp_lead_id, recorded_at desc);
create index if not exists siro_recordings_prospect_idx on public.siro_recordings (lp_prospect_id, recorded_at desc);
create index if not exists siro_recordings_contact_idx  on public.siro_recordings (ghl_contact_id, recorded_at desc);
create index if not exists siro_recordings_updated_idx  on public.siro_recordings (updated_at_siro);

create table if not exists public.siro_webhook_events (
  svix_id        text primary key,
  recording_id   text not null,
  event_type     text not null,
  processed_flag boolean,
  linked_flag    boolean,
  received_at    timestamptz not null default now(),
  handled        boolean not null default false,
  error          text
);
create index if not exists siro_webhook_events_recording_idx on public.siro_webhook_events (recording_id);

create table if not exists public.siro_rep_scorecards (
  siro_user_id         text not null,
  rep_email            text,
  period_start         date not null,
  period_end           date not null,
  instance_id          text not null,
  metrics              jsonb not null,
  spotlights           jsonb,
  recordings_evaluated integer,
  pulled_at            timestamptz not null default now(),
  primary key (siro_user_id, instance_id, period_start, period_end)
);

create table if not exists public.siro_sync_state (
  key        text primary key,
  value      text,
  updated_at timestamptz default now()
);

alter table public.agentic_messages add column if not exists siro_recording_id text;
create index if not exists agentic_messages_siro_idx on public.agentic_messages (siro_recording_id);

create or replace view public.v_siro_rehash_priority as
select r.recording_id, r.lp_lead_id, r.lp_prospect_id, r.ghl_contact_id, r.rep_name,
       r.recorded_at, r.result, r.followup_score, r.followup_status, r.followup_action,
       extract(day from now() - r.recorded_at)::int as days_since_demo, l.disposition_code
from public.siro_recordings r
left join public.lp_leads l on l.lp_lead_id = r.lp_lead_id
where r.processed and not r.deleted and coalesce(l.disposition_code, '') <> 'Sale'
order by r.followup_score desc nulls last, r.recorded_at desc;

-- F.0 v2 measurement: one row per generated touch joins agentic_messages to the recording.
create or replace view public.v_f0_v2_touches as
select m.generation_id, m.ghl_contact_id, m.prompt_code, m.send_status, m.suppressed_reason,
       m.generated_at, m.siro_recording_id, r.result, r.followup_score, r.rep_name
from public.agentic_messages m
left join public.siro_recordings r on r.recording_id = m.siro_recording_id
where m.prompt_code like 'F.0-%';

alter table public.siro_recordings enable row level security;
alter table public.siro_webhook_events enable row level security;
alter table public.siro_rep_scorecards enable row level security;
alter table public.siro_sync_state enable row level security;
revoke all on public.siro_recordings, public.siro_webhook_events,
  public.siro_rep_scorecards, public.siro_sync_state from anon, authenticated;
revoke all on public.v_siro_rehash_priority, public.v_f0_v2_touches from anon, authenticated;
