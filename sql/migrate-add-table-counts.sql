-- Add table_counts JSONB column to lp_sync_log for per-table breakdown
-- Safe to run multiple times (IF NOT EXISTS equivalent via DO block)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'lp_sync_log' AND column_name = 'table_counts'
  ) THEN
    ALTER TABLE lp_sync_log ADD COLUMN table_counts JSONB;
  END IF;
END $$;
