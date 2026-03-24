-- ─── Add ghl_note_pushed tracking column to lp_notes ──────────────
-- Required for LP notes → GHL contact notes sync feature.
-- Tracks which notes have been pushed to GHL to avoid duplicates.
--
-- Run in Supabase SQL Editor BEFORE deploying the notes sync feature.

-- Step 1: Add the tracking column
ALTER TABLE lp_notes ADD COLUMN IF NOT EXISTS ghl_note_pushed BOOLEAN DEFAULT false;

-- Step 2: Create index for efficient querying of unpushed notes
CREATE INDEX IF NOT EXISTS idx_lp_notes_unpushed
  ON lp_notes (ghl_contact_id, ghl_note_pushed)
  WHERE ghl_contact_id IS NOT NULL AND ghl_note_pushed = false;

-- Step 3: Verify
SELECT
  COUNT(*) as total_notes,
  COUNT(*) FILTER (WHERE ghl_contact_id IS NOT NULL) as with_ghl_match,
  COUNT(*) FILTER (WHERE ghl_contact_id IS NOT NULL AND ghl_note_pushed = false) as pending_push
FROM lp_notes;
