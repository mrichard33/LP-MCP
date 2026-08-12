-- ─── 2026-08-13 · the date a file COVERS is not the date it RAN ──────────────
--
-- WHAT THIS IS. A third replacement of `lp_cohort_maturation`, appending three
-- columns. Additive only, so `CREATE OR REPLACE VIEW` is legal and every
-- existing SELECT is unaffected. No data moves. `lp_cohort_reobservation` is
-- deliberately untouched — see WHY OBSERVED_ON STAYS below.
--
-- WHY
--
-- The scorecard showed "report 137 · as of 08-11-2026" beside four other panels
-- reading 08-10, and a reader reasonably concluded the page was mixing days —
-- that an Aug-11 sales numerator was being paced against a denominator of eight
-- selling days ending Aug 10.
--
-- It was not. The snapshot behind that figure is:
--
--     period_start 2026-08-01   period_end 2026-08-10
--     as_of_date   2026-08-11   is_partial_month false
--
-- `period_end` is what the data COVERS. `as_of_date` is when LP RAN the report.
-- The dollars stop on the 10th; only the label said otherwise. The seven market
-- rows sum to $1,852,941, all of it Aug 1–10, and the pace arithmetic was right.
--
-- The defect is that this view had no way to say so. It published
-- `observed_on = s.as_of_date` and did not expose `period_end` at ALL, so every
-- downstream reader had exactly one date available and it was the wrong one for
-- a current-period figure. Correctness depended on those two dates happening to
-- agree, which for an MTD file they never do.
--
-- WHY `data_through` IS NULL FOR A PARTIAL FILE
--
-- `period_end` can lie, and the warehouse already knows when. Live example:
--
--     c1fc176f  period_start 2026-08-01  period_end 2026-08-31
--               as_of_date   2026-08-10  is_partial_month TRUE
--
-- LP generated that on the 10th with the month-end as the requested range. Its
-- `period_end` claims coverage through Aug 31 that the file cannot possibly
-- contain. Publishing 2026-08-31 as a data-through date would be worse than
-- publishing nothing: it would license a reader to compare eleven days of sales
-- against a full month of goal.
--
-- So `data_through` is NULL whenever coverage is partial or unknown — the same
-- "unknown is not zero" rule this view already applies to every money column,
-- and the same `IS FALSE` (not `NOT`) test `lp_csv_ingest_finalize` uses to
-- decide whether a period is closed. `declared_period_end` carries the raw value
-- alongside so the overstatement stays diagnosable rather than invisible.
--
-- WHY `observed_on` STAYS `as_of_date`
--
-- It is the right field for what it is for. The maturation series asks "what
-- does the January cohort look like as of the latest observation", and the
-- answer is dated by when we looked, not by what the file covered. A closed
-- month re-pulled in October is a NEW observation of the same period_end — it
-- is `as_of_date` that distinguishes the two readings, and
-- `lp_cohort_reobservation` and the §8 staleness monitor are built on exactly
-- that. Changing it would collapse the series.
--
-- The two dates answer different questions and this migration stops conflating
-- them: `observed_on` for cohort maturation, `data_through` for anything paced
-- against a current period.
--
-- ROLLBACK: re-run 2026-08-12b_cohort_disposition_split.sql (idempotent). The
-- three appended columns disappear; nothing else changes.
--
-- AFTER RUNNING: nothing to backfill — this is a view over existing rows.
--
-- Applied by hand per sql/README.md — additive DDL, MCP apply_migration.

BEGIN;

