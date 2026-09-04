-- ============================================================================
-- 2026-09-04 — Source queue repair + LP source catalog
--
-- WHAT
--   Repairs lp_unmapped_sources (the "sources needing a mapping" review queue),
--   retires its broken lead_count column, and adds the two objects the new
--   LP-driven source reconciler needs: lp_source_catalog and
--   v_source_volume_90d.
--
--   lp_source_mapping is NOT touched by this file. No mapping is created,
--   edited or deleted. Classification stays a human decision.
--
-- WHY — measured on production LP Supabase (project rcjcgjlqzepicbwhnnjl)
-- immediately before writing this file, 2026-09-04:
--
--   lp_source_mapping rows                                        531
--   lp_unmapped_sources rows                                      552   (all reviewed=false)
--     …of which already mapped in lp_source_mapping               372
--     …of which source_subdetail IS NULL                          175
--     …genuinely unmapped, real named sources                       5
--
--   PostgreSQL 17.6 — NULLS NOT DISTINCT (PG15+) is available.
--
--   A queue that is wrong 547 times out of 552 is a queue nobody reads. That,
--   not the mapping table, is the defect this file fixes.
--
-- ── ROOT CAUSE 1 — the 175 NULL rows: the unique index treats NULLs as distinct
--
--   src/normalization.js logUnmappedSource() upserts on
--   (source_subdetail, source_raw) against
--
--     CREATE UNIQUE INDEX idx_unmapped_src
--       ON lp_unmapped_sources(source_subdetail, source_raw);
--
--   Postgres defaults that index to NULLS DISTINCT, so (NULL, NULL) never
--   conflicts with an existing (NULL, NULL). Every source-less lead inserted a
--   brand-new row instead of upserting into the one already there. 175 rows
--   collapse to 2 distinct keys.
--
--   (src/sync-sources.js logUnmappedSource() compounded it independently: it
--   read with `.eq(col, value || '')` — empty string — but inserted `null`, so
--   its read never matched its own writes either. That path is rewritten in the
--   same PR to a single insert-if-absent upsert.)
--
-- ── ROOT CAUSE 2 — lead_count counts sync cycles, not leads
--
--   src/sync-sources.js incremented lead_count once per resolution attempt per
--   sync pass, so the column accumulates passes over the same lead forever.
--   Measured today: "Contractor Appointment Rev Share" reads 211,656 against
--   28,345 actual lp_leads rows and 179 leads in the last 90 days. The top
--   figure exceeding the whole lp_leads table is the tell.
--
--   Per the ITEM1 addendum §A3 recommendation the column is NOT repaired — it
--   is retired. Renamed rather than dropped so any reader missed by the grep
--   fails loudly instead of silently reading a stale number. Real volume comes
--   from v_source_volume_90d, computed from lp_leads on demand.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
--   Everything except step 1 is cleanly reversible:
--
--     -- step 5: drop the new objects
--     DROP VIEW  IF EXISTS v_source_volume_90d;
--     DROP TABLE IF EXISTS lp_source_reconcile_runs;
--     DROP TABLE IF EXISTS lp_source_catalog;
--
--     -- step 4: restore the counter column name (values stay as they were)
--     ALTER TABLE lp_unmapped_sources
--       RENAME COLUMN lead_count_deprecated TO lead_count;
--
--     -- step 3: un-review the rows this file reviewed
--     UPDATE lp_unmapped_sources SET reviewed = false
--      WHERE reviewed = true AND reviewed_by = 'migration:2026-09-04_source_queue_repair';
--
--     -- step 2: restore the NULLS DISTINCT index
--     DROP INDEX IF EXISTS idx_unmapped_src;
--     CREATE UNIQUE INDEX idx_unmapped_src
--       ON lp_unmapped_sources (source_subdetail, source_raw);
--
--   Step 1 (the duplicate collapse) has no automatic inverse — the deleted rows
--   were byte-identical duplicates carrying nothing but their own id and a
--   later first_seen, so there is nothing to restore. If a copy is wanted,
--   snapshot BEFORE running:
--
--     CREATE TABLE lp_unmapped_sources_undo_20260904 AS
--       SELECT * FROM lp_unmapped_sources;
--
--   The whole file runs in one transaction: a failure at any step leaves the
--   database exactly as it was.
-- ============================================================================

