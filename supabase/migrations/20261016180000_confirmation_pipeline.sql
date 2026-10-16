-- 20261016180000_confirmation_pipeline.sql
--
-- WHAT: confirmation_opportunities (one row per LP appointment's card in GHL "4. Confirmation Pipeline",
--       ThrBNpyzJhAON4WFC855) and confirmation_opportunity_log (one row per decision, dry run included).
-- WHY: 2026-10-16 handoff "4. Confirmation Pipeline". LP MCP owns every move on that pipeline (no GHL workflow
--      triggers on it). The handler is src/actions/handlers/confirmation-pipeline-sync.js, the clock and the
--      daily sweep are src/jobs/confirmation-pipeline-clock.js / -sweep.js.
--      Beyond the handoff's columns:
--        last_lp_change_at / last_manual_move_at  "an LP move applies only if the LP change is newer than the
--                                                 manual move" needs both times.
--        contact_name / card_name                 a rename on reschedule needs no GHL contact read.
--        dry_run                                  a row written while CONF_PIPE_DRY_RUN=true has no real card
--                                                 behind it; the first live run treats it as no stored state.
--      GHL allows one card per contact per pipeline, so a returning homeowner's NEW lead re-points the
--      contact's existing row (the user, 2026-10-16): lp_lead_id is updated in place, the log keeps the old one.
-- NOT: no customer phone or email. Names only, the same text the GHL card shows.
-- ROLLBACK: remove the CONF_PIPE_* rules (agent_rules) and the two jobs stop finding work. Additive; leave the tables.

create table if not exists public.confirmation_opportunities (
  id                  bigserial   primary key,
  lp_lead_id          text        not null unique,
  ghl_contact_id      text        not null,
  ghl_opportunity_id  text,
  stage_key           text        not null check (stage_key in ('new', 'issue', 'confirm_now', 'confirmed', 'disqualified')),
  last_lp_disposition text,
  last_moved_by       text        not null check (last_moved_by in ('agent', 'manual')),
  appointment_at      timestamptz,
  alerted_at          timestamptz,
  closed_status       text        check (closed_status in ('won', 'lost', 'abandoned')),
  closed_at           timestamptz,
  last_lp_change_at   timestamptz,
  last_manual_move_at timestamptz,
  contact_name        text,
  card_name           text,
  dry_run             boolean     not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists confirmation_opportunities_opp_uidx
  on public.confirmation_opportunities (ghl_opportunity_id) where ghl_opportunity_id is not null;
create index if not exists confirmation_opportunities_contact_idx
  on public.confirmation_opportunities (ghl_contact_id);
create index if not exists confirmation_opportunities_open_idx
  on public.confirmation_opportunities (appointment_at) where closed_status is null;

create table if not exists public.confirmation_opportunity_log (
  id                 bigserial   primary key,
  lp_lead_id         text,
  ghl_opportunity_id text,
  from_stage         text,
  to_stage           text,
  action             text,
  source             text,
  lp_disposition     text,
  dry_run            boolean,
  note               text,
  created_at         timestamptz not null default now()
);

create index if not exists confirmation_opportunity_log_lead_idx
  on public.confirmation_opportunity_log (lp_lead_id, created_at desc);
create index if not exists confirmation_opportunity_log_created_idx
  on public.confirmation_opportunity_log (created_at desc);

alter table public.confirmation_opportunities enable row level security;
alter table public.confirmation_opportunity_log enable row level security;
revoke all on public.confirmation_opportunities from anon, authenticated;
revoke all on public.confirmation_opportunity_log from anon, authenticated;
