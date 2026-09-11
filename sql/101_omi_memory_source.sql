-- ─── 101 — Omi conversation intelligence as an UNCONFIRMED memory source ────
--
-- WHY. Mark wears an Omi recorder. What he says out loud about the business —
-- a limit he wants changed, a report someone owes him, a question he keeps
-- asking — never reaches the memory tier, so the same ground gets re-covered in
-- chat a week later. The ruling (2026-09-10) is deliberately narrow:
--
--   Omi feeds the EXISTING memory. It never gets a parallel store, it never
--   stores a raw transcript anywhere in Supabase, and nothing it hears is ever
--   treated as confirmed.
--
-- So every item an Omi conversation produces lands in claude_pending_items as
-- an UNCONFIRMED proposal under one claude_session_logs row per conversation
-- (surface 'omi', log_origin 'omi'). Omi never writes claude_decision_log or
-- claude_known_issues. Confirmation stays the path it already is: Mark says yes
-- in chat, memory_checkpoint writes the decision live/confirmed and closes the
-- pending row with status 'ratified'.
--
-- WHAT this file changes, in the order Mark runs it:
--
--   A. CHECK constraints on claude_session_logs. Two of them were already
--      BEHIND the shipped code before Omi existed:
--        surface     allowed chat|cowork|code; memory-checkpoint.js has
--                    accepted 'n8n' since v1.0 (SURFACES on line 83).
--        log_origin  allowed live|retro; memory-validate.js writes draft
--                    sessions with log_origin 'nightly' (runDraftCheckpoints).
--      Both would have thrown a check_violation the first time that path ran.
--      They are widened here to match the code, and 'omi' is added to each.
--
--   B. claude_omi_ingest(jsonb) — ONE function, ONE transaction, for a whole
--      conversation: the session row, its pending items, mentions appended to
--      items that already exist, and the ledger row. A conversation is never
--      half-written. Idempotent on claude_session_logs.checkpoint_key (the
--      UNIQUE column from sql/096, key = sha256('omi|' || conversation_id)):
--      a replayed webhook returns {"status":"duplicate_event"} and writes
--      nothing.
--
--   C. claude_memory_context() v6 — keep Omi OUT of the session-start pack's
--      session slots. Without this, one Omi conversation becomes 'last_session'
--      and a real chat session stops being the thing a new session opens on.
--      Omi is represented in the pack by ONE number instead:
--      counts.omi_open_unconfirmed.
--
--   D. A partial index for the open Omi queue (the Monday digest reads it).
--
-- Every statement is additive and idempotent. No row is rewritten, no column is
-- dropped, no existing memory row changes meaning. The only DROP is of a CHECK
-- constraint, immediately re-added wider.
--
-- HOW TO APPLY. Supabase dashboard → SQL editor on the LP instance
-- (rcjcgjlqzepicbwhnnjl), as FOUR separate executions, in this order: A, D, B,
-- C. Verification queries are at the bottom.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS claude_omi_ingest(jsonb);
--   DROP INDEX IF EXISTS idx_claude_pending_omi_open;
--   -- and re-apply sql/090 + sql/097 + sql/098's pack definition to revert C.
--   -- The constraints in A should NOT be rolled back: they were widened to
--   -- match code that has been shipped for days.

-- ═══ A. Constraints — surface and log_origin catch up with the code ═════════
-- Constraint-only changes. No data is touched; every existing row already
-- satisfies the wider list.

ALTER TABLE claude_session_logs DROP CONSTRAINT IF EXISTS claude_session_logs_surface_check;
ALTER TABLE claude_session_logs ADD CONSTRAINT claude_session_logs_surface_check
  CHECK (surface = ANY (ARRAY['chat','cowork','code','n8n','omi']));

ALTER TABLE claude_session_logs DROP CONSTRAINT IF EXISTS claude_session_logs_log_origin_check;
ALTER TABLE claude_session_logs ADD CONSTRAINT claude_session_logs_log_origin_check
  CHECK (log_origin = ANY (ARRAY['live','retro','nightly','omi']));

