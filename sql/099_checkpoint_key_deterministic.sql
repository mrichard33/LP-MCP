-- ─── 099 — Deterministic checkpoint identity ───────────────────────────────
--
-- WHY. memory_checkpoint generated a fresh random checkpoint_key on every call
-- (sql/096). When the LP MCP transport drops the response (issue #1627) Claude
-- retries, the retry carries a NEW key, and the second call inserts a twin
-- session — identical title, identical summary, 2–5 minutes apart — plus
-- duplicate decisions, issues and pending items.
--
-- Measured 2026-09-09: 17 duplicate session pairs in claude_session_logs
-- (746/749, 754/756, 803/806, 916/919 … all same surface + date + title), and
-- 14 of the 42 open rows in claude_memory_conflicts are those twins at
-- similarity 1.0.
--
-- WHAT. The key becomes a deterministic hash of the checkpoint's IDENTITY, so
-- a retry computes the same key, finds the row, and UPDATEs it:
--
--     identity = surface | session_date | normalized(title)
--
-- normalized = whitespace collapsed to single spaces, trimmed, lowercased.
-- The SUMMARY is deliberately NOT part of the identity: a retry may re-generate
-- slightly different prose, and it must still collide.
--
-- Written by src/memory/memory-checkpoint.js (checkpointKeyFor). This function
-- mirrors it for the backfill and for verification queries. If the two ever
-- disagree on an exotic title the failure mode is benign — that row keeps the
-- behaviour it has today (no dedupe); it can never merge two different
-- sessions.
--
-- WHAT IT IS NOT. Two genuinely different chats with the same title, on the
-- same day, on the same surface now collapse into one session row. That is the
-- accepted trade: it is far rarer than the retry twins, and a refresh merges
-- rather than loses (keys union, summary replaced, chat_url never nulled, an
-- 'exact' link never downgraded).
--
-- ALL ADDITIVE. Nothing is dropped or deleted. Every statement is idempotent.
--
-- Apply through the LP MCP supabase_run_query tool AFTER Mark approves
-- (memory-project ground rule 5). Mirrored in src/memory/memory-migrations.js
-- as a presence check.
--
-- ROLLBACK (deterministic keys are harmless if left in place):
--   DROP INDEX IF EXISTS ux_claude_session_checkpoint_key;
--   DROP INDEX IF EXISTS ux_claude_decision_session_text;
--   DROP INDEX IF EXISTS ux_claude_issue_session_text;
--   DROP INDEX IF EXISTS ux_claude_pending_session_text;
--   DROP FUNCTION IF EXISTS claude_checkpoint_key(text, date, text);
--   then redeploy the previous commit.
-- ───────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── A. The identity function ──────────────────────────────────────────────
-- IMMUTABLE, so it can be used in an index expression and in the backfill.
-- NOTE (correction to the handoff): the original draft defaulted a NULL date to
-- CURRENT_DATE, which is STABLE — an IMMUTABLE function may not call it. A NULL
-- date now hashes as the empty string instead. session_date is never NULL in
-- practice, so no live row is affected.

CREATE OR REPLACE FUNCTION claude_checkpoint_key(
  p_surface text, p_date date, p_title text
) RETURNS text AS $$
  SELECT encode(digest(
    coalesce(nullif(btrim(p_surface), ''), 'chat')
      || '|' || coalesce(p_date::text, '')
      || '|' || lower(btrim(regexp_replace(coalesce(p_title, ''), '[\s\u00a0\ufeff]+', ' ', 'g'), ' ')),
    'sha256'), 'hex')
$$ LANGUAGE sql IMMUTABLE;

COMMENT ON FUNCTION claude_checkpoint_key(text, date, text) IS
  'Deterministic checkpoint identity (sql/099): sha256 of surface|session_date|normalized title. Mirrors checkpointKeyFor() in src/memory/memory-checkpoint.js.';

-- ─── B. Pre-flight: what the backfill is about to find ─────────────────────
-- Read this BEFORE the backfill. Each row is a set of sessions that share one
-- identity — the transport-drop twins. Only the winner keeps the new key.

SELECT claude_checkpoint_key(surface, session_date, session_title) AS newkey,
       count(*)                       AS twins,
       array_agg(id ORDER BY id)      AS ids,
       min(session_date)              AS session_date,
       left(min(session_title), 80)   AS title
FROM claude_session_logs
GROUP BY 1
HAVING count(*) > 1
ORDER BY 2 DESC, 4 DESC;

-- ─── C. Backfill ───────────────────────────────────────────────────────────
-- Give every existing row its deterministic key. Where rows collide (the known
-- twins) the winner is the one with a chat_url, else the lower id; the losers
-- keep their old random key so the unique index can still be created. The
-- dedupe batch marks those separately.

WITH ranked AS (
  SELECT id,
         claude_checkpoint_key(surface, session_date, session_title) AS newkey,
         row_number() OVER (
           PARTITION BY claude_checkpoint_key(surface, session_date, session_title)
           ORDER BY (chat_url IS NOT NULL) DESC, id ASC
         ) AS rn
  FROM claude_session_logs
)
UPDATE claude_session_logs s
SET checkpoint_key = r.newkey
FROM ranked r
WHERE s.id = r.id
  AND r.rn = 1
  AND s.checkpoint_key IS DISTINCT FROM r.newkey;

-- Report what stayed on a legacy key (expect exactly the duplicate pairs from B).
SELECT count(*) AS rows_left_on_legacy_key
FROM claude_session_logs s
WHERE s.checkpoint_key IS DISTINCT FROM
      claude_checkpoint_key(s.surface, s.session_date, s.session_title);

-- ─── D. Session uniqueness ─────────────────────────────────────────────────
-- sql/096 already put a column-level UNIQUE on checkpoint_key, so this index is
-- belt-and-braces: it names the constraint the rollback refers to and makes the
-- ON CONFLICT target explicit. IF NOT EXISTS keeps it a no-op when the column
-- constraint is judged sufficient.

CREATE UNIQUE INDEX IF NOT EXISTS ux_claude_session_checkpoint_key
  ON claude_session_logs (checkpoint_key)
  WHERE checkpoint_key IS NOT NULL;

-- ─── E. Child idempotency ──────────────────────────────────────────────────
-- A deterministic session key alone still lets a retry pile duplicate children
-- under the ONE session. src/memory/memory-checkpoint.js now skips a child whose
-- normalized text already exists for the session; these indexes are the backstop
-- that makes it true even under a race.
--
-- Each is PARTIAL, scoped to rows that are still live, so an item that was
-- closed and is later legitimately re-raised is not blocked forever.
--
-- Created inside DO blocks: an index that cannot be built because pre-existing
-- duplicates are in the way raises a NOTICE instead of aborting the whole file.
-- Measured 2026-09-09: 1 blocking group on claude_decision_log, 0 elsewhere.
-- Correctness does not depend on these indexes — the JS guard stands alone.

DO $$
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS ux_claude_decision_session_text
    ON claude_decision_log (session_id, md5(lower(btrim(decision))))
    WHERE session_id IS NOT NULL AND coalesce(status, 'active') = 'active';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'ux_claude_decision_session_text skipped — pre-existing duplicate active decisions; dedupe then re-run section E';
END $$;

DO $$
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS ux_claude_issue_session_text
    ON claude_known_issues (reported_session_id, md5(lower(btrim(description))))
    WHERE reported_session_id IS NOT NULL AND coalesce(status, 'open') IN ('open', 'in_progress');
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'ux_claude_issue_session_text skipped — pre-existing duplicate open issues; dedupe then re-run section E';
END $$;

DO $$
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS ux_claude_pending_session_text
    ON claude_pending_items (source_session_id, md5(lower(btrim(description))))
    WHERE source_session_id IS NOT NULL AND coalesce(status, 'open') = 'open';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'ux_claude_pending_session_text skipped — pre-existing duplicate open pending items; dedupe then re-run section E';
END $$;

-- ─── Verification ──────────────────────────────────────────────────────────
-- SELECT
--   (SELECT count(*) FROM pg_proc WHERE proname = 'claude_checkpoint_key')                    AS fn,           -- 1
--   (SELECT count(*) FROM pg_indexes WHERE indexname = 'ux_claude_session_checkpoint_key')    AS session_ux,   -- 1
--   (SELECT count(*) FROM pg_indexes WHERE indexname LIKE 'ux_claude_%_session_text')         AS child_ux,     -- 3 (fewer = dedupe still owed)
--   (SELECT count(*) FROM claude_session_logs s
--      WHERE s.checkpoint_key IS DISTINCT FROM
--            claude_checkpoint_key(s.surface, s.session_date, s.session_title))               AS legacy_rows;  -- = twins left to dedupe
--
-- Live proof after deploy — call memory_checkpoint twice with the same payload,
-- expect one row and inserted:false on the second, then tomorrow:
--   SELECT session_title, session_date, count(*)
--   FROM claude_session_logs WHERE created_at > now() - interval '24 hours'
--   GROUP BY 1,2 HAVING count(*) > 1;   -- expect zero rows
