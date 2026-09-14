-- ─── 112 — Command Center, Release 2 (Stale issues + To-dos) & Omi pull ──────
--
-- WHY. Release 1 (sql/102) shipped ONE lane. Counted live on 2026-09-14:
--
--     Rulings      487   ruled today, one card at a time
--     Stale issues 624   counted behind a placeholder, unrulable
--     To-dos     2,400   counted behind a placeholder, unrulable
--
-- 3,024 cards sit where nobody can act on them, and not one of them carries a
-- recommendation (rec_at IS NOT NULL returns 0 rows on both tables). Clearing
-- them one click at a time is not a plan — at one ruling a minute that is fifty
-- hours of Mark's evenings.
--
-- The second half of this file is the Omi side. Mark wears an Omi device all
-- day; Omi's Developer API holds structured summaries and the action items it
-- extracted, but nothing pulls them in. Verified against the live API on
-- 2026-09-14: transcript_segments is ALWAYS null, and GET /user/action-items
-- returns [] because Omi writes extracted items as candidates that expire in
-- about two days. 61 real action items were sitting unreachable inside 100
-- conversations. So we read conversations and we write tasks back.
--
-- WHAT this file changes, in the order Mark runs it — SEVEN SEPARATE
-- EXECUTIONS, A through G, in order:
--
--   A. Omi bookkeeping. claude_omi_sync (one row per pull kind: how far we got,
--      when it last succeeded, how many failures in a row), plus
--      claude_pending_items.omi_action_item_id and its two partial indexes.
--
--      omi_action_item_id is the LOOP GUARD, and it runs both ways. We never
--      push a row that already carries one (it is already a task in Omi), and
--      we never ingest an Omi task that carries one (we created it). Without
--      the column, write-back and pull feed each other forever.
--
--   B. claude_omi_memory_upsert(jsonb) — Omi "memories" (durable facts, not
--      conversations) become one unconfirmed_decision each, idempotent on
--      raw->>'omi_memory_id'.
--
--   C. claude_item_type_norm(text) — display normalizer. claude_pending_items
--      carries about 150 distinct item_type values, most of them written once
--      (open_task, blocker, cleanup, unexplained…), plus 364 rows with NULL.
--      They are all to-dos. This maps them onto four names FOR DISPLAY; the
--      stored column is never rewritten, because the raw value is evidence of
--      what the session that filed it meant.
--
--      (The handoff numbered this D and the view C. They are swapped here
--      because the view CALLS the normalizer, and Postgres resolves a function
--      body's references at CREATE time — the other order fails with "function
--      claude_item_type_norm(text) does not exist". Same trap sql/102 hit with
--      its C-and-D-before-E note.)
--
--   D. v_command_center_queue v2 — the two new lanes. The two Rulings branches
--      are the live definition unchanged except for the three columns appended
--      to every branch (UNION ALL demands matching arity). Proved before
--      shipping by diffing v1 against v2 inside one transaction: same 475 rows,
--      zero set difference, zero field difference across all 41 shared columns.
--      The verification query at the bottom re-runs that diff — do NOT check the
--      rulings lane against a fixed number, because the number moves every time
--      Mark rules a card (it was 487 in the morning and 475 by the afternoon).
--
--   E. claude_rule_lane_verdict(...) + claude_rule_batch(jsonb) — the batch
--      pass. One transaction, one batch_id, one claude_rulings_log row per item
--      plus a summary row. Refuses >50 targets, any Rulings-lane card, any
--      confidence below high, any `fixed` without proof, any stale
--      card_version. claude_rule_lane_verdict is the per-card writer that G
--      also calls, so a verdict means the same thing clicked once or fifty
--      times.
--
--   F. claude_rule_batch_undo(uuid, text, text) — the one-click reverse.
--      Validates the WHOLE batch before touching a row, so a partly-undone
--      batch cannot exist.
--
--   G. claude_rule_lane_apply(jsonb) — the single-card lane ruling. Release 1's
--      claude_rule_apply hard-rejects claude_known_issues as a target AND every
--      verdict outside its own list, so without this section the two new lanes
--      render and EVERY single-card button errors — the batch path alone is not
--      enough. claude_rule_apply itself is left exactly as audited; see G for
--      why that is the safer shape.
--
-- WHAT THIS FILE DOES NOT DO. Nothing here auto-promotes anything. An Omi item
-- is unconfirmed until Mark approves it in the Command Center, and only then
-- does memory_rule write a decision. Nothing closes on age alone: `keep` snoozes
-- for 30 days, it does not close. `fixed` demands a proof link. Age is a sort
-- key, never a verdict.
--
-- Every statement is additive and idempotent. No column is dropped, no row is
-- rewritten, no existing memory row changes meaning.
--
-- PROVED BEFORE SHIPPING (2026-09-14). Every section below was applied to the
-- LIVE database inside a transaction that was then rolled back, so these are
-- results against real rows, not a dry read:
--
--   Section D   v1-vs-v2 diff: 475 / 475 rows, 0 only-in-v1, 0 only-in-v2,
--               0 field differences across all 41 shared columns. Three lanes,
--               44 columns, 0 NULL card_versions, all 364 untyped rows present.
--   Sections E–G  12 checks: a 3-item batch applies and undoes exactly; a second
--               undo is refused; 51 targets, a Rulings card, medium confidence,
--               a proof-less `fixed`, a stale card_version, a wrong-table verdict
--               and a non-lane action are each refused; a single card bypasses
--               the confidence gate and writes no summary row; `fixed` with a
--               proof resolves the issue and clears the stale flag.
--   Section B   4 checks: two memories insert as open unconfirmed_decision/omi;
--               the same memory twice gives one row; the same fact in different
--               words and with a different prefix is skipped; a missing
--               checkpoint_key is refused.
--
-- Production was re-checked afterwards: 0 leaked functions, 0 leaked columns,
-- 0 test rulings, 0 test sessions.
--
-- HOW TO APPLY. Supabase dashboard → SQL editor on the LP instance
-- (rcjcgjlqzepicbwhnnjl), as SEVEN separate executions, in order A→G. The
-- verification query is at the bottom. D must follow A (the view reads
-- omi_action_item_id) and C (the todos branch calls the normalizer).
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS claude_rule_lane_apply(jsonb);
--   DROP FUNCTION IF EXISTS claude_rule_batch_undo(uuid, text, text);
--   DROP FUNCTION IF EXISTS claude_rule_batch(jsonb);
--   DROP FUNCTION IF EXISTS claude_rule_lane_verdict(text,integer,text,text,text,text);
--   DROP FUNCTION IF EXISTS claude_omi_memory_upsert(jsonb);
--   -- Re-apply sql/102 section D to revert the view, THEN drop the normalizer
--   -- (the v2 view depends on it).
--   DROP FUNCTION IF EXISTS claude_item_type_norm(text);
--   -- claude_rule_apply is untouched by this file — nothing to revert.
--   -- Do NOT roll back A: claude_omi_sync is the pull's memory, and dropping
--   -- omi_action_item_id re-opens the write-back loop.

