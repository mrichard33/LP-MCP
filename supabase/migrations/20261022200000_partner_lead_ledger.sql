-- 20261022200000_partner_lead_ledger.sql
--
-- WHAT: partner_lead_ledger, one row per lead handed to an outside partner (Ross Erstling / RFED): the partner,
--       the GHL contact, the partner-branch LP lead, the lead it came from, its Source / Sub-Source / Promoter, how it
--       was assigned (lp_sync | batch | ghl_or_manual), when we first and last saw it partner-owned, and when it went
--       back to Reece. v_partner_lead_metrics joins each row to the lead's LP result (disposition, appointment, sale) and
--       its jobs (count, value) so the partner metrics can be run at any time.
-- WHY: Mark, 2026-10-22: "keep track of every lead we assign to Ross ... I need to be able to run the metrics in the
--      future." partner_owner_assignments holds only the contacts LP-MCP itself assigned, and partner_owner_log only
--      decisions; neither sees an owner GHL or a person set. The partner Five9 sweep reads every partner-owned contact
--      live every 30 minutes and writes this ledger (src/partners/lead-ledger.js).
-- NOT: nothing here writes LP, GHL or Five9. Read-only for everything but the sweep.
-- ROLLBACK: drop view public.v_partner_lead_metrics; drop table public.partner_lead_ledger.

create table if not exists public.partner_lead_ledger (
  id bigserial primary key,
  partner_name text,
  ghl_user_id text not null,
  ghl_contact_id text not null,
  lead_key text not null default '',
  lp_lead_id text,
  lp_prospect_id text,
  partner_branch text,
  lead_branch text,
  origin_lp_lead_id text,
  origin_branch text,
  source text,
  sub_source text,
  promoter text,
  assigned_how text not null default 'ghl_or_manual',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  returned_at timestamptz,
  detail jsonb,
  constraint partner_lead_ledger_how_chk check (assigned_how in ('lp_sync', 'batch', 'ghl_or_manual'))
);

create unique index if not exists partner_lead_ledger_key
  on public.partner_lead_ledger (ghl_user_id, ghl_contact_id, lead_key);
create index if not exists partner_lead_ledger_contact_idx on public.partner_lead_ledger (ghl_contact_id);
create index if not exists partner_lead_ledger_lead_idx on public.partner_lead_ledger (lp_lead_id);

alter table public.partner_lead_ledger enable row level security;

comment on table public.partner_lead_ledger is 'Every lead handed to an outside partner (Ross / RFED), however it was assigned (2026-10-22). Written by src/partners/lead-ledger.js.';

create or replace view public.v_partner_lead_metrics as
select
  g.id, g.partner_name, g.ghl_user_id, g.ghl_contact_id, g.lp_prospect_id, g.lp_lead_id, g.lead_branch,
  g.partner_branch, g.origin_lp_lead_id, g.origin_branch, g.source, g.sub_source, g.promoter, g.assigned_how,
  g.first_seen_at, g.last_seen_at, g.returned_at,
  (g.first_seen_at at time zone 'America/New_York')::date as assigned_date_et,
  l.disposition_code as lead_disposition,
  l.appointment_date as lead_appointment_date,
  coalesce(l.closed_won, false) as lead_closed_won,
  l.rep_name as lead_rep,
  l.created_at_lp as lead_created_at_lp,
  l.updated_at_lp as lead_updated_at_lp,
  j.job_count,
  j.job_value_total,
  j.job_statuses
from public.partner_lead_ledger g
left join public.lp_leads l on l.lp_lead_id = g.lp_lead_id
left join lateral (
  select count(*)::int as job_count, sum(coalesce(x.job_value, 0)) as job_value_total,
         string_agg(distinct x.job_status, ', ') as job_statuses
  from public.lp_jobs x where g.lp_lead_id is not null and x.lp_lead_id = g.lp_lead_id
) j on true;

comment on view public.v_partner_lead_metrics is 'partner_lead_ledger joined to each lead''s LP disposition, appointment, sale and jobs (2026-10-22).';

notify pgrst, 'reload schema';
