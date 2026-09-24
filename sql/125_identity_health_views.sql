-- 125_identity_health_views.sql
-- People-level identity views behind get_identity_health (2026-09-24).
--
-- WHY. Reporting counts LP ROWS, not PEOPLE. Measured live on 2026-09-23/24:
--
--     linked lp_leads rows (all time) ............ 30,511
--     distinct GHL contacts behind them .......... 20,120
--     GHL ids whose LP rows disagree on phone
--       or last name (suspected bad links) .......    263
--     Google PPC Windows callers in 30 days with
--       no LP record at all ......................    257
--
-- None of this was visible anywhere. These three views make it queryable, and
-- src/identity-health.js reads them for the get_identity_health MCP tool.
--
-- READ-ONLY. Views only — no table, no column, no data write.
--
-- APPLY FROM THE DASHBOARD, LP instance, as THREE SEPARATE executions in this
-- order (2 and 3 read 1's shape / nothing else). Mirrored in runMigrations()
-- (src/index.js) so a fresh deploy self-heals.
--
-- Windowing is on created_at_lp — lp_leads has no created_at column.

-- 1 ──────────────────────────────────────────────────────────────────────────
-- One row per GHL contact (a person), rolled up across every LP lead row
-- linked to them. phone_variants / name_variants > 1 means the LP rows under
-- one GHL id do not agree on who the person is.
CREATE OR REPLACE VIEW v_lead_people AS
SELECT ghl_contact_id,
  count(*) AS lp_rows,
  min(created_at_lp) AS first_lead_at,
  max(created_at_lp) AS last_lead_at,
  (array_agg(lead_source ORDER BY created_at_lp))[1] AS first_source,
  (array_agg(lead_source_detail ORDER BY created_at_lp))[1] AS first_subsource,
  (array_agg(lead_source_detail ORDER BY created_at_lp DESC))[1] AS last_subsource,
  bool_or(ever_set) AS ever_set,
  bool_or(ever_sat) AS ever_sat,
  bool_or(closed_won) AS closed_won,
  max(job_value) FILTER (WHERE closed_won) AS job_value,
  count(DISTINCT right(regexp_replace(coalesce(phone,''),'\D','','g'),10)) AS phone_variants,
  count(DISTINCT lower(coalesce(last_name,''))) AS name_variants
FROM lp_leads
WHERE ghl_contact_id IS NOT NULL
GROUP BY ghl_contact_id;

-- 2 ──────────────────────────────────────────────────────────────────────────
-- Suspected bad LP→GHL links: one GHL id, more than one phone or last name.
CREATE OR REPLACE VIEW v_identity_link_mismatches AS
SELECT * FROM v_lead_people
WHERE phone_variants > 1 OR name_variants > 1;

-- 3 ──────────────────────────────────────────────────────────────────────────
-- Five9 callers in the last 30 days whose number matches NO lp_leads phone or
-- phone_alt. Outbound-only campaigns (dispatch, confirmation, reset, rehash)
-- are excluded — those dial numbers we already have.
--
-- LEFT JOIN ... IS NULL, NOT `NOT IN`: the NOT IN form times out against
-- lp_leads (verified 2026-09-23). Do not "simplify" it back.
CREATE OR REPLACE VIEW v_unmatched_inbound_callers_30d AS
WITH lp_ph AS (
  SELECT DISTINCT right(regexp_replace(phone,'\D','','g'),10) AS p FROM lp_leads WHERE phone IS NOT NULL
  UNION
  SELECT right(regexp_replace(phone_alt,'\D','','g'),10) FROM lp_leads WHERE phone_alt IS NOT NULL
),
calls AS (
  SELECT right(regexp_replace(coalesce(ani,''),'\D','','g'),10) AS caller,
         campaign, disposition_name, received_at, duration_sec
  FROM five9_events_raw
  WHERE received_at >= now() - interval '30 days'
    AND coalesce(lp_rec_key,'') = ''
    AND campaign NOT ILIKE ALL (ARRAY['%dispatch%','%confirmation%','%reset%','%rehash%'])
)
SELECT c.caller, c.campaign,
  count(*) AS calls,
  min(c.received_at) AS first_call_at,
  max(c.received_at) AS last_call_at,
  (array_agg(c.disposition_name ORDER BY c.received_at DESC))[1] AS last_disposition,
  max(c.duration_sec) AS max_duration_sec
FROM calls c
LEFT JOIN lp_ph l ON l.p = c.caller
WHERE length(c.caller) = 10 AND l.p IS NULL
GROUP BY c.caller, c.campaign;
