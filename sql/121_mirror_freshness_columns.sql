-- 121_mirror_freshness_columns.sql
-- verified_at / verified_from on every LP mirror table.
--
-- MIRROR means: the row shadows a record that can CHANGE upstream. Event logs
-- (lp_activities, lp_call_logs, lp_lead_disposition_history), derived
-- aggregates and deliberate snapshots are NOT mirrors and are excluded on
-- purpose — an event that happened does not go stale, and stamping one would
-- make the freshness number meaningless by diluting it with 4.6M rows that can
-- never be wrong.
--
-- Additive: new columns, new view on a NEW name. sql/120's v_lp_lead_freshness
-- is left untouched (iron law 7 — never mutate a live view).
--
-- APPLY THIS AT MERGE TIME, not "whenever". LP_VERIFIED_AT_ENABLED is already
-- true in production, so the writers name these columns the moment the code
-- deploys. runMigrations() in src/index.js mirrors the statements below as a
-- backstop, but the dashboard run is the one that is guaranteed.

ALTER TABLE lp_prospects      ADD COLUMN IF NOT EXISTS verified_at   timestamptz;
ALTER TABLE lp_prospects      ADD COLUMN IF NOT EXISTS verified_from text;
ALTER TABLE lp_notes          ADD COLUMN IF NOT EXISTS verified_at   timestamptz;
ALTER TABLE lp_notes          ADD COLUMN IF NOT EXISTS verified_from text;
ALTER TABLE lp_jobs           ADD COLUMN IF NOT EXISTS verified_at   timestamptz;
ALTER TABLE lp_jobs           ADD COLUMN IF NOT EXISTS verified_from text;
ALTER TABLE lp_job_milestones ADD COLUMN IF NOT EXISTS verified_at   timestamptz;
ALTER TABLE lp_job_milestones ADD COLUMN IF NOT EXISTS verified_from text;

-- lp_leads already has lp_verified_at (sql/120). Renaming a live column is not
-- additive and would break every reader; add the source column only.
ALTER TABLE lp_leads          ADD COLUMN IF NOT EXISTS verified_from text;

COMMENT ON COLUMN lp_prospects.verified_at IS
  'Last compare against the live upstream record (match or rewrite). See docs/data-freshness-rulebook.md.';

-- One number for the whole mirror surface. Active = touched by LP in the last
-- year, so dormant history does not drag the percentage down forever.
-- lp_prospects and lp_job_milestones have no created_at_lp column, which is why
-- those two branches filter on synced_at.
CREATE OR REPLACE VIEW v_supabase_freshness AS
WITH parts AS (
  SELECT 'lp_leads'::text AS table_name, lp_verified_at AS verified_at
    FROM lp_leads WHERE created_at_lp >= now() - interval '365 days'
  UNION ALL
  SELECT 'lp_prospects', verified_at
    FROM lp_prospects WHERE synced_at >= now() - interval '365 days'
  UNION ALL
  SELECT 'lp_notes', verified_at
    FROM lp_notes WHERE created_at_lp >= now() - interval '365 days'
  UNION ALL
  SELECT 'lp_jobs', verified_at
    FROM lp_jobs WHERE synced_at >= now() - interval '365 days'
  UNION ALL
  SELECT 'lp_job_milestones', verified_at
    FROM lp_job_milestones WHERE synced_at >= now() - interval '365 days'
)
SELECT
  table_name,
  count(*)                                                                AS active_rows,
  count(*) FILTER (WHERE verified_at >= now() - interval '1 day')         AS verified_24h,
  count(*) FILTER (WHERE verified_at >= now() - interval '7 days')        AS verified_7d,
  count(*) FILTER (WHERE verified_at IS NULL)                             AS never_verified,
  round(100.0 * count(*) FILTER (WHERE verified_at >= now() - interval '7 days')
        / greatest(count(*), 1), 2)                                       AS pct_verified_7d
FROM parts
GROUP BY table_name
ORDER BY active_rows DESC;

-- ─── RUN THIS SEPARATELY ──────────────────────────────────────────────────
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction, so it must be its
-- OWN execution in the dashboard, after the statements above have committed.
-- It is deliberately absent from runMigrations() for the same reason.
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lp_leads_verified_at
--     ON lp_leads (lp_verified_at NULLS FIRST);