-- ═══ A. Omi bookkeeping ════════════════════════════════════════════════════
-- One row per pull kind. The puller reads it to know where it stopped and
-- writes it after every run, successful or not.
--
-- consecutive_failures is a COUNTER, not a flag, because the alert is
-- edge-triggered on the third failure in a row. A single 500 from Omi at 3am is
-- not an incident; three in a row is.

CREATE TABLE IF NOT EXISTS claude_omi_sync (
  id                   serial PRIMARY KEY,
  -- conversations | memories | action_items | writeback
  kind                 text NOT NULL UNIQUE,
  -- Newest finished_at we have fully ingested. The Omi list endpoint is
  -- newest-first with no `since` parameter, so paging stops when it reaches
  -- this — there is nothing to ask the API for.
  last_cursor          text,
  last_run_at          timestamptz,
  last_ok_at           timestamptz,
  items_seen           integer DEFAULT 0,
  items_ingested       integer DEFAULT 0,
  consecutive_failures integer DEFAULT 0,
  last_error           text
);

GRANT SELECT, INSERT, UPDATE ON claude_omi_sync TO service_role;
GRANT USAGE, SELECT ON SEQUENCE claude_omi_sync_id_seq TO service_role;

-- The loop guard. Set when WE created the Omi task for this row (write-back),
-- or when we ingested a task Omi already had. Either way the row and the Omi
-- task are the same thing and neither side may re-create the other.
ALTER TABLE claude_pending_items
  ADD COLUMN IF NOT EXISTS omi_action_item_id text;

CREATE INDEX IF NOT EXISTS idx_claude_pending_omi_action
  ON claude_pending_items (omi_action_item_id)
  WHERE omi_action_item_id IS NOT NULL;

-- The write-back's work queue, as a partial index so the scan is the index.
CREATE INDEX IF NOT EXISTS idx_claude_pending_omi_pushable
  ON claude_pending_items (created_at DESC)
  WHERE origin = 'omi' AND status = 'open' AND omi_action_item_id IS NULL;

-- The stale lane's predicate, matching idx_claude_pending_rulings_open in 102.
CREATE INDEX IF NOT EXISTS idx_claude_issues_stale_open
  ON claude_known_issues (created_at)
  WHERE status IN ('open','in_progress') AND stale;

-- ═══ B. claude_omi_memory_upsert(jsonb) ════════════════════════════════════
-- Omi "memories" are durable facts Omi has decided are worth keeping about the
-- user — not conversations. They arrive with a stable id (mem_…) and no
-- structure beyond content + category, so each becomes exactly one
-- unconfirmed_decision. Mark ratifies it in the Command Center or it stays
-- unconfirmed forever; nothing here writes claude_decision_log.
--
-- Two independent idempotency gates, because they catch different things:
--
--   1. raw->>'omi_memory_id' — the same memory pulled twice. Exact, cheap.
--   2. normalised text against OPEN rows — the same fact said two ways, or a
--      memory that restates a to-do we already have from a conversation. Omi
--      re-extracts memories from conversations it has already given us, so
--      without this gate every nightly catch-up files the same fact again.
--
-- Payload:
--   { "checkpoint_key": "<sha256 hex of 'omi-memories|' || YYYY-MM-DD>",
--     "session_date": "YYYY-MM-DD",
--     "memories": [ { "omi_memory_id": "mem_…",
--                     "description": "[Omi memory] …",
--                     "raw": { … } } ] }
--
-- Returns { status, session_id, inserted, skipped_existing, skipped_duplicate,
--           pending_ids }.

CREATE OR REPLACE FUNCTION claude_omi_memory_upsert(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_key        text    := nullif(p->>'checkpoint_key','');
  v_date       date    := coalesce(nullif(p->>'session_date','')::date, CURRENT_DATE);
  v_session_id integer;
  v_mem        jsonb;
  v_mem_id     text;
  v_desc       text;
  v_norm       text;
  v_index      integer;
  v_pending_id integer;
  v_ids        integer[] := ARRAY[]::integer[];
  v_inserted   integer := 0;
  v_existing   integer := 0;
  v_dupe       integer := 0;
BEGIN
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'claude_omi_memory_upsert: checkpoint_key is required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  -- One session per day for all memories, unlike conversations which get one
  -- each. A memory has no conversation to belong to.
  INSERT INTO claude_session_logs (
    session_date, session_title, phase_focus, raw_summary, transcript_search_keys,
    surface, log_origin, link_confidence, date_confidence, validation_status,
    checkpoint_key,
    workflows_touched, phase_status, decisions_made, issues_found, issues_resolved,
    pending_items, board_versions, mcp_verified_ids, next_steps,
    created_at, updated_at
  ) VALUES (
    v_date,
    'Omi memories — ' || v_date::text,
    'omi',
    'Durable facts pulled from the Omi memories endpoint on ' || v_date::text
      || '. Every row is unconfirmed until it is ruled in the Command Center.',
    '["Omi","omi memories","claude_omi_memory_upsert"]'::jsonb,
    'omi', 'omi', 'unlinked', 'exact', 'passed',
    v_key,
    '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
    '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
    now(), now()
  )
  ON CONFLICT (checkpoint_key) DO NOTHING;

  SELECT id INTO v_session_id FROM claude_session_logs WHERE checkpoint_key = v_key;
  IF v_session_id IS NULL THEN
    RAISE EXCEPTION 'claude_omi_memory_upsert: could not resolve the day session'
      USING ERRCODE = 'internal_error';
  END IF;

  -- Continue the day's numbering rather than restarting at 0: the unique key is
  -- (source_session_id, source_field, source_index) and a second run of the day
  -- would collide on index 0.
  SELECT coalesce(max(source_index), -1) + 1 INTO v_index
    FROM claude_pending_items
   WHERE source_session_id = v_session_id AND source_field = 'omi_memory';

  FOR v_mem IN SELECT * FROM jsonb_array_elements(coalesce(p->'memories', '[]'::jsonb))
  LOOP
    v_mem_id := nullif(v_mem->>'omi_memory_id','');
    v_desc   := nullif(v_mem->>'description','');
    CONTINUE WHEN v_mem_id IS NULL OR v_desc IS NULL;

    -- Gate 1: this exact memory, already filed.
    IF EXISTS (SELECT 1 FROM claude_pending_items
                WHERE raw->>'omi_memory_id' = v_mem_id) THEN
      v_existing := v_existing + 1;
      CONTINUE;
    END IF;

    -- Gate 2: the same words, already open. Mirrors normText() in
    -- src/memory/memory-checkpoint.js — collapse whitespace, trim, lowercase —
    -- after dropping our own display prefixes so "[Omi memory] x" and
    -- "[Omi 2026-09-14] x" compare equal to "x".
    v_norm := lower(btrim(regexp_replace(
                regexp_replace(v_desc, '^\s*\[Omi( memory| \d{4}-\d{2}-\d{2})\]\s*', '', 'i'),
                '\s+', ' ', 'g')));
    IF EXISTS (SELECT 1 FROM claude_pending_items
                WHERE status = 'open'
                  AND lower(btrim(regexp_replace(
                        regexp_replace(description, '^\s*\[Omi( memory| \d{4}-\d{2}-\d{2})\]\s*', '', 'i'),
                        '\s+', ' ', 'g'))) = v_norm) THEN
      v_dupe := v_dupe + 1;
      CONTINUE;
    END IF;

    INSERT INTO claude_pending_items (
      source_session_id, source_field, source_index, kind, item_type, description,
      status, origin, session_date, raw, created_at, updated_at
    ) VALUES (
      v_session_id, 'omi_memory', v_index, 'pending', 'unconfirmed_decision', v_desc,
      'open', 'omi', v_date,
      coalesce(v_mem->'raw', '{}'::jsonb) || jsonb_build_object('omi_memory_id', v_mem_id),
      now(), now()
    )
    RETURNING id INTO v_pending_id;

    v_ids      := v_ids || v_pending_id;
    v_index    := v_index + 1;
    v_inserted := v_inserted + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'status', 'ok',
    'session_id', v_session_id,
    'inserted', v_inserted,
    'skipped_existing', v_existing,
    'skipped_duplicate', v_dupe,
    'pending_ids', to_jsonb(v_ids));
