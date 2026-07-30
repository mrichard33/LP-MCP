-- ─── lp_name_variant_counts() — supports src/jobs/lp-name-drift-check.js ───
--
-- OPTIONAL BUT RECOMMENDED. The drift check works without this function: it
-- falls back to a paged client-side scan of lp_leads. On ~100K rows the fallback
-- is roughly 10 round trips and a few seconds. This function collapses that to a
-- single grouped scan.
--
-- Run once in the Supabase SQL Editor (DDL cannot go through supabase_run_query).
-- Idempotent — safe to re-run.
--
-- WHY THIS EXISTS
--   lp_leads stores set_by_name / confirmed_by_name / verified_by_name as
--   denormalized text frozen at sync time. An LP user rename splits one person's
--   history across two strings with nothing to flag it. This function returns
--   every distinct name string per column with its row count and most recent
--   sync, which is all the drift checker needs to spot the split.

CREATE OR REPLACE FUNCTION lp_name_variant_counts()
RETURNS TABLE (
  column_name  text,
  name         text,
  row_count    bigint,
  last_synced  timestamptz
)
LANGUAGE sql
STABLE
AS $$
  SELECT 'set_by_name'::text AS column_name,
         set_by_name         AS name,
         count(*)            AS row_count,
         max(synced_at)      AS last_synced
    FROM lp_leads
   WHERE set_by_name IS NOT NULL
   GROUP BY set_by_name

  UNION ALL

  SELECT 'confirmed_by_name'::text,
         confirmed_by_name,
         count(*),
         max(synced_at)
    FROM lp_leads
   WHERE confirmed_by_name IS NOT NULL
   GROUP BY confirmed_by_name

  UNION ALL

  SELECT 'verified_by_name'::text,
         verified_by_name,
         count(*),
         max(synced_at)
    FROM lp_leads
   WHERE verified_by_name IS NOT NULL
   GROUP BY verified_by_name
$$;

COMMENT ON FUNCTION lp_name_variant_counts() IS
  'Distinct setter/confirmer/verifier name strings in lp_leads with row counts and '
  'last sync time. Feeds the nightly name-drift watchdog, which detects LP user '
  'renames that silently split one person''s history across two denormalized name '
  'strings. See src/jobs/lp-name-drift-check.js.';