CREATE OR REPLACE VIEW lp_cohort_maturation AS
WITH observation AS (
  SELECT DISTINCT ON (s.period_start, s.as_of_date)
         s.id           AS snapshot_id,
         s.period_start AS contract_month,
         s.as_of_date   AS observed_on,
         -- What the file COVERS, published only when it covers all of what it
         -- claims. NULL for a partial or unknown-coverage file: see WHY above.
         CASE WHEN s.is_partial_month IS FALSE THEN s.period_end END AS data_through,
         s.period_end   AS declared_period_end,
         s.is_partial_month,
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
         o.ingested_at, o.data_through, o.declared_period_end, o.is_partial_month,
         h.market,
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
           o.is_current, o.ingested_at, o.data_through, o.declared_period_end,
           o.is_partial_month, h.market
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

  -- THE OBSERVATION. What LP reports the business as doing. NOT a second way to
  -- compute net_sales_cents.
  (m.nsa_cents + m.working_cents + m.hold_cents)              AS observed_disposition_cents,
  -- THE GAP. observation − definition. Same quantity as waterfall_delta_cents,
  -- framed against the two figures a reader sees side by side.
  ((m.nsa_cents + m.working_cents + m.hold_cents)
     - (m.gross_cents - m.cancelled_cents - m.cd_cents))      AS reconciliation_delta_cents,

  -- ── NEW: coverage, kept apart from observation ────────────────────────────
  --
  -- The date these dollars actually reach. Date a current-period actual by THIS,
  -- never by observed_on. NULL means the file's coverage is partial or unknown
  -- and no such claim can be made — which is a refusal, not a zero.
  m.data_through,
  -- The raw period_end, published so an overstated range stays diagnosable.
  -- Equal to data_through on a complete file; ahead of it on a partial one.
  m.declared_period_end,
  m.is_partial_month
FROM market m;

COMMENT ON VIEW lp_cohort_maturation IS
  'Report 137 as a cohort time series: one row per (contract_month, market, observed_on), '
  'office codes summed to market grain before any rate is derived. TWO DATES, deliberately '
  'distinct: observed_on (= as_of_date) is WHEN LP RAN the report and is what the maturation '
  'series is keyed on; data_through (= period_end, NULL when is_partial_month is not false) is '
  'what the dollars actually COVER and is the only date a current-period actual may be paced '
  'against. net_sales_cents is DEFINED as gross − cancelled − cd and is never derived from the '
  'disposition; observed_disposition_cents (nsa + working + hold) is what LP separately reports, '
  'and reconciliation_delta_cents is the gap between them — carried, never resolved into either '
  'side. Superseded snapshots are INCLUDED: the demoted history IS the series. An unobserved '
  'disposition is NULL, never 0, and a market total is published only when every constituent '
  'office reported that column. Two rates over gross written answer different questions: '
  'net_sales_rate = not permanently lost; net_survival_rate = ultimately settled.';

COMMIT;

-- ── Verification ────────────────────────────────────────────────────────────
--
-- 1. The two dates are genuinely different on the live current month — this is
--    the whole reason the migration exists. Expect observed_on 2026-08-11 and
--    data_through 2026-08-10 on all seven markets.
--    SELECT market, observed_on, data_through, declared_period_end, is_partial_month
--    FROM lp_cohort_maturation
--    WHERE contract_month = '2026-08-01' AND is_current ORDER BY market;
--
-- 2. A partial file publishes NO data-through date, and says why. Expect the
--    2026-08-10 observation to show data_through NULL against a
--    declared_period_end of 2026-08-31.
--    SELECT DISTINCT observed_on, data_through, declared_period_end, is_partial_month
--    FROM lp_cohort_maturation
--    WHERE contract_month = '2026-08-01' ORDER BY observed_on;
--
-- 3. data_through never runs past the period it claims, and never precedes the
--    contract month. MUST return zero rows.
--    SELECT contract_month, market, observed_on, data_through, declared_period_end
--    FROM lp_cohort_maturation
--    WHERE data_through IS NOT NULL
--      AND (data_through > declared_period_end OR data_through < contract_month);
--
-- 4. The appended columns did not disturb the existing ones. Expect the same
--    eight cohort deltas: Jan +38951, Feb +55196, Mar +150920, Apr +29727,
--    May 0, Jun −13069, Jul −27457, Aug 0.
--    SELECT contract_month, SUM(waterfall_delta_cents) AS delta_cents
--    FROM lp_cohort_maturation WHERE is_current GROUP BY 1 ORDER BY 1;
--
-- 5. August Net Sales is unchanged at $1,852,941.
--    SELECT SUM(net_sales_cents) FROM lp_cohort_maturation
--    WHERE contract_month = '2026-08-01' AND is_current;
