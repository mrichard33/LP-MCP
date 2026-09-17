-- 118_lp_leads_close_date.sql
-- Give lp_leads a usable sale date, and say plainly where each one came from.
--
-- STATUS: NOT APPLIED. Apply from the Supabase dashboard (LP instance), AFTER
-- sql/117. Section 1 (the ALTER) is idempotent and is mirrored in
-- src/index.js runMigrations(). Section 2 (the one-time backfill) is NOT
-- mirrored and must be run here by hand — a 24,834-row data write does not
-- belong in a boot path. Run the section 3 verification immediately after.
--
-- ══ THE DEFECT ══
-- lp_leads.close_date is NULL on EVERY closed-won row. Measured live
-- 2026-09-16:
--
--   closed_won rows                         24,834
--   closed_won with close_date IS NULL       24,834   (100%)
--   closed_won with job_value > 0            24,708
--   max(close_date) across the whole table    NULL
--
-- Nothing has ever written it. src/sync-leads.js builds its upsert row with
-- closed_won and job_value but has never included close_date, so the column
-- has been dead since it was created. The repo already works around this: the
-- get_rep_performance RPC (src/index.js) buckets sales by appointment_date,
-- because appointment_date is the only date a sale can be tied to today.
--
-- That workaround is invisible to anyone reading the schema, and it blocks the
-- whole class of "when did this rep sell" question — month-to-date counts,
-- consecutive-day streaks, personal records, rank over a window.
--
-- ══ THE FIX, AND WHY IT NEEDS A PROVENANCE COLUMN ══
-- Backfill close_date from appointment_date, and have the sale-announcement
-- endpoint write a real close_date on every sale from here on.
--
-- Backfilling WITHOUT provenance would be the actual mistake. appointment_date
-- is a PROXY for the close date: a contract signed three weeks after the demo
-- lands in the demo's month. Writing that into close_date with no marker makes
-- a proxy permanently indistinguishable from a real close timestamp, and the
-- next person to read the column has no way to know. close_date_source keeps
-- the three cases separable:
--
--   appointment_proxy   backfilled by this file from appointment_date
--   sale_announcement   written live by POST /notifications/sale-announcement
--   lp                  reserved: a real close date from LP, if the API ever
--                       exposes one (see sql/108 for the appointment truth
--                       definitions this would sit alongside)
--
-- Read close_date_source before trusting close_date for anything that turns on
-- the exact day.
--
-- ══ WHY THE BACKFILL SURVIVES THE NEXT LP SYNC ══
-- Verified in src/sync-leads.js: both upserts use
-- `.upsert(row, { onConflict: 'lp_lead_id' })`, and `row` never contains
-- close_date or close_date_source. Postgres ON CONFLICT DO UPDATE only assigns
-- the columns present in the statement, so a close_date we write is left
-- untouched by every subsequent sync. This is why the backfill is durable
-- rather than something the next sync pass would erase.

-- ── 1. Provenance column (idempotent; mirrored in runMigrations) ──────────
alter table lp_leads add column if not exists close_date_source text;

-- ── 2. One-time backfill (NOT mirrored; run here, once) ──────────────────
-- Guarded on close_date IS NULL, so re-running is a no-op and a real close
-- date written later is never overwritten by the proxy.
with u as (
  update lp_leads
     set close_date        = appointment_date,
         close_date_source = 'appointment_proxy'
   where closed_won
     and close_date is null
     and appointment_date is not null
  returning 1
)
select count(*) as rows_backfilled from u;

-- ── 3. VERIFY IMMEDIATELY AFTER APPLYING ─────────────────────────────────
-- Expect ~24,834 in appointment_proxy, 0 still NULL apart from won rows that
-- genuinely have no appointment_date, and a non-null max(close_date).
--
--   select json_agg(row_to_json(s)) from (
--     select close_date_source,
--            count(*)                              rows,
--            min(close_date)::date                 earliest,
--            max(close_date)::date                 latest
--       from lp_leads
--      where closed_won
--      group by 1
--      order by 2 desc
--   ) s;
--
--   -- Won rows the backfill could not date (no appointment_date on file).
--   -- These stay NULL on purpose: an undated sale is honest, an invented
--   -- date is not.
--   select json_agg(row_to_json(s)) from (
--     select count(*) undated_won
--       from lp_leads
--      where closed_won and close_date is null
--   ) s;
