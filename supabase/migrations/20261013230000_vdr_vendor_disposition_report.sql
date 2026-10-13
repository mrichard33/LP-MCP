-- 20261013230000_vdr_vendor_disposition_report.sql
--
-- WHAT: the whole schema of the weekly Vendor Disposition Report (n8n "06 VDR", frlZu30c88H5bnkZ, owned by
--       mrichard33/n8n, source of truth sql/vdr_vendor_disposition_report.sql in that repo, same text):
--       vdr_vendor_config, vdr_send_log, vdr_touch_updated_at() + trigger, vdr_due_vendors(), the vendor
--       seed, and the rev-share additions of the same day (vdr_vendor_config.rev_share, the vdr_payable_jobs
--       ledger, vdr_rev_share_data()).
-- WHY: LeadPilot and Contractor Appointment Rev Share are paid per job released to production, so their
--      weekly report needs a second "Payable Jobs" CSV and a ledger so no job is listed twice. Every LP-project
--      schema change goes through this folder (sql/README.md rule 5); the first VDR tables (n8n commit
--      4557f0a, 2026-10-13 16:48 ET) and the rev-share block were both applied by hand through the LP MCP
--      on 2026-10-13 with no migration, which the Ledger check then reported as drift. This file is that
--      migration, and it is recorded as APPLIED in supabase_migrations.schema_migrations (the same way the
--      baseline dump is), so `db push` never re-runs it; every statement is idempotent anyway.
-- NOT: no change to lp_job_milestones / lp_job_status_history / lp_jobs / lp_leads (read-only here), and
--      nothing destructive.
-- ROLLBACK: deactivate the n8n workflow first; then drop function public.vdr_rev_share_data(),
--           drop function public.vdr_due_vendors(), drop table public.vdr_payable_jobs,
--           drop table public.vdr_send_log, drop table public.vdr_vendor_config (the trigger goes with it),
--           drop function public.vdr_touch_updated_at(). Nothing else reads these objects.

-- Weekly Vendor Disposition Report (VDR). LP Supabase (rcjcgjlqzepicbwhnnjl). Mark, 2026-10-13.
-- Used by n8n "06 VDR Weekly Vendor Disposition Report" (frlZu30c88H5bnkZ).
--   every hour -> POST /rest/v1/rpc/vdr_due_vendors   (who is due right now)
--   after send -> POST /rest/v1/vdr_send_log          (one row per vendor per attempt)
-- To add / pause / remove a vendor: edit vdr_vendor_config. No workflow change needed.

