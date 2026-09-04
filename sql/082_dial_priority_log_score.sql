-- ============================================================================
-- 082_dial_priority_log_score.sql — Capacity ranker: scoring provenance
-- ============================================================================
-- Additive. Extends dial_priority_log (sql/080, sql/081) with what the run was
-- SCORED on, so a logged ranking can be reproduced months later
-- (src/capacity/rankMarkets.js, src/capacity/marketPerformance.js):
--
--   perf_weight    — the RANKER_PERF_WEIGHT in force for this run (default
--                    0.25; 0 disables weighting entirely). The multiplier is
--                    clamp(1 + W × (market_set_to_sale / company - 1),
--                    0.85, 1.15) and the ±0.15 clamp holds at ANY W, so
--                    capacity always dominates performance.
--   scoring_basis  — 'open_true_weighted'. A literal, not a computed value:
--                    it names WHICH ranking rule produced the row so the
--                    pre-2026-09 rows (ranked on fill_pct = confirmed /
--                    requested, which ignored the hopper and put Jacksonville
--                    at priority 1 with one genuinely open slot) stay
--                    distinguishable from everything after.
--
-- Both are nullable: rows written before this migration have no answer, and
-- inventing one would be worse than leaving it NULL.
--
-- The per-market multiplier, set_to_sale and starvation_promoted flag are NOT
-- separate columns — they are already inside the `ranking` jsonb, per market,
-- where they belong.
--
-- Mirrored in runMigrations() (src/index.js). Safe to re-run.
--
-- EXECUTION: Supabase dashboard SQL editor, LP MCP instance. One execution.
--
-- Rollback:
--   ALTER TABLE dial_priority_log
--     DROP COLUMN IF EXISTS perf_weight,
--     DROP COLUMN IF EXISTS scoring_basis;
-- ============================================================================

ALTER TABLE dial_priority_log
  ADD COLUMN IF NOT EXISTS perf_weight   numeric,
  ADD COLUMN IF NOT EXISTS scoring_basis text;
