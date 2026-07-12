-- 039_lp_jobs_branch_code.sql  (#512 market attribution)
--
-- Persist the LP branch on lp_jobs so market attribution is a cheap join, not a
-- per-row JSONB extract. The branch is REVENUE-AUTHORITATIVE: job branch →
-- lp_branch_market_map → market ties the Net Report 1,710/1,710, where the
-- lead's ZIP mis-routes 147 sold jobs ($3.32M) to OUT_OF_AREA.
--
-- LP pads the code with trailing spaces ('ORL  '), so TRIM + upper on backfill.
-- Falls back to brn_id when brp_id is absent. Idempotent / additive — also
-- applied on boot by runMigrations() in src/index.js.

ALTER TABLE lp_jobs ADD COLUMN IF NOT EXISTS branch_code TEXT;

-- Backfill existing rows (only where unset — cheap + idempotent on re-run).
UPDATE lp_jobs
   SET branch_code = NULLIF(UPPER(TRIM(COALESCE(raw_lp_data->>'brp_id', raw_lp_data->>'brn_id', ''))), '')
 WHERE branch_code IS NULL
   AND COALESCE(raw_lp_data->>'brp_id', raw_lp_data->>'brn_id') IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lp_jobs_branch_code ON lp_jobs(branch_code);
