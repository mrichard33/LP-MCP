-- 20261022120000_partner_five9_removals.sql
--
-- WHAT: partner_five9_removals, one row per Five9 decision for a partner-owned contact (src/partners/five9-removal.js):
--       action 'remove' (the numbers come off every Reece outbound list; mode log = recorded only, enforce = queued as
--       five9_delete_record_from_list rows, group_key ties them together) or 'release' (the lead went back to the Reece
--       team: stop re-removing). detail.five9 holds the read-back once the enforce rows ran (removed_from, errors).
--       The unique index is the once-per-day claim: LP's own Five9 export refills the lists at 6 AM ET, so a removal is
--       repeated once per "removal day" (ET date of now - 6h20m), per mode.
-- WHY: handoff 2026-10-22 (Build 1). Ross Erstling's 1 Leg leads stayed on "Data - Hot - ORL less than 7" and DIAL ASAP
--      after GHL handed them to Ross, and the Reece floor kept dialing them. A separate table, not partner_owner_log,
--      because widening that table's reason CHECK is a destructive change that needs Mark's approval marker.
-- NOT: nothing here writes to Five9, LP or GHL; no Five9 DNC is used (it collides with the DNC Lift process).
-- ROLLBACK: PARTNER_FIVE9_REMOVAL_MODE=off (behaviour), then drop table public.partner_five9_removals (nothing else reads it).

create table if not exists public.partner_five9_removals (
  id bigserial primary key,
  ghl_contact_id text not null,
  ghl_user_id text,
  partner_name text,
  action text not null,
  mode text not null,
  trigger text,
  removal_day date,
  phones text[],
  lists text[],
  group_key text,
  lp_lead_id text,
  detail jsonb,
  created_at timestamptz not null default now(),
  constraint partner_five9_removals_action_chk check (action in ('remove', 'release')),
  constraint partner_five9_removals_mode_chk check (mode in ('log', 'enforce'))
);

create unique index if not exists partner_five9_removals_day_key
  on public.partner_five9_removals (ghl_contact_id, mode, removal_day) where action = 'remove';
create index if not exists partner_five9_removals_contact_idx
  on public.partner_five9_removals (ghl_contact_id, created_at desc);

alter table public.partner_five9_removals enable row level security;

comment on table public.partner_five9_removals is 'Partner-owned contacts off the Reece Five9 lists (2026-10-22). Written by src/partners/five9-removal.js.';

notify pgrst, 'reload schema';
