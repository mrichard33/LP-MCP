-- ─── 048 — Band-level capacity aggregate + submission horizon ────────────────
--
-- Additive. Two CREATE OR REPLACE VIEWs on NEW names. v_appt_board (sql/043)
-- and the GET /board/capacity route it backs are untouched, as are
-- lp_capacity_slots and lp_branch_market_map (read-only here).
--
-- WHY: v_appt_board aggregates slot_id AWAY. LP publishes three bands per rep
-- per day (slot_id 1=Morning, 2=Afternoon, 3=Evening) and GHL's Window Estimate
-- calendar books 18:00 / 18:30 / 19:00 — all three of which draw from the SAME
-- single LP evening slot per rep. Nothing downstream could see that. Measured
-- 2026-07-25: LP published 15 evening rep-slots company-wide against 16 GHL
-- bookings in the evening band alone.
--
-- Same LEFT JOIN + COALESCE('UNRESOLVED') discipline as 043 — a silent
-- inner-join drop is forbidden, so a branch code missing from the market map
-- surfaces as UNRESOLVED rather than vanishing from the totals.
--
-- ─── FAIL OPEN (binding rule for every consumer) ─────────────────────────────
-- Reps file availability ONCE A WEEK and NOT on a common schedule, so LP holds
-- no rows at all for a market that has not filed yet. Measured 2026-07-25:
-- FTLAU_MKT and LAKE_MKT reached only today while four other markets reached
-- 2026-08-02.
--
--   ABSENCE OF A CAPACITY ROW MEANS "NOT FILED YET", NEVER "ZERO CAPACITY".
--
-- A gate that read absence as zero would have closed Fort Lauderdale and
-- Lakeland for two weeks. v_capacity_submission_horizon exposes each market's
-- furthest filed date so callers can mark anything beyond it UNKNOWN and
-- decline to gate. These views deliberately do NOT encode the rule themselves:
-- do not SUM capacity across markets from v_appt_board_bands without joining
-- through the horizon. See reconcileBands() in src/jobs/capacity-bands.js.
--
-- TIMEZONE RULE (binding, inherited from 043): slot_date is already a plain ET
-- date written by the sweep, so it needs no cast. The only timestamptz touched
-- here is now(), which goes through AT TIME ZONE 'America/New_York'. A bare
-- ::date on a timestamptz rolls evening rows onto the next UTC day.
--
-- Idempotent — safe to re-run. Mirrored in runMigrations() (src/index.js) so a
-- fresh deploy boots with both views present.

-- ─── Band-level aggregate — the slot_id dimension 043 drops ──────────────────
CREATE OR REPLACE VIEW v_appt_board_bands AS
SELECT cs.slot_date,
       COALESCE(bm.market_code, 'UNRESOLVED') AS market,
       cs.slot_id,
       CASE cs.slot_id
         WHEN 1 THEN 'M'
         WHEN 2 THEN 'A'
         WHEN 3 THEN 'E'
         ELSE '?'                             -- LP has only ever emitted 1|2|3;
       END                                    AS band,   -- '?' beats a silent NULL
       count(*)                                AS capacity,
       count(*) FILTER (WHERE cs.has_appt)     AS booked,
       count(*) FILTER (WHERE NOT cs.has_appt) AS open_slots
FROM lp_capacity_slots cs
LEFT JOIN lp_branch_market_map bm
  ON UPPER(TRIM(bm.brn_id)) = UPPER(TRIM(cs.rep_home_market))
GROUP BY 1, 2, 3, 4;

-- ─── Per-market submission horizon — the fail-open guard ─────────────────────
-- horizon_date = the furthest day this market has filed. Dates after it are
-- UNKNOWN, never FULL.
--
-- days_filed counts FORWARD days only. Past slot_dates linger in
-- lp_capacity_slots until the sweep's staleness delete reaches them, so an
-- unfiltered count(DISTINCT slot_date) badly overstates coverage: measured
-- 2026-07-25, LAKE_MKT counts 5 distinct dates but only ONE of them is today
-- or later. Unfiltered, the market that has filed almost nothing forward looks
-- as well-covered as one that filed a full week — precisely inverting the
-- signal an operator needs.
--
-- A market that has never filed anything has NO ROW here at all. Consumers must
-- source the market universe from lp_branch_market_map, not from this view, or
-- that market silently disappears instead of showing up as unknown.
CREATE OR REPLACE VIEW v_capacity_submission_horizon AS
SELECT COALESCE(bm.market_code, 'UNRESOLVED') AS market,
       max(cs.slot_date)                      AS horizon_date,
       count(DISTINCT cs.slot_date) FILTER (
         WHERE cs.slot_date >= (now() AT TIME ZONE 'America/New_York')::date
       )                                      AS days_filed,
       max(cs.swept_at)                       AS last_swept_at
FROM lp_capacity_slots cs
LEFT JOIN lp_branch_market_map bm
  ON UPPER(TRIM(bm.brn_id)) = UPPER(TRIM(cs.rep_home_market))
GROUP BY 1;
