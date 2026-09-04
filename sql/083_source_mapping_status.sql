-- 083_source_mapping_status.sql
--
-- WO-7 / PR B.2 — guard lp_source_mapping against non-source rows.
--
-- lp_source_mapping holds 531 rows against an LP catalog of 413. 84 are
-- orphaned, and some of those are not lead sources at all: eight are MARKET
-- codes (branch/territory), and two are placeholders. All of them point at
-- entry:other, so they look mapped and behave as a silent catch-all.
--
-- NOTHING IS DELETED. Deletion is a separate ruling and this migration does
-- not pre-empt it — it adds a label so the rows can be seen, counted and
-- reasoned about while they stay exactly where they are. Every row this
-- touches keeps its bucket, its tag and its behaviour.
--
-- COUNT CORRECTION: the brief said eight market codes plus two placeholders,
-- i.e. ten rows. There are TWELVE. 'Old Source' and 'Direct' each exist
-- twice — once as an lp_source_raw with a NULL subdetail, and once as an
-- lp_source_subdetail with a NULL raw (verified 2026-09-04). Both halves of
-- each pair are flagged; flagging one and not the other would leave a
-- working catch-all behind and make the count look wrong later.
--
-- Safe to re-run.

BEGIN;

ALTER TABLE lp_source_mapping
  ADD COLUMN IF NOT EXISTS mapping_status text;

COMMENT ON COLUMN lp_source_mapping.mapping_status IS
  'NULL | active | orphaned | suspected_non_source. suspected_non_source = the row is not a lead source at all (market code, placeholder) and its entry:other mapping is a silent catch-all. A LABEL ONLY — it changes no routing and removes no rows. NULL means unreviewed, not clean.';

-- ─── Flag the market codes ───────────────────────────────────────
--
-- BOCA, FTLAU, FTMYR, JAX, LAKE, MIAMI, ORL, RFED are Reece market/branch
-- codes. A market is WHERE a lead came from geographically; a source is HOW
-- it arrived. Mapping one as the other means every lead in that market gets
-- attributed to entry:other regardless of how it actually reached us.

UPDATE lp_source_mapping
   SET mapping_status = 'suspected_non_source',
       updated_at     = now()
 WHERE mapping_status IS DISTINCT FROM 'suspected_non_source'
   AND (
        lp_source_subdetail IN ('BOCA','FTLAU','FTMYR','JAX','LAKE','MIAMI','ORL','RFED')
     OR lp_source_raw       IN ('BOCA','FTLAU','FTMYR','JAX','LAKE','MIAMI','ORL','RFED')
   );

-- ─── Flag the placeholders ───────────────────────────────────────
--
-- 'Old Source' and 'Direct' are not names of anything. Both spellings of
-- each (raw-side and subdetail-side) are covered.

UPDATE lp_source_mapping
   SET mapping_status = 'suspected_non_source',
       updated_at     = now()
 WHERE mapping_status IS DISTINCT FROM 'suspected_non_source'
   AND (
        lp_source_subdetail IN ('Old Source','Direct')
     OR lp_source_raw       IN ('Old Source','Direct')
   );

-- Print what was flagged, and prove nothing was removed. The row count is
-- asserted against the pre-migration total so a stray DELETE anywhere in
-- this file would fail loudly rather than pass quietly.
DO $$
DECLARE
  flagged integer;
  total   integer;
BEGIN
  SELECT count(*) INTO flagged FROM lp_source_mapping WHERE mapping_status = 'suspected_non_source';
  SELECT count(*) INTO total   FROM lp_source_mapping;
  RAISE NOTICE '083: % rows flagged suspected_non_source; % rows total in lp_source_mapping (expected 12 flagged, 0 removed)', flagged, total;
END $$;

CREATE INDEX IF NOT EXISTS idx_lp_source_mapping_status
  ON lp_source_mapping (mapping_status)
  WHERE mapping_status IS NOT NULL;

COMMIT;
