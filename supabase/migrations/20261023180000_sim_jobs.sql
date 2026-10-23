-- 20261023180000_sim_jobs.sql
--
-- WHAT: sim_jobs, one row per simulate_bot_conversation / run_bot_eval job: the parsed request, every finished
--       conversation keyed `run#/scenario_key/channel`, the scorecard and comparison, the owning Railway deployment
--       and a 15 s heartbeat. Two functions: sim_job_claim (one stale job, claimed atomically with FOR UPDATE SKIP
--       LOCKED, so two instances never both resume it) and sim_job_record (one finished conversation merged into
--       `completed`, only while the caller still owns the job).
-- WHY: 2026-10-23 (AIOS CANON.IMP.068 sandboxed testing as a release gate, CANON.SK.063 idempotent triggers,
--      CANON.TBL.015 deployment history). Jobs lived in memory only, so any LP-MCP deploy killed a 20-30 minute gate
--      run. src/simulator/sim-job-store.js writes this table; a new instance resumes a job whose heartbeat stopped.
-- NOT: no customer data. Personas are simulated; a run on a real contact stores the contact id only (contact
--      fields are stripped from the stored result, persistableResult in sim-job-store.js).
-- ROLLBACK: SIM_JOB_PERSIST_MODE=off (in-memory jobs, as before). Leaving the table is harmless.
--           drop function public.sim_job_record(text, text, text, jsonb); drop function public.sim_job_claim(text, int);
--           drop table public.sim_jobs;

create table if not exists public.sim_jobs (
  id text primary key,
  kind text not null default 'simulate',
  status text not null default 'running',
  request jsonb not null default '{}'::jsonb,
  completed jsonb not null default '{}'::jsonb,
  total_units int not null default 0,
  done_units int not null default 0,
  versions jsonb not null default '[]'::jsonb,
  scorecard jsonb,
  comparison jsonb,
  error text,
  owner_deployment_id text,
  heartbeat_at timestamptz not null default now(),
  resume_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sim_jobs_kind_chk check (kind in ('simulate', 'gate')),
  constraint sim_jobs_status_chk check (status in ('running', 'interrupted', 'done', 'error'))
);

create index if not exists sim_jobs_open_idx on public.sim_jobs (heartbeat_at) where status in ('running', 'interrupted');
create index if not exists sim_jobs_finished_idx on public.sim_jobs (updated_at) where status in ('done', 'error');

alter table public.sim_jobs enable row level security;

comment on table public.sim_jobs is 'Bot simulator / gate jobs that survive an LP-MCP deploy (2026-10-23). Written by src/simulator/sim-job-store.js.';

-- Claim ONE open job whose heartbeat is older than p_stale_seconds. The row lock + SKIP LOCKED and the re-check in
-- the UPDATE make the claim atomic: a second claimer gets nothing. resume_count is NOT changed here; the caller
-- decides (resume cap, age) and increments it.
create or replace function public.sim_job_claim(p_owner text, p_stale_seconds int default 45)
returns setof public.sim_jobs
language sql
as $$
  with pick as (
    select id from public.sim_jobs
     where status in ('running', 'interrupted')
       and heartbeat_at < now() - make_interval(secs => p_stale_seconds)
     order by created_at
     limit 1
     for update skip locked
  )
  update public.sim_jobs j
     set owner_deployment_id = p_owner, status = 'running', heartbeat_at = now(), updated_at = now()
    from pick
   where j.id = pick.id
     and j.status in ('running', 'interrupted')
     and j.heartbeat_at < now() - make_interval(secs => p_stale_seconds)
  returning j.*;
$$;

-- Merge one finished conversation into `completed`, only for the owner of a running job. Returns false when the
-- caller no longer owns it (another instance claimed it), so the caller stops.
create or replace function public.sim_job_record(p_id text, p_owner text, p_key text, p_result jsonb)
returns boolean
language plpgsql
as $$
declare n int;
begin
  update public.sim_jobs
     set completed = completed || jsonb_build_object(p_key, p_result),
         done_units = (select count(*) from jsonb_object_keys(completed || jsonb_build_object(p_key, p_result))),
         heartbeat_at = now(), updated_at = now()
   where id = p_id and owner_deployment_id = p_owner and status = 'running';
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

revoke all on function public.sim_job_claim(text, int) from public, anon, authenticated;
revoke all on function public.sim_job_record(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.sim_job_claim(text, int) to service_role;
grant execute on function public.sim_job_record(text, text, text, jsonb) to service_role;
