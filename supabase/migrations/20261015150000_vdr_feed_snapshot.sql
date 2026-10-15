-- 20261015150000_vdr_feed_snapshot.sql
--
-- WHAT: vdr_feed_runs (one row per "Reece Vendor Disposition Feed" email) and vdr_feed_leads (ONE row per LP lead,
--       overwritten by each day's feed), plus three service-role functions the n8n "06 VDR" workflow calls:
--       vdr_store_feed_chunk(run, leads), vdr_finish_feed(message_id) and vdr_saved_feed().
-- WHY: the user, 2026-10-15. A manual run of 06 VDR found nothing to send from: the workflow only reads the CSV
--      attached to the email that starts the run (LP report 135 Lead Disposition Detail 2, last 90 days, ~24,000
--      rows), and nothing kept a copy. The user asked us to save each feed, "but I want to make sure that each day
--      when the last 90 days arrive we should be updating the pre existing values to match instead of add the
--      duplicates." So a lead is one row, keyed on the LP lead id, and each feed replaces its values. The row kept
--      per lead is the one the report builder would pick (a current row beats a Superseded one, then the newest
--      entry date, then the newest appointment, then the latest in the file); n8n picks it before it calls in.
--      A run is used only once every lead it carried is stored (`complete`), so a half-saved feed never reaches a
--      vendor. A re-sent OLDER email never overwrites a newer feed's values (the last_seen_at guard).
--      Leads that drop out of the 90 days keep their last values; a manual run reads only the newest run's leads.
--      Applied by hand through the LP MCP on 2026-10-15 and recorded as APPLIED in
--      supabase_migrations.schema_migrations, so `db push` never re-runs it; every statement is idempotent.
-- NOT: no change to vdr_vendor_config, vdr_send_log, vdr_payable_jobs, vdr_due_vendors(), vdr_rev_share_data(),
--      or any LP table (I.LPRC and lp_* are untouched).
-- ROLLBACK: drop the three functions, then the two tables (vdr_feed_leads first).  -- destructive: only after a ruling

-- ===== Saved copy of the daily 90-day feed — 2026-10-15 =====

create table if not exists public.vdr_feed_runs (
  id               bigserial primary key,
  gmail_message_id text        not null unique,
  received_at      timestamptz not null,
  source_file      text,
  header           text[]      not null default '{}',   -- the feed columns kept in vdr_feed_leads.row, in feed order
  raw_row_count    int         not null,                -- rows in the CSV (several per lead)
  lead_count       int         not null,                -- distinct leads the run carries
  window_start     date,
  complete         boolean     not null default false,
  saved_at         timestamptz not null default now(),
  completed_at     timestamptz
);
create index if not exists vdr_feed_runs_complete_received_idx
  on public.vdr_feed_runs (received_at desc) where complete;

create table if not exists public.vdr_feed_leads (
  lead_id       text        primary key,
  entry_date    date,
  sub_source    text,
  row           jsonb       not null,                   -- { "<feed column>": "<value>" } for vdr_feed_runs.header
  first_seen_at timestamptz not null,
  last_seen_at  timestamptz not null,                   -- received_at of the feed that last wrote this lead
  last_run_id   bigint      not null references public.vdr_feed_runs (id),
  updated_at    timestamptz not null default now()
);
create index if not exists vdr_feed_leads_last_run_idx on public.vdr_feed_leads (last_run_id);

alter table public.vdr_feed_runs  enable row level security;
alter table public.vdr_feed_leads enable row level security;
revoke all on public.vdr_feed_runs, public.vdr_feed_leads from anon, authenticated;
revoke all on sequence public.vdr_feed_runs_id_seq from anon, authenticated;

-- One chunk of a feed: the run (created on the first chunk, by Gmail message id) and up to a few thousand leads.
create or replace function public.vdr_store_feed_chunk(p_run jsonb, p_leads jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_run public.vdr_feed_runs;
  v_n   int;
begin
  if coalesce(p_run->>'gmail_message_id', '') = '' or coalesce(p_run->>'received_at', '') = '' then
    raise exception 'vdr_store_feed_chunk: gmail_message_id and received_at are required';
  end if;
  insert into public.vdr_feed_runs (gmail_message_id, received_at, source_file, header, raw_row_count, lead_count, window_start)
  values (p_run->>'gmail_message_id',
          (p_run->>'received_at')::timestamptz,
          p_run->>'source_file',
          coalesce(array(select jsonb_array_elements_text(coalesce(p_run->'header', '[]'::jsonb))), '{}'),
          (p_run->>'raw_row_count')::int,
          (p_run->>'lead_count')::int,
          nullif(p_run->>'window_start', '')::date)
  on conflict (gmail_message_id) do update set saved_at = now()
  returning * into v_run;

  insert into public.vdr_feed_leads as t (lead_id, entry_date, sub_source, row, first_seen_at, last_seen_at, last_run_id, updated_at)
  select distinct on (l->>'lead_id')
         l->>'lead_id', nullif(l->>'entry_date', '')::date, nullif(l->>'sub_source', ''), l->'row',
         v_run.received_at, v_run.received_at, v_run.id, now()
    from jsonb_array_elements(coalesce(p_leads, '[]'::jsonb)) l
   where coalesce(l->>'lead_id', '') <> ''
   order by l->>'lead_id'
  on conflict (lead_id) do update
     set entry_date   = excluded.entry_date,
         sub_source   = excluded.sub_source,
         row          = excluded.row,
         last_seen_at = excluded.last_seen_at,
         last_run_id  = excluded.last_run_id,
         updated_at   = now()
   where t.last_seen_at <= excluded.last_seen_at;   -- an older email never overwrites a newer feed
  get diagnostics v_n = row_count;
  return jsonb_build_object('run_id', v_run.id, 'stored', v_n);
end;
$$;

-- After the last chunk: the run is usable only when every lead it carried is stored under it.
create or replace function public.vdr_finish_feed(p_message_id text)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_run   public.vdr_feed_runs;
  v_saved int;
begin
  select * into v_run from public.vdr_feed_runs where gmail_message_id = p_message_id;
  if not found then
    return jsonb_build_object('complete', false, 'reason', 'run_not_found', 'saved', 0, 'expected', null);
  end if;
  select count(*) into v_saved from public.vdr_feed_leads where last_run_id = v_run.id;
  if v_saved = v_run.lead_count and v_run.lead_count > 0 then
    update public.vdr_feed_runs set complete = true, completed_at = coalesce(completed_at, now()) where id = v_run.id;
  end if;
  return jsonb_build_object('complete', v_saved = v_run.lead_count and v_run.lead_count > 0,
                            'saved', v_saved, 'expected', v_run.lead_count,
                            'run_id', v_run.id, 'received_at', v_run.received_at);
end;
$$;

-- The newest complete feed, with its leads, for the workflow's "Send now (saved feed)" button.
create or replace function public.vdr_saved_feed()
returns jsonb
language sql
stable
set search_path = public
as $$
  with r as (
    select * from public.vdr_feed_runs where complete order by received_at desc, id desc limit 1
  )
  select coalesce(
    (select jsonb_build_object(
              'found', true, 'run_id', r.id, 'gmail_message_id', r.gmail_message_id,
              'received_at', r.received_at, 'source_file', r.source_file, 'header', to_jsonb(r.header),
              'raw_row_count', r.raw_row_count, 'lead_count', r.lead_count, 'window_start', r.window_start,
              'leads', coalesce((select jsonb_agg(l.row order by l.lead_id)
                                   from public.vdr_feed_leads l where l.last_run_id = r.id), '[]'::jsonb))
       from r),
    jsonb_build_object('found', false));
$$;

revoke all on function public.vdr_store_feed_chunk(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.vdr_finish_feed(text)               from public, anon, authenticated;
revoke all on function public.vdr_saved_feed()                    from public, anon, authenticated;
grant execute on function public.vdr_store_feed_chunk(jsonb, jsonb) to service_role;
grant execute on function public.vdr_finish_feed(text)               to service_role;
grant execute on function public.vdr_saved_feed()                    to service_role;

notify pgrst, 'reload schema';
