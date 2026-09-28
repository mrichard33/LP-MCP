-- ════════════════════════════════════════════════════════════════════
-- sql/135 — lp_leads.lp_deleted_at: a lead LP no longer has (2026-09-27)
--
-- Run in the Supabase dashboard SQL editor, LP MCP instance. Additive only:
-- one nullable column, no default, no backfill — a metadata-only change.
-- Mirrored in src/admin/startup-mirrors.js so a fresh deploy self-heals.
--
-- WHY
--   LP deletes duplicate leads, and our copy never learns. Two found live on
--   2026-09-27, both duplicates of a real lead on the same customer at the
--   same appointment time:
--       578101 (customer 345639) — real lead 578404, Mon 9/28 11:00, Cnf
--       577827 (customer 460497) — real lead 577831, Mon 9/28 10:00, Cnf
--   Each ghost still read "Set" for 9/28, so the capacity board counted those
--   appointments twice (once as unconfirmed). And the near-window refresh
--   re-fetched them by lead id every ~15 minutes: LP answers a GetLead for a
--   lead id it no longer has with a 500 "Execution Timeout Expired" (it
--   searches the whole 2000→today range and finds nothing) — 99 failures in
--   13 hours, three slow attempts each.
--
--   The capacity sweep now confirms a suspected ghost by fetching its CUSTOMER
--   (fast), and only when that customer comes back intact without the lead
--   does it stamp this column. Stamped rows leave the board counts and the
--   near-window refresh. Nothing is deleted; the row keeps its history.
--
-- TO UNDO ONE (if LP ever restores a lead):
--   UPDATE lp_leads SET lp_deleted_at = NULL WHERE lp_lead_id = '<id>';
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS lp_deleted_at timestamptz;

COMMENT ON COLUMN lp_leads.lp_deleted_at IS
  'Set when LP returned this lead''s customer without the lead (LP deleted it, usually a duplicate). '
  'NULL = present in LP as far as we know. Excluded from the capacity board. See sql/135.';
