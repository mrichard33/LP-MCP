-- ─── 045 — Hourly appointment fill history (Mark, 2026-07-22) ────────────────
--
-- Hour-by-hour companion to the nightly lp_appt_fill_snapshot: one row per
-- (hour × slot_date × market) with the board's counts at that instant, so
-- fill can be trended BY TIME OF DAY ("how do Thursdays book between 9am and
-- noon?"). Insert-only, never rewritten.
--
-- Bounded to the board's forward window (days_out 0..CAPACITY_FORWARD_DAYS)
-- — unlike the nightly snapshot it does not carry far-future numerator-only
-- dates, so junk dates (e.g. the year-2924 typo appointment) never enter.
--
-- days_out cannot be a GENERATED column here: it derives from the ET date of
-- snapshot_hour (TIMEZONE RULE), which requires a timezone conversion that
-- Postgres does not allow in generated-column expressions. The writer computes
-- it in the INSERT with (slot_date - (snapshot_hour AT TIME ZONE
-- 'America/New_York')::date).
--
-- Volume: ~150 rows/hour ≈ 1.3M rows/year — trivial for Postgres.
--
-- Idempotent — mirrored in runMigrations() (src/index.js) via run_sql.

CREATE TABLE IF NOT EXISTS lp_appt_fill_hourly (
  snapshot_hour timestamptz NOT NULL,   -- date_trunc('hour', now())
  slot_date     date NOT NULL,
  market        text NOT NULL,          -- includes 'UNRESOLVED'
  requested     int  NOT NULL DEFAULT 0,
  confirmed     int  NOT NULL DEFAULT 0,
  set_pending   int  NOT NULL DEFAULT 0,
  days_out      int  NOT NULL,
  PRIMARY KEY (snapshot_hour, slot_date, market)
);
CREATE INDEX IF NOT EXISTS idx_lp_appt_fill_hourly_slot ON lp_appt_fill_hourly(slot_date, snapshot_hour);
