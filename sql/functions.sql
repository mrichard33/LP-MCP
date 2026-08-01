-- LP MCP Server — Supabase RPC Functions v3.1
--
-- v3.1: Exclude NOC (Not Covered) and NIS (Not Issued) dispositions from demo
--       counts. These are sits LP marks Sat=true but that should not count as
--       demos for Reece metrics. Applied at the reporting/count layer only —
--       demo_completed in lp_leads still mirrors LP faithfully. appointment_set,
--       closed_won, and lead counts are unchanged.

-- =============================================================
-- get_source_distribution — Priority Query #1
-- =============================================================
CREATE OR REPLACE FUNCTION get_source_distribution(p_limit INT, p_unmapped_only BOOL)
RETURNS TABLE (
  source_subdetail  TEXT,
  source_raw        TEXT,
  lead_count        BIGINT,
  demos_set         BIGINT,
  close_count       BIGINT,
  close_rate        NUMERIC,
  avg_job_value     NUMERIC,
  ghl_bucket        TEXT,
  needs_mapping     BOOL
) AS $$
  SELECT
    l.lead_source_detail,
    l.lead_source,
    COUNT(*) AS lead_count,
    COUNT(*) FILTER (WHERE (l.demo_completed AND l.disposition_code NOT IN ('NOC','NIS'))) AS demos_set,
    COUNT(*) FILTER (WHERE l.closed_won) AS close_count,
    ROUND(100.0 * COUNT(*) FILTER (WHERE l.closed_won) / NULLIF(COUNT(*),0), 1) AS close_rate,
    ROUND(AVG(l.job_value) FILTER (WHERE l.closed_won), 0) AS avg_job_value,
    m.ghl_intent_bucket AS ghl_bucket,
    (m.ghl_intent_bucket IS NULL) AS needs_mapping
  FROM lp_leads l
  LEFT JOIN lp_source_mapping m
    ON (m.lp_source_subdetail = l.lead_source_detail AND m.lp_source_subdetail IS NOT NULL)
    OR (m.lp_source_subdetail IS NULL AND m.lp_source_raw = l.lead_source)
  WHERE (NOT p_unmapped_only OR m.ghl_intent_bucket IS NULL)
  GROUP BY l.lead_source_detail, l.lead_source, m.ghl_intent_bucket
  ORDER BY lead_count DESC
  LIMIT p_limit;
$$ LANGUAGE sql;

-- =============================================================
-- get_time_to_demo_by_source — Priority Query #2
-- =============================================================
CREATE OR REPLACE FUNCTION get_time_to_demo_by_source()
RETURNS TABLE (
  source_subdetail   TEXT,
  source_raw         TEXT,
  ghl_bucket         TEXT,
  total_leads        BIGINT,
  demos_completed    BIGINT,
  demo_rate          NUMERIC,
  avg_days_to_demo   NUMERIC,
  min_days_to_demo   INTEGER,
  max_days_to_demo   INTEGER,
  median_days_to_demo NUMERIC
) AS $$
  SELECT
    l.lead_source_detail,
    l.lead_source,
    COALESCE(m.ghl_intent_bucket, 'unmapped') AS ghl_bucket,
    COUNT(*) AS total_leads,
    COUNT(*) FILTER (WHERE (l.demo_completed AND l.disposition_code NOT IN ('NOC','NIS'))) AS demos_completed,
    ROUND(100.0 * COUNT(*) FILTER (WHERE (l.demo_completed AND l.disposition_code NOT IN ('NOC','NIS'))) / NULLIF(COUNT(*), 0), 1) AS demo_rate,
    ROUND(AVG(l.days_to_demo) FILTER (WHERE (l.demo_completed AND l.disposition_code NOT IN ('NOC','NIS'))), 1) AS avg_days_to_demo,
    MIN(l.days_to_demo) FILTER (WHERE (l.demo_completed AND l.disposition_code NOT IN ('NOC','NIS'))) AS min_days_to_demo,
    MAX(l.days_to_demo) FILTER (WHERE (l.demo_completed AND l.disposition_code NOT IN ('NOC','NIS'))) AS max_days_to_demo,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY l.days_to_demo) FILTER (WHERE (l.demo_completed AND l.disposition_code NOT IN ('NOC','NIS')))::numeric, 1) AS median_days_to_demo
  FROM lp_leads l
  LEFT JOIN lp_source_mapping m
    ON (m.lp_source_subdetail = l.lead_source_detail AND m.lp_source_subdetail IS NOT NULL)
    OR (m.lp_source_subdetail IS NULL AND m.lp_source_raw = l.lead_source)
  GROUP BY l.lead_source_detail, l.lead_source, m.ghl_intent_bucket
  HAVING COUNT(*) FILTER (WHERE (l.demo_completed AND l.disposition_code NOT IN ('NOC','NIS'))) > 0
  ORDER BY demos_completed DESC;
