-- 20261015170000_vdr_vendor_leads_live.sql
--
-- WHAT: vdr_vendor_leads(vendor_id, as_of): one row per lead a vendor sent in its lookback window, read LIVE from
--       lp_leads + lp_lead_market_assignments + five9_events_raw; vdr_vendor_report(vendor_id, as_of): the same rows
--       as one jsonb document (no PostgREST row cap) plus the window, the lead-sync time and the optional 135 cross-
--       check. No index is added: one pass over five9_events_raw joined to the vendor's phones (~7s for 5,400
--       leads) beat per-lead index lookups (24-47s: every hit was a random read of a 984 MB table).
-- WHY: Vendor Lead Report v2 handoff, 2026-10-15. The n8n "06 VDR" workflow never delivered: every vdr_send_log row
--      since 2026-10-13 is blocked/no_feed_email, because every send depended on the LP report 135 Lead Disposition
--      Detail 2 email. Sends now read live data; 135 is a cross-check only, never a blocker. The XLSX is built by
--      LP-MCP's GET /vdr/report.xlsx (src/vdr/) from vdr_vendor_report.
--      - WINDOW: a lead counts when its LP entry DATE (created_at_lp holds Eastern wall-clock time labelled UTC) is
--        between the as_of Eastern date minus lookback_days and the as_of Eastern date, both whole days. That is what
--        reproduces the approved prototype (Modernize, as_of 2026-10-15T15:00Z, 90 days: 5,367 leads, 308 set,
--        169 issued, 121 demos, 41 sold, $926,569 gross, 64 Outside Service Area; HomeBuddy 995). A timestamp cut at
--        exactly as_of - 90 days gives 5,338.
--      - CALLS: Five9 is the only source (never lp_leads.call_count). A lead's phone (last 10 digits) matches
--        five9_events_raw.ani OR .dnis; a call counts from 10 minutes before the lead's real entry time
--        (created_at_lp read as America/New_York, i.e. +4h in EDT, +5h in EST) to as_of, one per call_id.
--      - "Contacted" = any of the person-reached Five9 dispositions listed in CONTACTED below.
--      - Issue date = appointment_date when ever_issued (LP has no issue timestamp).
--      - Repeat prospect = the prospect appears more than once in THIS vendor's window.
--      - No LP lead id, rep, setter or confirmer name is returned.
--      Applied by hand through the LP MCP on 2026-10-15 and recorded as APPLIED in
--      supabase_migrations.schema_migrations, so `db push` never re-runs it; every statement is idempotent.
-- NOT: no change to vdr_vendor_config, vdr_send_log, vdr_payable_jobs, vdr_feed_*, vdr_due_vendors(),
--      vdr_rev_share_data(), or any LP/Five9 row.
-- ROLLBACK: drop function vdr_vendor_report(bigint, timestamptz), vdr_vendor_leads(bigint, timestamptz).

-- ===== Vendor Lead Report v2: live vendor leads — 2026-10-15 =====

