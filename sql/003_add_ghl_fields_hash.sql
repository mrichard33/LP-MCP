-- ─── Migration: Add ghl_fields_hash to lp_leads ──────────────────
-- Run this in Supabase SQL Editor BEFORE deploying the feature branch.
--
-- This column stores a hash of the LP field values last pushed to GHL.
-- The sync engine compares this hash on each cycle — if unchanged,
-- it skips the GHL API call. This prevents 194K+ redundant PUT calls
-- on every sync cycle.

ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS ghl_fields_hash TEXT DEFAULT NULL;

-- Index for quickly finding leads that need field sync
-- (have a GHL match but no fields hash = never synced)
CREATE INDEX IF NOT EXISTS idx_lp_leads_ghl_fields_pending
  ON lp_leads (ghl_contact_id)
  WHERE ghl_contact_id IS NOT NULL AND ghl_fields_hash IS NULL;

-- Verify
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'lp_leads' AND column_name = 'ghl_fields_hash';