$$ LANGUAGE sql;

-- =============================================================
-- get_day15_disposition_breakdown — Priority Query #3
-- =============================================================
CREATE OR REPLACE FUNCTION get_day15_disposition_breakdown(p_days_inactive_min INT)
RETURNS TABLE (
  disposition_code    TEXT,
  disposition_label   TEXT,
  lead_count          BIGINT,
  pct_of_total        NUMERIC,
  demo_set_count      BIGINT,
  demo_completed_count BIGINT,
  avg_job_value       NUMERIC,
  avg_days_inactive   NUMERIC
) AS $$
  WITH day15_leads AS (
    SELECT *
    FROM lp_leads
    WHERE created_at_lp <= now() - (p_days_inactive_min || ' days')::INTERVAL
      AND NOT closed_won
  )
  SELECT
    COALESCE(d.disposition_code, 'NO_DISPOSITION') AS disposition_code,
    COALESCE(d.disposition_label, 'No Disposition Set') AS disposition_label,
    COUNT(*) AS lead_count,
    ROUND(100.0 * COUNT(*) / NULLIF(SUM(COUNT(*)) OVER (), 0), 1) AS pct_of_total,
    COUNT(*) FILTER (WHERE d.appointment_set) AS demo_set_count,
    COUNT(*) FILTER (WHERE d.demo_completed AND d.disposition_code NOT IN ('NOC','NIS')) AS demo_completed_count,
    ROUND(AVG(d.job_value), 0) AS avg_job_value,
    ROUND(AVG(EXTRACT(EPOCH FROM (now() - d.last_contact_date)) / 86400), 0) AS avg_days_inactive
  FROM day15_leads d
  GROUP BY d.disposition_code, d.disposition_label
  ORDER BY lead_count DESC;
$$ LANGUAGE sql;

-- =============================================================
-- get_close_rate_by_source — Priority Query #4
-- =============================================================
CREATE OR REPLACE FUNCTION get_close_rate_by_source()
RETURNS TABLE (
  source_subdetail    TEXT,
  source_raw          TEXT,
  ghl_bucket          TEXT,
  total_leads         BIGINT,
  demos_set           BIGINT,
  demos_completed     BIGINT,
  closed_won_count    BIGINT,
  lead_to_demo_rate   NUMERIC,
  demo_to_close_rate  NUMERIC,
  lead_to_close_rate  NUMERIC,
  avg_job_value       NUMERIC,
  total_revenue       NUMERIC
) AS $$
  SELECT
    l.lead_source_detail,
    l.lead_source,
    COALESCE(m.ghl_intent_bucket, 'unmapped') AS ghl_bucket,
    COUNT(*) AS total_leads,
    COUNT(*) FILTER (WHERE l.appointment_set) AS demos_set,
    COUNT(*) FILTER (WHERE (l.demo_completed AND l.disposition_code NOT IN ('NOC','NIS'))) AS demos_completed,
    COUNT(*) FILTER (WHERE l.closed_won) AS closed_won_count,
    ROUND(100.0 * COUNT(*) FILTER (WHERE (l.demo_completed AND l.disposition_code NOT IN ('NOC','NIS'))) / NULLIF(COUNT(*), 0), 1) AS lead_to_demo_rate,
    ROUND(100.0 * COUNT(*) FILTER (WHERE l.closed_won) / NULLIF(COUNT(*) FILTER (WHERE (l.demo_completed AND l.disposition_code NOT IN ('NOC','NIS'))), 0), 1) AS demo_to_close_rate,
    ROUND(100.0 * COUNT(*) FILTER (WHERE l.closed_won) / NULLIF(COUNT(*), 0), 1) AS lead_to_close_rate,
    ROUND(AVG(l.job_value) FILTER (WHERE l.closed_won), 0) AS avg_job_value,
    ROUND(SUM(l.job_value) FILTER (WHERE l.closed_won), 0) AS total_revenue
  FROM lp_leads l
  LEFT JOIN lp_source_mapping m
    ON (m.lp_source_subdetail = l.lead_source_detail AND m.lp_source_subdetail IS NOT NULL)
    OR (m.lp_source_subdetail IS NULL AND m.lp_source_raw = l.lead_source)
  GROUP BY l.lead_source_detail, l.lead_source, m.ghl_intent_bucket
  HAVING COUNT(*) >= 5
  ORDER BY total_leads DESC;
$$ LANGUAGE sql;

