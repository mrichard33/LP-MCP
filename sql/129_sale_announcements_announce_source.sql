-- 129_sale_announcements_announce_source.sql
-- Where an announcement came from.
--
-- STATUS: additive, one ADD COLUMN IF NOT EXISTS, mirrored in src/index.js
-- runMigrations() next to sql/117/119/128, so it applies itself on deploy.
--
-- ══ WHY ══
-- 2026-09-25. LP's webhook to GHL I.LP-IN stopped delivering sales on 09-24
-- (0 of 9 announced that day, 1 of 7 on 09-25). The backstop
-- (src/notifications/sale-backstop.js) now announces those from our own sync.
-- This column says which path posted each row, so the gap stays measurable:
--
--   NULL               the normal path — GHL I.LP-IN called the endpoint
--   'backstop'         announced by the backstop, 30+ min after LP showed Sale
--   'backstop_digest'  too old to celebrate alone; posted in a catch-up list
--
-- A rising share of backstop rows means LP's webhook is failing again.

alter table sale_announcements add column if not exists announce_source text;

-- ══ VERIFY ══
--   select json_agg(row_to_json(s)) from (
--     select (created_at at time zone 'America/New_York')::date day,
--            coalesce(announce_source, 'ghl') src, count(*)
--     from sale_announcements where created_at > now() - interval '7 days'
--     group by 1, 2 order by 1, 2
--   ) s;
