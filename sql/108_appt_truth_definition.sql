-- 108_appt_truth_definition.sql
-- Canonical appointment-count definition for Lead Perfection.
--
-- STATUS: NOT APPLIED. Ships as a file for review. Apply from the dashboard
-- (DDL is dashboard-only) after Mark signs off.
--
-- WHY THIS EXISTS
-- The 2026-09-14 reconciliation produced five different "confirmed" counts for
-- the same day (42, 43, 44, 45, 46). Every one of them was a real number read
-- from a real place. The problem was never a defect - it was five definitions
-- with no published winner. This file publishes the winner and the arithmetic
-- that proves it.
--
-- EVIDENCE (live, 2026-09-14 14:00Z snapshot / 14:19Z lp_leads sync)
--
--   slot_date 2026-09-14, lp_leads by disposition_code:
--     Issue 41 | Cnf 2 | Set 24 | Verif 1 | CXL 19 | ND 4
--     -> Cnf + Issue                     = 43   <- matches the 09:50 export footer
--     -> appointment_confirmed = true    = 45   (41 Issue + 2 Cnf + 2 ND)
--
--   lp_appt_fill_hourly, 2026-09-14 @ 14:00Z, per market:
--     FTLAU 0 | FTMYR 14 | JAX 5 | LAKE 2 | ORL 10 | SAR 2 | STPET 10  = 43
--     UNRESOLVED 1 | OUT_OF_AREA 0                                     = +1
--     -> naive SUM(confirmed) = 44, market-scoped = 43
--
-- THE KEY FINDING: lp_appt_fill_hourly and lp_leads DO reconcile. The apparent
-- divergence came from summing nine buckets (seven markets plus UNRESOLVED and
-- OUT_OF_AREA) against a seven-market table. Any report that does a bare
-- SUM(confirmed) over lp_appt_fill_hourly inherits that inflation. The two
-- catch-all buckets must be reported separately, never summed into a market
-- total - they are a data-quality signal, not capacity.
--
-- CANONICAL DEFINITIONS
--   confirmed   = disposition_code IN ('Cnf','Issue')
--                 'Issue' means the sheet has been issued to the rep. It is the
--                 stage AFTER confirmation and happens on the appointment day.
--                 A report filtering Dispo = 'Cnf' alone returned 3 instead of 43.
--   set_pending = disposition_code IN ('Set','Verif')
--                 'Verif' is a pre-confirmation state and counts as SET.
--                 Write this on disposition_code, NEVER on appointment_verified:
--                 one Issue record on 2026-09-14 also carries verified = true,
--                 so a flag-based definition pulls an issued appointment into set.
--   cancelled   = disposition_code = 'CXL'
--                 NOT the cancelled-report row count: 4 of 22 rows on 2026-09-14
--                 were ND with no cancel date and 2 of those 4 were confirmed.
--   live        = confirmed + set_pending
--
-- KNOWN LIMITATION - READ BEFORE USING FOR HISTORY
-- lp_leads holds CURRENT state. After the appointment day, dispositions advance
-- past Cnf/Issue into sat/sold/demo outcomes, so v_appt_truth_daily under-reports
-- confirmed for past dates (2026-09-09 reads 3 against the hourly feed's 90).
-- For history use the immutable lp_appt_fill_hourly snapshot. For today and
-- forward dates use v_appt_truth_daily. This split is by design, not a defect.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Current-state truth, from lp_leads. Use for today and future dates.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_appt_truth_daily AS
SELECT
  appointment_date::date                                                     AS slot_date,
  count(*) FILTER (WHERE disposition_code IN ('Cnf','Issue'))                AS confirmed,
  count(*) FILTER (WHERE disposition_code IN ('Set','Verif'))                AS set_pending,
  count(*) FILTER (WHERE disposition_code IN ('Cnf','Issue','Set','Verif'))  AS live_total,
  count(*) FILTER (WHERE disposition_code = 'Issue')                         AS issued,
  count(*) FILTER (WHERE disposition_code = 'CXL')                           AS cancelled,
  count(*) FILTER (WHERE disposition_code = 'ND')                            AS nd_rows,
  -- Data-quality flags. Both should be zero. Non-zero means records need
  -- correcting in LP, not filtering out of a report.
  count(*) FILTER (WHERE disposition_code = 'ND'
                     AND appointment_confirmed)                              AS nd_but_confirmed,
  count(*) FILTER (WHERE disposition_code IN ('Set','Verif')
                     AND confirmed_date IS NOT NULL)                         AS set_but_confirmed,
  max(synced_at)                                                             AS last_synced_at
FROM lp_leads
WHERE appointment_date IS NOT NULL
GROUP BY 1;

COMMENT ON VIEW v_appt_truth_daily IS
  'Canonical LP appointment counts for today and forward dates. confirmed = Cnf+Issue, set_pending = Set+Verif. Current-state only - under-reports past dates by design; use lp_appt_fill_hourly for history. Added sql/108, 2026-09-14.';

-- ---------------------------------------------------------------------------
-- 2. Hourly snapshot with the catch-all buckets separated. Use for history,
--    for the capacity board, and for any trend line.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_appt_fill_hourly_markets AS
SELECT
  slot_date,
  snapshot_hour,
  sum(requested)   FILTER (WHERE market NOT IN ('UNRESOLVED','OUT_OF_AREA')) AS requested,
  sum(confirmed)   FILTER (WHERE market NOT IN ('UNRESOLVED','OUT_OF_AREA')) AS confirmed,
  sum(set_pending) FILTER (WHERE market NOT IN ('UNRESOLVED','OUT_OF_AREA')) AS set_pending,
  -- Never add these into a market total. Non-zero = appointments with no market
  -- assigned (e.g. LP 459032 PEREZ, blank market) or outside the service area.
  coalesce(sum(confirmed)   FILTER (WHERE market IN ('UNRESOLVED','OUT_OF_AREA')), 0) AS confirmed_unattributed,
  coalesce(sum(set_pending) FILTER (WHERE market IN ('UNRESOLVED','OUT_OF_AREA')), 0) AS set_pending_unattributed
FROM lp_appt_fill_hourly
GROUP BY 1, 2;

COMMENT ON VIEW v_appt_fill_hourly_markets IS
  'lp_appt_fill_hourly with UNRESOLVED and OUT_OF_AREA split out of the market totals. A bare SUM over the base table inflates confirmed by the unattributed count. Added sql/108, 2026-09-14.';

COMMIT;

-- ---------------------------------------------------------------------------
-- VERIFICATION - run after applying. Expected values as of 2026-09-14.
-- ---------------------------------------------------------------------------
--
-- A. Today's truth. Expect confirmed 43, set_pending 25, nd_but_confirmed 2.
--    nd_but_confirmed = 2 is the open defect (LP 355684 Marlatt, 383803
--    Buchalski) - confirmed appointments wearing an ND disposition inside the
--    cancelled report. Expect it to go to 0 once those records are corrected.
--
--    SELECT * FROM v_appt_truth_daily WHERE slot_date = CURRENT_DATE;
--
-- B. The two sources agree at the same instant. Expect diff 0 on the market
--    columns for the current date.
--
--    SELECT t.slot_date, t.confirmed AS leads_confirmed,
--           h.confirmed AS hourly_confirmed,
--           t.confirmed - h.confirmed AS diff,
--           h.confirmed_unattributed
--    FROM v_appt_truth_daily t
--    JOIN v_appt_fill_hourly_markets h
--      ON h.slot_date = t.slot_date
--     AND h.snapshot_hour = (SELECT max(snapshot_hour)
--                              FROM lp_appt_fill_hourly
--                             WHERE slot_date = t.slot_date)
--    WHERE t.slot_date = CURRENT_DATE;
--
-- C. Records needing correction, not filtering. Expect 0 rows once clean.
--
--    SELECT lp_lead_id, first_name, last_name, disposition_code,
--           appointment_date::date, appointment_confirmed, confirmed_date
--    FROM lp_leads
--    WHERE appointment_date::date >= CURRENT_DATE
--      AND ( (disposition_code = 'ND' AND appointment_confirmed)
--         OR (disposition_code IN ('Set','Verif') AND confirmed_date IS NOT NULL) );
--
-- ---------------------------------------------------------------------------
-- DO NOT USE FOR FORWARD-LOOKING BOOKED COUNTS
-- v_appt_board.booked is derived from lp_capacity_slots.has_appt, which LP only
-- populates on or near the appointment day. Measured 2026-09-14 14:16Z, all
-- swept in the same pass: 9/14 = 46 of 129 slots, 9/15 = 3 of 124, 9/16 = 7 of
-- 123, 9/17 = 1 of 129. The view is reporting that field faithfully - it is rep
-- slot occupancy, not an appointment count, and it is empty looking forward.
-- Any tile showing "booked tomorrow" must read v_appt_fill_hourly_markets.
-- ---------------------------------------------------------------------------
