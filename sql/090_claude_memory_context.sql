-- ─── 090 — Ranked session-start context pack for the Claude memory tables ───
--
-- The reece-session-continuity skill opened every session with three queries,
-- the second of which was "load ALL open issues". After the 2026-09-06 retro
-- promotion (856 decisions + 892 issues written from session JSON into the log
-- tables, tagged origin='retro') that dump measures 637,561 characters
-- (~160k tokens) — larger than a context window. Even before promotion it was
-- ~342k characters (~85k tokens) on every session start.
--
-- This migration replaces the three-query start with ONE call that returns a
-- ranked, size-capped pack (~33k characters ≈ 8k tokens, measured 2026-09-06):
--
--   last_session          the newest checkpoint: summary (1,500 chars), next
--                         steps, and its pending items that carry no closing
--                         status (done / dropped / ratified / superseded /
--                         resolved)
--   recent_sessions       the five checkpoints before it — id, date, title
--   open_issues_priority  top 25 open critical/high issues. Live rows rank
--                         above retro (reconstructed) rows, then by severity,
--                         then most recently touched. Retro rows surface here
--                         only once live critical/high drops below 25 — until
--                         priority #4 triages them they are visible through
--                         counts and topic search, not the default list.
--   decisions_30d         up to 25 decisions dated in the last 30 days (retro
--                         rows included — they carry the chat's real date)
--   resolved_30d          up to 15 issues resolved in the last 30 days
--   open_pending_recent   action / question / decision / blocked pending items
--                         from the last 14 days of OTHER sessions, still open
--   topic_matches         up to 20 full-text hits across decisions, issues and
--                         session summaries for the caller's topic (NULL when
--                         no topic is passed)
--   counts                what the pack did NOT include — open issues total /
--                         live / critical / high, decisions, sessions — so the
--                         reader knows the size of the rest and reaches for
--                         claude_memory_search() instead of assuming
--
-- The pack is read-only, STABLE, and touches no row. Nothing about the old
-- queries is removed; the skill simply stops calling them at session start.
--
-- Full-text search is the second half of this file. Retrieval on these tables
-- was ILIKE '%keyword%' only — no index, no ranking, no paraphrase tolerance.
-- Three GIN indexes on to_tsvector('english', …) make ranked search free, and
-- claude_memory_search() exposes it. The expressions inside the indexes are
-- repeated verbatim inside both functions so the planner can use them.
--
-- Vocabulary for origin / confidence (added 2026-09-06 during the retro
-- promotion) follows the sql/051 convention: plain TEXT, no CHECK constraint.
--   origin       'live' (written during the session) | 'retro' (promoted from
--                a reconstructed checkpoint's JSON)
--   confidence   'confirmed' | 'reconstructed'
--
-- Applied to Reece Lead Perfection Sync (rcjcgjlqzepicbwhnnjl) on 2026-09-06
-- via the LP MCP supabase_run_query tool (memory-project ground rule 5).
-- NOT mirrored in runMigrations() — same reasoning as sql/051: LP-MCP's request
-- path has no stake in the claude_* tables. Priority #8 of the memory plan
-- (memory_context / memory_search MCP tools) will wrap these two functions;
-- that is the point at which they become boot-critical and get mirrored.
--
-- ROLLBACK: DROP FUNCTION claude_memory_context(text); DROP FUNCTION
-- claude_memory_search(text, integer); DROP INDEX idx_claude_decision_fts,
-- idx_claude_issues_fts, idx_claude_sessions_fts. No data changes to undo.

-- ─── A. Full-text indexes ────────────────────────────────────────────────────
-- Plain CREATE INDEX (not CONCURRENTLY): 685 / 1,668 / 1,624 rows, sub-second.

CREATE INDEX IF NOT EXISTS idx_claude_decision_fts
  ON claude_decision_log
  USING gin (to_tsvector('english', coalesce(decision,'') || ' ' || coalesce(rationale,'')));

CREATE INDEX IF NOT EXISTS idx_claude_issues_fts
  ON claude_known_issues
  USING gin (to_tsvector('english', coalesce(description,'') || ' ' || coalesce(impact,'')));

CREATE INDEX IF NOT EXISTS idx_claude_sessions_fts
  ON claude_session_logs
  USING gin (to_tsvector('english', coalesce(session_title,'') || ' ' || coalesce(raw_summary,'')));

-- ─── B. claude_memory_search(query, limit) ───────────────────────────────────
-- Ranked full-text search across all three tables. websearch_to_tsquery accepts
-- plain phrases ("appointment title"), quoted phrases, and -exclusions. Exact
-- tokens that the English parser mangles (S4.5, 8e30ff37, file names) are
-- caught by the ILIKE fallback on the primary text column, so a canonical code
-- still finds its rows.

CREATE OR REPLACE FUNCTION claude_memory_search(p_query text, p_limit integer DEFAULT 20)
RETURNS TABLE (
  kind text, id integer, date date, text text, origin text, status text,
  category text, session_id integer, rank real
)
LANGUAGE sql STABLE AS $$
  SELECT m.kind, m.id, m.date, m.text, m.origin, m.status, m.category, m.session_id, m.rank
  FROM (
    SELECT 'decision'::text AS kind, d.id, d.decision_date AS date,
           left(d.decision, 300) AS text, d.origin, NULL::text AS status,
           d.category, d.session_id,
           (ts_rank(to_tsvector('english', coalesce(d.decision,'') || ' ' || coalesce(d.rationale,'')),
                    websearch_to_tsquery('english', p_query))
            + CASE WHEN d.decision ILIKE '%' || p_query || '%' THEN 0.5 ELSE 0 END)::real AS rank
    FROM claude_decision_log d
    WHERE to_tsvector('english', coalesce(d.decision,'') || ' ' || coalesce(d.rationale,''))
            @@ websearch_to_tsquery('english', p_query)
       OR d.decision ILIKE '%' || p_query || '%'
    UNION ALL
    SELECT 'issue', i.id, i.reported_date,
           left(i.description, 300), i.origin, i.status,
           i.category, i.reported_session_id,
           (ts_rank(to_tsvector('english', coalesce(i.description,'') || ' ' || coalesce(i.impact,'')),
                    websearch_to_tsquery('english', p_query))
            + CASE WHEN i.description ILIKE '%' || p_query || '%' THEN 0.5 ELSE 0 END)::real
    FROM claude_known_issues i
    WHERE to_tsvector('english', coalesce(i.description,'') || ' ' || coalesce(i.impact,''))
            @@ websearch_to_tsquery('english', p_query)
       OR i.description ILIKE '%' || p_query || '%'
    UNION ALL
    SELECT 'session', s.id, s.session_date,
           s.session_title, s.log_origin, NULL,
           s.phase_focus, s.id,
           (ts_rank(to_tsvector('english', coalesce(s.session_title,'') || ' ' || coalesce(s.raw_summary,'')),
                    websearch_to_tsquery('english', p_query))
            + CASE WHEN s.session_title ILIKE '%' || p_query || '%' THEN 0.5 ELSE 0 END)::real
    FROM claude_session_logs s
    WHERE to_tsvector('english', coalesce(s.session_title,'') || ' ' || coalesce(s.raw_summary,''))
            @@ websearch_to_tsquery('english', p_query)
       OR s.session_title ILIKE '%' || p_query || '%'
  ) m
  ORDER BY m.rank DESC, m.date DESC, m.id DESC
  LIMIT greatest(1, least(coalesce(p_limit, 20), 100));
$$;

-- ─── C. claude_memory_context(topic) ─────────────────────────────────────────
-- The session-start pack. Pass the conversation's topic in a few words (or
-- NULL). Returns one jsonb object; the skill wraps the call in json_agg so the
-- MCP tool returns the body rather than a row count.

