-- 117_sale_announcements.sql
-- The agentic sale-announcement ledger: one row per announced sale.
--
-- STATUS: NOT APPLIED. Apply from the Supabase dashboard (LP instance).
-- Every statement is IF NOT EXISTS, so re-running this file is idempotent.
-- src/index.js runMigrations() mirrors the CREATE TABLE so a fresh deploy
-- self-heals, but apply this file first — the endpoint writes a row before it
-- responds 200, and a missing table would turn every sale into a 500 at GHL.
--
-- ══ WHAT THIS IS FOR ══
-- POST /notifications/sale-announcement receives each completed sale from the
-- GHL Sold branch, enriches it with the rep's real performance history,
-- composes a message and posts it to Slack. This table is the idempotency
-- guard, the audit trail, and the record of which lead-id resolution path was
-- used.
--
-- ══ WHY idempotency_key IS ON lp_lead_id AND NOT lp_prospect_id ══
-- LP Lead ID and LP Prospect ID are DIFFERENT identifiers and are not
-- interchangeable. Measured live 2026-09-16 against lp_leads (241,625 rows):
--
--   241,625 distinct lp_lead_id      — one per lead
--   146,595 distinct lp_prospect_id  — one per person
--     2,049 rows where the two are equal
--
-- One prospect owns many leads. Keying on the prospect would suppress a repeat
-- customer's SECOND sale as a false duplicate — the exact customer we least
-- want to go silent on. So the key is the resolved LEAD id plus the rounded
-- sale amount:
--
--   idempotency_key = sha256(<resolved_lead_id> || ':' || round(amount))
--
-- LP dispositions replay. This unique constraint is the only thing standing
-- between a replay and a duplicate post on the sales board. A duplicate insert
-- resolves to a no-op returning the original row — never an error back to GHL.
--
-- ══ WHY key_source EXISTS ══
-- GHL's "LP Lead ID" custom field (GmAVmW6V9sekD7pVONKr) is trusted but
-- verified, never trusted blind. Its own decoder note reads "May contain
-- inbound queue ID until resolved" — the known in1_id vs lds_id defect. On a
-- sampled live contact, GHL carried 575065 while lp_leads held 573581 for the
-- same contact. key_source records which path produced the key:
--
--   lead_id            GHL's value matched a lp_leads row — trusted and verified
--   lead_id_corrected  it did not; the prospect's most recent lead was used
--   prospect_fallback  the prospect resolved to no lead rows at all
--   contact_fallback   nothing resolved; keyed on contact + day
--
-- `select key_source, count(*) from sale_announcements group by 1` then
-- measures how often the upstream field is wrong. A high lead_id_corrected
-- count means the in1_id defect is still live and deserves its own fix.

create table if not exists sale_announcements (
  id                bigserial primary key,
  lp_lead_id        text,
  lp_prospect_id    text,
  ghl_contact_id    text,
  rep_display_name  text,
  gross_sale_amount numeric,
  idempotency_key   text not null unique,
  key_source        text not null default 'lead_id',
  status            text not null default 'pending',
  slack_ts          text,
  slack_channel     text,
  message_text      text,
  facts_json        jsonb,
  error_message     text,
  created_at        timestamptz not null default now(),
  completed_at      timestamptz
);

-- Plain CREATE INDEX, not CONCURRENTLY, is correct here: the table is new and
-- empty, so the build is instant and there is no live traffic to block.
-- (CONCURRENTLY also cannot run inside a transaction, which would force this
-- file to be applied in three separate dashboard executions for no benefit.)
create index if not exists idx_sale_announcements_lead
  on sale_announcements (lp_lead_id, created_at desc);
create index if not exists idx_sale_announcements_prospect
  on sale_announcements (lp_prospect_id, created_at desc);

-- ══ VERIFY IMMEDIATELY AFTER APPLYING ══
-- Expect one row, all four counts 0, and the unique constraint present.
--
--   select json_agg(row_to_json(s)) from (
--     select count(*) rows,
--            count(*) filter (where status = 'posted')        posted,
--            count(*) filter (where status = 'slack_failed')  slack_failed,
--            count(*) filter (where status = 'skipped_invalid') skipped
--       from sale_announcements
--   ) s;
--
--   select json_agg(row_to_json(s)) from (
--     select indexname from pg_indexes
--      where tablename = 'sale_announcements' order by 1
--   ) s;
