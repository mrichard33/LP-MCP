-- 20261020200000_partner_owner_sync.sql
--
-- WHAT: three tables for the partner lead ownership sync (src/partners/):
--       partner_owner_map    which LP branch (and optionally LP rep) belongs to which outside sales partner's GHL user;
--       partner_owner_log    one row per ownership decision (assigned | reassigned | returned | noop | skipped_pre_golive
--                            | no_ghl_contact | failed), the record the status route, the memo and the lag figure read;
--       partner_owner_cursor the fast poll's LP "changed since" cursor.
--       Seeds partner #1: Ross Erstling, branch RFED, any rep, GHL user TxbMrITSVyTJtJvGD9vk (the user, 2026-10-20).
-- WHY: Mark, 2026-10-19: a NEW LP lead in branch RFED must be owned in GHL (contact + every open opportunity) by the
--      partner within ~2 minutes, and go back to the Reece team user when it leaves the branch. GHL's "Only Assigned
--      Data" permission keys on the OWNER, so the partner must be the owner, never a follower.
--      lp_rep_name NULL = the whole branch; a row with lp_rep_name set overrides it for that rep. NULLS NOT DISTINCT so
--      a branch cannot carry two branch-only rows.
-- NOT: no backfill of older RFED leads (314 since 2022); nothing here writes to LP or touches messaging.
-- ROLLBACK: PARTNER_SYNC_ENABLED=false (behaviour), then drop the three tables (nothing else reads them).

create table if not exists public.partner_owner_map (
  id uuid primary key default gen_random_uuid(),
  partner_name text not null,
  lp_branch_id text not null,
  lp_rep_name text,
  ghl_user_id text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint partner_owner_map_branch_rep_key unique nulls not distinct (lp_branch_id, lp_rep_name)
);

create table if not exists public.partner_owner_log (
  id bigserial primary key,
  lp_lead_id text,
  ghl_contact_id text,
  from_owner text,
  to_owner text,
  planned_target text,
  reason text not null,
  partner_name text,
  lp_branch_id text,
  rep_name text,
  lp_changed_at timestamptz,
  detail jsonb,
  error text,
  created_at timestamptz not null default now(),
  constraint partner_owner_log_reason_chk check (reason in
    ('assigned', 'reassigned', 'returned', 'noop', 'skipped_pre_golive', 'no_ghl_contact', 'failed'))
);

create index if not exists partner_owner_log_lead_idx on public.partner_owner_log (lp_lead_id, created_at desc);
create index if not exists partner_owner_log_created_idx on public.partner_owner_log (created_at desc);

create table if not exists public.partner_owner_cursor (
  id text primary key,
  last_changed_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.partner_owner_map enable row level security;
alter table public.partner_owner_log enable row level security;
alter table public.partner_owner_cursor enable row level security;

comment on table public.partner_owner_map is 'Partner lead ownership (2026-10-20): LP branch [+ rep] -> partner GHL user. Read by src/partners/owner-resolver.js.';
comment on table public.partner_owner_log is 'Partner lead ownership decisions, one row each. Written by src/partners/owner-sync.js.';

insert into public.partner_owner_map (partner_name, lp_branch_id, lp_rep_name, ghl_user_id, active)
values ('Ross Erstling', 'RFED', null, 'TxbMrITSVyTJtJvGD9vk', true)
on conflict on constraint partner_owner_map_branch_rep_key do nothing;

notify pgrst, 'reload schema';