BEGIN;

-- ─── Guard: NULLS NOT DISTINCT requires PostgreSQL 15+ ──────────────────────
-- Fail loudly rather than silently recreating the same broken index.
DO $$
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION
      'This migration requires PostgreSQL 15 or newer for NULLS NOT DISTINCT; this server is %',
      current_setting('server_version');
  END IF;
  RAISE NOTICE 'PostgreSQL version OK: %', current_setting('server_version');
END
$$;

-- Provenance for step 3, so the rollback can target exactly the rows this file
-- reviewed and no others.
ALTER TABLE lp_unmapped_sources ADD COLUMN IF NOT EXISTS reviewed_by TEXT;

-- ─── Step 1 — collapse the duplicate queue rows ─────────────────────────────
-- Keep the earliest first_seen row per (source_subdetail, source_raw) with
-- NULLs treated as EQUAL, and roll the discarded siblings' information onto the
-- keeper first so nothing is lost: a review already recorded stays recorded,
-- and a keeper with no sample lead inherits one.
--
-- Expected ~173 deletions (175 NULL-subdetail rows collapsing to 2 keys) — the
-- printed count below is the real number.

CREATE TEMP TABLE _sq_ranked ON COMMIT DROP AS
SELECT
  id,
  first_value(id) OVER w AS keeper_id,
  row_number()    OVER w AS rn
FROM lp_unmapped_sources
WINDOW w AS (
  PARTITION BY coalesce(source_subdetail, '\x00::null'),
               coalesce(source_raw,       '\x00::null')
  ORDER BY first_seen ASC NULLS LAST, id ASC
);

UPDATE lp_unmapped_sources k
   SET reviewed          = k.reviewed OR roll.any_reviewed,
       sample_lp_lead_id = coalesce(k.sample_lp_lead_id, roll.any_sample)
  FROM (
    SELECT r.keeper_id,
           bool_or(u.reviewed)                             AS any_reviewed,
           min(u.sample_lp_lead_id) FILTER (
             WHERE u.sample_lp_lead_id IS NOT NULL)        AS any_sample
      FROM _sq_ranked r
      JOIN lp_unmapped_sources u ON u.id = r.id
     WHERE r.rn > 1
     GROUP BY r.keeper_id
  ) roll
 WHERE k.id = roll.keeper_id;

WITH del AS (
  DELETE FROM lp_unmapped_sources
   WHERE id IN (SELECT id FROM _sq_ranked WHERE rn > 1)
  RETURNING 1
)
SELECT 'step1_collapse_duplicate_queue_rows' AS step, count(*) AS rows_affected FROM del;

-- ─── Step 2 — recreate the unique index with NULL equality ──────────────────
-- This is what makes the existing ON CONFLICT (source_subdetail, source_raw)
-- upsert in src/normalization.js correct for source-less leads. No code change
-- is needed there — the index was the bug.

DROP INDEX IF EXISTS idx_unmapped_src;

CREATE UNIQUE INDEX idx_unmapped_src
  ON lp_unmapped_sources (source_subdetail, source_raw) NULLS NOT DISTINCT;

-- ─── Step 3 — mark the already-mapped rows reviewed ─────────────────────────
-- These sources have a live mapping in lp_source_mapping. They are not work.
-- Expected ~372 — the printed count below is the real number.

WITH upd AS (
  UPDATE lp_unmapped_sources u
     SET reviewed    = true,
         reviewed_by = 'migration:2026-09-04_source_queue_repair'
   WHERE u.reviewed = false
     AND EXISTS (
       SELECT 1 FROM lp_source_mapping m
        WHERE lower(trim(m.lp_source_subdetail)) = lower(trim(u.source_subdetail))
     )
  RETURNING 1
)
SELECT 'step3_mark_already_mapped_reviewed' AS step, count(*) AS rows_affected FROM upd;

-- ─── Step 4 — retire lead_count ─────────────────────────────────────────────
-- Renamed, not dropped: a reader missed by the grep now errors on a column that
-- does not exist instead of quietly reporting a number inflated by three orders
-- of magnitude. In-repo readers updated in the same PR:
--   src/sync-sources.js      — increment path removed entirely
--   src/tools/source-tools.js — ranking moved to v_source_volume_90d
--   sql/schema.sql            — bootstrap definition kept in step
-- (Reece-Dashboard was grepped: it never read this column.)

