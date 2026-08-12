-- ─── 2026-08-12 · Cohort maturation time series ─────────────────────────────
--
-- WHAT THIS IS. Two read-only views over data that already exists. A sales
-- cohort is not a number — it is a number that MOVES. A contract written in
-- June is, on the day it is signed, entirely "working"; over the following
-- months it resolves into net, or into a cancellation, or into a financing
-- denial. Report 137 has been re-pulled for closed months since 2026-08-05 and
-- every superseded snapshot was retained, so the time series is already sitting
-- in `lp_sales_efficiency_history` — it has simply never been readable as one.
--
--   lp_cohort_maturation        one row per (contract_month, market, observed_on)
--   lp_cohort_reobservation     which cohorts still need re-pulling, and why
--
-- WHAT THIS IS NOT. It is not a new table, not a new fact, not an ingest
-- change, and it writes nothing. Nothing about how 137 is parsed or stored
-- moves. It is also NOT a maturity ruling: `cohort_age_days` is published and
-- the eligibility threshold stays with the consumer (the dashboard owns
-- MATURE_RATE_ELIGIBILITY_DAYS), because "how old is old enough" is a business
-- decision that will be re-derived from this very series.
--
-- ── WHY THE RAW ROWS AND NOT lp_report_facts ────────────────────────────────
--
-- `lp_report_facts` is the projection the dashboard reads; `lp_sales_efficiency_
-- history` is what it is projected FROM, and its own table comment settles the
-- precedence: "on any divergence the raw rows win and facts are rebuilt via
-- scorecard_rebuild_facts(snapshot_id)". Three practical reasons on top of that:
--
--   • COVERAGE. 22 snapshots carry raw 137 rows; only 18 produced facts. Four
--     March snapshots projected to zero fact rows and would have been invisible
--     to a facts-sourced view.
--   • NULL SEMANTICS AT SOURCE. `nsa_cents` is genuinely NULL on an MTD pull
--     (see below). Reading facts required inferring absence from a missing EAV
--     row; here the column simply is NULL and every rate propagates it.
--   • VOCABULARY. gsa_cents / nsa_cents / working_cents / hold_cents /
--     cancelled_cents / cd_cents are real columns, so no metric-string pivot
--     sits between the report and the view.
--
-- ── THE FOUR THINGS THAT MAKE A NAIVE VERSION OF THIS VIEW WRONG ────────────
--
-- ⚠️ 1. A BLANK IS UNKNOWN, NOT ZERO — AND EARLY OBSERVATIONS ARE FULL OF THEM.
-- The documented case is the Net column: "MTD pulls have blank Net columns:
-- num_net/nsa_cents NULL, never 0." Summing that to zero would draw a
-- maturation curve climbing from 0% to 71% that is pure ingest artifact.
--
-- Measured 2026-08-12, the problem is WIDER than the Net column. Observations
-- on 2026-08-05 and 2026-08-06 carry sparse NULLs across EVERY money column —
-- the August 08-05 pull has MIAMI entirely NULL, BOCA with a NULL cancelled and
-- a NULL hold, JAX with a NULL cancelled but a populated cd. The parser of that
-- era wrote a blank where the report printed nothing, and "nothing" and "zero"
-- are not distinguishable after the fact. From 2026-08-09 every column on every
-- office is populated.
--
-- So a market total is published only when every constituent office reported
-- that column:
--
--     CASE WHEN COUNT(*) = COUNT(col) THEN SUM(col) END
--
-- Partial knowledge is unknown, not a smaller number. This deliberately makes
-- most of the 08-05 and 08-06 observations NULL rather than confidently wrong —
-- a market summed from two reporting offices and one blank one would look
-- complete and understate the market. Nothing user-facing depends on those two
-- dates: every closed cohort has a complete 2026-08-09 reading, Panel 3 reads
-- current observations only, and the maturation panel is deferred until the
-- series has points.
--
-- FOLLOW-UP (not v1): if the early blanks can be shown to mean zero — e.g. by
-- reconciling a 08-06 cohort against its 08-09 re-read, where Gross Written is
-- immutable and must tie — those observations become recoverable and the series
-- gains two dates. Do not assume it; prove it against a closed month first.
--
-- ⚠️ 2. (period_start, as_of_date) IS NOT UNIQUE. March carries six snapshots
-- observed 2026-08-06 with identical totals; August carries two on 08-10 and
-- two on 08-11. These are redundant re-ingests of one observation, not several
-- observations. Un-deduped they double-count the cohort and stack several
-- points on one x-coordinate. DISTINCT ON keeps the latest `ingested_at` per
-- (cohort month, observation date). `snapshot_id` is published so the specific
-- ingest behind any row stays traceable.
--
-- ⚠️ 3. OFFICE CODES MUST BE SUMMED BEFORE ANY RATE IS DERIVED. BOCA, FTLAU and
-- MIAMI are three LP offices and one market. On the 2026-08-11 snapshot they
-- are gross $94,415 / $140,433 / $0 and net $85,415 / $0 / $0 — so reading the
-- FTLAU row alone reports Fort Lauderdale at $140,433 gross and $0 net, and
-- averaging the three rates is a different (also wrong) number. The market
-- total is $234,848 gross and $85,415 net, and every rate here divides a summed
-- numerator by a summed denominator. RFED appears in January and not in August,
-- so the constituent set is not fixed and must never be hardcoded.
--
-- ⚠️ 4. 'ytd' SNAPSHOTS SHARE JANUARY'S period_start. A cohort is one contract
-- month; the YTD pull would collide with the January cohort and roughly septuple
-- it. Only 'month' and 'mtd' scopes are cohorts.
--
-- ── THE WATERFALL IS A DIAGNOSTIC, NOT A GATE ───────────────────────────────
--
-- `waterfall_delta_cents = (nsa + working + hold + cancelled + cd) − gross`.
-- Positive means the disposition buckets EXCEED gross written. Measured
-- 2026-08-11, the identity ties exactly on only two of eight cohorts (May and
-- August at $0; March is +$150,920 / +1.27%), and the sign flips between April
-- and June, so it is not a systematic double-count.
--
-- The delta is RECORDED, never corrected. `net_survival_rate` stays
-- nsa ÷ gross even when the waterfall does not foot — no normalising the
-- components to 100%, no allocating the residual, no silent "Other" bucket.
-- The precedent is report 138's disposition identity, which was verified
-- against January alone, generalised, and rejected 60 files in a day before it
-- was downgraded to a warning. A reconciliation identity OBSERVED in data is
-- evidence; a source-system accounting identity is a contract. LP guarantees
-- no such contract, so this stays an observation.
--
-- ⚠️ CORRECTED 2026-08-12b — see 2026-08-12b_cohort_disposition_split.sql.
-- This paragraph originally called `net_sales_cents` (gross − cancelled − cd)
-- and `nsa_cents + working_cents + hold_cents` "two routes to the same figure".
-- That states as an IDENTITY what the section above proves is only an
-- OBSERVATION, and it is the one mistake this file exists to prevent. Correct
-- statement: the subtraction DEFINES Net Sales; the sum is what LP separately
-- reports; the difference between them is the delta, carried and never
-- resolved into either side. January: $8,715,862 defined vs $8,754,813
-- observed = a +$38,951 gap, which is January's delta to the cent.
--
-- ROLLBACK:
--   DROP VIEW IF EXISTS lp_cohort_reobservation;
--   DROP VIEW IF EXISTS lp_cohort_maturation;
--
-- AFTER RUNNING: nothing to backfill and no ingest to restart — both views read
-- snapshots that already exist. New observations appear as soon as report 137
-- is re-pulled. `lp_cohort_reobservation` is the list that re-pull should be
-- driven from; the schedule itself lives in n8n, which posts to
-- POST /n8n/admin/lp-report-ingest/{slug}.
--
-- Applied by hand per sql/README.md — additive DDL, MCP apply_migration.
-- Not mirrored in runMigrations(): these are reporting views, not boot-critical
-- schema, and a fresh deploy with no snapshots would create them over an empty
-- table to no purpose.