CREATE OR REPLACE FUNCTION claude_memory_context(p_topic text DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'generated_at', now(),
    'topic', p_topic,
    'how_to_read', 'Ranked pack, ~8k tokens. counts shows what is NOT here. For anything else use claude_memory_search(query).',

    'last_session', (SELECT row_to_json(s) FROM (
        SELECT id, session_date, session_title, phase_focus, surface, log_origin, chat_url,
               left(raw_summary, 1500) AS summary, next_steps,
               (SELECT jsonb_agg(jsonb_build_object(
                          'ref', e->>'ref', 'type', e->>'type',
                          'description', left(e->>'description', 200)))
                  FROM jsonb_array_elements(
                         CASE WHEN jsonb_typeof(pending_items) = 'array'
                              THEN pending_items ELSE '[]'::jsonb END) e
                 WHERE coalesce(e->>'status','') NOT IN ('done','dropped','ratified','superseded','resolved')
               ) AS open_pending_items
        FROM claude_session_logs ORDER BY created_at DESC LIMIT 1) s),

    'recent_sessions', (SELECT jsonb_agg(r) FROM (
        SELECT id, session_date, session_title
        FROM claude_session_logs ORDER BY created_at DESC OFFSET 1 LIMIT 5) r),

    'open_issues_priority', (SELECT jsonb_agg(r) FROM (
        SELECT id, severity, category, left(description, 220) AS description,
               workflow_name, status, reported_date, origin
        FROM claude_known_issues
        WHERE status IN ('open','in_progress') AND severity IN ('critical','high')
        ORDER BY (origin = 'live') DESC,
                 CASE severity WHEN 'critical' THEN 1 ELSE 2 END,
                 updated_at DESC
        LIMIT 25) r),

    'decisions_30d', (SELECT jsonb_agg(r) FROM (
        SELECT id, decision_date, category, left(decision, 240) AS decision, origin
        FROM claude_decision_log
        WHERE decision_date >= CURRENT_DATE - 30
        ORDER BY decision_date DESC, id DESC LIMIT 25) r),

    'resolved_30d', (SELECT jsonb_agg(r) FROM (
        SELECT id, severity, left(description, 160) AS description, resolved_date
        FROM claude_known_issues
        WHERE status = 'resolved' AND resolved_date >= CURRENT_DATE - 30
        ORDER BY resolved_date DESC, id DESC LIMIT 15) r),

    'open_pending_recent', (SELECT jsonb_agg(r) FROM (
        SELECT s.id AS session_id, s.session_date, e->>'type' AS type,
               left(e->>'description', 180) AS description
        FROM claude_session_logs s,
             jsonb_array_elements(
               CASE WHEN jsonb_typeof(s.pending_items) = 'array'
                    THEN s.pending_items ELSE '[]'::jsonb END) e
        WHERE s.id <> (SELECT id FROM claude_session_logs ORDER BY created_at DESC LIMIT 1)
          AND s.session_date >= CURRENT_DATE - 14
          AND coalesce(e->>'status','') NOT IN ('done','dropped','ratified','superseded','resolved')
          AND coalesce(e->>'type','') IN ('action_needed','open_question','decision_needed','blocked')
        ORDER BY s.session_date DESC, s.id DESC LIMIT 20) r),

    'topic_matches', CASE WHEN nullif(trim(p_topic), '') IS NULL THEN NULL ELSE
        (SELECT jsonb_agg(r) FROM (
           SELECT kind, id, date, left(text, 200) AS text, origin, status
           FROM claude_memory_search(p_topic, 20)) r) END,

    'counts', (SELECT row_to_json(c) FROM (SELECT
        (SELECT count(*) FROM claude_known_issues WHERE status IN ('open','in_progress')) AS open_issues,
        (SELECT count(*) FROM claude_known_issues WHERE status IN ('open','in_progress') AND origin = 'live') AS open_issues_live,
        (SELECT count(*) FROM claude_known_issues WHERE status IN ('open','in_progress') AND severity = 'critical') AS open_critical,
        (SELECT count(*) FROM claude_known_issues WHERE status IN ('open','in_progress') AND severity = 'high') AS open_high,
        (SELECT count(*) FROM claude_decision_log) AS decisions,
        (SELECT count(*) FROM claude_session_logs) AS sessions) c)
  );
$$;

-- ─── Verification ───────────────────────────────────────────────────────────
-- Expected after apply (measured 2026-09-06): pack ≈ 31–34k characters, both
-- functions present, three GIN indexes present, all with rank/kind columns.
--
-- SELECT json_agg(row_to_json(v)) FROM (
--   SELECT
--     length(claude_memory_context('memory system')::text) AS pack_chars,
--     (SELECT count(*) FROM claude_memory_search('appointment title', 20)) AS hits,
--     (SELECT count(*) FROM pg_proc WHERE proname IN ('claude_memory_context','claude_memory_search')) AS functions,
--     (SELECT count(*) FROM pg_indexes WHERE indexname IN ('idx_claude_decision_fts','idx_claude_issues_fts','idx_claude_sessions_fts')) AS fts_indexes
-- ) v;
-- → pack_chars between 25000 and 40000, hits > 0, functions = 2, fts_indexes = 3