ALTER TABLE lp_unmapped_sources
  RENAME COLUMN lead_count TO lead_count_deprecated;

COMMENT ON COLUMN lp_unmapped_sources.lead_count_deprecated IS
  'DEPRECATED 2026-09-04 — counted sync cycles, not leads (values inflated up to '
  '~7x the entire lp_leads table). Do not read. Use v_source_volume_90d.';

-- ─── Step 5 — the real volume view ──────────────────────────────────────────
-- lp_leads.lead_source_detail is the LP `sourcesubdescr` field (verified
-- against the live schema, not assumed) — the same value lp_source_mapping
-- keys on as lp_source_subdetail.

CREATE OR REPLACE VIEW v_source_volume_90d AS
SELECT
  lead_source_detail,
  count(*)                                                                    AS leads_90d,
  count(*) FILTER (WHERE created_at_lp >= now() - interval '30 days')         AS leads_30d,
  max(created_at_lp)                                                          AS last_lead_at
FROM lp_leads
WHERE created_at_lp >= now() - interval '90 days'
  AND lead_source_detail IS NOT NULL
GROUP BY 1;

COMMENT ON VIEW v_source_volume_90d IS
  'Real per-source lead volume from lp_leads. Replaces the retired '
  'lp_unmapped_sources.lead_count for every ranking and alerting decision.';

-- ─── Step 6 — LP''s authoritative source catalog ────────────────────────────
-- Populated daily by src/jobs/source-reconcile.js from
-- POST /api/Leads/GetLeadsSourceSubPromoter (type=s), which returns 417 rows
-- shaped { key: "871", value: "871 - Events 2026 - Great American Home Show" }.
-- LP publishes its own source list; discovering sources lead-by-lead was always
-- the long way round.

CREATE TABLE IF NOT EXISTS lp_source_catalog (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lp_source_id          TEXT,          -- LP's numeric source id ("871")
  lp_source_raw         TEXT,          -- parent category ("Events 2026")
  lp_source_subdetail   TEXT,          -- sub-source, the intent signal
  active                BOOLEAN DEFAULT TRUE,   -- false = LP dropped it from the catalog
  first_seen            TIMESTAMPTZ DEFAULT now(),
  last_seen             TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lp_source_catalog_key
  ON lp_source_catalog (lp_source_raw, lp_source_subdetail) NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS idx_lp_source_catalog_subdetail
  ON lp_source_catalog (lower(trim(lp_source_subdetail)));

COMMENT ON TABLE lp_source_catalog IS
  'Mirror of LP''s authoritative source list. Report-only: the reconciler never '
  'writes lp_source_mapping from it — bucket and entry tag stay human decisions.';

-- ─── Step 7 — reconciler run summary ────────────────────────────────────────
-- One row per daily run: the three diffs as counts plus the detail payload
-- get_source_catalog_health serves.

CREATE TABLE IF NOT EXISTS lp_source_reconcile_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at            TIMESTAMPTZ DEFAULT now(),
  catalog_count     INTEGER,
  unmapped_count    INTEGER,
  orphaned_count    INTEGER,
  dormant_count     INTEGER,
  events_emitted    INTEGER DEFAULT 0,
  detail            JSONB
);

CREATE INDEX IF NOT EXISTS idx_lp_source_reconcile_runs_ran_at
  ON lp_source_reconcile_runs (ran_at DESC);

-- ─── Verification — the numbers to paste into the PR ────────────────────────
SELECT
  'verify' AS step,
  (SELECT count(*) FROM lp_source_mapping)                                  AS mapping_rows_untouched,
  (SELECT count(*) FROM lp_unmapped_sources)                                AS queue_rows_after,
  (SELECT count(*) FROM lp_unmapped_sources WHERE reviewed = false)         AS queue_unreviewed_after,
  (SELECT count(*) FROM lp_unmapped_sources WHERE source_subdetail IS NULL) AS null_subdetail_after,
  (SELECT count(*) FROM v_source_volume_90d)                                AS sources_with_90d_volume;

COMMIT;
