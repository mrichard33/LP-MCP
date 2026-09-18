-- 122_lp_link_repair_indexes.sql
-- Expression indexes for the LP↔GHL link repair and its daily leak monitor.
--
-- WHAT THIS IS. Two indexes on lp_leads, matching the two expressions
-- scripts/repair-lp-ghl-links.js and the link-leak monitor scan on. Nothing
-- else: no new columns, no data change, no view.
--
-- WHAT THIS IS *NOT*. It is NOT the contacts address migration from the
-- handoff. `contacts` lives in the HL Supabase, not this one, so that DDL is in
-- the OTHER repo — HL-MCP `supabase/migrations/017_contacts_address_columns.sql`
-- — and must be pasted into the HL project. Putting it in this directory would
-- invite running it against LP, where there is no `contacts` table to alter and
-- where the phone index would then be built on the wrong 25k rows.
--
-- WHY THE EXPRESSION AND NOT THE COLUMN. GHL stores `+13524453161`; LP stores
-- `3524453161`. Measured 2026-09-18 over the live 344-opportunity cohort, a
-- full-string compare across that boundary matches 0 rows and the last-10
-- compare matches 110. So every match this work performs goes through
-- `right(regexp_replace(phone,'[^0-9]','','g'), 10)`, and without an index on
-- exactly that expression the repair and the daily monitor both sequential-scan
-- 242,212 lp_leads rows.
--
-- The second index serves the monitor's other half — "created in the last 24h
-- and still unlinked" — which is a tiny, highly selective slice of a large
-- table. Partial on `ghl_contact_id IS NULL` so it indexes only the rows the
-- monitor can act on (214,953 of 242,212 today, and the useful direction is
-- that it shrinks as the repair lands).
--
-- MIRRORED IN runMigrations()? YES — the two CREATE INDEX statements are
-- mirrored in src/index.js so a fresh deploy self-heals. Per sql/README.md they
-- are the plain (non-CONCURRENTLY) form there, which is correct on a fresh
-- deploy where the table is empty.
--
-- APPLY THIS FROM THE DASHBOARD ON THE LIVE TABLE. lp_leads is populated and
-- written continuously by the 15-minute sync, so the CONCURRENTLY form below is
-- the one to run there — a plain CREATE INDEX takes a write lock for the whole
-- build and would stall the sync. sql/README.md: CREATE INDEX CONCURRENTLY can
-- never go through MCP apply_migration (it wraps statements in a transaction and
-- CONCURRENTLY cannot run inside one).
--
-- ROLLBACK:
--   DROP INDEX CONCURRENTLY IF EXISTS idx_lp_leads_phone10;
--   DROP INDEX CONCURRENTLY IF EXISTS idx_lp_leads_unlinked_recent;
-- Dropping either is safe at any time: both are pure read optimisations and no
-- query depends on one for correctness.

-- ─── RUN SEPARATELY, one at a time, outside any transaction ────────────────
-- (Supabase dashboard SQL editor: paste and run each statement on its own.)

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lp_leads_phone10
  ON lp_leads (right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10));

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lp_leads_unlinked_recent
  ON lp_leads (created_at_lp)
  WHERE ghl_contact_id IS NULL;

-- AFTER RUNNING: confirm both are present and VALID. A CONCURRENTLY build that
-- fails leaves an INVALID index behind that the planner ignores while it still
-- costs every write — the failure mode is a silent slowdown, not an error.
--
--   SELECT i.relname, idx.indisvalid
--     FROM pg_class i
--     JOIN pg_index idx ON idx.indexrelid = i.oid
--    WHERE i.relname IN ('idx_lp_leads_phone10', 'idx_lp_leads_unlinked_recent');
--
-- Both rows must read indisvalid = true. If either is false, DROP it and rerun.
