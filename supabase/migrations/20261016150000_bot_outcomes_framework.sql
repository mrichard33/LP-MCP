-- 20261016150000_bot_outcomes_framework.sql
--
-- WHAT: bot_outcomes.framework (nepq | nepq_rehash | logistics | none, NULL = not known) and a new view
--       v_bot_quality_weekly_by_framework: v_bot_quality_weekly's numbers grouped by framework as well.
-- WHY: 2026-10-16 (Mark, 2026-10-15: NEPQ is the only framework in the conversation prompt). Whether that helped is
--      read from booked % and opt-out % per framework, and bot_outcomes had no trace of which plan wrote a reply.
--      The outcomes job (src/bot-feedback/outcomes.js) fills it from the reply's agent_actions plan (frameworkFor in
--      outcomes-core.js): the post-demo planner → nepq_rehash, a cancel/reschedule flow → logistics, any other live
--      NEPQ plan → nepq, otherwise none.
-- NOT: no backfill (rows already final keep NULL). v_bot_quality_weekly is not changed: sql/README.md says never
--      change a live view's column list in place, so the framework split is a NEW view.
-- ROLLBACK: drop view v_bot_quality_weekly_by_framework; leave the column (additive, nothing else reads it).

alter table public.bot_outcomes add column if not exists framework text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bot_outcomes_framework_check') then
    alter table public.bot_outcomes
      add constraint bot_outcomes_framework_check
      check (framework is null or framework in ('nepq', 'nepq_rehash', 'logistics', 'none'));
  end if;
end $$;

create or replace view public.v_bot_quality_weekly_by_framework as
with settings as (
  select coalesce((select bot_settings.value::text::numeric from bot_settings where bot_settings.key = 'report_min_sample'), 30::numeric) as min_sample
), base as (
  select date_trunc('week', (q.generated_at at time zone 'America/New_York'))::date as et_week,
         coalesce(bo.framework, '(unknown)') as framework,
         coalesce(q.rule_applied, q.workflow_code, '(none)') as path,
         coalesce(q.channel, '(unknown)') as channel,
         q.message_type,
         q.message_ref,
         q.ai_score,
         q.replied_at,
         q.booked_at,
         q.opted_out_at
    from v_bot_review_queue q
    left join bot_outcomes bo on bo.message_type = q.message_type and bo.message_ref = q.message_ref
), verdicts as (
  select cf.message_type,
         cf.message_ref,
         bool_or(cf.verdict = 'good') as any_good,
         bool_or(cf.verdict = 'needs_work') as any_needs,
         bool_or(cf.verdict = 'unsafe') as any_unsafe
    from v_bot_current_feedback cf
   where cf.counts
   group by cf.message_type, cf.message_ref
)
select b.et_week,
       b.framework,
       b.path,
       b.channel,
       count(*)::integer as sent,
       count(v.*)::integer as reviewed,
       count(*) filter (where v.any_good and not v.any_needs and not v.any_unsafe)::integer as good,
       count(*) filter (where v.any_needs and not v.any_unsafe)::integer as needs_work,
       count(*) filter (where v.any_unsafe)::integer as unsafe,
       case when count(v.*) = 0 then null::numeric
            else round(count(*) filter (where v.any_good and not v.any_needs and not v.any_unsafe)::numeric / count(v.*)::numeric, 4) end as good_rate,
       case when count(v.*) = 0 then null::numeric
            else round(100.0 * count(*) filter (where v.any_needs or v.any_unsafe)::numeric / count(v.*)::numeric, 2) end as issues_per_100,
       round(avg(b.ai_score), 1) as avg_ai_score,
       round(count(*) filter (where b.replied_at is not null)::numeric / nullif(count(*), 0)::numeric, 4) as reply_rate,
       round(count(*) filter (where b.booked_at is not null)::numeric / nullif(count(*), 0)::numeric, 4) as booking_rate,
       round(count(*) filter (where b.opted_out_at is not null)::numeric / nullif(count(*), 0)::numeric, 4) as optout_rate,
       count(v.*)::numeric >= (select settings.min_sample from settings) as enough_data
  from base b
  left join verdicts v on v.message_type = b.message_type and v.message_ref = b.message_ref
 group by b.et_week, b.framework, b.path, b.channel;

revoke all on public.v_bot_quality_weekly_by_framework from anon;
grant select on public.v_bot_quality_weekly_by_framework to authenticated, service_role;
