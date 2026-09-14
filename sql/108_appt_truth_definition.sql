-- 108_appt_truth_definition.sql
-- Canonical appointment-count definition for Lead Perfection.
--
-- STATUS: APPLIED to LP Supabase 2026-09-14 ~15:35Z. All three views created
-- via CREATE OR REPLACE, run as individual statements rather than one
-- transaction so a failure could not leave a half-applied set. Verified after
-- apply with tests A-D below. Re-running this file is idempotent.
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
-- THE GRAIN: COUNT PROSPECTS, NOT LEAD ROWS
-- lp_leads is keyed on lp_lead_id. One lp_prospect_id legitimately owns many
-- lead rows over time - Bermudez Luis (prospect 358689) has seven, spanning
-- appointments in January, February and September, with Data, DNC and OPPFDN
-- in the mix. That is normal multi-appointment history, not duplication.
--
-- What is NOT normal is two LIVE lead rows for one prospect on the SAME
-- appointment date. Measured 2026-09-14:
--   prospect 358689 Bermudez -> lead 550806 'Issue' AND lead 575443 'Set',
--     both 2026-09-14. One person counted once as confirmed and once as set.
--   prospect 450345 Golden   -> lead 574757 'CXL' AND lead 574758 'Set',
--     both 2026-09-14, surname spelled 'Gold' on both. Duplicate-with-typo.
--
-- Same-date duplication scoped to LIVE rows only (Cnf/Issue/Set/Verif), which
-- is what actually inflates a count:
--   9/08 +2 | 9/09 0 | 9/10 0 | 9/11 +1 | 9/12 0 | 9/13 0
--   9/14 +1 | 9/15 0 | 9/16 +1 | 9/17 0
-- Real, persistent, and small: 0-2 a day. A wider scan over ALL rows shows
-- 2-8 a day, but most of that excess is dead history (Data/DNC/closed rows)
-- that no count reads. Size the fix to the live number.
--
-- HOW THE COLLISIONS ARE CREATED - checked on created_at_lp, not on lead-id
-- adjacency, which misleads. The five live collisions 9/08-9/17:
--   400876 JULICH      575041 / 575052   4m apart,  MVP / MVP
--   458357 Ingrassia   574953 / 574957   9m apart,  Self Generated / Lead Gurus
--   230019 Reyes/Fuentes 572626 / 572972 1 day,     MVP / Prolific
--   412674 Gibbons     537047 / 573470   4 months,  Reecewindows.com / Lead Gurus
--   358689 Bermudez    550806 / 575443   3 months,  Prolific / Prolific
-- Only JULICH fits a same-session double-submit. Three of the five are the
-- same person arriving through a DIFFERENT source and getting a second lead
-- row - which also means paying two vendors for one appointment. So a
-- create-time guard must key on prospect + appointment date ALONE. Scoping it
-- to same-session or same-source would catch one case in five.
--
-- So every count below is COUNT(DISTINCT prospect), with the raw row count
-- kept beside it. The gap between the two IS the duplication, visible rather
-- than silently folded in. lp_prospect_id has no nulls on any appointment row
-- 9/08-9/17, but the coalesce guard is kept so a future null degrades to
-- counting that one row instead of dropping it.
--
-- WHAT DISTINCT DOES NOT FIX: Golden. Only one of his two rows is live, so a
-- distinct count already reads him once. His problem is that the live row has
-- no cancel on it - the cancel is on the sibling lead row. That needs a
-- prospect-level cancel check, which is the live_with_prospect_cancel column.
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
--   live        = confirmed + set_pending, counted on DISTINCT prospect
--
-- KNOWN LIMITATION - READ BEFORE USING FOR HISTORY
-- lp_leads holds CURRENT state. After the appointment day, dispositions advance
-- past Cnf/Issue into sat/sold/demo outcomes, so v_appt_truth_daily under-reports
-- confirmed for past dates (2026-09-09 reads 3 against the hourly feed's 90).
-- The decay starts the same day: 9/14 confirmed read 43 at 14:00Z and 40 by
-- 14:52Z while the day was still running. For history use the immutable
-- lp_appt_fill_hourly snapshot. For today and forward dates use
-- v_appt_truth_daily. This split is by design, not a defect.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Current-state truth, from lp_leads. Use for today and future dates.
--    Counts are per DISTINCT prospect; *_rows columns expose the duplication.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_appt_truth_daily AS
SELECT
  l.appointment_date::date AS slot_date,

  -- Canonical counts. One person = one count.
  count(DISTINCT coalesce(l.lp_prospect_id, 'lead:' || l.lp_lead_id))
    FILTER (WHERE l.disposition_code IN ('Cnf','Issue'))                     AS confirmed,
  count(DISTINCT coalesce(l.lp_prospect_id, 'lead:' || l.lp_lead_id))
    FILTER (WHERE l.disposition_code IN ('Set','Verif'))                     AS set_pending,
  count(DISTINCT coalesce(l.lp_prospect_id, 'lead:' || l.lp_lead_id))
    FILTER (WHERE l.disposition_code IN ('Cnf','Issue','Set','Verif'))       AS live_total,
  count(DISTINCT coalesce(l.lp_prospect_id, 'lead:' || l.lp_lead_id))
    FILTER (WHERE l.disposition_code = 'Issue')                              AS issued,
  count(DISTINCT coalesce(l.lp_prospect_id, 'lead:' || l.lp_lead_id))
    FILTER (WHERE l.disposition_code = 'CXL')                                AS cancelled,

  -- Raw row counts. live_rows - live_total = same-date duplication.
  count(*) FILTER (WHERE l.disposition_code IN ('Cnf','Issue','Set','Verif')) AS live_rows,
  count(*) FILTER (WHERE l.disposition_code IN ('Cnf','Issue','Set','Verif'))
    - count(DISTINCT coalesce(l.lp_prospect_id, 'lead:' || l.lp_lead_id))
      FILTER (WHERE l.disposition_code IN ('Cnf','Issue','Set','Verif'))      AS dup_live_rows,

  count(*) FILTER (WHERE l.disposition_code = 'ND')                           AS nd_rows,

  -- Data-quality flags. All three should be zero. Non-zero means records need
  -- correcting or deduplicating in LP, not filtering out of a report.
  count(*) FILTER (WHERE l.disposition_code = 'ND'
                     AND l.appointment_confirmed)                             AS nd_but_confirmed,
  count(*) FILTER (WHERE l.disposition_code IN ('Set','Verif')
                     AND l.confirmed_date IS NOT NULL)                        AS set_but_confirmed,
  -- The Golden case: a live row whose prospect has a CXL sibling on the same
  -- date. A lead-level cancel join misses these entirely.
  count(DISTINCT coalesce(l.lp_prospect_id, 'lead:' || l.lp_lead_id))
    FILTER (WHERE l.disposition_code IN ('Cnf','Issue','Set','Verif')
              AND EXISTS (SELECT 1 FROM lp_leads c
                           WHERE c.lp_prospect_id = l.lp_prospect_id
                             AND c.appointment_date::date = l.appointment_date::date
                             AND c.disposition_code = 'CXL'))                 AS live_with_prospect_cancel,

  max(l.synced_at)                                                            AS last_synced_at
FROM lp_leads l
WHERE l.appointment_date IS NOT NULL
GROUP BY 1;

COMMENT ON VIEW v_appt_truth_daily IS
  'Canonical LP appointment counts for today and forward dates, counted on DISTINCT lp_prospect_id. confirmed = Cnf+Issue, set_pending = Set+Verif. dup_live_rows and live_with_prospect_cancel are data-quality signals and should read 0. Current-state only - under-reports past dates by design; use lp_appt_fill_hourly for history. Added sql/108, 2026-09-14.';

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
  -- assigned (e.g. prospect 459032 PEREZ, blank market) or outside the service area.
  coalesce(sum(confirmed)   FILTER (WHERE market IN ('UNRESOLVED','OUT_OF_AREA')), 0) AS confirmed_unattributed,
  coalesce(sum(set_pending) FILTER (WHERE market IN ('UNRESOLVED','OUT_OF_AREA')), 0) AS set_pending_unattributed
FROM lp_appt_fill_hourly
GROUP BY 1, 2;

COMMENT ON VIEW v_appt_fill_hourly_markets IS
  'lp_appt_fill_hourly with UNRESOLVED and OUT_OF_AREA split out of the market totals. A bare SUM over the base table inflates confirmed by the unattributed count. Added sql/108, 2026-09-14.';

-- ---------------------------------------------------------------------------
-- 3. The duplicate worklist (WO-8). One row per prospect-date with more than
--    one lead row, so a correction can be applied to a named lead_id.
--    NOTE: many lead rows per prospect across DIFFERENT dates is normal and is
--    not listed here. Only same-date collisions appear.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_appt_prospect_dupes AS
SELECT
  appointment_date::date                                  AS slot_date,
  lp_prospect_id,
  count(*)                                                AS lead_rows,
  count(*) FILTER (WHERE disposition_code
                         IN ('Cnf','Issue','Set','Verif')) AS live_rows,
  array_agg(lp_lead_id       ORDER BY lp_lead_id)          AS lead_ids,
  array_agg(disposition_code ORDER BY lp_lead_id)          AS dispositions,
  array_agg(DISTINCT last_name)                            AS surnames,
  array_agg(DISTINCT ghl_contact_id)
    FILTER (WHERE ghl_contact_id IS NOT NULL)              AS ghl_contact_ids
FROM lp_leads
WHERE appointment_date IS NOT NULL
  AND lp_prospect_id IS NOT NULL
GROUP BY 1, 2
HAVING count(*) > 1;

COMMENT ON VIEW v_appt_prospect_dupes IS
  'Prospects holding more than one lead row on the SAME appointment date. Worklist for WO-8. Differing surnames in the surnames column indicate a duplicate-with-typo (e.g. Golden/Gold on 2026-09-14). Added sql/108, 2026-09-14.';

COMMIT;

-- ---------------------------------------------------------------------------
-- VERIFICATION - results from the 2026-09-14 post-apply run.
-- Absolute counts decay through the day as dispositions advance, so the tests
-- below are written as relationships, not fixed numbers.
-- ---------------------------------------------------------------------------
--
-- A. Today's truth.
--    Expect: dup_live_rows = live_rows - live_total
--            confirmed + set_pending - live_total = prospects sitting in BOTH
--              buckets on one date. Read 1 on 2026-09-14 (Bermudez, Issue+Set).
--              It is NOT an error for the two buckets to overshoot live_total;
--              that overshoot is the cross-bucket collision count.
--    Open defects at apply time, all should trend to 0:
--            nd_but_confirmed = 2 (prospects 355684 Marlatt, 383803 Buchalski)
--            dup_live_rows = 1    (prospect 358689 Bermudez, leads 550806/575443)
--            live_with_prospect_cancel = 1 (prospect 450345 Golden, 574757/574758)
--            set_but_confirmed = 2 on 9/15 and 4 on 9/16 - confirmations logged
--              against rows still sitting on Set. Wider than the single Kualica
--              record found in the export; not yet triaged.
--
--    SELECT * FROM v_appt_truth_daily WHERE slot_date = CURRENT_DATE;
--
-- B. The two sources agree AT THE SAME INSTANT - and only then. Run this in the
--    first minutes after the top of the hour, or expect drift: at 14:52Z
--    lp_leads read 40 confirmed for 9/14 against the 14:00Z snapshot's 43,
--    because Issue rows had already advanced to sat/sold. Same run, 9/15 read
--    11 against 9 as new confirmations landed. Neither is a defect. A
--    persistent diff at matched times, or a non-zero confirmed_unattributed,
--    is the signal worth chasing.
--
--    SELECT t.slot_date, t.confirmed AS leads_confirmed,
--           h.confirmed AS hourly_confirmed,
--           t.confirmed - h.confirmed AS diff,
--           t.dup_live_rows, h.confirmed_unattributed, h.snapshot_hour
--    FROM v_appt_truth_daily t
--    JOIN v_appt_fill_hourly_markets h
--      ON h.slot_date = t.slot_date
--     AND h.snapshot_hour = (SELECT max(snapshot_hour)
--                              FROM lp_appt_fill_hourly
--                             WHERE slot_date = t.slot_date)
--    WHERE t.slot_date = CURRENT_DATE;
--
-- C. The WO-8 worklist. Filter to live_rows > 1 - that is the set that inflates
--    a count. Returned exactly five records for 9/08-9/17 at apply time.
--
--    SELECT * FROM v_appt_prospect_dupes
--    WHERE slot_date >= CURRENT_DATE AND live_rows > 1
--    ORDER BY slot_date;
--
-- D. Records needing correction, not filtering. Expect 0 rows once clean.
--    Returns BOTH ids - never key a write on lp_prospect_id alone.
--
--    SELECT lp_prospect_id, lp_lead_id, first_name, last_name, disposition_code,
--           appointment_date::date, appointment_confirmed, confirmed_date
--    FROM lp_leads
--    WHERE appointment_date::date >= CURRENT_DATE
--      AND ( (disposition_code = 'ND' AND appointment_confirmed)
--         OR (disposition_code IN ('Set','Verif') AND confirmed_date IS NOT NULL) );
--
-- ---------------------------------------------------------------------------
-- ID NAMESPACE WARNING - READ BEFORE WRITING ANYTHING
-- The LP confirmation-report export's "ID#" column is lp_prospect_id, NOT
-- lp_lead_id. The two namespaces overlap, so a query keyed on the wrong column
-- returns a different real customer without erroring. Verified 2026-09-14:
--   171689  as lead -> Hager, 2022-07-25 CXL    | as prospect -> Sarchapone, 9/15
--   455859  as lead -> SCOTT/CHRIST, Sale       | as prospect -> Jacob, 9/15 Set
--   459002  as lead -> GARCIA/MARTIN, Sale      | as prospect -> Hott
--   450345  as lead -> Laret, 2025-09-16 CXL    | as prospect -> Golden/Gold, 9/14
-- Two of those four wrong matches are closed Sale records. Any record
-- correction must name BOTH ids and the intended lead row.
-- ---------------------------------------------------------------------------
-- DO NOT USE FOR FORWARD-LOOKING BOOKED COUNTS
-- v_appt_board.booked is derived from lp_capacity_slots.has_appt, which LP only
-- populates on or near the appointment day. Measured 2026-09-14 14:16Z, all
-- swept in the same pass: 9/14 = 46 of 129 slots, 9/15 = 3 of 124, 9/16 = 7 of
-- 123, 9/17 = 1 of 129. The view is reporting that field faithfully - it is rep
-- slot occupancy, not an appointment count, and it is empty looking forward.
-- Any tile showing "booked tomorrow" must read v_appt_fill_hourly_markets.
-- ---------------------------------------------------------------------------