BEGIN;

-- ── One observation per cohort per day, at market grain ─────────────────────
CREATE OR REPLACE VIEW lp_cohort_maturation AS
WITH observation AS (
  -- ⚠️ 2 and ⚠️ 4 above: cohorts only, and same-day re-ingests collapsed to the
  -- one that landed last.
  SELECT DISTINCT ON (s.period_start, s.as_of_date)
         s.id             AS snapshot_id,
         s.period_start   AS contract_month,
         s.as_of_date     AS observed_on,
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
  -- ⚠️ 3 above: office codes summed into the market here, once, before any
  -- division happens anywhere downstream.
  --
  -- ⚠️ 1 above: COUNT(*) = COUNT(col) is what keeps an unreported column
  -- unknown instead of small. Do not simplify these to a bare SUM().
  SELECT o.snapshot_id,
         o.contract_month,
         o.observed_on,
         o.scope,
         o.is_current,
         o.ingested_at,
         h.market,
         COUNT(DISTINCT h.branch_code_raw)                                        AS office_count,
         CASE WHEN COUNT(*) = COUNT(h.gsa_cents)       THEN SUM(h.gsa_cents)       END AS gross_cents,
         CASE WHEN COUNT(*) = COUNT(h.nsa_cents)       THEN SUM(h.nsa_cents)       END AS nsa_cents,
         CASE WHEN COUNT(*) = COUNT(h.working_cents)   THEN SUM(h.working_cents)   END AS working_cents,
         CASE WHEN COUNT(*) = COUNT(h.hold_cents)      THEN SUM(h.hold_cents)      END AS hold_cents,
         CASE WHEN COUNT(*) = COUNT(h.cancelled_cents) THEN SUM(h.cancelled_cents) END AS cancelled_cents,
         CASE WHEN COUNT(*) = COUNT(h.cd_cents)        THEN SUM(h.cd_cents)        END AS cd_cents,
         SUM(h.num_issued)     AS issued_count,
         SUM(h.num_net_issued) AS net_issued_count,
         SUM(h.num_sat)        AS sat_count,
         SUM(h.num_sold)       AS sold_count,
         SUM(h.num_net)        AS net_sold_count,
         SUM(h.num_cancelled)  AS cancelled_count,
         SUM(h.num_cd)         AS cd_count,
         SUM(h.num_working)    AS working_count,
         SUM(h.num_hold)       AS hold_count
  FROM observation o
  JOIN lp_sales_efficiency_history h ON h.snapshot_id = o.snapshot_id
  GROUP BY o.snapshot_id, o.contract_month, o.observed_on, o.scope,
           o.is_current, o.ingested_at, h.market
)
SELECT
  m.contract_month,
  m.market,
  m.observed_on,
  (m.observed_on - m.contract_month)                          AS cohort_age_days,
  m.snapshot_id,
  m.scope,
  m.is_current,
  m.ingested_at,
  m.office_count,

  -- ── Dollars. The cohort's defining figure and its five dispositions. ──────
  m.gross_cents,
  m.nsa_cents,
  m.working_cents,
  m.hold_cents,
  m.cancelled_cents,
  m.cd_cents,

  -- Net Sales = Gross Written − Cancellations − Financing Denied.
  -- The goal-bearing basis: it excludes only the two TERMINAL losses and
  -- counts working and hold as business still in play. Observable immediately
  -- (cancels and credit declines land fast) where NSA takes months to settle,
  -- and it converges on NSA as the cohort matures — NSA is 100.1%–101.6% of it
  -- on the settled Jan–Apr cohorts.
  (m.gross_cents - m.cancelled_cents - m.cd_cents)            AS net_sales_cents,

  -- ── Rates, every one a summed numerator over a summed denominator. ────────
  (m.nsa_cents::numeric       / NULLIF(m.gross_cents, 0))     AS nsa_rate,
  (m.working_cents::numeric   / NULLIF(m.gross_cents, 0))     AS working_rate,
  (m.hold_cents::numeric      / NULLIF(m.gross_cents, 0))     AS hold_rate,
  (m.cancelled_cents::numeric / NULLIF(m.gross_cents, 0))     AS cancel_rate,
  (m.cd_cents::numeric        / NULLIF(m.gross_cents, 0))     AS cd_rate,

  ((m.working_cents + m.hold_cents)::numeric
                              / NULLIF(m.gross_cents, 0))     AS pending_rate,
  ((m.cancelled_cents + m.cd_cents)::numeric
                              / NULLIF(m.gross_cents, 0))     AS lost_rate,

  -- The goal-bearing basis as a share of what was written.
  ((m.gross_cents - m.cancelled_cents - m.cd_cents)::numeric
                              / NULLIF(m.gross_cents, 0))     AS net_sales_rate,

  -- The QUALITY KPI: how much of what we wrote survived all the way to LP's
  -- net. Unaffected by the waterfall delta, by construction.
  (m.nsa_cents::numeric       / NULLIF(m.gross_cents, 0))     AS net_survival_rate,

  -- ── Reconciliation. Diagnostic only. NULL until all five are observed. ────
  ((m.nsa_cents + m.working_cents + m.hold_cents
      + m.cancelled_cents + m.cd_cents) - m.gross_cents)      AS waterfall_delta_cents,
  (((m.nsa_cents + m.working_cents + m.hold_cents
      + m.cancelled_cents + m.cd_cents) - m.gross_cents)::numeric
                              / NULLIF(m.gross_cents, 0))     AS waterfall_delta_pct,

  -- ── Counts, for sit rate and average sale. ───────────────────────────────
  m.issued_count,
  m.net_issued_count,
  m.sat_count,
  m.sold_count,
  m.net_sold_count,
  m.cancelled_count,
  m.cd_count,
  m.working_count,
  m.hold_count
