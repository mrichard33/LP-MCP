-- ============================================================================
-- 065 — Call Intelligence: make the LP phone match an index lookup
--
-- WHY: §8 matching resolves a call to an LP record by phone. lp_leads already
-- has idx_lp_leads_phone (btree) and trigram indexes, but lp_prospects — the
-- ONE ROW PER PERSON table that carries cst_id, and therefore the table the
-- 'cst' note target comes from — has no phone index at all. Only
-- idx_lp_prospects_ghl exists.
--
-- Measured 2026-08-22: lp_prospects holds 140,600 rows. Without these, every
-- matched call sequentially scans all of them, twice (phone and phone_alt).
-- At the observed call volume (~170 rows per 15 minutes in the Call Log) that
-- is the difference between a lookup and a table scan per call.
--
-- WHY PLAIN BTREE AND NOT A NORMALIZED COLUMN: the data is already normalized
-- in practice — 139,693 of 140,600 phones (99.4%) are bare 10-digit strings
-- and ZERO are E.164. match.js therefore compares with equality against both
-- the 10-digit form and the '1'-prefixed form, which uses these indexes.
-- Wrapping the column in regexp_replace() to normalize at query time would
-- defeat any index on it, and adding a generated column would rewrite a
-- 140k-row table that several other subsystems read. The residue is small and
-- fails SAFE: 232 short/junk, 68 seven-digit (no area code), 43 over-long.
-- Those simply do not match, and a call that finds no LP record goes to
-- review — a miss, never a wrong attachment.
--
-- Mirrored in runMigrations() (src/index.js). Purely additive: creates
-- indexes, changes no column, rewrites no row.
--
-- NOTE ON CONCURRENTLY: per sql/README.md, index builds that would lock a
-- busy table use CREATE INDEX CONCURRENTLY and run from the dashboard.
-- These are plain builds because they must also be re-runnable inside
-- runMigrations(), where CONCURRENTLY is illegal (it cannot run in a
-- transaction block). lp_prospects is a mirror written by the sync job, not
-- an interactive write path, and a brief ACCESS SHARE lock on it is
-- acceptable. If this ever becomes a problem, build them CONCURRENTLY by hand
-- first — IF NOT EXISTS then makes the migration a no-op.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_lp_prospects_phone;
--   DROP INDEX IF EXISTS idx_lp_prospects_phone_alt;
--   DROP INDEX IF EXISTS idx_lp_leads_phone_alt;
--   DROP INDEX IF EXISTS idx_lp_leads_prospect_id;
-- ============================================================================

-- The primary and secondary phone on the person record.
CREATE INDEX IF NOT EXISTS idx_lp_prospects_phone
  ON lp_prospects (phone);
CREATE INDEX IF NOT EXISTS idx_lp_prospects_phone_alt
  ON lp_prospects (phone_alt);

-- lp_leads.phone is already indexed; phone_alt is only covered by a trigram
-- index, which does not serve an equality probe well.
CREATE INDEX IF NOT EXISTS idx_lp_leads_phone_alt
  ON lp_leads (phone_alt);

-- §8 note-target selection walks from a matched person to their inquiries to
-- decide between rectype 'cst' and 'ils'. That is a lookup by prospect id.
CREATE INDEX IF NOT EXISTS idx_lp_leads_prospect_id
  ON lp_leads (lp_prospect_id);

-- ─── Verification ────────────────────────────────────────────────────────────
--   SELECT indexname FROM pg_indexes
--   WHERE tablename IN ('lp_prospects','lp_leads')
--     AND indexname IN ('idx_lp_prospects_phone','idx_lp_prospects_phone_alt',
--                       'idx_lp_leads_phone_alt','idx_lp_leads_prospect_id');
--   -- expect 4 rows
--
-- Confirm the planner actually uses one (should be an Index Scan, not Seq):
--   EXPLAIN SELECT lp_prospect_id FROM lp_prospects WHERE phone = '7273302574';
