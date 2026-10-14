-- 20261014213000_vdr_send_time_default_midnight.sql
--
-- WHAT: vdr_vendor_config.send_time defaults to 00:00 (was 09:00), and every existing vendor row is set to
--       00:00. Column, type and NOT NULL are unchanged.
-- WHY: the n8n "06 VDR" workflow (frlZu30c88H5bnkZ) now has ONE trigger, the LP feed email itself (Mark,
--      2026-10-14): no hourly timer and no second Gmail search. LP sends the feed about 6:30 AM ET, so a vendor
--      "due" at Monday 09:00 would have been found not-yet-due by the Monday email and would not have sent until
--      Tuesday's. With send_time 00:00 the Monday feed sends. The retry is the next day's feed email (Mon, Tue,
--      Wed = the 3 attempts vdr_due_vendors() allows). Applied by hand through the LP MCP on 2026-10-14 and
--      recorded as APPLIED in supabase_migrations.schema_migrations, so `db push` never re-runs it; both
--      statements are idempotent anyway.
-- NOT: no change to vdr_due_vendors(), vdr_send_log, vdr_payable_jobs, or any LP table.
-- ROLLBACK: alter table public.vdr_vendor_config alter column send_time set default '09:00';
--           update public.vdr_vendor_config set send_time = '09:00';  -- and restore the hourly timer in n8n.

alter table public.vdr_vendor_config alter column send_time set default '00:00';
update public.vdr_vendor_config set send_time = '00:00' where send_time <> '00:00';
