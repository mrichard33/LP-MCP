-- 111_ghl_request_budget.sql — shared GHL request budget counter
--
-- ⚠️  APPLY THIS ON THE **HL** SUPABASE INSTANCE, NOT LP.
--
-- LP-MCP's runMigrations() in src/index.js targets the LP instance only, and
-- CLAUDE.md puts DDL through the Supabase dashboard. This table lives on HL
-- deliberately: LP-MCP already holds HL_SUPABASE_URL / HL_SUPABASE_SERVICE_ROLE_KEY,
-- so LP -> HL is the established direction and both services can reach one table.
--
-- WHY THIS EXISTS (2026-09-14)
-- ────────────────────────────
-- LP-MCP and HL-MCP each run their own token bucket against the SAME GHL
-- location (65/min and 60/min) and neither can see the other, so every tuning
-- decision has been a guess.
--
-- Measured after #927 brought 25 ungoverned call sites into LP-MCP's bucket:
-- ~80 `acquireToken timed out after 30000ms` lines in 35 minutes at queue
-- depths of 9-23, all `tokens=0, paused=false` — and ZERO 429s. The bucket
-- throttles below real demand while the limit it defends against never fires.
--
-- ghl-rate-limiter.js's own header says not to exceed ~60-70 "without
-- confirming GHL's per-location sustained limit, which is SHARED with the HL
-- MCP". This table is that confirmation.
--
-- APPEND-ONLY BY DESIGN. Rows are summed at read time rather than incremented
-- in place, so multiple instances — or both services — can report the same
-- minute without a read-modify-write race.

CREATE TABLE IF NOT EXISTS ghl_request_budget (
  id            BIGSERIAL PRIMARY KEY,
  minute_bucket TIMESTAMPTZ NOT NULL,
  service       TEXT        NOT NULL,   -- 'lp-mcp' | 'hl-mcp'
  requests      INTEGER     NOT NULL,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ghl_request_budget_minute_idx
  ON ghl_request_budget (minute_bucket DESC);

CREATE INDEX IF NOT EXISTS ghl_request_budget_service_idx
  ON ghl_request_budget (service, minute_bucket DESC);

-- ─── The query this exists to answer ────────────────────────────────
-- Combined rate per minute, and which service contributed what:
--
--   SELECT minute_bucket,
--          SUM(requests) FILTER (WHERE service = 'lp-mcp') AS lp_mcp,
--          SUM(requests) FILTER (WHERE service = 'hl-mcp') AS hl_mcp,
--          SUM(requests)                                   AS total
--   FROM ghl_request_budget
--   WHERE minute_bucket > now() - interval '6 hours'
--   GROUP BY 1
--   ORDER BY 1 DESC;
--
-- The peak `total` is the number the rate-limiter ceiling should be set from.
-- Cross-reference it against LP-MCP's "[RateLimiter] 429 received!" timestamps:
-- if the peak never coincides with a 429, there is headroom.

-- ─── Retention ──────────────────────────────────────────────────────
-- Per-minute rows accumulate at ~1440/day/service. Keep 14 days; that is far
-- more than any tuning decision needs and keeps the table trivially small.
DELETE FROM ghl_request_budget WHERE minute_bucket < now() - interval '14 days';
