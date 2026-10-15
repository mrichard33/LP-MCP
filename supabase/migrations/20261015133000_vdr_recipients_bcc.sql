-- 20261015133000_vdr_recipients_bcc.sql
--
-- WHAT: vdr_vendor_config.recipients_bcc text[] (default '{}'), returned by vdr_due_vendors() as `recipients_bcc`;
--       every active vendor seeded with {m.richard@reecewindows.com, b.codman@reecewindows.com}.
-- WHY: Mark, 2026-10-15: "add b.codman@reecewindows.com as a bcc as well for now. I would actually like to add and
--      show the BCC as a tab in the dashboard right below the CC so that the BCC can be updated and seen who it is
--      being sent to." The hidden copy was the hard-coded m.richard@reecewindows.com in the n8n "06 VDR" Build node.
--      The node now sends BCC = Mark + this list (de-duplicated), so an edit on the dashboard can never drop Mark.
--      Applied by hand through the LP MCP on 2026-10-15 and recorded as APPLIED in
--      supabase_migrations.schema_migrations, so `db push` never re-runs it; the statements are idempotent (the seed
--      only fills an empty list).
-- NOT: no change to vdr_send_log, vdr_payable_jobs, vdr_rev_share_data(), or any LP table.
-- ROLLBACK: restore vdr_due_vendors() from 20261014233000_vdr_report_frequency.sql, then
--           alter table public.vdr_vendor_config drop column recipients_bcc;  -- destructive: only after a ruling

-- ===== BCC per vendor, shown and edited on the dashboard — 2026-10-15 =====
-- Mark: "add b.codman@reecewindows.com as a bcc as well for now. I would actually like to add and show the BCC as a
-- tab in the dashboard right below the CC so that the BCC can be updated and seen who it is being sent to." The
-- hidden copy used to be the hard-coded m.richard@reecewindows.com in the Build node. Now vdr_vendor_config carries
-- recipients_bcc, vdr_due_vendors() returns it, and the Build node sends BCC = m.richard@reecewindows.com plus the
-- row's list (de-duplicated), so an edit on the page can never drop Mark. The seed below gives every active vendor
-- Mark + Brad; it is guarded on an empty list so a re-run changes nothing.

alter table public.vdr_vendor_config add column if not exists recipients_bcc text[] not null default '{}';

update public.vdr_vendor_config
   set recipients_bcc = '{m.richard@reecewindows.com,b.codman@reecewindows.com}'
 where is_active and recipients_bcc = '{}';

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
        'recipients_to', s.recipients_to, 'recipients_cc', s.recipients_cc, 'recipients_bcc', s.recipients_bcc,
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
