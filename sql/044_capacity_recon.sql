-- ─── 044 — Capacity board fix pass 1: LP branch attribution ─────────────────
--
-- lp_leads.lp_branch_id: LP's own branch for the LEAD (lead-level `brn_id` in
-- GetLead responses, verified live 2026-07-22 — e.g. 'SAR', 'FTLAU'). LP's
-- screens attribute appointments by this branch; resolving by customer ZIP
-- structurally disagrees with it (a SAR-branch lead can carry a 34201 mailing
-- zip). Market assignment now resolves: job branch (brn_map, revenue-
-- authoritative, unchanged) → lead branch (method='branch') → zip fallback.
--
-- Populated by the sync writers on every path (absent never overwrites);
-- historical rows stay NULL until a re-sync touches them and fall back to zip.
--
-- Idempotent — mirrored in runMigrations() (src/index.js) via run_sql.

ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS lp_branch_id text;
CREATE INDEX IF NOT EXISTS idx_lp_leads_branch ON lp_leads(lp_branch_id);
