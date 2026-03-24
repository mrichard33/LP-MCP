-- ─── Purge Junk Notes — Run in Supabase SQL Editor ────────────────
--
-- Root Cause: LP API returned notes as strings instead of arrays.
-- JavaScript spread operator on a string iterates each character,
-- creating one "note" row per character with Math.random() IDs.
--
-- Evidence:
--   1,750,277 rows have lp_note_id starting with "0." (Math.random fallback)
--   1,750,274 rows have null note_body
--   Only 32,627 rows have actual note content
--   raw_lp_data contains single characters, corrupting JSONB queries
--
-- This script deletes the junk rows and vacuums the table.
-- Run AFTER deploying the code fix (src/safe-notes.js) to prevent re-creation.

-- Step 1: Count what we're about to delete (verify before proceeding)
SELECT
  COUNT(*) FILTER (WHERE lp_note_id LIKE '%-0.%' OR lp_note_id LIKE '0.%') as junk_rows,
  COUNT(*) FILTER (WHERE note_body IS NOT NULL AND LENGTH(note_body) > 1) as good_rows,
  COUNT(*) as total_rows
FROM lp_notes;

-- Step 2: Delete junk rows (Math.random IDs)
-- These are the rows created by the string-spread bug.
-- They have IDs like "12345-0.7382619..." or just "0.7382619..."
DELETE FROM lp_notes
WHERE lp_note_id LIKE '%-0.%'
   OR (lp_note_id LIKE '0.%' AND LENGTH(lp_note_id) > 10);

-- Step 3: Delete any remaining rows with null body AND no useful data
-- Safety net for edge cases the pattern above might miss
DELETE FROM lp_notes
WHERE note_body IS NULL
  AND ghl_contact_id IS NULL
  AND created_at_lp IS NULL
  AND created_by_rep_name IS NULL;

-- Step 4: Verify cleanup
SELECT
  COUNT(*) as remaining_rows,
  COUNT(*) FILTER (WHERE note_body IS NOT NULL) as with_body,
  COUNT(*) FILTER (WHERE note_body IS NULL) as null_body
FROM lp_notes;

-- Step 5: Also purge junk activity rows synthesized from bad notes
-- These have IDs like "note-12345-0.738..." or "note-12345--"
DELETE FROM lp_activities
WHERE lp_activity_id LIKE 'note-%-0.%'
   OR (activity_type = 'note' AND activity_detail IS NULL AND activity_date IS NULL);

-- Step 6: Verify activities cleanup
SELECT COUNT(*) as remaining_activities FROM lp_activities;

-- Step 7: Reclaim disk space (run separately if needed — can take a moment)
-- VACUUM ANALYZE lp_notes;
-- VACUUM ANALYZE lp_activities;
