-- ════════════════════════════════════════════════════════════════════
-- 080_dial_priority_log.sql — Capacity-driven Five9 list priority ranker log
-- ════════════════════════════════════════════════════════════════════
-- Doctrine: sql/README.md
--
-- WHAT THIS IS
--   dial_priority_log — one row per POST /n8n/capacity-ranker/run. Carries the
--   computed market ranking (jsonb), the markets excluded as UNKNOWN (fail
--   open — not filed yet, never zero capacity), whether the change was
--   material against the last APPLIED row, whether it was applied to Five9,
--   the mode it ran in (shadow | live), and the error if apply failed.
--
-- WHAT THIS IS NOT
--   - Not a Five9 state mirror: the audit record of an actual write is the
--     five9.admin_write event the gated op already emits.
--   - Nothing in lp_capacity_slots / lp_leads / v_appt_board is touched.
--
-- WHY
--   The ranker compares each run to the last row where applied = true — the
--   ranking Five9 actually reflects — so shadow runs need somewhere to land
--   for the five-working-day review before live mode is considered.
--
-- Mirrored in runMigrations() (src/index.js) with a plain CREATE INDEX so a
-- fresh deploy self-heals. Apply BEFORE the route is first called; the route
-- answers 500 with a clear message if the table is missing.
--
-- EXECUTION: Supabase dashboard SQL editor, LP MCP instance. TWO SEPARATE
-- executions — CREATE INDEX CONCURRENTLY cannot run inside a transaction.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_dial_priority_log_slot_ran;
--   DROP TABLE IF EXISTS dial_priority_log;

-- ── Execution 1 ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dial_priority_log (
  id              bigserial PRIMARY KEY,
  ran_at          timestamptz NOT NULL DEFAULT now(),
  slot_date       date        NOT NULL,
  ranking         jsonb       NOT NULL,
  unknown_markets jsonb       NOT NULL DEFAULT '[]'::jsonb,
  changed         boolean     NOT NULL DEFAULT false,
  applied         boolean     NOT NULL DEFAULT false,
  mode            text        NOT NULL,
  error_message   text
);

-- ── Execution 2 — RUN SEPARATELY (own execution, not in a transaction) ──
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dial_priority_log_slot_ran
  ON dial_priority_log (slot_date, ran_at DESC);