END $$;

GRANT EXECUTE ON FUNCTION claude_omi_memory_upsert(jsonb) TO service_role;

-- ═══ C. claude_item_type_norm(text) — display normalizer ═══════════════════
-- Counted live on 2026-09-14: the 2,400 open to-dos carry about 150 distinct
-- item_type values. Six of them account for 2,150 rows; the rest are one-offs a
-- single session invented (open_task, blocker, cleanup, unexplained,
-- work_not_started, …), and 364 rows have no item_type at all.
--
-- They are all to-dos, and the lane must show every one of them — those 654
-- off-list and NULL rows are exactly the ones nobody has ever looked at.
--
-- So: normalise FOR DISPLAY, never in the column. The stored value is evidence
-- of what the session that filed the row meant by it, and rewriting it would
-- destroy that to make a label prettier. Unrecognised falls through to
-- action_needed rather than to a NULL or an "other" bucket, because a to-do
-- whose kind we cannot name is still something somebody has to do.
--
-- IMMUTABLE so the view can call it per row without a planner penalty.

CREATE OR REPLACE FUNCTION claude_item_type_norm(p_type text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE lower(btrim(coalesce(p_type, '')))
           WHEN 'action_needed'       THEN 'action_needed'
           WHEN 'build_needed'        THEN 'build_needed'
           WHEN 'verification_needed' THEN 'verification_needed'
           WHEN 'next_step'           THEN 'next_step'
           WHEN 'todo'                THEN 'action_needed'
           WHEN 'task'                THEN 'action_needed'
           WHEN 'pending'             THEN 'action_needed'
           WHEN 'deferred'            THEN 'next_step'
           ELSE 'action_needed'
         END;
$$;

GRANT EXECUTE ON FUNCTION claude_item_type_norm(text) TO service_role;

-- ═══ D. v_command_center_queue v2 — three lanes ════════════════════════════
-- Branches 1 and 2 are sql/102's definition, pulled live from the database on
-- 2026-09-14 and reproduced here with NO change to any expression, join or
-- WHERE clause. The only difference is the three columns appended to the end of
-- every branch, which UNION ALL requires of all four:
--
--     rec_group_key       the batch grouping key (column existed since 102,
--                         written by nothing until now)
--     omi_action_item_id  set → this row is already a task in Mark's Omi
--     item_type_norm      section C's display label, NULL off the todos lane
--
-- The Rulings lane is LIVE — its count changes every time Mark rules a card, so
-- "is it still 487?" is not a test, it is a coin flip. The real check is the
-- v1-vs-v2 diff at the bottom of this file: same rows, same values, run inside
-- one transaction so nothing can move underneath it. That diff returned
-- 475 / 475 / 0 / 0 / 0 against live data before this file was committed.
--
-- Branch 3 (stale) has no options, item_type, blocked_by, rec_decision_text,
-- rec_category or rec_build_text — claude_known_issues simply has no such
-- columns — so those are NULL. Branch 4 (todos) is the rulings branch with the
-- item_type test inverted, and it deliberately catches item_type IS NULL:
-- 364 rows have no type, and "we could not classify it" is not a reason to hide
-- work from the person who has to do it.

CREATE OR REPLACE VIEW v_command_center_queue AS
WITH blocks AS (
  SELECT b.id AS blocked_id, p.id AS blocker_id
  FROM claude_pending_items b
  JOIN claude_pending_items p
    ON b.blocked_by ~ ('(^|[^0-9])#' || p.id || '([^0-9]|$)')
  WHERE b.status IN ('open','blocked')
),
block_counts AS (
  SELECT blocker_id, count(*)::integer AS n FROM blocks GROUP BY blocker_id
),
area_rank AS (
  SELECT * FROM (VALUES
    ('payroll-callcenter', 1), ('partners-vendors', 2), ('appointments', 3),
    ('chatbot-lane', 4), ('scorecard-reporting', 5)
  ) AS t(area, rank)
)
-- (1) Rulings lane — pending items of the four ruling types. Unchanged.
SELECT
  'rulings'::text                                   AS lane,
  p.item_type                                       AS card_type,
  'claude_pending_items'::text                      AS source_table,
  p.id                                              AS source_id,
  p.description,
  p.options,
  p.origin,
  p.area,
  p.created_at,
  (CURRENT_DATE - p.created_at::date)::integer      AS age_days,
  p.rec_verdict, p.rec_reason, p.rec_evidence, p.rec_confidence, p.rec_risk,
  p.rec_decision_text, p.rec_category, p.rec_build_text, p.rec_at,
  NULL::integer AS left_id,  NULL::text AS left_text,  NULL::text AS left_origin,
  NULL::text    AS left_confidence, NULL::date AS left_date, NULL::text AS left_status,
  NULL::text    AS left_rollout_stage,
  NULL::integer AS right_id, NULL::text AS right_text, NULL::text AS right_origin,
  NULL::text    AS right_confidence, NULL::date AS right_date, NULL::text AS right_status,
  NULL::text    AS right_rollout_stage,
  NULL::text    AS conflict_kind,
  NULL::real    AS similarity,
  coalesce(bc.n, 0)                                 AS blocks_count,
  claude_card_version('claude_pending_items', p.id) AS card_version,
  1                                                 AS sort_conflict,
  CASE WHEN p.rec_risk IN ('money','live_leads','customer_messaging') THEN 0 ELSE 1 END AS sort_risk,
  -coalesce(bc.n, 0)                                AS sort_blocks,
  coalesce(ar.rank, 6)                              AS area_rank,
  p.rec_group_key,
  p.omi_action_item_id,
  NULL::text                                        AS item_type_norm
FROM claude_pending_items p
LEFT JOIN block_counts bc ON bc.blocker_id = p.id
LEFT JOIN area_rank ar ON ar.area = p.area
WHERE p.status IN ('open','blocked')
  AND p.item_type IN ('decision_needed','unconfirmed_decision','open_question','approval_needed')
  AND (p.snooze_until IS NULL OR p.snooze_until <= CURRENT_DATE)

UNION ALL

-- (2) Rulings lane — open memory conflicts. Unchanged.
SELECT
  'rulings'::text                                       AS lane,
  'conflict'::text                                      AS card_type,
  'claude_memory_conflicts'::text                       AS source_table,
  c.id                                                  AS source_id,
  concat_ws(' ',
    'Two memory rows on the same subject disagree (cosine',
    round(c.similarity::numeric, 2)::text || ').',
    'Which one is true?')                               AS description,
  NULL::jsonb                                           AS options,
  NULL::text                                            AS origin,
  coalesce(da.area, ia.area)                            AS area,
  c.detected_at                                         AS created_at,
  (CURRENT_DATE - c.detected_at::date)::integer         AS age_days,
  c.rec_verdict, c.rec_reason, c.rec_evidence, c.rec_confidence, c.rec_risk,
  c.rec_decision_text,
  NULL::text                                            AS rec_category,
  NULL::text                                            AS rec_build_text,
  c.rec_at,
  c.row_a                                               AS left_id,
  coalesce(da.decision, ia.description)                 AS left_text,
  coalesce(da.origin, ia.origin)                        AS left_origin,
  coalesce(da.confidence, ia.confidence)                AS left_confidence,
  coalesce(da.decision_date, ia.reported_date)          AS left_date,
  coalesce(da.status, ia.status)                        AS left_status,
  da.rollout_stage                                      AS left_rollout_stage,
  c.row_b                                               AS right_id,
  coalesce(db.decision, ib.description)                 AS right_text,
  coalesce(db.origin, ib.origin)                        AS right_origin,
  coalesce(db.confidence, ib.confidence)                AS right_confidence,
  coalesce(db.decision_date, ib.reported_date)          AS right_date,
  coalesce(db.status, ib.status)                        AS right_status,
  db.rollout_stage                                      AS right_rollout_stage,
  c.kind                                                AS conflict_kind,
  c.similarity,
  0                                                     AS blocks_count,
  claude_card_version('claude_memory_conflicts', c.id)  AS card_version,
  0                                                     AS sort_conflict,
  CASE WHEN c.rec_risk IN ('money','live_leads','customer_messaging') THEN 0 ELSE 1 END AS sort_risk,
  0                                                     AS sort_blocks,
  coalesce(ar.rank, 6)                                  AS area_rank,
  NULL::text                                            AS rec_group_key,
  NULL::text                                            AS omi_action_item_id,
  NULL::text                                            AS item_type_norm
FROM claude_memory_conflicts c
LEFT JOIN claude_decision_log da ON c.kind = 'decision' AND da.id = c.row_a
LEFT JOIN claude_decision_log db ON c.kind = 'decision' AND db.id = c.row_b
LEFT JOIN claude_known_issues  ia ON c.kind = 'issue'    AND ia.id = c.row_a
LEFT JOIN claude_known_issues  ib ON c.kind = 'issue'    AND ib.id = c.row_b
LEFT JOIN area_rank ar ON ar.area = coalesce(da.area, ia.area)
WHERE c.status = 'open'
  AND (c.snooze_until IS NULL OR c.snooze_until <= CURRENT_DATE)

UNION ALL

-- (3) Stale lane — open issues the nightly job flagged as unverified for a long
-- time. One card type, because every stale issue asks the same question: is
-- this still broken?
SELECT
  'stale'::text                                     AS lane,
  'stale_issue'::text                               AS card_type,
  'claude_known_issues'::text                       AS source_table,
  i.id                                              AS source_id,
  i.description,
  NULL::jsonb                                       AS options,
  i.origin,
  i.area,
  i.created_at,
  (CURRENT_DATE - i.created_at::date)::integer      AS age_days,
  i.rec_verdict, i.rec_reason, i.rec_evidence, i.rec_confidence, i.rec_risk,
  NULL::text    AS rec_decision_text,
  NULL::text    AS rec_category,
  NULL::text    AS rec_build_text,
  i.rec_at,
  NULL::integer AS left_id,  NULL::text AS left_text,  NULL::text AS left_origin,
  NULL::text    AS left_confidence, NULL::date AS left_date, NULL::text AS left_status,
  NULL::text    AS left_rollout_stage,
  NULL::integer AS right_id, NULL::text AS right_text, NULL::text AS right_origin,
  NULL::text    AS right_confidence, NULL::date AS right_date, NULL::text AS right_status,
  NULL::text    AS right_rollout_stage,
  NULL::text    AS conflict_kind,
  NULL::real    AS similarity,
  0                                                 AS blocks_count,
  claude_card_version('claude_known_issues', i.id)  AS card_version,
  1                                                 AS sort_conflict,
  CASE WHEN i.rec_risk IN ('money','live_leads','customer_messaging') THEN 0 ELSE 1 END AS sort_risk,
  0                                                 AS sort_blocks,
  coalesce(ar.rank, 6)                              AS area_rank,
  i.rec_group_key,
  NULL::text                                        AS omi_action_item_id,
  NULL::text                                        AS item_type_norm
FROM claude_known_issues i
LEFT JOIN area_rank ar ON ar.area = i.area
WHERE i.status IN ('open','in_progress')
  AND i.stale
  AND (i.snooze_until IS NULL OR i.snooze_until <= CURRENT_DATE)

UNION ALL

-- (4) To-dos lane — everything open in claude_pending_items that is not a
-- Rulings card. NOT IN would drop every NULL item_type on the floor (SQL's
-- three-valued logic makes `NULL NOT IN (…)` return NULL, not true), and those
-- 364 rows are precisely the ones that have never been seen. Hence the explicit
-- IS NULL arm.
SELECT
  'todos'::text                                     AS lane,
  'todo'::text                                      AS card_type,
  'claude_pending_items'::text                      AS source_table,
  p.id                                              AS source_id,
  p.description,
  p.options,
  p.origin,
  p.area,
  p.created_at,
  (CURRENT_DATE - p.created_at::date)::integer      AS age_days,
  p.rec_verdict, p.rec_reason, p.rec_evidence, p.rec_confidence, p.rec_risk,
  p.rec_decision_text, p.rec_category, p.rec_build_text, p.rec_at,
  NULL::integer AS left_id,  NULL::text AS left_text,  NULL::text AS left_origin,
  NULL::text    AS left_confidence, NULL::date AS left_date, NULL::text AS left_status,
  NULL::text    AS left_rollout_stage,
  NULL::integer AS right_id, NULL::text AS right_text, NULL::text AS right_origin,
  NULL::text    AS right_confidence, NULL::date AS right_date, NULL::text AS right_status,
  NULL::text    AS right_rollout_stage,
  NULL::text    AS conflict_kind,
  NULL::real    AS similarity,
  coalesce(bc.n, 0)                                 AS blocks_count,
  claude_card_version('claude_pending_items', p.id) AS card_version,
  1                                                 AS sort_conflict,
  CASE WHEN p.rec_risk IN ('money','live_leads','customer_messaging') THEN 0 ELSE 1 END AS sort_risk,
  -coalesce(bc.n, 0)                                AS sort_blocks,
  coalesce(ar.rank, 6)                              AS area_rank,
  p.rec_group_key,
  p.omi_action_item_id,
  claude_item_type_norm(p.item_type)                AS item_type_norm
FROM claude_pending_items p
LEFT JOIN block_counts bc ON bc.blocker_id = p.id
LEFT JOIN area_rank ar ON ar.area = p.area
WHERE p.status IN ('open','blocked')
  AND (p.item_type IS NULL
       OR p.item_type NOT IN ('decision_needed','unconfirmed_decision','open_question','approval_needed'))
  AND (p.snooze_until IS NULL OR p.snooze_until <= CURRENT_DATE);

GRANT SELECT ON v_command_center_queue TO service_role;

-- ═══ E. claude_rule_batch(jsonb) — the batch pass ══════════════════════════
-- 624 stale issues and 2,400 to-dos cannot be cleared one at a time. But a bulk
-- "close everything older than N" is how a system quietly loses the one real
-- item in a thousand, so every guard here exists to make sure a batch can only
-- do what a person would have done anyway, and can be taken back whole:
--
--   high confidence only  — a batch is the recommendation acting on its own
--                           word. Medium means "I am not sure", and unsure work
--                           gets looked at.
--   50 at a time          — the cap is not a performance limit. It is how many
--                           lines a person will actually read before clicking.
--   proof for `fixed`     — closing an issue as fixed without a link is a guess
--                           dressed as a fact. `still_broken` needs no proof
--                           because it changes nothing but the clock.
--   no Rulings cards      — a decision is never a bulk action.
--   card_version checked  — same stale guard as a single ruling; a card edited
--                           since the screen loaded drops the WHOLE batch.
--
-- AGE ALONE NEVER CLOSES ANYTHING. `keep` snoozes for 30 days. There is no
-- verdict in this function that means "old, therefore gone".
--
-- One transaction, one batch_id, one claude_rulings_log row per item carrying
-- that item's own before/after, plus one summary row (action 'batch_apply').
-- The per-item rows are what makes F an exact restore rather than a guess.
--
-- Payload:
--   { "verdict": "fixed",
--     "targets": [ { "table": "claude_known_issues", "id": 812,
--                    "card_version": "…", "proof": "https://…" } ],
--     "proof": "…",            -- batch-level default for every target
--     "assignee": "Amanda",    -- required by `assign`
--     "reason": "…", "ruled_by": "…", "via": "dashboard",
--     "rec_group_key": "fixed:pr-merged",
--     "session": { "date": "…", "title": "…", "checkpoint_key": "…" } }
--
-- Error codes, matching claude_rule_apply's vocabulary so one mapper handles
-- both: bad_input | batch_too_large | not_batchable | confidence_too_low |
-- proof_required | stale_card.

-- E.1 — the per-card writer. claude_rule_batch AND claude_rule_apply (section
-- G) both call this, so a lane verdict means exactly the same thing whether it
-- was clicked once or fifty times. Returns the changes array in the same shape
-- claude_rule_close_card returns, so claude_rule_restore_col reverses it.
CREATE OR REPLACE FUNCTION claude_rule_lane_verdict(
  p_table    text,
  p_id       integer,
  p_verdict  text,
  p_proof    text,
  p_assignee text,
  p_ruled_by text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  IF p_verdict IN ('still_broken','fixed','no_longer_matters') THEN
    IF p_table <> 'claude_known_issues' THEN
      RAISE EXCEPTION 'bad_input: % applies to claude_known_issues only', p_verdict
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    SELECT jsonb_build_object('status', t.status, 'resolved_date', t.resolved_date,
                              'verified_at', t.verified_at,
                              'verification_note', t.verification_note,
                              'stale', t.stale)
      INTO v_before FROM claude_known_issues t WHERE t.id = p_id;
    IF v_before IS NULL THEN
      RAISE EXCEPTION 'bad_input: issue #% not found', p_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF p_verdict = 'still_broken' THEN
      -- Nothing about the issue changes except that somebody just looked at it.
      -- That is the whole point: the stale flag is about attention, not state.
      UPDATE claude_known_issues
         SET verified_at = now(), stale = false,
             verification_note = coalesce(p_proof, verification_note),
             updated_at = now()
       WHERE id = p_id;
    ELSIF p_verdict = 'fixed' THEN
      UPDATE claude_known_issues
         SET status = 'resolved', resolved_date = CURRENT_DATE,
             verified_at = now(), verification_note = p_proof, stale = false,
             updated_at = now()
       WHERE id = p_id;
    ELSE  -- no_longer_matters
      UPDATE claude_known_issues
         SET status = 'wont_fix', verified_at = now(), stale = false,
             verification_note = coalesce(p_proof, verification_note),
             updated_at = now()
       WHERE id = p_id;
    END IF;

    SELECT jsonb_build_object('status', t.status, 'resolved_date', t.resolved_date,
                              'verified_at', t.verified_at,
                              'verification_note', t.verification_note,
                              'stale', t.stale)
      INTO v_after FROM claude_known_issues t WHERE t.id = p_id;

    RETURN jsonb_build_array(jsonb_build_object(
      'table','claude_known_issues','id',p_id,'inserted',false,
      'before', v_before, 'after', v_after));

  ELSIF p_verdict IN ('done','drop','keep','assign') THEN
    IF p_table <> 'claude_pending_items' THEN
      RAISE EXCEPTION 'bad_input: % applies to claude_pending_items only', p_verdict
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    SELECT jsonb_build_object('status', t.status, 'closed_by', t.closed_by,
                              'closed_reason', t.closed_reason, 'closed_at', t.closed_at,
                              'snooze_until', t.snooze_until, 'stale', t.stale,
                              'owner', t.owner)
      INTO v_before FROM claude_pending_items t WHERE t.id = p_id;
    IF v_before IS NULL THEN
      RAISE EXCEPTION 'bad_input: pending item #% not found', p_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF p_verdict IN ('done','drop') THEN
      UPDATE claude_pending_items
         SET status = CASE WHEN p_verdict = 'done' THEN 'done' ELSE 'dropped' END,
             closed_by = 'command_center',
             closed_reason = coalesce(p_proof, 'rule:' || p_verdict),
             closed_at = now(), verified_at = now(), stale = false, updated_at = now()
       WHERE id = p_id;
    ELSIF p_verdict = 'keep' THEN
      -- Keep is NOT a close. It is "yes, still mine, ask me again in a month" —
      -- the answer that a pure age sweep has no way to express.
      UPDATE claude_pending_items
         SET snooze_until = CURRENT_DATE + 30, stale = false,
             verified_at = now(), updated_at = now()
       WHERE id = p_id;
    ELSE  -- assign
      IF nullif(btrim(coalesce(p_assignee,'')), '') IS NULL THEN
        RAISE EXCEPTION 'bad_input: assign needs an assignee'
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      UPDATE claude_pending_items
         SET owner = p_assignee, stale = false, verified_at = now(), updated_at = now()
       WHERE id = p_id;
    END IF;

    SELECT jsonb_build_object('status', t.status, 'closed_by', t.closed_by,
                              'closed_reason', t.closed_reason, 'closed_at', t.closed_at,
                              'snooze_until', t.snooze_until, 'stale', t.stale,
                              'owner', t.owner)
      INTO v_after FROM claude_pending_items t WHERE t.id = p_id;

    RETURN jsonb_build_array(jsonb_build_object(
      'table','claude_pending_items','id',p_id,'inserted',false,
      'before', v_before, 'after', v_after));
  END IF;

  RAISE EXCEPTION 'bad_input: % is not a lane verdict', p_verdict
    USING ERRCODE = 'invalid_parameter_value';
END $$;

GRANT EXECUTE ON FUNCTION claude_rule_lane_verdict(text,integer,text,text,text,text) TO service_role;

-- E.2 — the batch itself.
CREATE OR REPLACE FUNCTION claude_rule_batch(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_verdict   text    := nullif(p->>'verdict','');
  v_targets   jsonb   := coalesce(p->'targets', '[]'::jsonb);
  -- Honoured only for a batch of exactly one (see the gate below).
  v_single    boolean := coalesce((p->>'single_card')::boolean, false);
  v_ruled_by  text    := coalesce(nullif(p->>'ruled_by',''), 'unknown');
  v_via       text    := coalesce(nullif(p->>'via',''), 'dashboard');
  v_reason    text    := nullif(p->>'reason','');
  v_assignee  text    := nullif(p->>'assignee','');
  v_proof     text    := nullif(p->>'proof','');
  v_group     text    := nullif(p->>'rec_group_key','');
  v_sess      jsonb   := coalesce(p->'session', '{}'::jsonb);

  v_lane      text;
  v_want      text;          -- the one table this verdict may touch
  v_n         integer;
  v_date      date;
  v_key       text;
  v_session_id integer;
  v_batch     uuid    := gen_random_uuid();
  v_keys      jsonb   := '["Command Center","memory_rule","claude_rulings_log","batch"]'::jsonb;

  v_t         jsonb;
  v_tbl       text;
  v_id        integer;
  v_cardver   text;
  v_live      text;
  v_conf      text;
  v_itype     text;
  v_tproof    text;
  v_changes   jsonb;
  v_ruling_id integer;
  v_ids       integer[] := ARRAY[]::integer[];
  v_summary_id integer;
BEGIN
  -- ── validation. Every check runs over EVERY target before a single row is
  -- written, so a rejected batch leaves nothing half-applied and the error names
  -- the first thing wrong rather than the first thing tried.
  IF v_verdict IS NULL THEN
    RAISE EXCEPTION 'bad_input: verdict is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_verdict IN ('still_broken','fixed','no_longer_matters') THEN
    v_lane := 'stale';  v_want := 'claude_known_issues';
  ELSIF v_verdict IN ('done','drop','keep','assign') THEN
    v_lane := 'todos';  v_want := 'claude_pending_items';
  ELSE
    RAISE EXCEPTION 'bad_input: % is not a batchable verdict', v_verdict
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF jsonb_typeof(v_targets) <> 'array' THEN
    RAISE EXCEPTION 'bad_input: targets must be an array'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_n := jsonb_array_length(v_targets);
  IF v_n = 0 THEN
    RAISE EXCEPTION 'bad_input: a batch needs at least one target'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_n > 50 THEN
    RAISE EXCEPTION 'batch_too_large: % targets — 50 is the most that can be ruled at once', v_n
      USING ERRCODE = 'program_limit_exceeded';
  END IF;

  IF v_verdict = 'assign' AND v_assignee IS NULL THEN
    RAISE EXCEPTION 'bad_input: assign needs an assignee'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  FOR v_t IN SELECT * FROM jsonb_array_elements(v_targets) LOOP
    v_tbl     := nullif(v_t->>'table','');
    v_id      := nullif(v_t->>'id','')::integer;
    v_cardver := nullif(v_t->>'card_version','');
    v_tproof  := coalesce(nullif(v_t->>'proof',''), v_proof);

    IF v_tbl IS NULL OR v_id IS NULL THEN
      RAISE EXCEPTION 'bad_input: every target needs a table and an id'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_tbl <> v_want THEN
      RAISE EXCEPTION 'not_batchable: % rules %, not % #%', v_verdict, v_want, v_tbl, v_id
        USING ERRCODE = 'feature_not_supported';
    END IF;

    IF v_tbl = 'claude_pending_items' THEN
      SELECT rec_confidence, item_type INTO v_conf, v_itype
        FROM claude_pending_items WHERE id = v_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'bad_input: pending item #% not found', v_id
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      -- A decision is never a bulk action.
      IF v_itype IN ('decision_needed','unconfirmed_decision','open_question','approval_needed') THEN
        RAISE EXCEPTION 'not_batchable: #% is a Rulings card (%) — rule it one at a time', v_id, v_itype
          USING ERRCODE = 'feature_not_supported';
      END IF;
    ELSE
      SELECT rec_confidence INTO v_conf FROM claude_known_issues WHERE id = v_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'bad_input: issue #% not found', v_id
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
    END IF;

    -- The confidence gate is what separates a batch from a click. A person
    -- ruling ONE card has read it; that is the confidence. Fifty at once are
    -- being ruled on the recommendation's word, so the recommendation has to be
    -- sure. The flag is honoured only at n = 1, so it cannot be used to wave a
    -- real batch through.
    IF NOT (v_single AND v_n = 1) AND coalesce(v_conf,'') <> 'high' THEN
      RAISE EXCEPTION 'confidence_too_low: %.#% is % — a batch applies high-confidence recommendations only',
        v_tbl, v_id, coalesce(v_conf,'unrecommended')
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF v_verdict = 'fixed' AND v_tproof IS NULL THEN
      RAISE EXCEPTION 'proof_required: issue #% cannot be closed as fixed without a link to what fixed it', v_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF v_cardver IS NOT NULL THEN
      v_live := claude_card_version(v_tbl, v_id);
      IF v_live IS DISTINCT FROM v_cardver THEN
        RAISE EXCEPTION 'stale_card: % #% changed since it was loaded — reload and re-check the batch', v_tbl, v_id
          USING ERRCODE = 'serialization_failure';
      END IF;
    END IF;
  END LOOP;

  -- ── the daily session, identical to claude_rule_apply's.
  v_date := coalesce(nullif(v_sess->>'date','')::date, CURRENT_DATE);
  v_key  := nullif(v_sess->>'checkpoint_key','');
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'bad_input: session.checkpoint_key is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO claude_session_logs (
    session_date, session_title, phase_focus, raw_summary, transcript_search_keys,
    surface, log_origin, link_confidence, date_confidence, validation_status, checkpoint_key,
    workflows_touched, phase_status, decisions_made, issues_found, issues_resolved,
    pending_items, board_versions, mcp_verified_ids, next_steps, created_at, updated_at
  ) VALUES (
    v_date,
    left(coalesce(nullif(v_sess->>'title',''), 'Command Center rulings — ' || v_date::text), 300),
    'command-center',
    'Rulings made through memory_rule on ' || v_date::text || ' — see claude_rulings_log.',
    v_keys,
    'dashboard', 'live', 'unlinked', 'exact', 'passed', v_key,
    '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
    '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, now(), now()
  )
  ON CONFLICT (checkpoint_key) DO NOTHING;

  SELECT id INTO v_session_id FROM claude_session_logs WHERE checkpoint_key = v_key;
  IF v_session_id IS NULL THEN
    RAISE EXCEPTION 'bad_input: could not resolve the daily session'
      USING ERRCODE = 'internal_error';
  END IF;

  -- ── apply. One log row per item, each carrying only its own before/after.
  FOR v_t IN SELECT * FROM jsonb_array_elements(v_targets) LOOP
    v_tbl    := v_t->>'table';
    v_id     := (v_t->>'id')::integer;
    v_tproof := coalesce(nullif(v_t->>'proof',''), v_proof);

    v_changes := claude_rule_lane_verdict(v_tbl, v_id, v_verdict, v_tproof, v_assignee, v_ruled_by);

    INSERT INTO claude_rulings_log (
      ruled_by, via, lane, action, target_table, target_id, changes, reason,
      batch_id, session_id, rec_verdict
    ) VALUES (
      v_ruled_by, v_via, v_lane, v_verdict, v_tbl, v_id, v_changes, v_reason,
      v_batch, v_session_id, v_verdict
    ) RETURNING id INTO v_ruling_id;
    v_ids := v_ids || v_ruling_id;
  END LOOP;

  -- ── the summary row. changes is deliberately empty: the per-item rows own the
  -- restore, and a flip aimed at this row must be a no-op rather than a partial
  -- undo. F is the way to take a batch back.
  -- Only a real batch gets one. A single card would otherwise show up twice on
  -- the Decided tab — once as the ruling, once as a "batch of 1".
  IF v_n > 1 THEN
    INSERT INTO claude_rulings_log (
      ruled_by, via, lane, action, target_table, target_id, changes, reason,
      batch_id, session_id, rec_verdict
    ) VALUES (
      v_ruled_by, v_via, v_lane, 'batch_apply', v_want, 0, '[]'::jsonb,
      coalesce(v_reason, v_verdict || ' × ' || v_n::text)
        || CASE WHEN v_group IS NULL THEN '' ELSE ' (' || v_group || ')' END,
      v_batch, v_session_id, v_verdict
    ) RETURNING id INTO v_summary_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'batch_id', v_batch, 'lane', v_lane, 'verdict', v_verdict,
    'applied', v_n, 'session_id', v_session_id,
    'summary_ruling_id', v_summary_id, 'ruling_ids', to_jsonb(v_ids));
END $$;

GRANT EXECUTE ON FUNCTION claude_rule_batch(jsonb) TO service_role;

-- ═══ F. claude_rule_batch_undo(uuid, text, text) — one click back ══════════
-- A batch that cannot be taken back whole is not a batch, it is a bet. This
-- restores every `before` in the batch, writes one reversing log row per item,
-- and stamps reversed_by on each original.
--
-- It validates the ENTIRE batch before touching a row. The transaction would
-- roll back anyway, but validating first means the error names the row that
-- actually blocks the undo instead of the first one the loop happened to reach —
-- and it makes "half of my batch came back" impossible to report.
--
-- Refuses when any row is already reversed (already_reversed) or when a column
-- it would restore has moved since the batch was applied (changed_since) —
-- someone has ruled on that card in between, and their ruling is not ours to
-- overwrite. Fix that card by hand, then undo the rest.

CREATE OR REPLACE FUNCTION claude_rule_batch_undo(
  p_batch_id uuid,
  p_reason   text,
  p_ruled_by text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_ruled_by   text := coalesce(nullif(p_ruled_by,''), 'unknown');
  v_n          integer;
  v_row        claude_rulings_log%ROWTYPE;
  v_chg        jsonb;
  v_col        text;
  v_now_val    text;
  v_session_id integer;
  v_lane       text;
  v_via        text;
  v_undo_id    integer;
  v_ids        integer[] := ARRAY[]::integer[];
  v_summary_id integer;
BEGIN
  IF p_batch_id IS NULL THEN
    RAISE EXCEPTION 'bad_input: batch_id is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF nullif(btrim(coalesce(p_reason,'')), '') IS NULL THEN
    RAISE EXCEPTION 'reason_required: an undo must say why'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT count(*) INTO v_n
    FROM claude_rulings_log
   WHERE batch_id = p_batch_id AND action <> 'batch_apply' AND action <> 'batch_undo';
  IF v_n = 0 THEN
    RAISE EXCEPTION 'bad_input: no batch % to undo', p_batch_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT session_id, lane, via INTO v_session_id, v_lane, v_via
    FROM claude_rulings_log
   WHERE batch_id = p_batch_id AND action = 'batch_apply'
   LIMIT 1;

  -- ── pass 1: can the WHOLE batch come back?
  FOR v_row IN
    SELECT * FROM claude_rulings_log
     WHERE batch_id = p_batch_id AND action NOT IN ('batch_apply','batch_undo')
     ORDER BY id
  LOOP
    IF v_row.reversed_by IS NOT NULL THEN
      RAISE EXCEPTION 'already_reversed: ruling #% in this batch was already reversed by #%',
        v_row.id, v_row.reversed_by
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    FOR v_chg IN SELECT * FROM jsonb_array_elements(v_row.changes) LOOP
      FOR v_col IN SELECT jsonb_object_keys(v_chg->'after') LOOP
        EXECUTE format('SELECT (to_jsonb(t) ->> %L) FROM %I t WHERE t.id = $1', v_col, v_chg->>'table')
          INTO v_now_val USING (v_chg->>'id')::integer;
        IF v_now_val IS DISTINCT FROM (v_chg->'after'->>v_col) THEN
          RAISE EXCEPTION 'changed_since: %.% on row % is now % — it was % when the batch ran',
            v_chg->>'table', v_col, v_chg->>'id', coalesce(v_now_val,'NULL'),
            coalesce(v_chg->'after'->>v_col,'NULL')
            USING ERRCODE = 'serialization_failure';
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  -- ── pass 2: restore, log, stamp.
  FOR v_row IN
    SELECT * FROM claude_rulings_log
     WHERE batch_id = p_batch_id AND action NOT IN ('batch_apply','batch_undo')
     ORDER BY id
  LOOP
    FOR v_chg IN SELECT * FROM jsonb_array_elements(v_row.changes) LOOP
      FOR v_col IN SELECT jsonb_object_keys(v_chg->'before') LOOP
        PERFORM claude_rule_restore_col(v_chg->>'table', (v_chg->>'id')::integer,
                                        v_col, v_chg->'before'->>v_col);
      END LOOP;
    END LOOP;

    INSERT INTO claude_rulings_log (
      ruled_by, via, lane, action, target_table, target_id, changes, reason,
      reverses_id, batch_id, session_id
    ) VALUES (
      v_ruled_by, coalesce(v_via,'dashboard'), coalesce(v_lane, v_row.lane), 'batch_undo',
      v_row.target_table, v_row.target_id, '[]'::jsonb, p_reason,
      v_row.id, p_batch_id, v_session_id
    ) RETURNING id INTO v_undo_id;

    UPDATE claude_rulings_log SET reversed_by = v_undo_id WHERE id = v_row.id;
    v_ids := v_ids || v_undo_id;
  END LOOP;

  -- Close the summary row too, so the Decided tab shows the batch as reversed
  -- rather than as fifty reversed rows under a live heading.
  INSERT INTO claude_rulings_log (
    ruled_by, via, lane, action, target_table, target_id, changes, reason,
    batch_id, session_id
  )
  SELECT v_ruled_by, coalesce(v_via,'dashboard'), coalesce(v_lane,'todos'), 'batch_undo',
         s.target_table, s.target_id, '[]'::jsonb,
         p_reason || ' — reversed ' || v_n::text || ' items',
         p_batch_id, v_session_id
    FROM claude_rulings_log s
   WHERE s.batch_id = p_batch_id AND s.action = 'batch_apply' AND s.reversed_by IS NULL
   LIMIT 1
  RETURNING id INTO v_summary_id;

  IF v_summary_id IS NOT NULL THEN
    UPDATE claude_rulings_log SET reversed_by = v_summary_id
     WHERE batch_id = p_batch_id AND action = 'batch_apply' AND reversed_by IS NULL;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'batch_id', p_batch_id, 'reversed', v_n,
    'session_id', v_session_id, 'ruling_ids', to_jsonb(v_ids),
    'summary_ruling_id', v_summary_id);
END $$;

GRANT EXECUTE ON FUNCTION claude_rule_batch_undo(uuid, text, text) TO service_role;

-- ═══ G. claude_rule_lane_apply(jsonb) — one lane card, one click ═══════════
-- Release 1's claude_rule_apply hard-rejects two things the new lanes need:
-- claude_known_issues as a target ("target_table % is not rulable"), and every
-- verdict outside its own list ("not_in_release: action % is not part of
-- Release 1"). Without this section the lanes render and every button errors.
--
-- Why a new function instead of widening claude_rule_apply: that function is
-- 500 lines of audited Release-1 behaviour — the decision writer, the conflict
-- resolver, the flip machinery — and none of it has anything to say about a
-- stale issue. Editing it to bolt on seven verdicts risks the paths Mark
-- already relies on, for no gain. The doctrine that matters is "one audited
-- DOOR", and the door is the memory_rule tool: both functions write
-- claude_rulings_log in one transaction and neither can be reached any other
-- way. The verdict semantics cannot drift between one click and fifty, because
-- both go through claude_rule_lane_verdict (E.1).
--
-- Implemented as a batch of one so that undo is the SAME function for one card
-- and fifty — claude_rule_batch_undo(batch_id). A single ruling is a batch of
-- one, and it gets no summary row.
--
-- Payload: { "action", "target_table", "target_id", "card_version",
--            "proof", "assignee", "reason", "ruled_by", "via", "rec_verdict",
--            "session": { "date", "title", "checkpoint_key" } }

CREATE OR REPLACE FUNCTION claude_rule_lane_apply(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_action text    := nullif(p->>'action','');
  v_table  text    := nullif(p->>'target_table','');
  v_id     integer := nullif(p->>'target_id','')::integer;
  v_res    jsonb;
BEGIN
  IF v_action IS NULL OR v_table IS NULL OR v_id IS NULL THEN
    RAISE EXCEPTION 'bad_input: action, target_table and target_id are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_action NOT IN ('still_broken','fixed','no_longer_matters','done','drop','keep','assign') THEN
    RAISE EXCEPTION 'not_in_release: % is not a lane verdict — use claude_rule_apply', v_action
      USING ERRCODE = 'feature_not_supported';
  END IF;

  v_res := claude_rule_batch(jsonb_build_object(
    'verdict',       v_action,
    'single_card',   true,
    'targets',       jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
                       'table',        v_table,
                       'id',           v_id,
                       'card_version', p->>'card_version',
                       'proof',        p->>'proof'))),
    'proof',         p->>'proof',
    'assignee',      p->>'assignee',
    'reason',        p->>'reason',
    'ruled_by',      p->>'ruled_by',
    'via',           p->>'via',
    'rec_group_key', p->>'rec_group_key',
    'session',       coalesce(p->'session', '{}'::jsonb)));

  RETURN jsonb_build_object(
    'ok', true,
    'ruling_id', (v_res->'ruling_ids'->>0)::integer,
    'batch_id',  v_res->>'batch_id',
    'session_id', (v_res->>'session_id')::integer);
