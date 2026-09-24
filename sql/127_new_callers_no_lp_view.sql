-- 127_new_callers_no_lp_view.sql
-- Brand-new callers who stayed on the line with an agent but never reached LP
-- (2026-09-24). Read by get_identity_health (src/identity-health.js).
--
-- WHY. The question was "are agents typing new callers into Five9 and it never
-- reaches LP?". Measured 2026-09-24, the answer is no — there is no Five9→LP
-- path for a new caller at all:
--
--   - The "LeadPerfection" web connector pops LP's own Five9ConnectorLookup
--     page in a separate browser on OnCallAccepted. A new lead is created THERE,
--     in LP. Five9 has no worksheet and no custom fields for caller details.
--   - The Five9 contact records for the longest unmatched callers are blank
--     (no name, address or CustID; one carries a first name only).
--   - All 72 "Google PPC Windows" LP leads in 30 days were web-form leads; none
--     was created around a phone call. 62 of the 65 inbound "Appointment Set"
--     calls that matched LP were people LP already had.
--
-- So the gap is process: a brand-new caller is usually never entered in LP.
-- Nothing reported it. This view counts it, per call, with the agent and team,
-- so it can be watched and taken to the call center.
--
-- CLASSIFY BEFORE YOU THRESHOLD (CLAUDE.md). The exclusions are named, not
-- tuned away with a higher duration floor:
--   - dispositions that are not a new sales lead: Service Call, Do Not Call,
--     DNC, Bad Data, Confirmed (an existing appointment), Spanish (routed to
--     the Spanish list);
--   - OUR OWN NUMBERS as the caller. On an outbound call Five9 records our
--     caller ID as the ANI, and without this anti-join those rows read as
--     dozens of "new callers" who are really us. "Ours" = a number seen with
--     20+ distinct counterpart numbers in 30 days (see the `own` CTE);
--   - outbound-only campaigns (dispatch / confirmation / reset / rehash), the
--     same patterns v_unmatched_inbound_callers_30d excludes;
--   - any call already carrying an LP key.
--
-- `minutes` is Five9's call start→end: time ON THE LINE, which can include IVR
-- and queue time — not talk time. The tool labels it that way.
--
-- LEFT JOIN ... IS NULL, never NOT IN: the NOT IN form times out against
-- lp_leads (verified 2026-09-23, sql/125).
--
-- team: ci_agent_map (one row per name) on the agent name with the " - XX" ending removed; else
-- the ending itself (LF → lightfire, NC → north_carolina); else 'unmapped'.
--
-- READ-ONLY view. APPLY FROM THE DASHBOARD, LP instance, one execution.
-- Mirrored in runMigrations() (src/index.js) so a fresh deploy self-heals.

CREATE OR REPLACE VIEW v_new_callers_no_lp_30d AS
WITH lp_ph AS (
  SELECT DISTINCT right(regexp_replace(phone,'\D','','g'),10) AS p FROM lp_leads WHERE phone IS NOT NULL
  UNION
  SELECT right(regexp_replace(phone_alt,'\D','','g'),10) FROM lp_leads WHERE phone_alt IS NOT NULL
),
own AS (
  -- Our numbers are the ones shared across MANY other numbers: a caller ID we
  -- dial out on (one ANI, many DNIS) or a tracking line people call (one DNIS,
  -- many ANI). "Every DNIS ever seen" would be wrong — on an outbound call the
  -- DNIS is the CUSTOMER, so it would hide every new caller we later rang back.
  SELECT right(regexp_replace(ani,'\D','','g'),10) AS p
    FROM five9_events_raw WHERE received_at >= now() - interval '30 days' AND ani IS NOT NULL
   GROUP BY 1 HAVING count(DISTINCT dnis) >= 20
  UNION
  SELECT right(regexp_replace(dnis,'\D','','g'),10)
    FROM five9_events_raw WHERE received_at >= now() - interval '30 days' AND dnis IS NOT NULL
   GROUP BY 1 HAVING count(DISTINCT ani) >= 20
),
agent_team AS (
  -- One team per name, so a duplicated map row can never double-count a call.
  SELECT DISTINCT ON (lower(agent_name)) lower(agent_name) AS name_key, team
    FROM ci_agent_map WHERE agent_name IS NOT NULL
   ORDER BY lower(agent_name), active DESC NULLS LAST, updated_at DESC NULLS LAST
),
calls AS (
  SELECT right(regexp_replace(coalesce(e.ani,''),'\D','','g'),10) AS caller,
         e.campaign,
         e.disposition_name AS disposition,
         round(e.duration_sec / 60.0, 1) AS minutes,
         e.agent_name,
         e.received_at AS call_at,
         coalesce(m.team,
                  CASE substring(e.agent_name from ' - ([A-Za-z]+)$')
                    WHEN 'LF' THEN 'lightfire'
                    WHEN 'NC' THEN 'north_carolina'
                  END,
                  'unmapped') AS team
  FROM five9_events_raw e
  LEFT JOIN agent_team m
         ON m.name_key = lower(regexp_replace(e.agent_name, ' - [A-Za-z]+$', ''))
  WHERE e.event_type = 'disposition'
    AND e.received_at >= now() - interval '30 days'
    AND coalesce(e.lp_rec_key,'') = ''
    AND coalesce(e.agent_name,'') <> ''
    AND e.duration_sec >= 120
    AND e.campaign NOT ILIKE ALL (ARRAY['%dispatch%','%confirmation%','%reset%','%rehash%'])
    AND coalesce(e.disposition_name,'') NOT IN
        ('Service Call','Do Not Call','DNC','Bad Data','Confirmed','Spanish - Send data to Spanish list')
)
SELECT c.caller, c.campaign, c.disposition, c.minutes, c.agent_name, c.team, c.call_at
FROM calls c
LEFT JOIN lp_ph l ON l.p = c.caller
LEFT JOIN own   o ON o.p = c.caller
WHERE length(c.caller) = 10
  AND l.p IS NULL
  AND o.p IS NULL;
