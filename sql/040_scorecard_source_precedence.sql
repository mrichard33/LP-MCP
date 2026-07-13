-- ─── Scorecard revenue realignment — sql/040_scorecard_source_precedence.sql ───
--
-- Realigns the scorecard's headline revenue metric to the AUTHORITATIVE basis —
-- Released-to-Production (RTP) NET, by RTP milestone date — and makes the
-- live-month source deterministic. Reporting layer only; nothing writes back to LP.
--
-- Two revenue figures now coexist on a live-month row, NEVER blended:
--   AUTHORITATIVE  report-sourced RTP net → released_dollars / net_sales / good_business,
--                  revenue_basis='rtp_net_by_milestone_date', revenue_as_of=<report date>.
--   PROVISIONAL    warehouse RTP gross by milestone date, for the days AFTER revenue_as_of →
--                  provisional_gross_dollars / provisional_days (pace signal, gross, not net).
--
-- INVARIANT (enforced in the writer + verified): released_dollars IS NULL ⇔ revenue_basis IS NULL.
-- revenue_basis describes the AUTHORITATIVE column ONLY; the provisional label lives in
-- raw_inputs.provisional_basis, never in revenue_basis.
--
-- Sections A/B (schema) are idempotent and mirrored in src/index.js runMigrations() so a
-- deploy applies them on boot. Sections C/D are ONE-SHOT data ops — run once (already applied
-- via the migration tool for this PR); they are guarded so re-running is safe.

-- ─── A. Live-month revenue columns on the snapshot table (additive, idempotent) ───
ALTER TABLE lp_market_scorecard_daily
  ADD COLUMN IF NOT EXISTS revenue_as_of            DATE,
  ADD COLUMN IF NOT EXISTS provisional_gross_dollars NUMERIC,
  ADD COLUMN IF NOT EXISTS provisional_days          INTEGER;

-- ─── B. Net Report RTP staging (one row per market × report snapshot) ───
-- Populated by POST /n8n/admin/net-report-ingest (manual upload or scheduled drop; LP has no
-- report API). report_as_of = the report's coverage end date. A newer snapshot supersedes an
-- older one for the same (market, report_month); older snapshots are retained for drift audit.
CREATE TABLE IF NOT EXISTS lp_net_report_rtp (
  market        TEXT NOT NULL,          -- '*_MKT' or 'REECE'
  report_month  DATE NOT NULL,          -- first-of-month the RTP net applies to (milestone month)
  report_as_of  DATE NOT NULL,          -- report coverage end date (the "as of" date)
  released_net  NUMERIC NOT NULL,       -- Σ NetAmount, MdtDescr='RTP', MilestoneDate in report_month
  rows_counted  INTEGER,                -- # RTP milestone rows summed (audit)
  ingested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (market, report_month, report_as_of)
);
CREATE INDEX IF NOT EXISTS idx_lp_net_report_rtp_month ON lp_net_report_rtp(report_month, market);

-- ─── C. ONE-SHOT: retire legacy / mislabeled bases (guarded; preserves the invariant) ───
-- C1. Backfill closed report rows to the correct label. They ARE report RTP net; the NULL
--     (Jan–May) and mislabeled 'v1' (June REECE) values are simply wrong metadata. Label-only:
--     no dollar column is touched, so the $47,814,304.43 closed total does not move.
UPDATE lp_market_scorecard_daily
   SET revenue_basis = 'rtp_net_by_milestone_date'
 WHERE computed_from = 'net_report_rtp'
   AND released_dollars IS NOT NULL
   AND (revenue_basis IS NULL OR revenue_basis = 'released/working/cancel v1');

-- C2. Retire the legacy July backfill_split_sql rows so they can never win precedence. These
--     rows carry released_dollars (NULL revenue_basis today → an invariant violation), so the
--     relabel both retires them AND repairs the invariant. GUARD: never touch a NULL-revenue row.
UPDATE lp_market_scorecard_daily
   SET revenue_basis = 'released/working/cancel v1 (retired)'
 WHERE computed_from = 'backfill_split_sql'
   AND released_dollars IS NOT NULL;

-- C3. Retire the live-month lp_api 'v1' revenue rows (wrong basis: released/working/cancel by
--     appt/sold date). The realigned daily writer overwrites the live-month slots going forward
--     with the RTP net + provisional split. GUARD: never touch a NULL-revenue row.
UPDATE lp_market_scorecard_daily
   SET revenue_basis = 'released/working/cancel v1 (retired)'
 WHERE computed_from = 'lp_api'
   AND revenue_basis = 'released/working/cancel v1'
   AND released_dollars IS NOT NULL;

-- ─── D. Precedence view — one authoritative row per (market, period_start) ───
-- Ranks on REVENUE provenance (revenue_basis), NOT computed_from: live rows are
-- computed_from='lp_api' but their revenue is report-sourced, so ranking on computed_from would
-- wrongly demote them. Retired/legacy split rows are EXCLUDED entirely so they can never win —
-- the approved goal ("legacy can never win precedence"), stronger than a low rank (a low rank
-- would still beat a fresh no-report NULL row and mis-select the retired figure).
CREATE OR REPLACE VIEW lp_market_scorecard_resolved AS
SELECT DISTINCT ON (market, period_start) *
FROM (
  SELECT s.*,
    CASE
      WHEN revenue_basis = 'rtp_net_by_milestone_date'              THEN 1  -- authoritative net
      WHEN revenue_basis = 'rtp_gross_by_milestone_date_provisional' THEN 2 -- all-provisional (config B)
      ELSE 9                                                                -- NULL (no report yet) / other
    END AS source_rank
  FROM lp_market_scorecard_daily s
  WHERE computed_from NOT IN ('backfill_split_sql', 'backfill_split')
) ranked
ORDER BY market, period_start, source_rank ASC, as_of_date DESC;