END $$;

GRANT EXECUTE ON FUNCTION claude_rule_lane_apply(jsonb) TO service_role;

-- ═══ Verification ══════════════════════════════════════════════════════════
-- Run after all seven sections. Expect fn = 6 and three lanes: rulings in the
-- high 400s (it moves — see below), stale about 624, todos about 2,400.
--
-- SELECT json_build_object(
--   'fn',    (SELECT count(*) FROM pg_proc
--              WHERE proname IN ('claude_rule_batch','claude_rule_batch_undo',
--                                'claude_rule_lane_verdict','claude_rule_lane_apply',
--                                'claude_omi_memory_upsert','claude_item_type_norm')),
--   'lanes', (SELECT json_agg(row_to_json(l))
--               FROM (SELECT lane, count(*) n FROM v_command_center_queue
--                      GROUP BY 1 ORDER BY 1) l),
--   'omi',   (SELECT count(*) FROM claude_omi_sync));
--
-- THE REAL CHECK on section D, if you want to re-run it. This proves the two
-- Rulings branches were reproduced exactly rather than "look about right" — it
-- snapshots the OLD view, replaces it, and diffs. Run the whole thing as one
-- statement BEFORE applying D for real; it rolls itself back and changes
-- nothing. Expect only_in_v1 = only_in_v2 = field_diffs = 0.
--
--   BEGIN;
--   CREATE TEMP TABLE _v1 ON COMMIT DROP AS SELECT * FROM v_command_center_queue;
--   <paste sections C and D here>
--   SELECT json_build_object(
--     'v1_rulings', (SELECT count(*) FROM _v1),
--     'v2_rulings', (SELECT count(*) FROM v_command_center_queue WHERE lane='rulings'),
--     'only_in_v1', (SELECT count(*) FROM (SELECT source_table,source_id FROM _v1
--                      EXCEPT SELECT source_table,source_id FROM v_command_center_queue
--                       WHERE lane='rulings') x),
--     'only_in_v2', (SELECT count(*) FROM (SELECT source_table,source_id
--                        FROM v_command_center_queue WHERE lane='rulings'
--                      EXCEPT SELECT source_table,source_id FROM _v1) x),
--     'field_diffs',(SELECT count(*) FROM _v1 a
--                      JOIN v_command_center_queue b ON b.lane='rulings'
--                       AND b.source_table=a.source_table AND b.source_id=a.source_id
--                     WHERE to_jsonb(a) - 'item_type_norm' IS DISTINCT FROM
--                           (to_jsonb(b) - 'rec_group_key' - 'omi_action_item_id'
--                                        - 'item_type_norm')));
--   ROLLBACK;