create or replace function public.vdr_vendor_leads(p_vendor_id bigint, p_as_of timestamptz default now())
returns table (
  prospect_id           text,
  repeat_prospect       boolean,
  sub_source            text,
  market_code           text,
  market                text,
  entry_at              timestamp,      -- Eastern wall clock
  entry_week            date,           -- Monday of the entry week
  first_name            text,
  last_name             text,
  phone                 text,           -- 10 digits
  email                 text,
  city                  text,
  zip                   text,
  five9_dials           integer,
  minutes_to_first_dial numeric,
  last_call_result      text,
  contacted             boolean,
  appt_set_at           timestamp,
  appt_at               timestamp,
  days_set_to_appt      numeric,
  confirmed_at          timestamp,
  is_set                boolean,
  is_confirmed          boolean,
  issue_date            date,
  is_issued             boolean,
  is_net_issued         boolean,
  is_demo               boolean,
  is_sold               boolean,
  gross_sale            numeric,
  lp_status             text
)
language sql
stable
set search_path = public
as $$
  with cfg as (
    select c.lp_sub_sources, c.lookback_days,
           (p_as_of at time zone 'America/New_York')::date - c.lookback_days as start_date,
           (p_as_of at time zone 'America/New_York')::date                   as end_date
      from public.vdr_vendor_config c
     where c.id = p_vendor_id
  ),
  l as (
    select l.*,
           (l.created_at_lp at time zone 'UTC')                                         as entry_wall,
           ((l.created_at_lp at time zone 'UTC') at time zone 'America/New_York')       as entry_real,
           right(regexp_replace(coalesce(l.phone, ''), '[^0-9]', '', 'g'), 10)          as ph10,
           coalesce(a.resolved_market_code, l.lp_branch_id, 'UNASSIGNED')              as mkt
      from public.lp_leads l
      join cfg on l.lead_source_detail = any(cfg.lp_sub_sources)
      left join public.lp_lead_market_assignments a on a.lead_id = l.lp_lead_id
     where l.lp_deleted_at is null
       and (l.created_at_lp at time zone 'UTC')::date between cfg.start_date and cfg.end_date
  ),
  phones as (
    select distinct l.ph10 from l where length(l.ph10) = 10
  ),
  -- One pass over Five9: every event whose ani OR dnis (last 10 digits) is one of this vendor's lead phones.
  ev as materialized (
    select e.id, e.call_id, e.call_start_at, e.disposition_name, x.ph10
      from public.five9_events_raw e
     cross join lateral (values
             (right(regexp_replace(coalesce(e.ani, ''),  '[^0-9]', '', 'g'), 10)),
             (right(regexp_replace(coalesce(e.dnis, ''), '[^0-9]', '', 'g'), 10))) x(ph10)
     where e.call_start_at >= (select min(l.entry_real) from l) - interval '10 minutes'
       and e.call_start_at <= p_as_of
       and x.ph10 in (select phones.ph10 from phones)
  ),
  f as (
    select l.lp_lead_id,
           count(distinct coalesce(ev.call_id, ev.id::text))                          as dials,
           min(ev.call_start_at)                                                       as first_call,
           (array_agg(ev.disposition_name order by ev.call_start_at desc, ev.id desc))[1] as last_result,
           bool_or(ev.disposition_name = any (array[
             'Not Interested', 'Appointment Set', 'Confirmed', 'Callback', 'Cant Do Project', 'Bought Competition',
             'Spanish - Send data to Spanish list', 'Below Minimum', 'Renter - mobile home', 'Verified',
             'Do Not Call', 'DNC', 'Out of Area', 'Service Call', 'Reset', 'Construction', 'Insurance Claim',
             'Duplicate', 'Canvass Confirmed']))                                      as contacted   -- CONTACTED
      from l
      join ev on ev.ph10 = l.ph10 and ev.call_start_at >= l.entry_real - interval '10 minutes'
     group by l.lp_lead_id
  )
  select
    l.lp_prospect_id,
    count(*) over (partition by l.lp_prospect_id) > 1,
    l.lead_source_detail,
    l.mkt,
    case
      when l.mkt in ('ORL_MKT', 'ORL', 'LAKE')        then 'Orlando'
      when l.mkt in ('STPET_MKT', 'STPET')            then 'St. Petersburg'
      when l.mkt in ('JAX_MKT', 'JAX')                then 'Jacksonville'
      when l.mkt in ('FTLAU_MKT', 'FTLAU', 'BOCA')    then 'Fort Lauderdale'
      when l.mkt in ('FTMYR_MKT', 'FTMYR')            then 'Fort Myers'
      when l.mkt in ('SAR_MKT', 'SAR')                then 'Sarasota'
      else 'Outside Service Area'
    end,
    l.entry_wall,
    date_trunc('week', l.entry_wall)::date,
    l.first_name,
    l.last_name,
    nullif(l.ph10, ''),
    l.email,
    initcap(nullif(btrim(l.city), '')),
    nullif(btrim(l.zip), ''),
    coalesce(f.dials, 0)::integer,
    case when f.first_call is null then null
         else round(greatest(extract(epoch from (f.first_call - l.entry_real)) / 60.0, 0)::numeric, 1) end,
    f.last_result,
    coalesce(f.contacted, false),
    (l.set_date at time zone 'UTC'),
    (l.appointment_date at time zone 'UTC'),
    case when l.set_date is not null and l.appointment_date is not null
         then round((extract(epoch from (l.appointment_date - l.set_date)) / 86400.0)::numeric, 1) end,
    (l.confirmed_date at time zone 'UTC'),
    coalesce(l.ever_set, false),
    coalesce(l.ever_confirmed, false),
    case when l.ever_issued then (l.appointment_date at time zone 'UTC')::date end,
    coalesce(l.ever_issued, false),
    coalesce(l.ever_net_issued, false),
    coalesce(l.demo_completed, false),
    coalesce(l.closed_won, false),
    case when l.closed_won then l.job_value end,
    coalesce(d.disposition_label, coalesce(nullif(l.raw_lp_data->>'disposition', ''), l.disposition_code))
  from l
  left join public.lp_dispositions d
    on d.disposition_code = coalesce(nullif(l.raw_lp_data->>'disposition', ''), l.disposition_code)
  left join f on f.lp_lead_id = l.lp_lead_id
  order by l.entry_wall desc, l.lp_prospect_id;
