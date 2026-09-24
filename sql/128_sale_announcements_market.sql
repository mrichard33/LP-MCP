-- 128_sale_announcements_market.sql
-- Record the office power ranking posted to the sale's MARKET channel.
--
-- STATUS: additive, five ADD COLUMN IF NOT EXISTS. Mirrored in src/index.js
-- runMigrations() alongside the sql/117 + sql/119 block, so it also applies
-- itself on the next deploy. Run it from the dashboard too so the columns exist
-- before SALE_ANNOUNCE_MARKET_ENABLED is flipped.
--
-- ══ WHY ══
-- 2026-09-24. Every sale posted to #sales-all only. Rows 80–90 all carry
-- slack_channel = C0C0AQMARE1 while their leads sit in FTMYR / JAX / STPET /
-- ORL: nothing ever looked up a market. With the flag on, each sale now ALSO
-- posts to #sales-<market> — not the celebration again, but the rep's month
-- line and the office's month-to-date power ranking (requested 2026-09-24; see
-- src/notifications/office-ranking.js). slack_ts / slack_channel keep meaning
-- #sales-all; these columns describe the market post.
--
--   market_code            lp_leads.lp_branch_id as read at post time (raw,
--                          so BOCA stays BOCA even though it posts to FTLAU)
--   slack_market_channel   the channel id we aimed at (filled on failure too)
--   slack_market_ts        the market post's ts; NULL = it did not land
--   market_message_text    the ranking text posted (or attempted), so a failed
--                          post can be reposted by hand exactly as built
--   market_error           NULL on success; 'no_market_channel' when the code
--                          maps to no channel; 'slack:<err> after <n> attempts'
--                          when Slack refused; 'no_market_text' when neither
--                          the rep's facts nor the ranking could be read
--
-- A market failure NEVER changes status: the sale reached #sales-all.
-- All five are NULL when the flag is off, when the lead has no branch, and on
-- every row before this change. Old sales are not reposted.

alter table sale_announcements
  add column if not exists market_code text,
  add column if not exists slack_market_channel text,
  add column if not exists slack_market_ts text,
  add column if not exists market_message_text text,
  add column if not exists market_error text;

-- ══ VERIFY ══
--   select json_agg(row_to_json(s)) from (
--     select id, rep_display_name, market_code, slack_channel,
--            slack_market_channel, market_error
--     from sale_announcements order by id desc limit 5
--   ) s;
