-- 085_sync_watermark_window_complete.sql
--
-- WO-11 / WO-12 / WO-14: stop the incremental window growing all day, make the
-- watermark advance on rows PROCESSED rather than rows WRITTEN, and finish the
-- honest-metrics work 082 started.
--
--
-- WO-11 — WHAT THE WATERMARK ACTUALLY IS, AND WHETHER IT WAS STUCK
-- ----------------------------------------------------------------
-- Source: getLastSyncTimestamp() in src/sync-log.js. It reads lp_sync_log —
-- NOT any entity table, and NOT max(synced_at) over written rows. Pre-085 rule:
--
--   max(completed_at) WHERE entity_type='leads'
--                       AND status='completed'
--                       AND records_synced > 0
--
-- It was NOT stuck. Measured 2026-09-04, the `leads` row of every incremental
-- run: 16:50:13 → 17:04:17 → 17:18:24 → 17:37:46 → 17:52:53 → 18:17:01 →
-- 18:57:55Z. Every run completed with records_synced between 79 and 130, so the
-- gate never excluded one and the value advanced each cycle.
--
-- The leading hypothesis — that #837's skip-unchanged-writes optimization froze
-- the watermark — is therefore REFUTED as the cause of the 2026-09-04
-- degradation. #841 is refuted too: the pattern predates its 16:41Z deploy by
-- days.
--
-- The window start was thrown away AFTER the watermark was read. resolveWindowStart()
-- in src/sync-engine.js truncates the cursor to an ET calendar DATE unless
-- SYNC_WINDOW_MODE='timestamp'. The default was 'date' and production was
-- running it. Measured in production at 2026-09-04T19:18:49Z:
--
--   [Sync] Incremental window: 2026-09-04 → 2026-09-04 [date]
--
-- That is a midnight-Eastern anchor with a moving end: a window that grows all
-- day and resets at midnight ET. It shows up as a daily sawtooth, not a
-- monotonic climb — avg minutes per incremental run, from lp_sync_log:
--
--   Sep 2   04:00Z  2.08 → 05:00Z 0.30 → 19:00Z 38.00 → 23:00Z  4.86
--   Sep 3   04:00Z 19.00 → 05:00Z 0.02 → 20:00Z 29.05
--   Sep 4   04:00Z 54.13 → 05:00Z 0.16 → 18:00Z 16.93
--
-- The 04:00Z spike each day is the single run whose window spans two ET dates.
-- A frozen watermark cannot produce a daily reset. The date truncation can, and
-- does.
--
--
-- WO-12 — WHY THE FIX IS TWO CHANGES, NOT ONE
-- -------------------------------------------
-- Narrowing the window alone would have re-introduced the reported symptom by a
-- different route, because the H1 mechanism IS real — it is simply masked today.
--
-- #837/#846 stopped writing rows whose payload hash was unchanged. An unchanged
-- prospect returns null from the page mapper and never increments counts.leads,
-- so `records_synced` counts WRITES. The pre-085 watermark gate required
-- records_synced > 0. A since-midnight window always writes something, so the
-- gate always passed. A true 15-minute delta in which every row is unchanged
-- writes NOTHING — and that gate would have discarded the run, dropped the
-- cursor back to the last run that happened to write, and re-opened the window
-- a little further every cycle.
--
-- So the gate moves off writes and onto window coverage:
--
--   max(started_at) WHERE entity_type='leads'
--                     AND status='completed'
--                     AND window_complete = true
--
-- window_complete is TRUE only when the leads sweep reached the end of its
-- window: no MAX_INCREMENTAL_LEADS cap, no MAX_SCANNED_LEADS ceiling, and no
-- page that errored and truncated the sweep. A capped run is `completed` for
-- log purposes and is draining a backlog by design; advancing past one silently
-- abandons the remainder. This is the "never advance past a page that errored
-- mid-way" guard, widened to cover the two caps, which are the far more common
-- way a run stops short.
--
-- started_at, not completed_at: a sweep READS across [started_at..completed_at]
-- (22.5 min on the 18:35Z run). A lead changed while the sweep was already past
-- its page is invisible to that run, so a cursor at completed_at skips it
-- forever. SYNC_WINDOW_OVERLAP_MIN was sized to out-run that hazard; anchoring
-- at started_at removes it, and the overlap returns to defence in depth.
--
-- NULL is the honest default. Rows written before this migration cannot know
-- whether their window drained, so they are left NULL and the pre-085 rule
-- still serves them — scoped to `window_complete IS NULL` so a legacy row can
-- never out-rank a real drained-window row.
--
--
-- WO-14/G1+G2 — CONTAINER KILLS ARE NOT SYNC FAILURES
-- ---------------------------------------------------
-- 082 fixed the classification going forward and never backfilled history. The
-- backlog is far larger than the 120 rows reported: measured 2026-09-04,
--
--   failed / 'Process terminated'              8,805   (pre-v6.6 SIGTERM label)
--   failed / 'SIGTERM — container terminated'  2,298
--   failed / 'Stale lock — cleaned up on boot' 1,204
--
-- All three are one thing: the process being killed out from under an in-flight
-- sweep. That is infrastructure, never a data defect. 'Process terminated' was
-- the SIGTERM/SIGINT handler's default reason before v6.6 gave timeout cleanup
-- its own wording, so it belongs with the other two.
--
-- Sweep timeouts ('... timed out after Nmin', 1,048 rows) are deliberately left
-- `failed`. A sweep that ran out of budget is a real capacity problem and
-- should stay visible; it is not a container kill.
--
-- Stale-lock rows need no code change — src/sync-engine.js already writes them
-- as `interrupted` (the newest `failed` one is 2026-09-04 12:52Z, before that
-- deploy). This is history only.
--
-- Expected after this migration, over a trailing 24h: 102 SIGTERM and 6 stale
-- lock rows move to `interrupted`, leaving `failed` = 1 ('1 records failed').
-- That 1 is the true record-level failure count.
--
--
-- WO-14/G4 (api_calls → sweep_api_calls) is sql/086, NOT this file. A column
-- rename is only safe simultaneously with the deploy that writes the new name;
-- run early, it silently blinds the paging telemetry during an active P1.
-- Everything in 085 is safe to run against the CURRENT production build.
--
-- G3 (jobs/milestones telemetry) is already closed by 084: the job-changes
-- sweep now writes its own paging columns to the `jobs` row. `milestones` stays
-- NULL on purpose — milestones are not paged for at all, they arrive embedded
-- in the job payloads, and a mirrored number would read as an independent
-- measurement.

