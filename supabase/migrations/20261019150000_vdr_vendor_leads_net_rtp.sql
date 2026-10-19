-- 20261019150000_vdr_vendor_leads_net_rtp.sql
--
-- WHAT: vdr_vendor_leads(vendor_id, as_of) returns five more columns for each SOLD lead, read from the lead's
--       deciding LP job: job_status, cancelled_amount, financing_denied_amount, rtp_date, rtp_amount. The vendor
--       XLSX (src/vdr/report-xlsx.js) turns them into Net Sales (gross - cancelled - financing denied), RTP and
--       Pending RTP (net - RTP) for every vendor.
-- WHY: the user, 2026-10-19: "would it be possible to include net sales? Net = gross sales - cancelled sales -
--      Financing Denied", RTP "for all vendors and not just the Rev Share ones", and rev-share vendors must see
--      that RTP is the amount we pay out on. Rulings the same day: Cancelled = job status Cancelled, Cancelled By
--      Mgt or Dead Deal; Financing Denied = Credit Decline.
--      - Every amount is the lead's own sale amount (lp_leads.job_value, the Gross Sale Amount already on the
--        report), so Net never exceeds Gross and the columns add up on one basis.
--      - Status: lp_jobs.job_status (the live job sync), else the latest lp_job_status_history row (133).
--      - RTP: the latest lp_job_milestones RTP act_date (stored at midnight UTC: compare act_date::date). A job
--        released and later cancelled counts as cancelled, not RTP (none on 2026-10-19).
--      Measured 2026-10-19 over the active vendors' 90-day windows: every sold lead has one lp_jobs row; Socius
--      $2.17M gross, $288k cancelled, $17k denied, $1.28M RTP; MyHomePros $805k / $117k / $68k / $459k.
--      vdr_vendor_report adds 'rev_share' so the workbook can label RTP as the rev-share payout basis.
-- NOT: no change to vdr_vendor_config, vdr_send_log, vdr_payable_jobs, vdr_rev_share_data() or any LP row. The
--      rev-share Payable Jobs list still pays on the 133 job amount by RTP week.
-- destructive: approved by r.lymych 2026-10-19 (drop + re-create of vdr_vendor_leads: its output columns change)
-- ROLLBACK: drop function vdr_vendor_leads(bigint, timestamptz), then re-apply both functions from
--           20261015170000_vdr_vendor_leads_live.sql.

drop function if exists public.vdr_vendor_leads(bigint, timestamptz);

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
  lp_status             text,
  job_status            text,
  cancelled_amount      numeric,
  financing_denied_amount numeric,
  rtp_date              date,
  rtp_amount            numeric
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
  ),
  -- The deciding job of each SOLD lead: placeholder twins dropped (status New, no RTP, the same value as another
  -- job of the lead that is not New: dropShadowJobs in src/p2-opportunity-context.js), then the newest job that is
  -- not lost, else the newest. Status from the live job sync, else the latest 133 Jobs By Status row.
  jb as (
    select j.lp_lead_id, j.lp_job_id, j.job_value,
           coalesce(nullif(btrim(j.job_status), ''),
                    (select h.status_raw from public.lp_job_status_history h
                      where h.job_id::text = j.lp_job_id order by h.id desc limit 1)) as status,
           (select max(m.act_date::date) from public.lp_job_milestones m
             where m.lp_job_id::text = j.lp_job_id and m.datetype = 'RTP' and m.act_date is not null) as rtp_date
      from public.lp_jobs j
     where j.lp_lead_id in (select l.lp_lead_id from l where l.closed_won)
  ),
  jd as (
    select distinct on (a.lp_lead_id) a.lp_lead_id, a.status, a.rtp_date,
           a.status in ('Cancelled', 'Cancelled By Mgt', 'Dead Deal') as cancelled,   -- the user, 2026-10-19
           a.status = 'Credit Decline'                                as denied
      from jb a
     where not (coalesce(a.status, '') = 'New' and a.rtp_date is null
                and exists (select 1 from jb b where b.lp_lead_id = a.lp_lead_id and b.lp_job_id <> a.lp_job_id
                               and b.job_value = a.job_value and coalesce(b.status, '') <> 'New'))
     order by a.lp_lead_id,
              (a.status in ('Cancelled', 'Cancelled By Mgt', 'Dead Deal', 'Credit Decline')),
              nullif(regexp_replace(a.lp_job_id, '[^0-9]', '', 'g'), '')::bigint desc nulls last
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
    coalesce(d.disposition_label, coalesce(nullif(l.raw_lp_data->>'disposition', ''), l.disposition_code)),
    case when l.closed_won then jd.status end,
    case when l.closed_won and jd.cancelled then l.job_value end,
    case when l.closed_won and jd.denied then l.job_value end,
    case when l.closed_won then jd.rtp_date end,
    case when l.closed_won and jd.rtp_date is not null and not coalesce(jd.cancelled or jd.denied, false)
         then l.job_value end
  from l
  left join public.lp_dispositions d
    on d.disposition_code = coalesce(nullif(l.raw_lp_data->>'disposition', ''), l.disposition_code)
  left join f on f.lp_lead_id = l.lp_lead_id
  left join jd on jd.lp_lead_id = l.lp_lead_id
  order by l.entry_wall desc, l.lp_prospect_id;
$$;

-- The same document as before plus 'rev_share' (the RTP tile reads "RTP (your payout basis)" for those vendors).
create or replace function public.vdr_vendor_report(p_vendor_id bigint, p_as_of timestamptz default now())
returns jsonb
language sql
stable
set search_path = public
as $$
  with cfg as (
    select c.id, c.vendor_name, c.lp_sub_sources, c.lookback_days, c.rev_share,
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
      'rev_share', coalesce(cfg.rev_share, false),
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

revoke all on function public.vdr_vendor_leads(bigint, timestamptz) from public, anon, authenticated;
grant execute on function public.vdr_vendor_leads(bigint, timestamptz) to service_role;
revoke all on function public.vdr_vendor_report(bigint, timestamptz) from public, anon, authenticated;
grant execute on function public.vdr_vendor_report(bigint, timestamptz) to service_role;

notify pgrst, 'reload schema';
