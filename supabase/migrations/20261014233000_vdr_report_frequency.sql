-- 20261014233000_vdr_report_frequency.sql
--
-- WHAT: vdr_vendor_config.frequency ('weekly' | 'monthly', default 'weekly') and vdr_due_vendors() rewritten to
--       work on a PERIOD start per vendor: the Monday of this week (weekly) or the 1st of this month (monthly).
--       The function still returns the period start as `week_start`, so the n8n "06 VDR" workflow
--       (frlZu30c88H5bnkZ) and vdr_send_log.week_start are unchanged; that column now means "period start".
--       The output gains `frequency` and `period_start`.
-- WHY: Mark, 2026-10-14: "control the report frequency, monthly or weekly, in the dashboard. If monthly, send
--      the report on the first of each month; if weekly, send it every Monday morning." The run starts when LP's
--      daily feed email lands (~6:30 AM ET), so weekly = the first feed email on or after Monday 00:00 and
--      monthly = the first feed email on or after the 1st at 00:00. "Sent this period" and the 3-attempt count
--      read week_start >= period_start, so a vendor switched weekly -> monthly after a Monday send is not sent
--      again that month, and monthly -> weekly after a 1st-of-month send waits for the next Monday.
--      Applied by hand through the LP MCP on 2026-10-14 and recorded as APPLIED in
--      supabase_migrations.schema_migrations, so `db push` never re-runs it; the statements are idempotent anyway.
-- NOT: no change to vdr_send_log, vdr_payable_jobs, vdr_rev_share_data(), or any LP table. Every existing
--      vendor stays weekly (the column default).
-- ROLLBACK: restore vdr_due_vendors() from 20261013230000_vdr_vendor_disposition_report.sql (the rev-share
--           version, which carries the 'rev_share' key), then
--           alter table public.vdr_vendor_config drop column frequency;  -- destructive: only after a ruling

-- ===== Report frequency: weekly (Monday) or monthly (the 1st) — 2026-10-14 =====
-- Mark: "control the report frequency, monthly or weekly, in the dashboard. If monthly, send the report on the
-- first of each month; if weekly, send it every Monday morning." The run starts when LP's daily feed email lands
-- (~6:30 AM ET), so "Monday" means the first feed email on or after Monday 00:00 and "the 1st" the first feed
-- email on or after the 1st at 00:00. vdr_due_vendors() now works on a PERIOD start per vendor (Monday of this
-- week, or the 1st of this month) and still returns it as week_start, so the workflow and vdr_send_log.week_start
-- are unchanged: that column is the period start. "Sent this period" and the 3-attempt count read
-- week_start >= period_start, so a vendor switched weekly -> monthly after a Monday send is not sent again that
-- month, and monthly -> weekly after a 1st-of-month send waits for the next Monday.

alter table public.vdr_vendor_config
  add column if not exists frequency text not null default 'weekly'
  check (frequency in ('weekly','monthly'));

create or replace function public.vdr_due_vendors()
returns jsonb language sql stable as $$
  with v as (
    select c.*,
           (now() at time zone c.timezone) as local_now,
           case when c.frequency = 'monthly' then date_trunc('month', now() at time zone c.timezone)::date
                else date_trunc('week', now() at time zone c.timezone)::date end as period_start
    from public.vdr_vendor_config c
    where c.is_active
  ), s as (
    select v.*,
           case when v.frequency = 'monthly' then (v.period_start + v.send_time)
                else (v.period_start + (v.send_dow - 1) + v.send_time) end as slot_local
    from v
  )
  select jsonb_build_object(
    'due', coalesce((
      select jsonb_agg(jsonb_build_object(
        'vendor_id', s.id, 'vendor_name', s.vendor_name, 'lp_sub_sources', s.lp_sub_sources,
        'recipients_to', s.recipients_to, 'recipients_cc', s.recipients_cc,
        'dry_run', s.dry_run, 'rev_share', s.rev_share, 'lookback_days', s.lookback_days,
        'frequency', s.frequency, 'week_start', s.period_start, 'period_start', s.period_start,
        'scheduled_for', (s.slot_local at time zone s.timezone)) order by s.vendor_name)
      from s
      where s.local_now >= s.slot_local
        and not exists (select 1 from public.vdr_send_log l
                        where l.vendor_id = s.id and l.week_start >= s.period_start
                          and l.dry_run = s.dry_run and l.status in ('sent','empty'))
        and (select count(*) from public.vdr_send_log l
             where l.vendor_id = s.id and l.week_start >= s.period_start and l.dry_run = s.dry_run) < 3
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

notify pgrst, 'reload schema';
