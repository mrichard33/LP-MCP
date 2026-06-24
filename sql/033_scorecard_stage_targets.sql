-- ─── Scorecard optional stage targets — sql/033_scorecard_stage_targets.sql ───
--
-- Optional funnel-stage goal inputs for the scorecard. When set (via the dashboard
-- GoalEditor), the read layer derives Set / % Issue and # Net Close / % Net Close
-- goals from them; when null those rows render "no target" instead of a bare "—".
--   target_issue_pct     → issued ÷ set goal (drives the Set goal: issued_goal ÷ pct)
--   target_net_close_pct → net close % of demos (drives # Net Close goal)
--
-- Nullable + ignored by older readers. Idempotent — safe to re-run.

ALTER TABLE scorecard_goals
  ADD COLUMN IF NOT EXISTS target_issue_pct     numeric,
  ADD COLUMN IF NOT EXISTS target_net_close_pct numeric;