create table if not exists public.vdr_vendor_config (
  id bigserial primary key,
  vendor_name text not null unique,
  lp_sub_sources text[] not null,                 -- LP SourceSubDescr values that belong to this vendor
  recipients_to text[] not null default '{}',
  recipients_cc text[] not null default '{}',
  send_dow int not null default 1 check (send_dow between 1 and 7),   -- 1=Mon ... 7=Sun
  send_time time not null default '09:00',
  timezone text not null default 'America/New_York',
  lookback_days int not null default 90 check (lookback_days between 1 and 365),
  is_active boolean not null default true,        -- false = no report (sources still count as "mapped")
  dry_run boolean not null default true,          -- true = report goes to Mark only
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.vdr_send_log (
  id bigserial primary key,
  vendor_id bigint references public.vdr_vendor_config(id) on delete set null,
  vendor_name text not null,
  week_start date not null,
  scheduled_for timestamptz,
  attempted_at timestamptz not null default now(),
  dry_run boolean not null,
  status text not null check (status in ('sent','failed','blocked','empty')),
  lead_count int,
  recipients text,
  out_file text,
  reason text,
  source_file text,
  source_row_count int,
  feed_received_at timestamptz,
  n8n_execution_id text
);
create index if not exists vdr_send_log_vendor_week_idx on public.vdr_send_log (vendor_id, week_start);
-- Duplicate guard: one successful send per vendor per week (dry run and live counted separately).
create unique index if not exists vdr_send_log_one_send_per_week
  on public.vdr_send_log (vendor_id, week_start, dry_run) where status = 'sent';

create or replace function public.vdr_touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists vdr_vendor_config_touch on public.vdr_vendor_config;
create trigger vdr_vendor_config_touch before update on public.vdr_vendor_config
  for each row execute function public.vdr_touch_updated_at();

-- Who is due right now. A vendor is due once its send slot this week has passed and it has
-- no 'sent'/'empty' row this week. Blocked/failed attempts retry hourly, max 3 per week.
create or replace function public.vdr_due_vendors()
returns jsonb language sql stable as $$
  with v as (
    select c.*,
           (now() at time zone c.timezone) as local_now,
           date_trunc('week', now() at time zone c.timezone)::date as week_start
    from public.vdr_vendor_config c
    where c.is_active
  ), s as (
    select v.*, (v.week_start + (v.send_dow - 1) + v.send_time) as slot_local from v
  )
  select jsonb_build_object(
    'due', coalesce((
      select jsonb_agg(jsonb_build_object(
        'vendor_id', s.id, 'vendor_name', s.vendor_name, 'lp_sub_sources', s.lp_sub_sources,
        'recipients_to', s.recipients_to, 'recipients_cc', s.recipients_cc,
        'dry_run', s.dry_run, 'lookback_days', s.lookback_days, 'week_start', s.week_start,
        'scheduled_for', (s.slot_local at time zone s.timezone)) order by s.vendor_name)
      from s
      where s.local_now >= s.slot_local
        and not exists (select 1 from public.vdr_send_log l
                        where l.vendor_id = s.id and l.week_start = s.week_start
                          and l.dry_run = s.dry_run and l.status in ('sent','empty'))
        and (select count(*) from public.vdr_send_log l
             where l.vendor_id = s.id and l.week_start = s.week_start and l.dry_run = s.dry_run) < 3
    ), '[]'::jsonb),
    -- every sub-source assigned to ANY vendor row (active or not) -> used for the unmapped-source check
    'mapped_sub_sources', coalesce((
      select jsonb_agg(distinct x) from public.vdr_vendor_config c, unnest(c.lp_sub_sources) x
    ), '[]'::jsonb),
    -- last successful feed size -> used for the "file much smaller than usual" check
    'prev_source_rows', (
      select l.source_row_count from public.vdr_send_log l
      where l.status = 'sent' and l.source_row_count is not null
      order by l.attempted_at desc limit 1
    )
  );
$$;

alter table public.vdr_vendor_config enable row level security;
alter table public.vdr_send_log enable row level security;
revoke all on table public.vdr_vendor_config, public.vdr_send_log from anon, authenticated;
grant all on table public.vdr_vendor_config, public.vdr_send_log to service_role;
grant usage, select on sequence public.vdr_vendor_config_id_seq, public.vdr_send_log_id_seq to service_role;
revoke all on function public.vdr_due_vendors() from public, anon, authenticated;
grant execute on function public.vdr_due_vendors() to service_role;

-- Seed. All reporting vendors start in dry run (reports go to Mark only) with no recipients.
-- Inactive rows send nothing; they exist so their sub-sources are not flagged as unmapped.
insert into public.vdr_vendor_config (vendor_name, lp_sub_sources, is_active, notes) values
  ('Modernize', '{Modernize}', true, null),
  ('HomeBuddy', '{HomeBuddy}', true, null),
  ('Lead Gurus', '{"Lead Gurus"}', true, null),
  ('MyHomePros', '{MyHomePros}', true, null),
  ('Swish Leads', '{"Swish Leads"}', true, null),
  ('Prolific Marketing', '{"Prolific Marketing"}', true, null),
  ('Taste of Latino', '{"Taste of Latino"}', true, null),
  ('MVP Marketing', '{"MVP Marketing"}', true, null),
  ('Socius Marketing', '{"Socius Marketing","Google PPC PMAX","Google PPC Windows","Google PPC Roofs"}', true, 'Socius runs Google PPC + SEO. All Google PPC sub-sources assigned to Socius by Mark 2026-10-13'),
  ('Contractor Appointment Rev Share', '{"Contractor Appointment Rev Share"}', true, 'Confirmed as a vendor by Mark 2026-10-13'),
  ('Bing PPC', '{"Bing PPC"}', false, 'Ad platform, no report'),
  ('Canvass', '{Canvass,"Canvass Sticky"}', false, 'Internal, no report'),
  ('Previous Customer / Referral', '{"Previous Customer","Customer Referral"}', false, 'Internal, no report')
on conflict (vendor_name) do nothing;

notify pgrst, 'reload schema';

-- ===== Rev share: Payable Jobs (RTP) — 2026-10-13 =====
-- Rev-share vendors (LeadPilot, Contractor Appointment Rev Share) are paid per job RELEASED TO PRODUCTION,
-- not per lead. Each week they also get a "Payable Jobs" CSV: every job from their LP sub-sources whose
-- RTP date fell in the PRIOR Sunday..Saturday pay period. vdr_payable_jobs is the ledger that keeps a job
-- from ever being listed as payable twice (dry run and live are separate ledgers, like vdr_send_log).
--
-- JOIN PATH (verified 2026-10-13, 119/119 RTP jobs 09-27..10-10 matched):
--   lp_job_milestones.lp_job_id::text = lp_job_status_history.job_id::text  (latest row per job = max id)
--   -> lp_job_status_history.lp_id   = the 135 Lead Disposition Detail 2 lead id
--   -> lp_job_status_history.sub_source = the vendor attribution
-- lp_job_milestones.lp_lead_id is LP-MCP's own lead id space (e.g. 574903), NOT the 135 id (e.g. 462203).
-- It is used ONLY as a fallback through lp_jobs -> lp_leads.lead_source_detail to attribute an RTP job that
-- 133 Jobs By Status has not reported yet (the user, 2026-10-13: an unrelated unmatched job must not block
-- a rev-share vendor; one that is theirs, or cannot be attributed at all, does).
-- lp_job_milestones.act_date is stored at midnight UTC: compare act_date::date, never "at time zone".

alter table public.vdr_vendor_config add column if not exists rev_share boolean not null default false;

insert into public.vdr_vendor_config (vendor_name, lp_sub_sources, is_active, rev_share, notes)
values ('LeadPilot', '{LeadPilot,LeadPilotData}', true, true, 'Rev share. Both LP sub-sources per Mark 2026-10-13')
on conflict (vendor_name) do nothing;
update public.vdr_vendor_config set rev_share = true where vendor_name = 'Contractor Appointment Rev Share';

create table if not exists public.vdr_payable_jobs (
  id bigserial primary key,
  vendor_id bigint references public.vdr_vendor_config(id) on delete set null,
  vendor_name text not null,
  lp_job_id text not null,
  lp_lead_id text,                       -- the 135 lead id (job_status_history.lp_id)
  sub_source text,
  rtp_date date not null,
  period_start date not null,
  period_end date not null,
  gross_cents bigint,
  job_status text,
  dry_run boolean not null,
  listed_at timestamptz not null default now(),
  n8n_execution_id text
);
-- A job is payable once per vendor (dry run and live counted separately).
create unique index if not exists vdr_payable_jobs_once on public.vdr_payable_jobs (vendor_id, lp_job_id, dry_run);
alter table public.vdr_payable_jobs enable row level security;
revoke all on table public.vdr_payable_jobs from anon, authenticated;
grant all on table public.vdr_payable_jobs to service_role;
grant usage, select on sequence public.vdr_payable_jobs_id_seq to service_role;

-- vdr_due_vendors(): same as before, plus rev_share on each due vendor.
create or replace function public.vdr_due_vendors()
returns jsonb language sql stable as $$
  with v as (
    select c.*,
           (now() at time zone c.timezone) as local_now,
           date_trunc('week', now() at time zone c.timezone)::date as week_start
    from public.vdr_vendor_config c
    where c.is_active
  ), s as (
    select v.*, (v.week_start + (v.send_dow - 1) + v.send_time) as slot_local from v
  )
  select jsonb_build_object(
    'due', coalesce((
      select jsonb_agg(jsonb_build_object(
        'vendor_id', s.id, 'vendor_name', s.vendor_name, 'lp_sub_sources', s.lp_sub_sources,
        'recipients_to', s.recipients_to, 'recipients_cc', s.recipients_cc,
        'dry_run', s.dry_run, 'rev_share', s.rev_share, 'lookback_days', s.lookback_days, 'week_start', s.week_start,
        'scheduled_for', (s.slot_local at time zone s.timezone)) order by s.vendor_name)
      from s
      where s.local_now >= s.slot_local
        and not exists (select 1 from public.vdr_send_log l
                        where l.vendor_id = s.id and l.week_start = s.week_start
                          and l.dry_run = s.dry_run and l.status in ('sent','empty'))
        and (select count(*) from public.vdr_send_log l
             where l.vendor_id = s.id and l.week_start = s.week_start and l.dry_run = s.dry_run) < 3
    ), '[]'::jsonb),
    'mapped_sub_sources', coalesce((
      select jsonb_agg(distinct x) from public.vdr_vendor_config c, unnest(c.lp_sub_sources) x
    ), '[]'::jsonb),
    'prev_source_rows', (
      select l.source_row_count from public.vdr_send_log l
      where l.status = 'sent' and l.source_row_count is not null
      order by l.attempted_at desc limit 1
    )
  );
$$;

-- vdr_rev_share_data(): for every ACTIVE rev-share vendor, the prior Sun..Sat pay period, the payable jobs
-- in it, every RTP of the vendor's jobs (all time, for the Job # / RTP Date columns on the lead CSV), and
-- the health facts the workflow fails closed on.
create or replace function public.vdr_rev_share_data()
returns jsonb language sql stable as $$
  with v as (
    select c.id, c.vendor_name, c.lp_sub_sources, c.dry_run, c.timezone,
           array(select lower(trim(x)) from unnest(c.lp_sub_sources) x) as subs_norm,
           ((now() at time zone c.timezone)::date
             - (extract(dow from (now() at time zone c.timezone)::date)::int + 1)) as period_end
    from public.vdr_vendor_config c
    where c.is_active and c.rev_share
  ), vp as (
    select v.*, (v.period_end - 6) as period_start from v
  ), js as (
    -- latest 133 Jobs By Status row per job
    select distinct on (h.job_id) h.job_id::text as job_id, h.lp_id, h.sub_source,
           lower(trim(h.sub_source)) as sub_norm, h.customer_name, h.contract_date, h.gross_cents,
           h.status_raw, h.bucket
    from public.lp_job_status_history h
    where h.job_id is not null
    order by h.job_id, h.id desc
  ), rtp as (
    select m.lp_job_id::text as job_id, m.act_date::date as rtp_date
    from public.lp_job_milestones m
    where m.datetype = 'RTP' and m.act_date is not null and m.lp_job_id is not null
  ), unmatched as (
    -- RTP jobs 133 has not reported: attributed, if at all, through lp_jobs -> lp_leads
    select r.job_id, r.rtp_date, l.lead_source_detail as fallback_source,
           nullif(lower(trim(l.lead_source_detail)), '') as fallback_norm
    from rtp r
    left join js on js.job_id = r.job_id
    left join public.lp_jobs j on j.lp_job_id::text = r.job_id
    left join public.lp_leads l on l.lp_lead_id = j.lp_lead_id
    where js.job_id is null
  ), in_period as (
    select u.* from unmatched u
    where exists (select 1 from vp where u.rtp_date between vp.period_start and vp.period_end)
  )
  select jsonb_build_object(
    'vendors', coalesce((
      select jsonb_agg(jsonb_build_object(
        'vendor_id', vp.id, 'vendor_name', vp.vendor_name, 'rev_share', true, 'dry_run', vp.dry_run,
        'period_start', vp.period_start, 'period_end', vp.period_end,
        'payable', coalesce((
          select jsonb_agg(jsonb_build_object(
            'lp_job_id', js.job_id, 'lp_lead_id', js.lp_id, 'customer_name', js.customer_name,
            'sub_source', js.sub_source, 'contract_date', js.contract_date, 'rtp_date', r.rtp_date,
            'sale_amount', round(coalesce(js.gross_cents, 0) / 100.0, 2), 'gross_cents', js.gross_cents,
            'job_status', js.status_raw, 'bucket', js.bucket,
            'already_listed', exists (select 1 from public.vdr_payable_jobs p
                                      where p.vendor_id = vp.id and p.lp_job_id = js.job_id and p.dry_run = vp.dry_run)
          ) order by r.rtp_date, js.job_id)
          from rtp r join js on js.job_id = r.job_id
          where r.rtp_date between vp.period_start and vp.period_end
            and js.sub_norm = any (vp.subs_norm)
        ), '[]'::jsonb),
        'lead_rtp', coalesce((
          select jsonb_agg(jsonb_build_object('lp_lead_id', js.lp_id, 'lp_job_id', js.job_id, 'rtp_date', r.rtp_date)
                           order by r.rtp_date, js.job_id)
          from rtp r join js on js.job_id = r.job_id
          where js.sub_norm = any (vp.subs_norm)
        ), '[]'::jsonb),
        'rtp_unresolved_in_period', (
          select count(*) from in_period u
          where u.rtp_date between vp.period_start and vp.period_end and u.fallback_norm = any (vp.subs_norm))
      ) order by vp.vendor_name)
      from vp
    ), '[]'::jsonb),
    'milestones_last_sync', (select max(synced_at) from public.lp_job_milestones),
    'jobstatus_last_contract', (select max(contract_date) from public.lp_job_status_history),
    'rtp_unmatched_in_period', (select count(*) from in_period),
    'rtp_unattributed_in_period', (select count(*) from in_period u where u.fallback_norm is null),
    'rtp_unmatched_detail', coalesce((
      select jsonb_agg(jsonb_build_object('lp_job_id', u.job_id, 'rtp_date', u.rtp_date, 'fallback_source', u.fallback_source)
                       order by u.rtp_date, u.job_id)
      from in_period u
    ), '[]'::jsonb)
  );
$$;
revoke all on function public.vdr_rev_share_data() from public, anon, authenticated;
grant execute on function public.vdr_rev_share_data() to service_role;

notify pgrst, 'reload schema';