FROM market m;

COMMENT ON VIEW lp_cohort_maturation IS
  'Report 137 as a cohort time series: one row per (contract_month, market, observed_on), '
  'office codes summed to market grain before any rate is derived. Sourced from the raw '
  'lp_sales_efficiency_history rows, not lp_report_facts — the raw rows win on divergence '
  'and cover 4 snapshots that projected to zero facts. Superseded snapshots are INCLUDED: '
  'the demoted history IS the series and must not be pruned. An unobserved disposition is '
  'NULL, never 0 (MTD pulls carry a blank Net column), and a market total is published only '
  'when every constituent office reported that column. waterfall_delta_* is a diagnostic and '
  'never adjusts a rate.';

-- ── Which cohorts still need re-observing ───────────────────────────────────
--
-- A cohort only matures if it is re-observed. Pull the current month always;
-- pull a prior month while it still holds Working or Hold dollars, or while it
-- is younger than the eligibility threshold and therefore still feeding the
-- mature-rate denominator. Nine rows per month — the cost is trivial and the
-- alternative is a cohort frozen at its first reading.
--
-- 90 days mirrors the dashboard's MATURE_RATE_ELIGIBILITY_DAYS, anchored at the
-- cohort month start. If that constant moves, move this with it.
CREATE OR REPLACE VIEW lp_cohort_reobservation AS
WITH latest AS (
  SELECT DISTINCT ON (contract_month)
         contract_month, observed_on
  FROM lp_cohort_maturation
  ORDER BY contract_month, observed_on DESC
),
totals AS (
  SELECT m.contract_month,
         m.observed_on,
         SUM(m.working_cents) AS working_cents,
         SUM(m.hold_cents)    AS hold_cents
  FROM lp_cohort_maturation m
  JOIN latest l
    ON l.contract_month = m.contract_month
   AND l.observed_on    = m.observed_on
  GROUP BY m.contract_month, m.observed_on
)
SELECT t.contract_month,
       t.observed_on                              AS last_observed_on,
       (CURRENT_DATE - t.observed_on)             AS days_since_observed,
       (CURRENT_DATE - t.contract_month)          AS cohort_age_days,
       t.working_cents,
       t.hold_cents,
       CASE
         WHEN t.contract_month = date_trunc('month', CURRENT_DATE)::date
           THEN 'current_month'
         WHEN COALESCE(t.working_cents, 0) + COALESCE(t.hold_cents, 0) > 0
           THEN 'unresolved_dollars'
         ELSE 'below_eligibility_age'
       END                                        AS reason