-- ═══ D. Index for the open Omi queue ═══════════════════════════════════════
-- The Monday digest's "Heard in Omi" section and the pack's
-- counts.omi_open_unconfirmed both read exactly this predicate.
-- (Run this BEFORE B so the function below is created against the index.)

CREATE INDEX IF NOT EXISTS idx_claude_pending_omi_open
  ON claude_pending_items (created_at DESC) WHERE origin = 'omi' AND status = 'open';

-- ═══ B. claude_omi_ingest(jsonb) — the atomic writer ═══════════════════════
--
-- Input shape (built by src/memory/omi-ingest.js; every string is already
-- PII-scrubbed by stripPii() before it gets here):
--
--   {
--     "checkpoint_key": "<sha256 hex of 'omi|' || conversation_id>",
--     "session": {
--       "session_date": "YYYY-MM-DD",
--       "session_title": "…",
--       "raw_summary": "…",
--       "transcript_search_keys": ["…", "…", "…"]
--     },
--     "items": [
--       { "item_type": "unconfirmed_decision", "description": "[Omi 2026-09-11] …",
--         "priority": 1, "owner": "Amanda", "raw": { … } }
--     ],
--     "mentions": [ { "pending_id": 412, "mention": { … } } ],
--     "ledger_ref": "omi:<conversation_id>"
--   }
--
-- Returns either
--   {"status":"duplicate_event","session_id":123}                 nothing written
-- or
--   {"status":"written","session_id":124,"pending_ids":[…],"mentions":2}
--
-- A plpgsql function body is a single transaction: if any insert below raises,
-- the session row goes with it. That is the whole point — a conversation is
-- never represented by a partial set of items.
--
-- Triggers that still apply, deliberately:
--   claude_set_area (sql/093)         fills area on the session and on each item.
--   claude_guard_session_insert (098) acts only on log_origin 'live' / 'retro',
--                                     so an 'omi' row passes through untouched.
--   claude_inherit_provenance (100)   fires on claude_decision_log /
--                                     claude_known_issues only. Omi writes
--                                     neither, so it never fires here.

