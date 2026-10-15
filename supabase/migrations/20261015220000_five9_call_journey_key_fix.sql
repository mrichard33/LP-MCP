-- 20261015220000_five9_call_journey_key_fix.sql
--
-- WHAT: v_lead_call_journey groups a lead by its LPRecKey only when that key is a real LP id (LDS<n> / INQ<n>);
--       anything else falls back to the customer phone.
-- WHY: the first 7-day backfill (2026-10-15) showed one "lead" with 499 dials and 356 in 24 hours: LPRecKey "INQ-1",
--      a placeholder Five9 carries on the "Data -Old more than 180" records, shared by 499 different phones. Grouped by
--      that key, the 3-in-24 audit counted every one of those people as a single over-cap lead. It is the only shape
--      seen (23,180 INQ<n> legs, 1,405 LDS<n>, 2,655 null, 499 INQ-1).
-- NOT: no change to five9_call_journey or its rows; the view's columns are unchanged, so CREATE OR REPLACE applies.

create or replace view public.v_lead_call_journey as
with keyed as (
  select j.*,
         case when j.lp_rec_key ~ '^(LDS|INQ)[1-9][0-9]*$' then j.lp_rec_key else j.customer_phone end as journey_key
    from public.five9_call_journey j
)
select k.*,
       row_number() over w_order as attempt_seq,
       count(*) filter (where k.call_type in ('Outbound', 'Preview', 'Manual')) over (
         partition by k.journey_key
         order by k.call_ts
         range between interval '24 hours' preceding and current row) as calls_last_24h
  from keyed k
window w_order as (partition by k.journey_key order by k.call_ts, k.id);

revoke all on public.v_lead_call_journey from anon, authenticated;
