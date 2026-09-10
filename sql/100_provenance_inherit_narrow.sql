-- ─── 100 — Provenance inheritance is scoped to the parent's own checkpoint ──
--
-- WHY. sql/098 gave claude_decision_log and claude_known_issues a BEFORE INSERT
-- trigger that copies a retro parent session's provenance onto every child:
-- origin 'retro', confidence 'reconstructed'. That is right for the case it was
-- written for — a retro checkpoint (or a hand-SQL batch) whose children arrive
-- moments after the session row.
--
-- It is WRONG for a refresh. Mark reopens an old chat whose session summary was
-- reconstructed from a digest, states a decision with the transcript in view,
-- and memory_checkpoint appends it under that session. The decision is live and
-- confirmed — Mark just said it — but the trigger silently stamped it retro /
-- reconstructed because the PARENT is retro.
--
-- Measured 2026-09-10: 95 children (50 decisions, 45 issues) written on 09-09
-- into retro sessions created 09-05, all restored to live / confirmed by hand
-- afterwards. Ruling recorded on a claude_memory_conflicts row the same night:
-- "confirmed beats reconstructed; matches shipped code." The trigger and the
-- ruling were in a standing fight — every future refresh needed the same
-- manual reversal, and the nightly provenance_mismatch_children check reported
-- the reversal as drift.
--
-- WHAT. One window decides it. A child inherits the parent's provenance only
-- when it arrives INSIDE the parent's own checkpoint window (the session row
-- created less than CHECKPOINT_WINDOW ago, 5 minutes — the same constant as
-- BATCH_WINDOW_MINUTES in src/memory/memory-checkpoint.js). Outside that
-- window the child stands on its own: a later append is its own act of
-- recording, with its own origin, confidence and date.
--
--   retro checkpoint      session + children in one sequence, seconds apart
--                         → inside the window → children inherit retro /
--                           reconstructed. Unchanged from sql/098. (The tool
--                           also stamps them explicitly; this stays the
--                           backstop for the hand-SQL fallback path.)
--   live refresh          session written days or weeks earlier
--                         → outside the window → child keeps live / confirmed
--                           and its own date_confidence. NEW.
--
-- date_confidence follows the same window, and for the same reason: inside the
-- window the child is dated FROM the session (memory-checkpoint.js passes
-- c.session.date straight through to decision_date / reported_date), so a
-- guessed session date makes the child's date a guess too. On a later refresh
-- the child is dated the day it was actually decided, which is exact.
--
-- WHAT THIS DOES NOT CHANGE. The session guard
-- (claude_guard_session_insert, sql/098) is untouched: a retro session still
-- cannot be inserted without chat_url + source_chat_updated_at, and a burst of
-- 'live' checkpoints is still relabelled. Nothing about a session row changes
-- here. No existing child row is rewritten by this file — the 95 already carry
-- the provenance the ruling gave them.
--
-- ALL ADDITIVE. One CREATE OR REPLACE FUNCTION. The two triggers created by
-- sql/098 keep pointing at it and are not re-created.
--
-- Apply through the LP MCP supabase_run_query tool AFTER Mark approves
-- (memory-project ground rule 5). Mirrored in src/memory/memory-migrations.js
-- as a presence check (the function body mentions the window).
--
-- ROLLBACK: re-run the claude_inherit_provenance() block in
-- sql/098_memory_integrity.sql section C. No data to undo.

CREATE OR REPLACE FUNCTION claude_inherit_provenance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  j jsonb := to_jsonb(NEW);
  parent_id integer;
  p_origin text; p_date_conf text; p_created timestamptz;
  in_parent_window boolean;
BEGIN
  parent_id := CASE TG_TABLE_NAME
                 WHEN 'claude_decision_log' THEN (j->>'session_id')::int
                 WHEN 'claude_known_issues' THEN (j->>'reported_session_id')::int
               END;
  IF parent_id IS NULL THEN RETURN NEW; END IF;
  SELECT log_origin, date_confidence, created_at
    INTO p_origin, p_date_conf, p_created
    FROM claude_session_logs WHERE id = parent_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  -- Is this child part of the parent's own checkpoint sequence, or a later
  -- append (a refresh)? 5 minutes = BATCH_WINDOW_MINUTES in memory-checkpoint.js.
  in_parent_window := p_created IS NOT NULL
                      AND p_created > now() - interval '5 minutes';

  -- A later append keeps the provenance its caller gave it: on a refresh the
  -- decision was stated live, with the chat in view, and is confirmed.
  IF NOT in_parent_window THEN RETURN NEW; END IF;

  IF p_origin = 'retro' AND coalesce(NEW.origin, 'live') = 'live' THEN
    NEW.origin := 'retro';
    IF coalesce(NEW.confidence, 'confirmed') = 'confirmed' THEN
      NEW.confidence := 'reconstructed';
    END IF;
  END IF;

  IF p_date_conf = 'write_date' AND coalesce(NEW.date_confidence, 'exact') = 'exact' THEN
    NEW.date_confidence := 'write_date';
  END IF;

  RETURN NEW;
END $$;

-- ─── Verification ───────────────────────────────────────────────────────────
-- The two sql/098 triggers still resolve to the new body, and the window is in it:
--
-- SELECT json_agg(row_to_json(v)) FROM (
--   SELECT
--     (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_claude_inherit_provenance'
--        AND NOT tgisinternal) AS triggers,                                            -- 2
--     (SELECT count(*) FROM pg_proc WHERE proname = 'claude_inherit_provenance'
--        AND prosrc LIKE '%in_parent_window%') AS narrowed                             -- 1
-- ) v;
--
-- Behaviour, inside a transaction then ROLLBACK (needs a retro session to hang off):
--   -- a child appended to an OLD retro session keeps live / confirmed:
--   INSERT INTO claude_decision_log (session_id, category, decision)
--   VALUES (<an old retro session id>, 'architecture', 'window narrow smoke test')
--   RETURNING origin, confidence;            -- → live, confirmed   (was retro, reconstructed)
--   ROLLBACK;
--
-- The nightly provenance_mismatch_children check (src/jobs/memory-validate.js)
-- is narrowed to the same window in the same PR, so the 95 legitimate refresh
-- children stop being reported as drift and a genuine miss still is.
