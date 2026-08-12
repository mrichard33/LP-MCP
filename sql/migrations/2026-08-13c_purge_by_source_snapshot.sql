-- ════════════════════════════════════════════════════════════════════
-- Purge the By Source snapshot from the market table — 2026-08-13
--
-- Run in: LP MCP Supabase → SQL Editor (or supabase MCP apply_migration).
-- Idempotent (the DELETE is a no-op once the row is gone); safe to re-run.
-- Apply AFTER 2026-08-13_sales_efficiency_by_setter.sql.
--
-- WHAT
--   Snapshot fe5df304-2c90-48fe-a8e0-b413acaebcaf, ingested 2026-08-11, is a
--   137 BY SOURCE export that the header fingerprint could not distinguish
--   from By Market. It put 29 rows of LEAD SOURCES — Bing PPC, HomeBuddy,
--   Modernize, Google PPC Windows, Reece ChatBot … — into
--   lp_sales_efficiency_history, a table whose every consumer reads
--   branch_code_raw as a branch code. All 29 landed market='UNRESOLVED',
--   carrying $2,185,283 of GSA that double-counts revenue already present in
--   the By Market rows for the same period.
--
--   From 2026-08-13 the ingest recognises 'by source' as a known-unstored
--   variant and archives it without storing rows, so this cannot recur. This
--   file removes the one occurrence that predates the fix.
--
-- WHY A GUARD AND NOT A BARE DELETE
--   Deleting a snapshot that holds is_current would leave the period with no
--   live 137 row and blank the Scorecard. Verified 2026-08-12: this snapshot
--   is is_current=false and every is_current sales_efficiency snapshot has
--   zero UNRESOLVED rows — but that was yesterday, and the guard is cheap.
--   If it has since been promoted, this ABORTS and the By Market snapshot for
--   mtd 2026-08-01..2026-08-10 must be restored first.
--
-- WHAT IS DELETED, AND WHAT IS NOT
--   ON DELETE CASCADE removes the 29 lp_sales_efficiency_history rows and the
--   232 lp_report_facts rows with the snapshot. The 29
--   scorecard_ingest_quarantine rows are keyed by file_sha256, not
--   snapshot_id, so they do NOT cascade and are KEPT ON PURPOSE: they are the
--   audit record of what arrived and why it was flagged. The archived CSV in
--   the lp-reports bucket is likewise kept.
--
--   This is the one sanctioned exception to the retention guarantee in
--   2026-08-05_sales_efficiency.sql. That guarantee protects SUPERSEDED
--   snapshots — real reports that a later pull replaced. This snapshot is not
--   a superseded report; it is a different report misfiled into the wrong
--   table, and retaining it means retaining a wrong number.
-- ════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_id        uuid := 'fe5df304-2c90-48fe-a8e0-b413acaebcaf';
  v_current   boolean;
  v_type      text;
  v_rows      int;
  v_unres     int;
BEGIN
  SELECT is_current, report_type INTO v_current, v_type
    FROM scorecard_report_snapshots WHERE id = v_id;

  IF v_type IS NULL THEN
    RAISE NOTICE 'purge: snapshot % already gone — nothing to do', v_id;
    RETURN;
  END IF;

  IF v_current THEN
    RAISE EXCEPTION
      'purge ABORTED: snapshot % is is_current. Restore the By Market snapshot for mtd 2026-08-01..2026-08-10 first, then re-run.', v_id;
  END IF;

  -- Confirm it is the file we think it is before deleting anything: every row
  -- unresolved is the signature of a non-branch grouping in the branch table.
  SELECT count(*), count(*) FILTER (WHERE market = 'UNRESOLVED')
    INTO v_rows, v_unres
    FROM lp_sales_efficiency_history WHERE snapshot_id = v_id;

  IF v_rows = 0 THEN
    RAISE NOTICE 'purge: snapshot % has no history rows — deleting the snapshot only', v_id;
  ELSIF v_unres <> v_rows THEN
    RAISE EXCEPTION
      'purge ABORTED: snapshot % has %/% rows resolved to a real market — that is not the By Source file, refusing to delete',
      v_id, v_rows - v_unres, v_rows;
  END IF;

  DELETE FROM scorecard_report_snapshots WHERE id = v_id;
  RAISE NOTICE 'purge: deleted snapshot % (% history rows, facts cascaded)', v_id, v_rows;
END;
$$;

-- ── verification ────────────────────────────────────────────────────────────
-- Expect 0 from both. The second is the check that actually catches this
-- class of defect — the handoff's `branch_code_raw LIKE '%,%'` returns 0 even
-- with the pollution present, because lead-source names carry no comma.
--
--   SELECT count(*) FROM scorecard_report_snapshots
--    WHERE id = 'fe5df304-2c90-48fe-a8e0-b413acaebcaf';
--
--   SELECT count(*) FROM lp_sales_efficiency_history WHERE market = 'UNRESOLVED';
