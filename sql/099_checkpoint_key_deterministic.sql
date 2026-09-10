-- ─── 099 — Deterministic checkpoint identity (duplicate sessions, #1627) ────
--
-- WHY. memory_checkpoint minted a fresh random uuid for checkpoint_key on every
-- tool call (sql/096). That key only survives INSIDE one call: the withRetry
-- loop in src/memory/memory-checkpoint.js can find its own half-written row
-- again. It does nothing when the LP MCP transport drops the RESPONSE and
-- Claude re-sends the whole tool call — the second call mints a new uuid and
-- inserts a twin session: identical title, identical summary, 2–5 minutes
-- apart, plus duplicate decisions, issues and pending items.
--
-- Measured 2026-09-09: 16 duplicate session pairs in 48 hours; 14 of the 42
-- open rows in claude_memory_conflicts are these twins at similarity 1.0.
-- Earlier instances: 746/749, 754/756.
--
-- WHAT. Make the key a deterministic hash of the checkpoint's IDENTITY, so the
-- retry computes the same key and the write becomes an UPDATE:
--
--   identity = surface + session_date + normalized title
--              (title lowercased, whitespace collapsed, trimmed)
--
-- Not the summary. A retry may re-generate slightly different prose and it
-- must still collide.
--
-- All additive; every statement idempotent; nothing dropped or deleted.
--   A. claude_checkpoint_key(surface, date, title)  — the identity hash. Must
--      stay byte-for-byte identical to checkpointKeyFor() in
--      src/memory/memory-checkpoint.js: same separator, normalization, order.
--   B. claude_memory_text_key(text) — the child-row normalization, used by the
--      dedupe indexes in D and mirrored by normalizedTextKey() in Node.
--   C. Backfill every existing session row with its deterministic key, then
--      make sure the column is unique.
--   D. Per-session dedupe indexes on decisions / issues / pending items, so a
--      retry cannot duplicate children under one session. Created only when
--      the table has no existing collisions (a NOTICE names the table when it
--      is skipped) — the migration never hard-fails on legacy data.
--
-- ORDER OF OPERATIONS. Run the dedupe batch for the 16 known session pairs
-- FIRST (keep the row with a chat_url, else the lower id). Section C's backfill
-- leaves colliding rows on their legacy uuid so the unique check still passes;
-- rows_left_on_legacy_key tells you how many are still twinned. Expect 0 after
-- the dedupe batch. If it is not 0, dedupe and re-run this file — it is safe to
-- apply repeatedly.
--
-- Apply through the LP MCP supabase_run_query tool AFTER Mark approves the
-- statement (memory-project ground rule 5).
--
-- ROLLBACK (no data loss): DROP INDEX IF EXISTS ux_claude_session_checkpoint_key,
--   ux_claude_decision_session_text, ux_claude_issue_session_text,
--   ux_claude_pending_session_text; DROP FUNCTION IF EXISTS
--   claude_checkpoint_key(text, date, text); DROP FUNCTION IF EXISTS
--   claude_memory_text_key(text); redeploy the previous commit. The
--   deterministic keys already written are harmless if left in place.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── A. The identity hash ───────────────────────────────────────────────────
-- search_path is pinned because Supabase installs pgcrypto (digest) into the
-- `extensions` schema, which is not on every role's path.

CREATE OR REPLACE FUNCTION claude_checkpoint_key(
  p_surface text, p_date date, p_title text
) RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public, extensions
AS $$
  SELECT encode(digest(
    coalesce(nullif(lower(btrim(regexp_replace(coalesce(p_surface, ''), '\s+', ' ', 'g'))), ''), 'chat')
      || '|' ||
    coalesce(p_date::text, '')
      || '|' ||
    lower(btrim(regexp_replace(coalesce(p_title, ''), '\s+', ' ', 'g'))),
    'sha256'), 'hex')
$$;

COMMENT ON FUNCTION claude_checkpoint_key(text, date, text) IS
  'Deterministic memory_checkpoint identity: sha256(surface|session_date|normalized title). Mirrors checkpointKeyFor() in src/memory/memory-checkpoint.js — change both together.';

-- ─── B. Child-row text normalization ────────────────────────────────────────

CREATE OR REPLACE FUNCTION claude_memory_text_key(p_text text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT md5(lower(btrim(regexp_replace(coalesce(p_text, ''), '\s+', ' ', 'g'))))
$$;

COMMENT ON FUNCTION claude_memory_text_key(text) IS
  'Normalized md5 of a decision / issue / pending description, for per-session dedupe. Mirrors normalizedTextKey() in src/memory/memory-checkpoint.js.';

-- ─── C. Backfill + uniqueness on claude_session_logs.checkpoint_key ─────────
--
-- Give every existing row its deterministic key. Rows that would collide (the
-- known twins) keep their old key so uniqueness still holds; the dedupe batch
-- marks those separately.
--
-- NOT every key is a per-call uuid. src/routes/admin-memory.js keys the daily
-- n8n event session 'n8n:YYYY-MM-DD' and looks it up by that literal, so
-- re-keying those rows would make the route insert a fresh n8n session every
-- time. Only NULLs and uuid-shaped keys are rewritten; any other convention is
-- left exactly as it is, here and in the report below.

WITH ranked AS (
  SELECT id,
         claude_checkpoint_key(surface, session_date, session_title) AS newkey,
         row_number() OVER (
           PARTITION BY claude_checkpoint_key(surface, session_date, session_title)
           ORDER BY (chat_url IS NOT NULL) DESC, id ASC
         ) AS rn
  FROM claude_session_logs
  WHERE checkpoint_key IS NULL
     OR checkpoint_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
)
UPDATE claude_session_logs s
SET checkpoint_key = r.newkey
FROM ranked r
WHERE s.id = r.id AND r.rn = 1
  AND s.checkpoint_key IS DISTINCT FROM r.newkey
  -- Never take a key another row already holds (a twin that got there first).
  AND NOT EXISTS (SELECT 1 FROM claude_session_logs o WHERE o.checkpoint_key = r.newkey AND o.id <> s.id);

-- Report what stayed on a legacy uuid (expect the known duplicate pairs, then 0).
SELECT count(*) AS rows_left_on_legacy_key
FROM claude_session_logs s
WHERE s.checkpoint_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   OR s.checkpoint_key IS NULL;

-- sql/096 already declared the column `text UNIQUE`, which in Postgres still
-- allows many NULLs — exactly the semantics the handoff's partial index wanted.
-- Only add the index when that constraint is somehow absent, so the table does
-- not carry two unique indexes on one column.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'claude_session_logs'
      AND c.contype = 'u'
      AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a
                            WHERE a.attrelid = c.conrelid AND a.attname = 'checkpoint_key')]
  ) THEN
    RAISE NOTICE 'claude_session_logs.checkpoint_key is already UNIQUE (sql/096) — no second index created';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS ux_claude_session_checkpoint_key
      ON claude_session_logs (checkpoint_key)
      WHERE checkpoint_key IS NOT NULL;
  END IF;
