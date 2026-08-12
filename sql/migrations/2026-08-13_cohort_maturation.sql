-- ─── 2026-08-13 · appointment_month, and the two rates the contract names ────
--
-- WHAT THIS IS. A fourth replacement of `lp_cohort_maturation`, appending three
-- columns. Additive only — `CREATE OR REPLACE VIEW` can APPEND columns but can
-- neither rename nor drop one — so every existing SELECT is unaffected, no data
-- moves, and this runs through MCP `apply_migration` per sql/README.md.
--
-- ── 1. `appointment_month` — the v4 §2 rename ───────────────────────────────
--
-- Report 137 filters on APPOINTMENT dates. Verified from the PDF header:
-- "Sales Efficiency By Setter — For Appointment Dates Between Sun 08/02/26 and
-- Sat 08/08/26." The CSV carries only SDate/EDate and never states its filter,
-- which is why the column was named for the wrong thing in the first place.
--
-- ⚠️ STANDING RULE, and it is the reason this rename exists at all: TWO EXPORTS
-- SHARING `SDate`/`EDate` ARE NOT THEREBY ON THE SAME DATE BASIS. Render as PDF
-- — the header states filters the CSV omits. Anywhere a date basis is asserted
-- in this tree, that sentence belongs beside it.
--
-- VALUE BASIS AND COHORT BASIS ARE DIFFERENT THINGS AND BOTH ARE TRUE. A row's
-- dollars are the contract value of sales whose APPOINTMENTS fall in the
-- window. That is not a contradiction and it does not block anything; it is
-- precisely what `appointment_month` now says and `contract_month` did not.
--
-- WHY BOTH COLUMNS. `CREATE OR REPLACE VIEW` cannot rename an existing column;
-- doing it properly means DROP + CREATE, and DROP is a "human watching the
-- dashboard" operation under sql/README.md's split. Appending keeps this a
-- single idempotent statement. `contract_month` is DEPRECATED as of this
-- migration — identical value, retained only so a reader mid-deploy does not
-- break — and is dropped in a later change once no consumer references it. Both
-- consumers (Reece-Dashboard, this repo's cohort-reobservation job) move to
-- `appointment_month` in the same PR, so the deprecation window is short.
--
-- ── 2. `net_retention_rate` — the contract's name for the quality KPI ───────
--
-- Already published as `net_sales_rate`. Same arithmetic, same column position
-- in spirit; the contract (§7, §16) calls it Net Retention %, so the view now
-- says that too. `net_sales_rate` is likewise deprecated-not-dropped.
--
-- ── 3. `permanent_loss_rate` — genuinely new ────────────────────────────────
--
-- (cancelled + cd) ÷ gross. The terminal losses as a share of the cohort's
-- immutable Gross Written. Identical arithmetic to the existing `lost_rate`,
-- published under the name §3 and §16 use so a reader is not asked to know that
-- "lost" and "permanent loss" are the same thing while Working and Hold — which
-- are also, colloquially, "not yet won" — are NOT in it.
--
-- ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
--
-- Not an ingest change, not a new fact, not a re-derivation. Net Sales is still
-- `gross − cancelled − cd` and is still never computed from the disposition or
-- from a residual. The waterfall delta is still a DIAGNOSTIC and still gates
-- nothing. No rate is normalised to make the buckets foot.
--
-- ROLLBACK: re-run 2026-08-13_cohort_data_through.sql (idempotent). The three
-- appended columns disappear; nothing else changes.
--
-- AFTER RUNNING: nothing to backfill — this is a view over existing rows.
--
-- NOT mirrored in runMigrations(): views are not boot-critical, and the three
-- migrations this one builds on are applied by hand for the same reason.
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
         -- claims. NULL for a partial or unknown-coverage file.
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
  -- constituent office reported it.
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
  -- DEPRECATED NAME. `net_retention_rate` below is the same expression under the
  -- name the contract uses; this one is retained for the deprecation window.
  ((m.gross_cents - m.cancelled_cents - m.cd_cents)::numeric
                              / NULLIF(m.gross_cents, 0))     AS net_sales_rate,

  -- NET SURVIVAL RATE — of what we wrote, how much has LP settled to its net?
  --
  -- ⚠️ NOT the rate the settlement forecast is built on. v4 §8 defines
  -- settled_net_retention as Σ NET SALES ÷ Σ Gross Written over eligible
  -- cohorts, not Σ NSA ÷ Σ Gross. On Jan–May 2026 the two are 71.10% and
  -- 71.06% — close enough to look like a rounding difference and far enough
  -- apart to be a different published figure. This column stays because the
  -- maturation series wants the settled share as a diagnostic; it is not a
  -- forecast input. (An earlier comment here claimed it was. It was wrong.)
  (m.nsa_cents::numeric       / NULLIF(m.gross_cents, 0))     AS net_survival_rate,

  ((m.nsa_cents + m.working_cents + m.hold_cents
      + m.cancelled_cents + m.cd_cents) - m.gross_cents)      AS waterfall_delta_cents,
  (((m.nsa_cents + m.working_cents + m.hold_cents
      + m.cancelled_cents + m.cd_cents) - m.gross_cents)::numeric
                              / NULLIF(m.gross_cents, 0))     AS waterfall_delta_pct,

  -- APPOINTMENT-DATE COHORT COUNTS. Under Amendment A these are the SALES
  -- funnel — 137 filters on appointment dates, so its counts and its dollars
  -- describe one cohort, and pairing them is the whole point. They are NOT
  -- "diagnostic only"; the v4 §1 rule that barred them applied while one funnel
  -- was being made to serve both Sales and the call center, and A2 retires it.
  --
  -- What has NOT changed: these may not be compared against, or reconciled to,
  -- Appointment Statistics (report 138). Same window and same setters give
  -- Issued 446 here against 418 there, Sat 271 against 260, with per-setter
  -- differences running in BOTH directions. That is two cohort bases and two
  -- attributions, it is expected, and it will never resolve.
  m.issued_count, m.net_issued_count, m.sat_count, m.sold_count,
  m.net_sold_count, m.cancelled_count, m.cd_count, m.working_count, m.hold_count,

  -- THE OBSERVATION. What LP reports the business as doing. NOT a second way to
  -- compute net_sales_cents.
  (m.nsa_cents + m.working_cents + m.hold_cents)              AS observed_disposition_cents,
  -- THE GAP. observation − definition. Same quantity as waterfall_delta_cents,
  -- framed against the two figures a reader sees side by side.
  ((m.nsa_cents + m.working_cents + m.hold_cents)
     - (m.gross_cents - m.cancelled_cents - m.cd_cents))      AS reconciliation_delta_cents,

  -- Coverage, kept apart from observation. Date a current-period actual by
  -- data_through, never by observed_on.
  m.data_through,
  m.declared_period_end,
  m.is_partial_month,

  -- ── NEW: the contract's names ─────────────────────────────────────────────
  --
  -- The cohort month, named for what 137 actually filters on. Identical value
  -- to contract_month, which is DEPRECATED as of this migration.
  m.contract_month                                            AS appointment_month,

  -- NET RETENTION % (§7, §16). Same expression as net_sales_rate above, under
  -- the name the contract publishes. The quality KPI, available on any cohort
  -- including the current month — and independent of Working and Hold, which
  -- are unresolved business, not loss. A $30,000 job on permit hold is still
  -- good business and is still in this numerator.
  ((m.gross_cents - m.cancelled_cents - m.cd_cents)::numeric
                              / NULLIF(m.gross_cents, 0))     AS net_retention_rate,

  -- PERMANENT LOSS % (§3, §16). Cancellations + financing denied over Gross
  -- Written — the two TERMINAL losses, and only those. Working and Hold are
  -- excluded by definition, not by omission.
  ((m.cancelled_cents + m.cd_cents)::numeric
                              / NULLIF(m.gross_cents, 0))     AS permanent_loss_rate
FROM market m;

-- ── The re-pull queue gets the same name ────────────────────────────────────
--
-- Same append-only treatment, same reason. The three arms of the WHERE clause
-- are §15's re-pull rule verbatim and are unchanged: the current month always;
-- any prior month still holding Working or Hold; anything younger than the
-- eligibility age. The 90 here is deliberately NOT the dashboard's
-- MATURE_RATE_ELIGIBILITY_DAYS constant — it is a re-pull cadence, and the
-- original migration left "how old is old enough" with the consumer because
-- that threshold gets re-derived from this very series.
CREATE OR REPLACE VIEW lp_cohort_reobservation AS
WITH latest AS (
  SELECT DISTINCT ON (contract_month) contract_month, observed_on
  FROM lp_cohort_maturation
  ORDER BY contract_month, observed_on DESC
), totals AS (
  SELECT m.contract_month, m.observed_on,
         SUM(m.working_cents) AS working_cents,
         SUM(m.hold_cents)    AS hold_cents
  FROM lp_cohort_maturation m
  JOIN latest l ON l.contract_month = m.contract_month AND l.observed_on = m.observed_on
  GROUP BY m.contract_month, m.observed_on
)
SELECT contract_month,
       observed_on              AS last_observed_on,
       CURRENT_DATE - observed_on    AS days_since_observed,
       CURRENT_DATE - contract_month AS cohort_age_days,
       working_cents,
       hold_cents,
       CASE
         WHEN contract_month = date_trunc('month', CURRENT_DATE)::date THEN 'current_month'
         WHEN (COALESCE(working_cents, 0) + COALESCE(hold_cents, 0)) > 0 THEN 'unresolved_dollars'
         ELSE 'below_eligibility_age'
       END                      AS reason,
       -- DEPRECATED above, canonical here. Same value; see the header.
       contract_month           AS appointment_month
FROM totals t
WHERE contract_month = date_trunc('month', CURRENT_DATE)::date
   OR (COALESCE(working_cents, 0) + COALESCE(hold_cents, 0)) > 0
   OR (CURRENT_DATE - contract_month) < 90
ORDER BY contract_month;

COMMENT ON VIEW lp_cohort_maturation IS
  'Report 137 as a cohort time series: one row per (appointment_month, market, observed_on), '
  'office codes summed to market grain before any rate is derived. 137 filters on APPOINTMENT '
  'dates (verified from the PDF header; the CSV states only SDate/EDate), so appointment_month '
  'is the cohort key and contract_month is a DEPRECATED alias for it — as is net_sales_rate for '
  'net_retention_rate. TWO DATES, deliberately distinct: observed_on (= as_of_date) is WHEN LP '
  'RAN the report and is what the maturation series is keyed on; data_through (= period_end, '
  'NULL when is_partial_month is not false) is what the dollars actually COVER and is the only '
  'date a current-period actual may be paced against. net_sales_cents is DEFINED as gross − '
  'cancelled − cd and is never derived from the disposition; observed_disposition_cents (nsa + '
  'working + hold) is what LP separately reports, and reconciliation_delta_cents is the gap '
  'between them — carried, never resolved into either side. The appointment counts '
  '(issued_count, sat_count, sold_count) ARE the sales funnel under Amendment A, because they '
  'share this cohort with the dollars; they must never be reconciled to report 138, which is a '
  'different cohort basis and a different attribution. Superseded snapshots are INCLUDED: the '
  'demoted history IS the series. An unobserved disposition is NULL, never 0, and a market total '
  'is published only when every constituent office reported that column.';

COMMIT;

-- ── Verification ────────────────────────────────────────────────────────────
--
-- 1. The three new columns exist and appointment_month is identical to the
--    deprecated contract_month on every row. Expect 0.
--    SELECT COUNT(*) FROM lp_cohort_maturation
--    WHERE appointment_month IS DISTINCT FROM contract_month;
--
-- 2. net_retention_rate is identical to the deprecated net_sales_rate, and
--    permanent_loss_rate to lost_rate. Expect 0 for both.
--    SELECT COUNT(*) FROM lp_cohort_maturation
--    WHERE net_retention_rate IS DISTINCT FROM net_sales_rate
--       OR permanent_loss_rate IS DISTINCT FROM lost_rate;
--
-- 3. §8 SETTLED NET RETENTION — start-anchored 90 days, as of 2026-08-12,
--    summing numerators and denominators and THEN dividing. Expect exactly
--    5 cohorts, $58,169,659.07 gross, $41,357,719.15 net, 71.0984%, Jan–May.
--
--    Note this is NOT Σ nsa ÷ Σ gross, which returns 71.0558% on the same
--    cohorts. Both round to 71.1% at one decimal place; the contract publishes
--    two, and they differ there.
--
--    SELECT COUNT(DISTINCT appointment_month)                    AS cohorts,
--           SUM(gross_cents)/100.0                               AS gross_dollars,
--           SUM(net_sales_cents)/100.0                           AS net_sales_dollars,
--           ROUND(100.0 * SUM(net_sales_cents)::numeric
--                       / NULLIF(SUM(gross_cents),0), 4)         AS settled_net_retention_pct,
--           MIN(appointment_month) AS first_month,
--           MAX(appointment_month) AS last_month
--    FROM lp_cohort_maturation
--    WHERE is_current AND (DATE '2026-08-12' - appointment_month) >= 90;
--
-- 4. The §11 market-rollup fixture — Fort Lauderdale is BOCA + FTLAU + MIAMI
--    summed BEFORE any rate is derived. Expect gross $234,848, cancelled
--    $95,698, cd $0, net $139,150, and office_count 3. Reading the FTLAU office
--    row alone would report $140,433 gross and $0 net.
--    SELECT market, office_count, gross_cents/100.0, cancelled_cents/100.0,
--           cd_cents/100.0, net_sales_cents/100.0, net_retention_rate
--    FROM lp_cohort_maturation
--    WHERE appointment_month = '2026-08-01' AND observed_on = '2026-08-11'
--      AND market = 'FTLAU_MKT';
--
-- 5. The waterfall is a DIAGNOSTIC and Net Sales is unaffected by it. March
--    misses by +1.27% and still publishes a net_sales_cents. Expect a non-zero
--    delta beside a non-null net.
--    SELECT appointment_month, SUM(waterfall_delta_cents)/100.0 AS delta_dollars,
--           SUM(net_sales_cents)/100.0 AS net_sales_dollars
--    FROM lp_cohort_maturation WHERE is_current
--    GROUP BY 1 ORDER BY 1;
--
-- 6. IDEMPOTENCY — re-run this entire file. It is a single CREATE OR REPLACE
--    over a view with no dependent objects, so the second run is a no-op and
--    checks 1–5 still hold.