BEGIN;

-- WO-12: window coverage. Nullable, no backfill — see the NULL note above.
ALTER TABLE lp_sync_log
  ADD COLUMN IF NOT EXISTS window_complete boolean;

COMMENT ON COLUMN lp_sync_log.window_complete IS
  'True when this sweep reached the END of its incremental window (no MAX_INCREMENTAL_LEADS cap, no MAX_SCANNED_LEADS ceiling, no truncating page error). Only the leads row is written, and only a true row may advance getLastSyncTimestamp. NULL = written before sql/085 and unknowable.';

-- The watermark read: newest drained leads row. Partial so it stays small.
CREATE INDEX IF NOT EXISTS idx_lp_sync_log_watermark
  ON lp_sync_log (started_at DESC)
  WHERE entity_type = 'leads' AND status = 'completed' AND window_complete;

-- WO-14/G1+G2: reclassify historical container kills. Idempotent.
UPDATE lp_sync_log
   SET status = 'interrupted'
 WHERE status = 'failed'
   AND error_message IN (
     'SIGTERM — container terminated',
     'Process terminated',
     'Stale lock — cleaned up on boot'
   );

COMMIT;

-- ─── VERIFY ──────────────────────────────────────────────────────────────────
--
-- 1. Real record-level failures over 24h. Expect a single digit (1 at the time
--    of writing), with the container kills carried by `interrupted`.
--
--    SELECT status, count(*)
--      FROM lp_sync_log
--     WHERE started_at >= now() - interval '24 hours'
--     GROUP BY 1 ORDER BY 2 DESC;
--
-- 2. Nothing infrastructural left in `failed`. Expect zero rows.
--
--    SELECT count(*) FROM lp_sync_log
--     WHERE status = 'failed'
--       AND error_message IN ('SIGTERM — container terminated',
--                             'Process terminated',
--                             'Stale lock — cleaned up on boot');
--
-- 3. AFTER DEPLOY — the window must collapse. Expect `[timestamp]` in the log
--    line, and records_synced for activities to fall from ~2,979 to a small
--    steady delta that does NOT climb run over run:
--
--    SELECT started_at, records_synced, rows_scanned, paging_mode, sweep_api_calls,
--           round(EXTRACT(EPOCH FROM (completed_at - started_at))/60, 2) AS minutes
--      FROM lp_sync_log
--     WHERE entity_type = 'activities' AND sync_type = 'incremental'
--     ORDER BY started_at DESC LIMIT 12;
--
-- 4. AFTER DEPLOY — the watermark must advance on quiet runs too. Every recent
--    leads row should read window_complete = true; a run with records_synced = 0
--    that still shows true is the #837 landmine proven defused:
--
--    SELECT started_at, records_synced, window_complete
--      FROM lp_sync_log
--     WHERE entity_type = 'leads' AND sync_type = 'incremental'
--     ORDER BY started_at DESC LIMIT 12;
--
-- 5. SAFETY — no lead may be skipped across the change. Run before and after;
--    a jump means the watermark advanced past unread rows: roll back by setting
--    SYNC_WINDOW_MODE=date and SYNC_WATERMARK_FROM_PROCESSED=false on Railway.
--
--    SELECT count(*) FROM lp_leads
--     WHERE created_at_lp >= '2026-09-04 16:00:00+00' AND ghl_contact_id IS NULL;
