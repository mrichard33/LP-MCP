-- ============================================================================
-- 066 — Call Intelligence: reconciliation support + a latent view bug
--
-- TWO THINGS.
--
-- 1. v_ci_review_queue JOINS ci_matches WITHOUT PICKING A ROW.
--
--    sql/061 wrote that view when ci_matches held at most one row per call.
--    PR 4 and PR 5 made the table append-only on purpose: stageMatch inserts
--    decided_by='auto' (the column default, and one of the only two values its
--    CHECK admits), and the review endpoint appends decided_by='human' beside
--    it rather than overwriting, so the trail shows both what the matcher
--    concluded and what a person decided.
--
--    With a plain LEFT JOIN, a call with two match rows appears TWICE in the
--    review queue — and the two copies disagree, because one carries the
--    system tier and one the human tier. A reviewer would see the same call
--    listed twice with different verdicts and no way to tell which is current.
--
--    Latent as of 2026-08-22 (ci_matches is empty, nothing has run), so this
--    lands before it can bite rather than after. Fixed with a LATERAL that
--    takes the newest row per call.
--
-- 2. Reconciliation needs an index it does not have.
--
--    §6: the Call Log's RECORDINGS column is the authoritative completeness
--    check — a call with segments and no ingested audio is a gap. reconcile.js
--    walks a day of ci_calls and asks, per call, whether ci_recordings holds a
--    non-excluded row. That is a lookup by call_id, and ci_recordings has no
--    such index (its unique index is on source_path).
--
-- Mirrored in runMigrations() (src/index.js). CREATE OR REPLACE VIEW keeps the
-- view's name and permissions; no table is altered and no row is rewritten.
--
-- ⚠ THIS FILE SUPERSEDES sql/061's DEFINITION OF v_ci_review_queue.
-- CREATE OR REPLACE VIEW can add trailing columns but CANNOT DROP one, so
-- re-applying sql/061 verbatim after this has run fails with
-- "cannot drop columns from view" — this view now has 13 columns, sql/061
-- declares 12. Observed live on the 2026-08-23 deploy, where the sql/061
-- migration block failed for exactly this reason. That block no longer creates
-- the view (see the note in runMigrations); this file is its sole owner. To
-- apply sql/061 by hand on a database where 066 has run, either skip its view
-- statement or DROP VIEW v_ci_review_queue first and re-apply 066 after.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS ci_recordings_call_id_idx;
--   -- and restore the sql/061 body of v_ci_review_queue (plain LEFT JOIN)
-- ============================================================================

-- 1. Newest match per call, not every match.
CREATE OR REPLACE VIEW v_ci_review_queue AS
SELECT c.id,
       c.five9_call_id,
       (c.call_start AT TIME ZONE 'America/New_York') AS call_et,
       c.agent_name,
       c.team,
       c.customer_phone_e164,
       c.disposition,
       c.review_reason,
       s.summary_text,
       s.outcome,
       m.tier,
       m.candidates,
       -- Surfaced so a reviewer can see at a glance whether they are looking
       -- at the matcher's conclusion or a colleague's correction.
       m.decided_by
  FROM ci_calls c
  LEFT JOIN ci_summaries s
         ON s.call_id = c.id AND s.is_current
  LEFT JOIN LATERAL (
         SELECT tier, candidates, decided_by
           FROM ci_matches
          WHERE call_id = c.id
          ORDER BY decided_at DESC
          LIMIT 1
       ) m ON true
 WHERE c.status = 'review'
 ORDER BY c.call_start;

-- 2. The per-call recording lookup reconciliation performs for every call in
--    the window.
CREATE INDEX IF NOT EXISTS ci_recordings_call_id_idx
  ON ci_recordings (call_id);

-- ─── Verification ────────────────────────────────────────────────────────────
-- The view returns ONE row per reviewed call even with several match rows:
--   SELECT id, count(*) FROM v_ci_review_queue GROUP BY id HAVING count(*) > 1;
--   -- expect zero rows
-- The index exists:
--   SELECT indexname FROM pg_indexes WHERE indexname = 'ci_recordings_call_id_idx';