CREATE OR REPLACE FUNCTION claude_omi_ingest(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_key          text    := nullif(p->>'checkpoint_key', '');
  v_session      jsonb   := coalesce(p->'session', '{}'::jsonb);
  v_ledger       text    := nullif(p->>'ledger_ref', '');
  v_session_date date;
  v_session_id   integer;
  v_existing_id  integer;
  v_item         jsonb;
  v_mention      jsonb;
  v_index        integer := 0;
  v_pending_id   integer;
  v_pending_ids  integer[] := ARRAY[]::integer[];
  v_mentions     integer := 0;
BEGIN
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'claude_omi_ingest: checkpoint_key is required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  v_session_date := coalesce(nullif(v_session->>'session_date','')::date, CURRENT_DATE);

  -- 1. The session row. ON CONFLICT DO NOTHING is the idempotency gate: a
  --    replayed webhook (n8n retry, Omi re-delivery) inserts nothing and the
  --    RETURNING leaves v_session_id NULL.
  INSERT INTO claude_session_logs (
    session_date, session_title, phase_focus, raw_summary, transcript_search_keys,
    surface, log_origin, link_confidence, date_confidence, validation_status,
    checkpoint_key,
    workflows_touched, phase_status, decisions_made, issues_found, issues_resolved,
    pending_items, board_versions, mcp_verified_ids, next_steps,
    created_at, updated_at
  ) VALUES (
    v_session_date,
    left(coalesce(nullif(v_session->>'session_title',''), 'Omi conversation'), 300),
    'omi',
    v_session->>'raw_summary',
    coalesce(v_session->'transcript_search_keys', '[]'::jsonb),
    'omi', 'omi', 'unlinked', 'exact', 'passed',
    v_key,
    '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
    '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
    now(), now()
  )
  ON CONFLICT (checkpoint_key) DO NOTHING
  RETURNING id INTO v_session_id;

  IF v_session_id IS NULL THEN
    SELECT id INTO v_existing_id FROM claude_session_logs WHERE checkpoint_key = v_key;
    RETURN jsonb_build_object('status', 'duplicate_event', 'session_id', v_existing_id);
  END IF;

  -- 2. The items. source_field 'omi' keeps them out of the way of the
  --    checkpoint tool's own 'live' source_index sequence (the UNIQUE is on
  --    source_session_id + source_field + source_index).
  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p->'items', '[]'::jsonb))
  LOOP
    INSERT INTO claude_pending_items (
      source_session_id, source_field, source_index, kind, item_type, description,
      status, priority, owner, origin, session_date, raw, created_at, updated_at
    ) VALUES (
      v_session_id, 'omi', v_index, 'pending',
      coalesce(nullif(v_item->>'item_type',''), 'action_needed'),
      v_item->>'description',
      'open',
      nullif(v_item->>'priority','')::integer,
      nullif(v_item->>'owner',''),
      'omi', v_session_date,
      coalesce(v_item->'raw', '{}'::jsonb),
      now(), now()
    )
    RETURNING id INTO v_pending_id;
    v_pending_ids := v_pending_ids || v_pending_id;
    v_index := v_index + 1;
  END LOOP;

  -- 3. Mentions. The item already exists (exact-text or vector duplicate), so
  --    nothing new is created — the existing row just learns it came up again.
  --    Closed rows are skipped on purpose: hearing an old closed item mentioned
  --    is not a reason to touch it.
  FOR v_mention IN SELECT * FROM jsonb_array_elements(coalesce(p->'mentions', '[]'::jsonb))
  LOOP
    UPDATE claude_pending_items
       SET raw = coalesce(raw, '{}'::jsonb) || jsonb_build_object(
                   'omi_mentions',
                   coalesce(raw->'omi_mentions', '[]'::jsonb)
                     || jsonb_build_array(v_mention->'mention')),
           updated_at = now()
     WHERE id = nullif(v_mention->>'pending_id','')::integer
       AND status = 'open';
    IF FOUND THEN v_mentions := v_mentions + 1; END IF;
  END LOOP;

  -- 4. Ledger. 'omi:<conversation_id>' is not a URL and is never fetched — it
  --    is the ledger's record that this conversation has been dealt with.
  IF v_ledger IS NOT NULL THEN
    INSERT INTO claude_transcript_ledger (chat_url, session_id, disposition, reviewed_at, notes)
    VALUES (v_ledger, v_session_id, 'linked', now(), 'omi ingest')
    ON CONFLICT (chat_url) DO UPDATE
      SET session_id = EXCLUDED.session_id,
          disposition = 'linked',
          reviewed_at = now(),
          notes = 'omi ingest';
  END IF;

  RETURN jsonb_build_object(
    'status', 'written',
    'session_id', v_session_id,
    'pending_ids', to_jsonb(v_pending_ids),
    'mentions', v_mentions
  );
END $$;

GRANT EXECUTE ON FUNCTION claude_omi_ingest(jsonb) TO service_role;

-- ═══ C. claude_memory_context() v6 — Omi stays out of the session slots ════
--
-- Copied verbatim from the live definition (pg_get_functiondef, 2026-09-11)
-- with FIVE edits, each marked `-- sql/101` below:
--   last_session          skip Omi sessions
--   recent_sessions       skip Omi sessions
--   open_pending_recent   skip Omi sessions in BOTH the "which session is the
--                         newest" sub-select and the outer join
--   counts.unlinked_sessions   Omi sessions are unlinked by design, not by
--                              neglect — they must not inflate the backlog
--   counts.omi_open_unconfirmed   NEW: the one number Omi contributes
--
-- `coalesce(log_origin,'')` rather than a bare `<>`: both columns are nullable,
-- and a bare `<> 'omi'` is NULL (i.e. false) for a NULL row, which would
-- silently drop legacy sessions out of the pack.

