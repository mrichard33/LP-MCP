-- ─── 097 — Session-start pack: rank by session_date, demote write-date rows ──
--
-- WHY. The Cowork sweep on 2026-09-06/07 wrote ~80 retro checkpoints for chats
-- that happened weeks earlier (sessions 705–781). Each carried the WRITE date
-- in session_date, not the chat's real date, and the newest created_at. The
-- sql/091 pack orders last_session / recent_sessions by created_at and takes
-- open_issues_priority / decisions_30d / open_pending_recent straight from
-- those rows, so every session start opened on a sweep checkpoint instead of
-- the last real working session, and the "top open issues" list was headed by
-- issues those checkpoints re-reported.
--
-- FIX. A per-session flag, claude_session_logs.date_confidence:
--   'exact'       session_date is the real date of the work (default)
--   'write_date'  session_date is only the date the row was written; the real
--                 date is unknown or earlier
-- Vocabulary follows the sql/051 convention: plain TEXT, no CHECK constraint.
-- The column was added by hand via supabase_run_query on 2026-09-07
-- (ALTER TABLE claude_session_logs ADD COLUMN date_confidence text NOT NULL
-- DEFAULT 'exact') and the 76 sweep rows were flagged 'write_date'. Section A
-- repeats that ALTER with IF NOT EXISTS so this file is self-contained.
--
-- Section B is the sql/091 v3 claude_memory_context() copied verbatim, with
-- ONLY these edits:
--   1. last_session / recent_sessions   exclude date_confidence = 'write_date';
--                                       ORDER BY session_date DESC, created_at
--                                       DESC (was created_at DESC alone).
--                                       recent_sessions keeps OFFSET 1 LIMIT 5.
--   2. open_issues_priority             LEFT JOIN the reporting session; a
--                                       write_date session becomes the FIRST
--                                       sort key (ascending), so those issues
--                                       fall to the bottom of the 25 instead
--                                       of leading it.
--   3. decisions_30d                    LEFT JOIN the session; decisions from
--                                       write_date sessions are dropped (their
--                                       decision_date is the write date, so
--                                       "last 30 days" is meaningless).
--   4. open_pending_recent              pending items from write_date sessions
--                                       are excluded; the "current session"
--                                       exclusion now uses the same selection
--                                       as last_session (edit 1) so the two
--                                       lists stay disjoint.
-- Everything else (open_items from claude_pending_items, issue_type = 'defect',
-- stale ordering, counts, topic_matches) is unchanged from sql/091.
-- claude_memory_search() is untouched.
--
-- Mirrored in src/memory/memory-migrations.js (presence check: the function
-- body mentions date_confidence). memory_checkpoint accepts
-- session.date_confidence ('exact' | 'write_date') from the same PR.
--
-- ROLLBACK: re-run section D of sql/091 (CREATE OR REPLACE FUNCTION
-- claude_memory_context). The column stays — harmless, default 'exact'.

-- ─── A. Column (already applied by hand 2026-09-07; idempotent here) ─────────

ALTER TABLE claude_session_logs
  ADD COLUMN IF NOT EXISTS date_confidence text NOT NULL DEFAULT 'exact';

-- ─── B. claude_memory_context() v4 ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION claude_memory_context(p_topic text DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'generated_at', now(),
    'topic', p_topic,
    'how_to_read', 'Ranked pack, ~8k tokens. counts shows what is NOT here. For anything else use claude_memory_search(query). Pending work lives in claude_pending_items; close items with UPDATE, never re-paste.',

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
        ORDER BY l.session_date DESC, l.created_at DESC LIMIT 1) s),

    'recent_sessions', (SELECT jsonb_agg(r) FROM (
        SELECT id, session_date, session_title
        FROM claude_session_logs
        WHERE date_confidence <> 'write_date'
        ORDER BY session_date DESC, created_at DESC OFFSET 1 LIMIT 5) r),

    'open_issues_priority', (SELECT jsonb_agg(r) FROM (
        SELECT i.id, i.severity, i.category, left(i.description, 220) AS description,
               i.workflow_name, i.status, i.reported_date, i.origin, i.stale
        FROM claude_known_issues i
        LEFT JOIN claude_session_logs s ON s.id = i.reported_session_id
        WHERE i.status IN ('open','in_progress') AND i.issue_type = 'defect'
          AND i.severity IN ('critical','high')
        ORDER BY (coalesce(s.date_confidence,'exact') = 'write_date') ASC,
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
                                       ORDER BY session_date DESC, created_at DESC LIMIT 1)
          AND coalesce(s.date_confidence,'exact') <> 'write_date'
          AND p.session_date >= CURRENT_DATE - 14
          AND p.status IN ('open','blocked')
          AND (p.kind = 'next_step' OR coalesce(p.item_type,'') IN ('action_needed','open_question','decision_needed','blocked','build_needed'))
        ORDER BY p.session_date DESC, p.source_session_id DESC, p.priority NULLS LAST, p.id
        LIMIT 20) r),

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
        (SELECT count(*) FROM claude_decision_log WHERE status = 'active') AS active_decisions,
        (SELECT count(*) FROM claude_session_logs) AS sessions) c)
  );
$$;

-- ─── Verification ───────────────────────────────────────────────────────────
-- Expected after apply (2026-09-07): last_session is an 'exact' row (not one of
-- 705–781), open_issues_priority no longer starts with issues reported by
-- sessions 705–781, pack size still 25–40k characters.
--
-- SELECT json_agg(row_to_json(v)) FROM (
--   SELECT
--     (SELECT date_confidence FROM claude_session_logs
--       WHERE id = (claude_memory_context('memory system')->'last_session'->>'id')::int) AS last_session_confidence,  -- 'exact'
--     (SELECT count(*) FROM jsonb_array_elements(claude_memory_context(NULL)->'open_issues_priority') e
--        JOIN claude_known_issues i ON i.id = (e->>'id')::int
--        JOIN claude_session_logs s ON s.id = i.reported_session_id
--       WHERE s.date_confidence = 'write_date') AS write_date_issues_in_top25,          -- 0 unless exact rows run out
--     length(claude_memory_context('memory system')::text) AS pack_chars                -- 25000-40000
-- ) v;
