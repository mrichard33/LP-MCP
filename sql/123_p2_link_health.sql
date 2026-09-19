-- ─── sql/123 — P2 link health snapshot ──────────────────────────────────────
--
-- 2026-09-19. Makes the standing pile of open P2 opportunities that have NO
-- lp_jobs row behind them durable, queryable and TRENDED. Measured the day
-- this was written:
--
--     open P2 opportunities .......................... 1,107
--     of those, no lp_jobs row for the contact .......   289   $6,732,863
--
-- $6.7M of signed contracts that no LP-derived process can see. They are
-- reported and deliberately never touched by scripts/reconcile-p2-stages.js,
-- which is correct for a repair pass and left the pile with no owner and no
-- number.
--
-- ─── WHY THIS IS A SNAPSHOT TABLE AND NOT JUST A VIEW ──────────────────────
-- Because the question spans BOTH Supabase instances and they cannot be
-- cross-joined (CLAUDE.md). The opportunities and contacts live in HL; the
-- jobs and leads live here in LP. No view in either database can see both
-- halves, so there is no SELECT that answers this and never will be.
--
-- The intersection is therefore computed in JS by src/jobs/p2-unresolvable-
-- monitor.js, which already holds a client to each instance, and the ANSWER is
-- written here once per pass. That is the only honest shape: a view would have
-- to lie about one side.
--
-- Storing it rather than recomputing on demand buys the thing a live query
-- could not give anyway — HISTORY. "Is the backlog shrinking?" is the question
-- an operator actually asks, and a number with no predecessor cannot answer
-- it. It is also what feeds the growth rule in src/p2-unresolvable-alerts.js:
-- that rule compares against the previous row, and with no table there is no
-- previous row and the rule silently never fires.
--
-- ONE ROW PER PASS, APPEND ONLY. Daily, so this grows by ~365 rows a year and
-- needs no retention policy in any timeframe worth writing code for.

CREATE TABLE IF NOT EXISTS p2_link_health (
  id                   BIGSERIAL PRIMARY KEY,
  measured_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Denominator. Without it "289" is unreadable: 289 of 1,107 is a problem,
  -- 289 of 300 is an outage.
  open_total           INTEGER,

  -- Open P2 opportunities with no lp_jobs row for their ghl_contact_id.
  unresolvable         INTEGER,
  unresolvable_value   NUMERIC(14,2),

  -- The subset added inside the alert window. This is what gets paged on; the
  -- totals above are context. See the alert module's header for why.
  window_days          INTEGER,
  recent               INTEGER,
  recent_value         NUMERIC(14,2),

  -- NULL on every numeric column above means THE READ FAILED, and it is
  -- distinct from 0. A pass that could not count must never be read later as
  -- a pass that counted zero — same doctrine as the three-way alert verdicts.
  read_ok              BOOLEAN NOT NULL DEFAULT TRUE,
  errors               TEXT[],

  verdict              TEXT,   -- alert | healthy | insufficient_evidence
  detail               JSONB
);

CREATE INDEX IF NOT EXISTS idx_p2_link_health_measured_at
  ON p2_link_health (measured_at DESC);

-- ─── v_p2_link_health — the current answer, plus movement ──────────────────
--
-- What a dashboard or an operator wants is one row: where the backlog stands
-- and which way it is going. The window function does the "vs. yesterday"
-- arithmetic here rather than in every caller.
--
-- It reads only rows where read_ok, so a failed pass cannot be mistaken for a
-- recovery. A day the monitor could not measure leaves the view showing the
-- last real measurement, which is the honest answer to "where does it stand".
CREATE OR REPLACE VIEW v_p2_link_health AS
WITH ranked AS (
  SELECT
    measured_at, open_total, unresolvable, unresolvable_value,
    window_days, recent, recent_value, verdict,
    LAG(unresolvable) OVER (ORDER BY measured_at)    AS prev_unresolvable,
    LAG(measured_at)  OVER (ORDER BY measured_at)    AS prev_measured_at
  FROM p2_link_health
  WHERE read_ok AND unresolvable IS NOT NULL
)
SELECT
  measured_at,
  open_total,
  unresolvable,
  unresolvable_value,
  CASE WHEN open_total > 0
       THEN round(100.0 * unresolvable / open_total, 1)
  END AS unresolvable_pct,
  window_days,
  recent,
  recent_value,
  prev_unresolvable,
  unresolvable - prev_unresolvable AS change_since_prev,
  prev_measured_at,
  verdict
FROM ranked
ORDER BY measured_at DESC
LIMIT 1;

COMMENT ON TABLE p2_link_health IS
  'Daily snapshot of open P2 opportunities with no LP job behind them. Written '
  'by src/jobs/p2-unresolvable-monitor.js, which computes the LP/HL '
  'intersection in JS because the two Supabase instances cannot be '
  'cross-joined. NULL counts mean the read failed, never zero.';