FROM totals t
WHERE t.contract_month = date_trunc('month', CURRENT_DATE)::date
   OR COALESCE(t.working_cents, 0) + COALESCE(t.hold_cents, 0) > 0
   OR (CURRENT_DATE - t.contract_month) < 90
ORDER BY t.contract_month;

COMMENT ON VIEW lp_cohort_reobservation IS
  'Cohorts that still need report 137 re-pulled, and why: the current month always, plus any '
  'prior month still holding Working or Hold dollars or younger than the 90-day eligibility '
  'threshold. Drive the n8n re-pull schedule from this; the 90 mirrors the dashboard''s '
  'MATURE_RATE_ELIGIBILITY_DAYS.';

COMMIT;

-- ── Verification ────────────────────────────────────────────────────────────
--
-- 1. Fort Lauderdale on snapshot 7b76f264-6e2b-4e1c-ab5f-41e3838090bd is the
--    three-office rollup, NOT the FTLAU row. MUST return exactly one row:
--    gross 23484800, nsa 8541500, cancelled 9569800, issued 47, sold 4,
--    office_count 3. If gross comes back 14043300 with nsa 0, the aggregation
--    collapsed to a single constituent office.
--    SELECT market, gross_cents, nsa_cents, cancelled_cents, issued_count,
--           sold_count, office_count
--    FROM lp_cohort_maturation
--    WHERE snapshot_id = '7b76f264-6e2b-4e1c-ab5f-41e3838090bd'
--      AND market = 'FTLAU_MKT';
--
-- 2. A blank is unknown, not zero. Verified 2026-08-12: 08-05 and 08-06 return
--    nsa_known 0 (and mostly-NULL money columns generally — see ⚠️ 1); 08-09,
--    08-10 and 08-11 return a number on every row. Any 0.0000 survival rate in
--    the early group means a bare SUM() crept back in.
--    SELECT observed_on, COUNT(*) AS rows,
--           COUNT(nsa_cents) AS nsa_known,
--           COUNT(net_survival_rate) AS survival_known,
--           COUNT(net_sales_cents) AS net_sales_known
--    FROM lp_cohort_maturation GROUP BY 1 ORDER BY 1;
--
-- 2b. Which columns the early parser left blank. Expect full counts from
--    2026-08-09 onward and ragged ones before it.
--    SELECT observed_on, COUNT(*) AS rows, COUNT(gross_cents) AS gross_known,
--           COUNT(cancelled_cents) AS canc_known, COUNT(cd_cents) AS cd_known,
--           COUNT(working_cents) AS working_known, COUNT(hold_cents) AS hold_known
--    FROM lp_cohort_maturation GROUP BY 1 ORDER BY 1;
--
-- 3. Same-day re-ingests collapse to one observation. MUST return zero rows —
--    March 2026-08-06 (6 snapshots) and August 08-10/08-11 (2 each) are the
--    cases this guards.
--    SELECT contract_month, market, observed_on, COUNT(*)
--    FROM lp_cohort_maturation GROUP BY 1,2,3 HAVING COUNT(*) > 1;
--
-- 4. Company waterfall by cohort, on the current observations. Expect
--    Jan +38951 (+0.33%), Feb +55196 (+0.51%), Mar +150920 (+1.27%),
--    Apr +29727 (+0.28%), May 0, Jun −13069 (−0.11%), Jul −27457 (−0.26%),
--    Aug 0. March exceeding the 1% threshold is a WARNING, not a failure —
--    nothing here rejects it and net_survival_rate is unaffected.
--    SELECT contract_month,
--           SUM(waterfall_delta_cents) AS delta_cents,
--           ROUND(100.0 * SUM(waterfall_delta_cents) / NULLIF(SUM(gross_cents),0), 2) AS delta_pct
--    FROM lp_cohort_maturation WHERE is_current GROUP BY 1 ORDER BY 1;
--
-- 5. The two routes to Net Sales differ by exactly the waterfall delta.
--    MUST return zero rows.
--    SELECT contract_month, market, observed_on
--    FROM lp_cohort_maturation
--    WHERE nsa_cents IS NOT NULL
--      AND (nsa_cents + working_cents + hold_cents) - net_sales_cents
--          <> waterfall_delta_cents;
--
-- 6. Gross Written is immutable once the month closes. March was observed on
--    08-06 and again on 08-09; gross MUST be identical across both.
--    SELECT contract_month, COUNT(DISTINCT gross_total) AS distinct_gross
--    FROM (SELECT contract_month, observed_on, SUM(gross_cents) AS gross_total
--          FROM lp_cohort_maturation WHERE contract_month < date_trunc('month', CURRENT_DATE)::date
--          GROUP BY 1,2) x
--    GROUP BY 1 HAVING COUNT(DISTINCT gross_total) > 1;
--
-- 7. The re-pull queue names the current month and every cohort still holding
--    unresolved dollars. Expect August as 'current_month' and July (25.1%
--    pending) as 'unresolved_dollars'.
--    SELECT * FROM lp_cohort_reobservation;