CREATE OR REPLACE FUNCTION claude_memory_context(p_topic text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE sql STABLE AS $function$
  SELECT jsonb_build_object(
    'generated_at', now(),
    'topic', p_topic,
    'how_to_read', 'Ranked pack, ~8k tokens. counts shows what is NOT here. For anything else use claude_memory_search(query). Pending work lives in claude_pending_items; close items with UPDATE, never re-paste. open_conflicts need a ruling (memory_precheck shows the pair). counts.omi_open_unconfirmed = things heard on Omi, unconfirmed: confirm one with memory_checkpoint (decision) + close_pending {status:''ratified''}.',

    'last_session', (SELECT row_to_json(s) FROM (
        SELECT l.id, l.session_date, l.session_title, l.phase_focus, l.surface, l.log_origin, l.chat_url,
               left(l.raw_summary, 1500) AS summary,
               (SELECT jsonb_agg(jsonb_build_object('id', p.id, 'kind', p.kind, 'type', p.item_type,
                          'priority', p.priority, 'status', p.status, 'description', left(p.description, 200))
                        ORDER BY (p.kind='next_step') DESC, p.priority NULLS LAST, p.id)
                  FROM claude_pending_items p
                 WHERE p.source_session_id = l.id AND p.status IN ('open','blocked','deferred')
               ) AS open_items
        FROM claude_session_logs l
        WHERE l.date_confidence <> 'write_date'
          AND coalesce(l.log_origin,'') <> 'omi'                      -- sql/101
        ORDER BY l.session_date DESC, l.created_at DESC LIMIT 1) s),

    'recent_sessions', (SELECT jsonb_agg(r) FROM (
        SELECT id, session_date, session_title
        FROM claude_session_logs
        WHERE date_confidence <> 'write_date'
          AND coalesce(log_origin,'') <> 'omi'                        -- sql/101
        ORDER BY session_date DESC, created_at DESC OFFSET 1 LIMIT 5) r),

    'open_issues_priority', (SELECT jsonb_agg(r) FROM (
        SELECT i.id, i.severity, i.category, left(i.description, 220) AS description,
               i.workflow_name, i.status, i.reported_date, i.origin, i.stale
        FROM claude_known_issues i
        LEFT JOIN claude_session_logs s ON s.id = i.reported_session_id
        WHERE i.status IN ('open','in_progress') AND i.issue_type = 'defect'
          AND i.severity IN ('critical','high')
        ORDER BY (coalesce(s.date_confidence,'exact') = 'write_date' OR coalesce(i.date_confidence,'exact') = 'write_date') ASC,
                 (i.origin = 'live') DESC, i.stale ASC,
                 CASE i.severity WHEN 'critical' THEN 1 ELSE 2 END,
                 i.updated_at DESC
        LIMIT 25) r),

    'decisions_30d', (SELECT jsonb_agg(r) FROM (
        SELECT d.id, d.decision_date, d.category, left(d.decision, 240) AS decision, d.origin, d.status
        FROM claude_decision_log d
        LEFT JOIN claude_session_logs s ON s.id = d.session_id
        WHERE d.decision_date >= CURRENT_DATE - 30 AND d.status = 'active'
          AND coalesce(s.date_confidence,'exact') <> 'write_date'
          AND coalesce(d.date_confidence,'exact') <> 'write_date'
        ORDER BY d.decision_date DESC, d.id DESC LIMIT 25) r),

    'resolved_30d', (SELECT jsonb_agg(r) FROM (
        SELECT id, severity, left(description, 160) AS description, resolved_date
        FROM claude_known_issues
        WHERE status = 'resolved' AND resolved_date >= CURRENT_DATE - 30
        ORDER BY resolved_date DESC, id DESC LIMIT 15) r),

    'open_pending_recent', (SELECT jsonb_agg(r) FROM (
        SELECT p.id, p.source_session_id AS session_id, p.session_date, p.kind, p.item_type AS type,
               p.status, p.priority, left(p.description, 180) AS description
        FROM claude_pending_items p
        LEFT JOIN claude_session_logs s ON s.id = p.source_session_id
        WHERE p.source_session_id <> (SELECT id FROM claude_session_logs
                                       WHERE date_confidence <> 'write_date'
                                         AND coalesce(log_origin,'') <> 'omi'   -- sql/101
                                       ORDER BY session_date DESC, created_at DESC LIMIT 1)
          AND coalesce(s.date_confidence,'exact') <> 'write_date'
          AND coalesce(s.log_origin,'') <> 'omi'                       -- sql/101
          AND p.session_date >= CURRENT_DATE - 14
          AND p.status IN ('open','blocked')
          AND (p.kind = 'next_step' OR coalesce(p.item_type,'') IN ('action_needed','open_question','decision_needed','blocked','build_needed'))
        ORDER BY p.session_date DESC, p.source_session_id DESC, p.priority NULLS LAST, p.id
        LIMIT 20) r),

    'open_conflicts', (SELECT jsonb_agg(r) FROM (
        SELECT id, kind, row_a, row_b, round(similarity::numeric, 3) AS similarity, detected_at::date AS detected
        FROM claude_memory_conflicts
        WHERE status = 'open'
        ORDER BY similarity DESC, id LIMIT 5) r),

    'topic_matches', CASE WHEN nullif(trim(p_topic), '') IS NULL THEN NULL ELSE
        (SELECT jsonb_agg(r) FROM (
           SELECT kind, id, date, left(text, 200) AS text, origin, status
           FROM claude_memory_search(p_topic, 20)) r) END,

    'counts', (SELECT row_to_json(c) FROM (SELECT
        (SELECT count(*) FROM claude_known_issues WHERE status IN ('open','in_progress') AND issue_type = 'defect') AS open_issues,
        (SELECT count(*) FROM claude_known_issues WHERE status IN ('open','in_progress') AND issue_type = 'defect' AND NOT stale) AS open_issues_fresh,
        (SELECT count(*) FROM claude_known_issues WHERE status IN ('open','in_progress') AND issue_type = 'defect' AND origin = 'live') AS open_issues_live,
        (SELECT count(*) FROM claude_known_issues WHERE status IN ('open','in_progress') AND issue_type = 'defect' AND severity = 'critical') AS open_critical,
        (SELECT count(*) FROM claude_known_issues WHERE status IN ('open','in_progress') AND issue_type = 'defect' AND severity = 'high') AS open_high,
        (SELECT count(*) FROM claude_known_issues WHERE status IN ('open','in_progress') AND issue_type = 'initiative') AS open_initiatives,
        (SELECT count(*) FROM claude_pending_items WHERE status IN ('open','blocked')) AS open_pending_items,
        (SELECT count(*) FROM claude_pending_items WHERE status IN ('open','blocked') AND session_date >= CURRENT_DATE - 30) AS open_pending_items_30d,
        (SELECT count(*) FROM claude_pending_items WHERE origin = 'omi' AND status = 'open') AS omi_open_unconfirmed,   -- sql/101
        (SELECT count(*) FROM claude_decision_log WHERE status = 'active') AS active_decisions,
        (SELECT count(*) FROM claude_session_logs) AS sessions,
        (SELECT count(*) FROM claude_memory_conflicts WHERE status = 'open') AS open_conflicts,
        (SELECT count(*) FROM claude_session_logs WHERE chat_url IS NULL
           AND coalesce(surface,'chat') <> 'omi') AS unlinked_sessions,                                                -- sql/101
        (SELECT count(*) FROM claude_session_logs WHERE date_confidence = 'write_date') AS write_date_sessions,
        (SELECT count(*) FROM claude_session_logs WHERE validation_status = 'flagged') AS flagged_sessions) c)
  );
$function$;

-- ═══ Verification ══════════════════════════════════════════════════════════
-- Run after all four blocks. Expect fn = 1, both _ok true, pack_last NOT 'omi',
-- omi_count present (0 until the first live ingest).
--
-- SELECT json_build_object(
--   'fn',          (SELECT count(*) FROM pg_proc WHERE proname = 'claude_omi_ingest'),
--   'surface_ok',  (SELECT pg_get_constraintdef(oid) LIKE '%omi%'
--                     FROM pg_constraint WHERE conname = 'claude_session_logs_surface_check'),
--   'origin_ok',   (SELECT pg_get_constraintdef(oid) LIKE '%nightly%'
--                     FROM pg_constraint WHERE conname = 'claude_session_logs_log_origin_check'),
--   'index_ok',    (SELECT count(*) FROM pg_indexes WHERE indexname = 'idx_claude_pending_omi_open'),
--   'pack_last',   (claude_memory_context('memory system')->'last_session'->>'surface'),
--   'omi_count',   (claude_memory_context(NULL)->'counts'->>'omi_open_unconfirmed'));
