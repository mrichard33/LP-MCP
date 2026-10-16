-- 20261016120000_five9_call_journey_cap_et.sql
--
-- WHAT: v_lead_call_journey counts only DIALER calls toward the 3-calls-in-24h cap and tracks manual calls apart;
--       every leg gets its Eastern wall-clock time; v_call_journey_cap_daily rolls the cap up per Eastern day.
-- WHY: the user, 2026-10-16: "Count dialer calls only but I want to track the number of violations caused by manual
--      calls", and Eastern time everywhere. The first 7 days showed 106 dialer calls that were a 4th call inside 24h
--      (105 with 2+ campaigns on the lead: Data - Hot and After DIAL ASAP both open at a record age of 25 hours) and
--      395 manual calls that were a 4th+ call.
-- COLUMNS (existing ones keep their place; new ones are appended, which CREATE OR REPLACE allows):
--   calls_last_24h            dialer calls (Outbound, Preview) in the 24h up to and including this row. WAS dialer + Manual.
--   all_calls_last_24h        Outbound + Preview + Manual in the same window.
--   call_ts_et / call_date_et Eastern wall clock (America/New_York, daylight saving aware).
--   cap_violation             'dialer' on a dialer row whose calls_last_24h > 3; 'manual' on a Manual row whose
--                             all_calls_last_24h > 3; otherwise null.
--   other_campaign_within_4h  a dialer row whose previous dialer call on the lead came from a DIFFERENT campaign less
--                             than 4 hours before (two campaigns working the lead at once).
--   prev_dialer_campaign      that previous dialer call's campaign (null on the lead's first dialer call).
-- v_call_journey_cap_daily: `clashes` leaves out DIAL ASAP -> After DIAL ASAP, the designed 3-hour hand-off (587 of the
-- 7-day pairs); `hot_after_clashes` is only Data - Hot and After DIAL ASAP following each other, either way round.
-- NOT: no change to five9_call_journey or its rows.

create or replace view public.v_lead_call_journey as
with keyed as (
  select j.*,
         case when j.lp_rec_key ~ '^(LDS|INQ)[1-9][0-9]*$' then j.lp_rec_key else j.customer_phone end as journey_key,
         (j.call_type in ('Outbound', 'Preview')) as is_dialer
    from public.five9_call_journey j
), counted as (
  select k.*,
         row_number() over w_order as attempt_seq,
         count(*) filter (where k.is_dialer) over w_24h as calls_last_24h,
         count(*) filter (where k.is_dialer or k.call_type = 'Manual') over w_24h as all_calls_last_24h,
         -- dialer and non-dialer rows sit in separate partitions here, so on a dialer row lag() is the previous DIALER call
         lag(k.campaign) over w_kind as prev_kind_campaign,
         lag(k.call_ts) over w_kind as prev_kind_ts
    from keyed k
  window w_order as (partition by k.journey_key order by k.call_ts, k.id),
         w_24h as (partition by k.journey_key order by k.call_ts
                   range between interval '24 hours' preceding and current row),
         w_kind as (partition by k.journey_key, k.is_dialer order by k.call_ts, k.id)
)
select c.id, c.leg_key, c.call_ts, c.call_id, c.call_type, c.campaign, c.list_name, c.skill, c.disposition,
       c.agent_name, c.agent_name_clean, c.team, c.ani, c.dnis, c.customer_phone, c.lp_rec_key, c.lp_lead_id,
       c.attempts, c.raw, c.pulled_at,
       c.journey_key, c.attempt_seq, c.calls_last_24h,
       c.all_calls_last_24h,
       (c.call_ts at time zone 'America/New_York') as call_ts_et,
       (c.call_ts at time zone 'America/New_York')::date as call_date_et,
       case
         when c.is_dialer and c.calls_last_24h > 3 then 'dialer'
         when c.call_type = 'Manual' and c.all_calls_last_24h > 3 then 'manual'
       end as cap_violation,
       coalesce(c.is_dialer
                and c.prev_kind_campaign is distinct from c.campaign
                and c.prev_kind_ts > c.call_ts - interval '4 hours', false) as other_campaign_within_4h,
       case when c.is_dialer then c.prev_kind_campaign end as prev_dialer_campaign
  from counted c;

-- One row per Eastern day: the cap and the cross-campaign clashes.
create or replace view public.v_call_journey_cap_daily as
with v as (
  select call_date_et, journey_key, campaign, cap_violation, prev_dialer_campaign,
         (other_campaign_within_4h
          and not (prev_dialer_campaign = 'DIAL ASAP' and campaign = 'After DIAL ASAP')) as clash
    from public.v_lead_call_journey
), manual as (
  select call_date_et, jsonb_object_agg(coalesce(campaign, '(none)'), n) as manual_by_campaign
    from (select call_date_et, campaign, count(*) as n from v where cap_violation = 'manual' group by 1, 2) m
   group by 1
)
select d.call_date_et,
       count(*) filter (where d.cap_violation = 'dialer') as dialer_violations,
       count(*) filter (where d.cap_violation = 'manual') as manual_violations,
       count(distinct d.journey_key) filter (where d.cap_violation = 'dialer') as leads_over_cap,
       count(*) filter (where d.clash) as clashes,
       count(*) filter (where d.clash
                          and d.campaign in ('Data - Hot Leads less than 7', 'After DIAL ASAP')
                          and d.prev_dialer_campaign in ('Data - Hot Leads less than 7', 'After DIAL ASAP')) as hot_after_clashes,
       coalesce(max(m.manual_by_campaign::text)::jsonb, '{}'::jsonb) as manual_by_campaign
  from v d
  left join manual m on m.call_date_et = d.call_date_et
 group by d.call_date_et;

revoke all on public.v_lead_call_journey, public.v_call_journey_cap_daily from anon, authenticated;
