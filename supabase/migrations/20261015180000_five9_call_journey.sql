-- 20261015180000_five9_call_journey.sql
--
-- WHAT: five9_call_journey (one row per call LEG from the saved Five9 report "Shared Reports / Call Journey"),
--       five9_call_journey_runs (one row per pull), the service-role upsert function five9_call_journey_upsert(rows),
--       and the view v_lead_call_journey (each lead's dials in order, with a trailing-24h dial count).
-- WHY: the user, 2026-10-15 (Call Journey handoff). five9_events_raw is a webhook mirror and misses most unanswered
--      and busy dials: 69 calls for 13:00-13:16 UTC against 150 in the report. A dial-by-dial history per lead
--      (campaign, list, skill, disposition, agent) is the basis for auditing the 3-calls-in-24h cap. Read-only
--      against Five9; the CI "Call Log" pipeline (ci_calls, src/ci/*) is a different report and is untouched.
--      The pull is src/jobs/five9-call-journey-sync.js; the row rules are src/five9/call-journey.js.
-- KEY: one CALL ID can carry several legs (3rd party transfer / conference), so a leg is
--      call_id | call_ts | call_type | dnis. Postgres never treats NULLs as equal, so a UNIQUE over those four
--      columns would let a leg with no DNIS duplicate on every overlapping pull; leg_key (built in code from the
--      same four parts, '' for a null) carries the uniqueness instead.
-- NOT: no change to five9_events_raw, ci_calls, or any LP table.
-- ROLLBACK: drop the view, the function, then the two tables.  -- destructive: only after a ruling

create table if not exists public.five9_call_journey (
  id               bigserial primary key,
  leg_key          text        not null unique,
  call_ts          timestamptz not null,
  call_id          text        not null,
  call_type        text,
  campaign         text,
  list_name        text,
  skill            text,
  disposition      text,
  agent_name       text,
  agent_name_clean text,
  team             text,
  ani              text,
  dnis             text,
  customer_phone   text,
  lp_rec_key       text,
  lp_lead_id       text,
  attempts         int,
  raw              jsonb       not null,
  pulled_at        timestamptz not null default now()
);
create index if not exists five9_call_journey_rec_key_ts_idx  on public.five9_call_journey (lp_rec_key, call_ts);
create index if not exists five9_call_journey_phone_ts_idx    on public.five9_call_journey (customer_phone, call_ts);
create index if not exists five9_call_journey_ts_idx          on public.five9_call_journey (call_ts);
create index if not exists five9_call_journey_campaign_ts_idx on public.five9_call_journey (campaign, call_ts);

create table if not exists public.five9_call_journey_runs (
  id             bigserial primary key,
  window_start   timestamptz not null,
  window_end     timestamptz not null,
  mode           text        not null,             -- shadow | live | backfill
  status         text        not null,             -- running | ok | failed | timeout
  rows_returned  int,
  rows_upserted  int,                              -- new rows inserted
  rows_updated   int,                              -- existing legs whose raw row changed
  rows_unchanged int,                              -- existing legs, identical (the overlap)
  rows_rejected  int,
  reject_reasons jsonb       not null default '{}',
  error          text,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz
);
create index if not exists five9_call_journey_runs_ok_end_idx
  on public.five9_call_journey_runs (window_end desc) where status = 'ok';

-- Upsert a batch of legs (a jsonb array of five9_call_journey rows without id / pulled_at). A leg already stored
-- with the same raw row is left alone; a changed raw row is replaced. Returns the three counts for the run log.
create or replace function public.five9_call_journey_upsert(p_rows jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_total    int := coalesce(jsonb_array_length(p_rows), 0);
  v_inserted int := 0;
  v_updated  int := 0;
begin
  with incoming as (
    select *
      from jsonb_to_recordset(p_rows) as r(
        leg_key text, call_ts timestamptz, call_id text, call_type text, campaign text, list_name text, skill text,
        disposition text, agent_name text, agent_name_clean text, team text, ani text, dnis text,
        customer_phone text, lp_rec_key text, lp_lead_id text, attempts int, raw jsonb)
  ), written as (
    insert into public.five9_call_journey as j (
      leg_key, call_ts, call_id, call_type, campaign, list_name, skill, disposition, agent_name, agent_name_clean,
      team, ani, dnis, customer_phone, lp_rec_key, lp_lead_id, attempts, raw)
    select leg_key, call_ts, call_id, call_type, campaign, list_name, skill, disposition, agent_name,
           agent_name_clean, team, ani, dnis, customer_phone, lp_rec_key, lp_lead_id, attempts, raw
      from incoming
    on conflict (leg_key) do update
       set call_type = excluded.call_type, campaign = excluded.campaign, list_name = excluded.list_name,
           skill = excluded.skill, disposition = excluded.disposition, agent_name = excluded.agent_name,
           agent_name_clean = excluded.agent_name_clean, team = excluded.team, ani = excluded.ani,
           customer_phone = excluded.customer_phone, lp_rec_key = excluded.lp_rec_key,
           lp_lead_id = excluded.lp_lead_id, attempts = excluded.attempts, raw = excluded.raw, pulled_at = now()
     where j.raw is distinct from excluded.raw
    returning (xmax = 0) as is_insert
  )
  select count(*) filter (where is_insert), count(*) filter (where not is_insert)
    into v_inserted, v_updated
    from written;
  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated,
                            'unchanged', greatest(v_total - v_inserted - v_updated, 0));
end;
$$;

-- Each lead's dials in order. The lead is its LPRecKey, else its phone. calls_last_24h counts the dials WE placed
-- (Outbound, Preview, Manual; not inbound calls or transfer legs) in the 24 hours up to and including that row:
-- the 3-calls-in-24h audit reads max(calls_last_24h) per lead.
create or replace view public.v_lead_call_journey as
select j.*,
       coalesce(j.lp_rec_key, j.customer_phone) as journey_key,
       row_number() over w_order as attempt_seq,
       count(*) filter (where j.call_type in ('Outbound', 'Preview', 'Manual')) over (
         partition by coalesce(j.lp_rec_key, j.customer_phone)
         order by j.call_ts
         range between interval '24 hours' preceding and current row) as calls_last_24h
  from public.five9_call_journey j
window w_order as (partition by coalesce(j.lp_rec_key, j.customer_phone) order by j.call_ts, j.id);

-- Service role only, like the health tables: the rows carry customer phone numbers.
alter table public.five9_call_journey      enable row level security;
alter table public.five9_call_journey_runs enable row level security;
revoke all on public.five9_call_journey, public.five9_call_journey_runs, public.v_lead_call_journey from anon, authenticated;
revoke all on sequence public.five9_call_journey_id_seq, public.five9_call_journey_runs_id_seq from anon, authenticated;
revoke all on function public.five9_call_journey_upsert(jsonb) from public, anon, authenticated;
grant execute on function public.five9_call_journey_upsert(jsonb) to service_role;