END $$;

-- ─── D. Per-session child dedupe (backstop for the Node-side skip) ──────────
--
-- The tool already refuses to insert a child whose normalized text is already
-- on the session. These indexes make that a database guarantee, so two calls
-- racing each other cannot both get through. Each is created only when the
-- table is already free of collisions — legacy duplicates must be cleaned by
-- the dedupe batch first, and a skipped index is announced, never fatal.

DO $$
DECLARE
  spec record;
  dupes bigint;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('ux_claude_decision_session_text', 'claude_decision_log',  'session_id',        'decision'),
      ('ux_claude_issue_session_text',    'claude_known_issues',  'reported_session_id','description'),
      ('ux_claude_pending_session_text',  'claude_pending_items', 'source_session_id', 'description')
    ) AS t(idx, tbl, sess_col, text_col)
  LOOP
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = spec.idx) THEN
      CONTINUE;
    END IF;
    EXECUTE format(
      'SELECT count(*) FROM (SELECT %I, claude_memory_text_key(%I) FROM %I
         WHERE %I IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1) d',
      spec.sess_col, spec.text_col, spec.tbl, spec.sess_col) INTO dupes;
    IF dupes > 0 THEN
      RAISE NOTICE '% skipped: % duplicate (session, text) groups in % — run the dedupe batch, then re-run sql/099',
        spec.idx, dupes, spec.tbl;
    ELSE
      EXECUTE format(
        'CREATE UNIQUE INDEX %I ON %I (%I, claude_memory_text_key(%I)) WHERE %I IS NOT NULL',
        spec.idx, spec.tbl, spec.sess_col, spec.text_col, spec.sess_col);
      RAISE NOTICE '% created on %', spec.idx, spec.tbl;
    END IF;
  END LOOP;
END $$;

-- ─── Verification ───────────────────────────────────────────────────────────
-- SELECT json_agg(row_to_json(v)) FROM (
--   SELECT
--     (SELECT count(*) FROM pg_proc WHERE proname IN ('claude_checkpoint_key','claude_memory_text_key')) AS fns,          -- 2
--     (SELECT count(*) FROM claude_session_logs WHERE checkpoint_key IS NULL) AS keyless_sessions,                        -- 0
--     (SELECT count(*) FROM claude_session_logs WHERE checkpoint_key ~*
--        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') AS rows_left_on_legacy_key,                     -- 0
--     (SELECT count(*) FROM claude_session_logs WHERE checkpoint_key LIKE 'n8n:%') AS n8n_keys_untouched,                  -- one per day the n8n door fired
--     (SELECT count(*) FROM pg_class WHERE relname IN ('ux_claude_decision_session_text',
--        'ux_claude_issue_session_text','ux_claude_pending_session_text')) AS child_indexes                                -- 3
-- ) v;
--
-- Live check the morning after the deploy — expect zero rows:
--   SELECT session_title, session_date, count(*)
--   FROM claude_session_logs WHERE created_at > now() - interval '24 hours'
--   GROUP BY 1, 2 HAVING count(*) > 1;
