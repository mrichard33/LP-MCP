-- 053_setter_performance.sql — setter analytics by channel (2026-08-01)
--
-- Distinct from get_rep_performance: rep_name is the SALES rep who ran the
-- appointment; set_by_name is whoever booked it. Two teams, two reports.
--
-- ANCHORED ON appointment_date, NOT demo_date. demo_date exists only on
-- appointments that ran, so anchoring there returns 100% sit for every
-- setter — the artifact that made the first version of this report useless.
--
-- GROUPED BY (set_by_name, lead_source_detail) BY DESIGN. `No, Setter` is
-- LP's value for CANVASSING — the canvasser books in the field and there is
-- no phone setter. That is correct and expected, not a data gap. But the
-- same value also appears on Internet/Affiliate leads, where it means the
-- appointment genuinely has no setter attributed. Measured Jul 5-26:
--   No, Setter + Canvass          345 appts, 48.7% sit  (above the 36.6% baseline)
--   No, Setter + Lead Gurus       113 appts,  9.7% sit
--   No, Setter + MVP Marketing     39 appts, 10.3% sit
-- Blending those produced a meaningless 37.4%. NEVER aggregate set_by_name
-- across sources, and do not add a setter-level rollup column — the blend is
-- the exact number this design exists to suppress.
--
-- p_min_appts defaults to 5, not 20. Once rows are split by source a named
-- setter's volume fragments across 2-4 sources, and a threshold of 20 drops
-- every phone setter but one. 5 is above the noise floor and still excludes
-- 1-2 appt rows. Raise it via the parameter for longer windows.
CREATE OR REPLACE FUNCTION get_setter_performance(
  p_start_date TIMESTAMPTZ,
  p_end_date   TIMESTAMPTZ,
  p_min_appts  INT DEFAULT 5
)
RETURNS TABLE (
  set_by_name        TEXT,
  lead_source_detail TEXT,
  set_channel        TEXT,
  appts_scheduled    BIGINT,
  appts_ran          BIGINT,
  sit_rate           NUMERIC,
  confirmed_count    BIGINT,
  confirm_rate       NUMERIC,
  closed_won_count   BIGINT,
  close_rate_on_net  NUMERIC,
  total_revenue      NUMERIC
) AS $$
  SELECT
    l.set_by_name,
    l.lead_source_detail,
    -- How the appointment was booked. Drives which benchmark applies:
    -- canvass_field is judged against the Canvass baseline (~36.6%), never
    -- against the 65-80% phone band. unset_inbound is the true gap bucket,
    -- and also catches rows with a NULL source (the = 'Canvass' test is NULL
    -- for them, so they fall through to it — the correct bucket).
    CASE
      WHEN l.set_by_name = 'No, Setter' AND l.lead_source_detail = 'Canvass'
        THEN 'canvass_field'
      WHEN l.set_by_name = 'No, Setter'
        THEN 'unset_inbound'
      WHEN l.set_by_name = 'Integration, GoHighLevel'
        THEN 'integration'
      WHEN l.set_by_name LIKE '%- LF,%'
        THEN 'partner_phone'
      ELSE 'phone_setter'
    END AS set_channel,
    COUNT(*)                                   AS appts_scheduled,
    COUNT(l.demo_date)                         AS appts_ran,
    ROUND(100.0 * COUNT(l.demo_date) / NULLIF(COUNT(*), 0), 1) AS sit_rate,
    COUNT(*) FILTER (WHERE l.ever_confirmed)   AS confirmed_count,
    ROUND(100.0 * COUNT(*) FILTER (WHERE l.ever_confirmed) / NULLIF(COUNT(*), 0), 1) AS confirm_rate,
    COUNT(*) FILTER (WHERE l.closed_won)       AS closed_won_count,
    -- Close rate is always off NET (ran), never off set. Dividing by
    -- scheduled blames the floor for a confirmation problem.
    ROUND(100.0 * COUNT(*) FILTER (WHERE l.closed_won) / NULLIF(COUNT(l.demo_date), 0), 1) AS close_rate_on_net,
    ROUND(SUM(l.job_value) FILTER (WHERE l.closed_won), 0) AS total_revenue
  FROM lp_leads l
  WHERE l.appointment_date >= p_start_date
    AND l.appointment_date <  p_end_date
    AND l.set_by_name IS NOT NULL
  GROUP BY l.set_by_name, l.lead_source_detail
  HAVING COUNT(*) >= p_min_appts
  ORDER BY appts_scheduled DESC;
$$ LANGUAGE sql;

COMMENT ON FUNCTION get_setter_performance IS
'Setter performance by (setter, source), appointment_date-anchored so no-shows stay in the denominator. set_channel distinguishes canvass_field (No, Setter on Canvass — booked in the field, benchmark ~36.6%) from unset_inbound (No, Setter on web/affiliate, or on a NULL source — a real attribution gap) and phone_setter (benchmark 65-80%). Never aggregate set_by_name across sources: the same name spans channels with 5x different sit rates. p_min_appts defaults to 5 because source splitting fragments a named setter across 2-4 sources; at 20 only one phone setter survives a 3-week window.';