-- =============================================================
-- get_rep_performance — Rep analytics
-- =============================================================
--
-- 2026-08-01: repaired. This returned [] for EVERY date range because it
-- filtered `AND l.rep_id IS NOT NULL` and rep_id is NULL on 227,710 of 227,710
-- rows — the sync never maps it and no LP source field is known. It now groups
-- on rep_name; rep_id stays in the GROUP BY so no caller breaks.
--
-- DROP before CREATE is REQUIRED, not cosmetic: adding sit_rate changes the
-- RETURNS TABLE column list, and Postgres rejects a return-type change on
-- CREATE OR REPLACE ("cannot change return type of existing function").
-- Verified 0 dependents in pg_depend, so the drop is safe and non-cascading.
DROP FUNCTION IF EXISTS get_rep_performance(TIMESTAMPTZ, TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION get_rep_performance(p_start_date TIMESTAMPTZ, p_end_date TIMESTAMPTZ)
RETURNS TABLE (
  rep_id              TEXT,
  rep_name            TEXT,
  total_leads         BIGINT,
  total_calls         BIGINT,
  demos_set           BIGINT,
  demos_completed     BIGINT,
  closed_won_count    BIGINT,
  total_revenue       NUMERIC,
  avg_job_value       NUMERIC,
  set_rate            NUMERIC,
  sit_rate            NUMERIC,
  close_rate          NUMERIC,
  avg_calls_per_lead  NUMERIC
) AS $$
  SELECT
    l.rep_id,
    l.rep_name,
    COUNT(DISTINCT l.lp_lead_id) AS total_leads,
    SUM(l.call_count) AS total_calls,
    COUNT(*) FILTER (WHERE l.appointment_set) AS demos_set,
    COUNT(*) FILTER (WHERE (l.demo_completed AND l.disposition_code NOT IN ('NOC','NIS'))) AS demos_completed,
    COUNT(*) FILTER (WHERE l.closed_won) AS closed_won_count,
    ROUND(SUM(l.job_value) FILTER (WHERE l.closed_won), 0) AS total_revenue,
    ROUND(AVG(l.job_value) FILTER (WHERE l.closed_won), 0) AS avg_job_value,
    ROUND(100.0 * COUNT(*) FILTER (WHERE l.appointment_set) / NULLIF(COUNT(*), 0), 1) AS set_rate,
    -- Sit rate = ran / scheduled. demo_date is written only when the
    -- appointment ran; appointment_date is written on every scheduled
    -- appointment, so it is the no-show-inclusive denominator. Healthy 65-80%.
    ROUND(100.0 * COUNT(l.demo_date) / NULLIF(COUNT(l.appointment_date), 0), 1) AS sit_rate,
    ROUND(100.0 * COUNT(*) FILTER (WHERE l.closed_won) / NULLIF(COUNT(*) FILTER (WHERE (l.demo_completed AND l.disposition_code NOT IN ('NOC','NIS'))), 0), 1) AS close_rate,
    ROUND(SUM(l.call_count)::NUMERIC / NULLIF(COUNT(DISTINCT l.lp_lead_id), 0), 1) AS avg_calls_per_lead
  FROM lp_leads l
  -- Anchored on appointment_date: the question is "what did this rep run in
  -- the window", not "which leads were created in it". created_at_lp made a
  -- lead synced today but created in 2019 invisible to every recent window.
  WHERE l.appointment_date >= p_start_date
    AND l.appointment_date <  p_end_date
    AND l.rep_name IS NOT NULL
    AND btrim(l.rep_name) <> ''
  GROUP BY l.rep_id, l.rep_name
  ORDER BY total_revenue DESC NULLS LAST;
$$ LANGUAGE sql;

-- =============================================================
-- get_pipeline_summary — Pipeline stage counts and values
-- =============================================================
CREATE OR REPLACE FUNCTION get_pipeline_summary()
RETURNS TABLE (
  disposition_code    TEXT,
  disposition_label   TEXT,
  category            TEXT,
  lead_count          BIGINT,
  total_value         NUMERIC,
  avg_value           NUMERIC,
  pct_of_total        NUMERIC
) AS $$
  SELECT
    COALESCE(l.disposition_code, 'NONE') AS disposition_code,
    COALESCE(l.disposition_label, 'No Disposition') AS disposition_label,
    COALESCE(d.category, 'unknown') AS category,
    COUNT(*) AS lead_count,
    ROUND(SUM(l.job_value), 0) AS total_value,
    ROUND(AVG(l.job_value), 0) AS avg_value,
    ROUND(100.0 * COUNT(*) / NULLIF(SUM(COUNT(*)) OVER (), 0), 1) AS pct_of_total
  FROM lp_leads l
  LEFT JOIN lp_dispositions d ON d.disposition_code = l.disposition_code
  GROUP BY l.disposition_code, l.disposition_label, d.category
  ORDER BY lead_count DESC;
$$ LANGUAGE sql;
