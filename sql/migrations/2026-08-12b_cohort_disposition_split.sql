-- ─── 2026-08-12b · Net Sales is a definition, not a sum of dispositions ──────
--
-- WHAT THIS IS. A correction to 2026-08-12_cohort_maturation.sql. Same two
-- views, replaced in place; no data moves and no reader breaks (columns are
-- only APPENDED, so `CREATE OR REPLACE VIEW` is legal and existing SELECTs are
-- unaffected).
--
-- WHY. The original migration called `net_sales_cents` and
-- `nsa_cents + working_cents + hold_cents` "two routes to the same figure".
-- That sentence is wrong in the one way this whole body of work exists to
-- prevent — it states as an IDENTITY something the same migration's own
-- waterfall section proves is only an OBSERVATION. Report 137 ties exactly on
-- two of eight cohorts and the sign of the miss flips between April and June.
-- Writing it as an equation invites the next reader to derive Net Sales from
-- the disposition, and the day the buckets disagree that produces a wrong
-- goal-bearing number instead of a visible delta.
--
-- THE CORRECT STATEMENT. One definition, and it is a subtraction:
--
--     net_sales_cents = gross_cents − cancelled_cents − cd_cents
--
-- Separately, LP reports how that business is currently sitting:
--
--     observed_disposition_cents = nsa_cents + working_cents + hold_cents
--
-- They are close. They are not guaranteed equal. `reconciliation_delta_cents`
-- is the gap, carried alongside both and resolved into neither. Net Sales does
-- not move because the disposition disagrees with it, and no rate is
-- normalised to make them agree.
--
-- WHAT IS ADDED. Two columns that make the separation explicit in the schema
-- rather than only in prose, so a query cannot accidentally treat the sum as
-- the definition:
--
--     observed_disposition_cents   the SUM   (what LP reports)
--     reconciliation_delta_cents   the GAP   (observation − definition)
--
-- `reconciliation_delta_cents` is algebraically identical to the existing
-- `waterfall_delta_cents` — expanding (nsa+w+h+c+cd) − gross gives
-- (nsa+w+h) − (gross−c−cd). Both are kept deliberately: the waterfall framing
-- names LP's five-bucket identity, this one names the two figures a reader
-- actually sees side by side. A verification below asserts they never diverge.
--
-- ROLLBACK: re-run 2026-08-12_cohort_maturation.sql (it is idempotent). The
-- two added columns disappear; nothing else changes.
--
-- AFTER RUNNING: nothing to backfill — these are views over existing rows.
--
-- Applied by hand per sql/README.md — additive DDL, MCP apply_migration.

BEGIN;

