-- 20261022180000_partner_rfed_batch.sql
--
-- WHAT: partner_rfed_batch, one row per 1-Leg lead Mark handed to a partner branch (Build 2, 2026-10-22): the original
--       LP lead, its prospect, and the Source / Sub-Source (srs_id) / Promoter (pro_id) the NEW RFED lead must carry.
--       scripts/rfed-1leg-batch.js writes the approved rows (--record) and fills rfed_lp_lead_id + checked_at (--verify)
--       once LP holds the new lead. src/partners/rfed-integrity.js reads it as "the lead it came from".
-- WHY: Mark's ruling 2026-10-22: an RFED lead copies Source, Sub-Source AND Promoter from the original lead, canvass
--      included; lp_leads keeps no link from a new lead back to the one it came from.
-- NOT: nothing here writes LP, GHL or Five9. The LP lead itself is created in LP (LP support / a person): LP's API only
--      reaches the inbound queue and picks the branch from the zip.
-- ROLLBACK: drop table public.partner_rfed_batch (rfed-integrity.js falls back to inference when it is missing).

create table if not exists public.partner_rfed_batch (
  id bigserial primary key,
  origin_lp_lead_id text not null,
  lp_prospect_id text,
  ghl_contact_id text,
  partner_branch text not null default 'RFED',
  product text not null default 'Roof',
  source text,
  sub_source text,
  srs_id text,
  promoter text,
  pro_id text,
  status text not null default 'approved',
  batch_no integer,
  rfed_lp_lead_id text,
  checked_at timestamptz,
  detail jsonb,
  created_at timestamptz not null default now(),
  constraint partner_rfed_batch_status_chk check (status in ('approved', 'sent_to_lp', 'created', 'verified', 'failed', 'skipped'))
);

create unique index if not exists partner_rfed_batch_origin_key on public.partner_rfed_batch (origin_lp_lead_id);
create index if not exists partner_rfed_batch_prospect_idx on public.partner_rfed_batch (lp_prospect_id);
create index if not exists partner_rfed_batch_rfed_lead_idx on public.partner_rfed_batch (rfed_lp_lead_id);

alter table public.partner_rfed_batch enable row level security;

comment on table public.partner_rfed_batch is 'One-Leg leads handed to a partner branch, and the attribution the new lead must copy (2026-10-22). Written by scripts/rfed-1leg-batch.js.';

notify pgrst, 'reload schema';