$$;

-- The same rows as ONE jsonb document for GET /vdr/report.xlsx (a set-returning RPC is capped by PostgREST's
-- max rows), with the window, the lead-sync time (the n8n freshness gate) and the 135 cross-check: the newest
-- COMPLETE saved 135 feed (vdr_feed_runs) received in the 36 hours before as_of, counted over this vendor's
-- sub-sources and window. The cross-check never blocks a send; n8n lists a gap over 2% in Mark's summary.
create or replace function public.vdr_vendor_report(p_vendor_id bigint, p_as_of timestamptz default now())
returns jsonb
language sql
stable
set search_path = public
as $$
  with cfg as (
    select c.id, c.vendor_name, c.lp_sub_sources, c.lookback_days,
           (p_as_of at time zone 'America/New_York')::date - c.lookback_days as start_date,
           (p_as_of at time zone 'America/New_York')::date                   as end_date
      from public.vdr_vendor_config c
     where c.id = p_vendor_id
  ),
  feed as (
    select r.id, r.received_at
      from public.vdr_feed_runs r
     where r.complete
       and r.received_at > p_as_of - interval '36 hours'
       and r.received_at <= p_as_of
     order by r.received_at desc, r.id desc
     limit 1
  )
  select case when not exists (select 1 from cfg) then jsonb_build_object('found', false) else (
    select jsonb_build_object(
      'found', true,
      'vendor_id', cfg.id,
      'vendor_name', cfg.vendor_name,
      'lp_sub_sources', to_jsonb(cfg.lp_sub_sources),
      'lookback_days', cfg.lookback_days,
      'start_date', cfg.start_date,
      'end_date', cfg.end_date,
      'as_of', p_as_of,
      'lead_synced_at', (select max(synced_at) from public.lp_leads),
      'feed_check', (
        select jsonb_build_object(
          'run_id', feed.id, 'received_at', feed.received_at,
          'leads', (select count(distinct fl.lead_id) from public.vdr_feed_leads fl
                     where fl.last_run_id = feed.id
                       and fl.sub_source = any(cfg.lp_sub_sources)
                       and fl.entry_date >= cfg.start_date and fl.entry_date <= cfg.end_date))
          from feed),
      'rows', coalesce((select jsonb_agg(to_jsonb(v)) from public.vdr_vendor_leads(p_vendor_id, p_as_of) v), '[]'::jsonb))
    from cfg) end;
$$;

revoke all on function public.vdr_vendor_leads(bigint, timestamptz)  from public, anon, authenticated;
revoke all on function public.vdr_vendor_report(bigint, timestamptz) from public, anon, authenticated;
grant execute on function public.vdr_vendor_leads(bigint, timestamptz)  to service_role;
grant execute on function public.vdr_vendor_report(bigint, timestamptz) to service_role;

notify pgrst, 'reload schema';