CREATE OR REPLACE VIEW lp_cohort_maturation AS
WITH observation AS (
  SELECT DISTINCT ON (s.period_start, s.as_of_date)
         s.id           AS snapshot_id,
         s.period_start AS contract_month,
         s.as_of_date   AS observed_on,
         s.scope,
         s.is_current,
         s.ingested_at
  FROM scorecard_report_snapshots s
  WHERE s.report_type = 'sales_efficiency'
    AND s.scope IN ('month', 'mtd')
    AND s.abandoned_at IS NULL
  ORDER BY s.period_start, s.as_of_date, s.ingested_at DESC
),
market AS (
  -- Office codes summed into the market BEFORE any rate is derived, and every
  -- money column summed all-or-unknown: a total is published only when every
  -- constituent office reported it. See the original migration's ⚠️ 1 and ⚠️ 3.
  SELECT o.snapshot_id, o.contract_month, o.observed_on, o.scope, o.is_current,
         o.ingested_at, h.market,
         COUNT(DISTINCT h.branch_code_raw)                                            AS office_count,
         CASE WHEN COUNT(*) = COUNT(h.gsa_cents)       THEN SUM(h.gsa_cents)       END AS gross_cents,
         CASE WHEN COUNT(*) = COUNT(h.nsa_cents)       THEN SUM(h.nsa_cents)       END AS nsa_cents,
         CASE WHEN COUNT(*) = COUNT(h.working_cents)   THEN SUM(h.working_cents)   END AS working_cents,
         CASE WHEN COUNT(*) = COUNT(h.hold_cents)      THEN SUM(h.hold_cents)      END AS hold_cents,
         CASE WHEN COUNT(*) = COUNT(h.cancelled_cents) THEN SUM(h.cancelled_cents) END AS cancelled_cents,
         CASE WHEN COUNT(*) = COUNT(h.cd_cents)        THEN SUM(h.cd_cents)        END AS cd_cents,
         SUM(h.num_issued) AS issued_count, SUM(h.num_net_issued) AS net_issued_count,
         SUM(h.num_sat) AS sat_count, SUM(h.num_sold) AS sold_count,
         SUM(h.num_net) AS net_sold_count, SUM(h.num_cancelled) AS cancelled_count,
         SUM(h.num_cd) AS cd_count, SUM(h.num_working) AS working_count,
         SUM(h.num_hold) AS hold_count
  FROM observation o
  JOIN lp_sales_efficiency_history h ON h.snapshot_id = o.snapshot_id
  GROUP BY o.snapshot_id, o.contract_month, o.observed_on, o.scope,
           o.is_current, o.ingested_at, h.market
)
SELECT
  m.contract_month, m.market, m.observed_on,
  (m.observed_on - m.contract_month) AS cohort_age_days,
  m.snapshot_id, m.scope, m.is_current, m.ingested_at, m.office_count,
  m.gross_cents, m.nsa_cents, m.working_cents, m.hold_cents,
  m.cancelled_cents, m.cd_cents,

  -- THE DEFINITION. A subtraction, and the only thing that derives Net Sales.
  (m.gross_cents - m.cancelled_cents - m.cd_cents)            AS net_sales_cents,

  (m.nsa_cents::numeric       / NULLIF(m.gross_cents, 0))     AS nsa_rate,
  (m.working_cents::numeric   / NULLIF(m.gross_cents, 0))     AS working_rate,
  (m.hold_cents::numeric      / NULLIF(m.gross_cents, 0))     AS hold_rate,
  (m.cancelled_cents::numeric / NULLIF(m.gross_cents, 0))     AS cancel_rate,
  (m.cd_cents::numeric        / NULLIF(m.gross_cents, 0))     AS cd_rate,
  ((m.working_cents + m.hold_cents)::numeric
                              / NULLIF(m.gross_cents, 0))     AS pending_rate,
  ((m.cancelled_cents + m.cd_cents)::numeric
                              / NULLIF(m.gross_cents, 0))     AS lost_rate,

  -- NET RETENTION % — of what we wrote, how much has NOT been permanently lost?
  ((m.gross_cents - m.cancelled_cents - m.cd_cents)::numeric
                              / NULLIF(m.gross_cents, 0))     AS net_sales_rate,

  -- NET SURVIVAL RATE — of what we wrote, how much ultimately SETTLED? This is
  -- the rate the Expected Mature Net forecast is built on. A different question
  -- from net_sales_rate above: on July 2026 they are 50.9% and 76.3%.
  (m.nsa_cents::numeric       / NULLIF(m.gross_cents, 0))     AS net_survival_rate,

  ((m.nsa_cents + m.working_cents + m.hold_cents
      + m.cancelled_cents + m.cd_cents) - m.gross_cents)      AS waterfall_delta_cents,
  (((m.nsa_cents + m.working_cents + m.hold_cents
      + m.cancelled_cents + m.cd_cents) - m.gross_cents)::numeric
                              / NULLIF(m.gross_cents, 0))     AS waterfall_delta_pct,

  m.issued_count, m.net_issued_count, m.sat_count, m.sold_count,
  m.net_sold_count, m.cancelled_count, m.cd_count, m.working_count, m.hold_count,

  -- ── NEW: the observation, and its distance from the definition ────────────
  --
  -- THE OBSERVATION. What LP reports the business as doing. NOT a second way to
  -- compute net_sales_cents.
  (m.nsa_cents + m.working_cents + m.hold_cents)              AS observed_disposition_cents,
  -- THE GAP. observation − definition. Same quantity as waterfall_delta_cents,
  -- framed against the two figures a reader sees side by side.
  ((m.nsa_cents + m.working_cents + m.hold_cents)
     - (m.gross_cents - m.cancelled_cents - m.cd_cents))      AS reconciliation_delta_cents
FROM market m;

COMMENT ON VIEW lp_cohort_maturation IS
  'Report 137 as a cohort time series: one row per (contract_month, market, observed_on), '
  'office codes summed to market grain before any rate is derived. net_sales_cents is DEFINED '
  'as gross − cancelled − cd and is never derived from the disposition; '
  'observed_disposition_cents (nsa + working + hold) is what LP separately reports, and '
  'reconciliation_delta_cents is the gap between them — carried, never resolved into either '
  'side. Superseded snapshots are INCLUDED: the demoted history IS the series. An unobserved '
  'disposition is NULL, never 0, and a market total is published only when every constituent '
  'office reported that column. Two rates over gross written answer different questions: '
  'net_sales_rate = not permanently lost; net_survival_rate = ultimately settled.';

COMMIT;

-- ── Verification ────────────────────────────────────────────────────────────
--
-- 1. The two framings of the gap never diverge. MUST return zero rows.
--    SELECT contract_month, market, observed_on
--    FROM lp_cohort_maturation
--    WHERE nsa_cents IS NOT NULL
--      AND reconciliation_delta_cents IS DISTINCT FROM waterfall_delta_cents;
--
-- 2. The definition is NOT the observation — March, Jan, Feb and Jul must all
--    appear here. If this returns zero rows the identity would have been safe
--    to assume, and it is not.
--    SELECT contract_month, SUM(net_sales_cents) AS defined,
--           SUM(observed_disposition_cents) AS observed,
--           SUM(reconciliation_delta_cents) AS gap
--    FROM lp_cohort_maturation WHERE is_current GROUP BY 1
--    HAVING SUM(reconciliation_delta_cents) <> 0 ORDER BY 1;
--
-- 3. The added columns did not disturb the existing ones. Expect the same eight
--    cohort deltas as the original migration: Jan +38951, Feb +55196,
--    Mar +150920, Apr +29727, May 0, Jun −13069, Jul −27457, Aug 0.
--    SELECT contract_month, SUM(waterfall_delta_cents) AS delta_cents
--    FROM lp_cohort_maturation WHERE is_current GROUP BY 1 ORDER BY 1;
