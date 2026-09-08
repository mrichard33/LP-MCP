-- ─── 098 — Memory integrity: provenance guard, conflicts, validation log ────
--
-- WHY. The 2026-09-06/07 Cowork sweep wrote ~80 checkpoints for chats that
-- happened in March–April. The write door let three things through at once:
-- rows stamped log_origin='live' for work that was reconstructed, session_date
-- defaulted to the write date, and no chat_url / ledger row even though the
-- sweep had found every chat through search. Everything downstream (the pack,
-- embeddings, the digest, auto-close clocks) faithfully reflected bad inputs.
-- Fix at the door, not after the fact: a memory row must prove where it came
-- from before it is allowed in.
--
-- WHAT (all additive; every statement idempotent; nothing dropped or deleted):
--   A. columns   claude_session_logs.source_chat_updated_at / validation_status /
--                validation_notes; claude_decision_log.date_confidence /
--                conflict_group_id; claude_known_issues.date_confidence;
--                claude_memory_embeddings.date_confidence / stale_embedding.
--   B. tables    claude_memory_conflicts (pairs for Mark to rule on) and
--                claude_memory_validation_log (one row per nightly check).
--   C. triggers  claude_guard_session_insert() on claude_session_logs — a retro
--                row must carry chat_url + source_chat_updated_at; 3+ 'live'
--                rows in 5 minutes is the sweep pattern and the 4th onward is
--                relabelled retro / write_date / flagged (marked, never
--                rejected). claude_inherit_provenance() on claude_decision_log
--                and claude_known_issues copies origin / confidence /
--                date_confidence from the parent session when the caller left
--                them at their defaults.
--   D. search    match_memory_embeddings(): closed / superseded / duplicate /
--                expired / wont_fix rows are EXCLUDED BY DEFAULT
--                (include_closed = false; same parameter name as sql/094 so
--                memory-search.js keeps working) and every hit carries
--                date_confidence so the Node ranker can weight provenance.
--                claude_memory_search() gains p_include_closed (default false)
--                and returns the real decision status.
--   E. pack      claude_memory_context() v5: write_date demotion extended from
--                sessions (sql/097) to the decisions' and issues' own
--                date_confidence; open conflicts and integrity counts added.
--
-- GUARD MODE. MEMORY_GUARD_MODE (off | shadow | live, code default shadow) is
-- read by the TOOL layer (src/memory/memory-checkpoint.js) before the insert:
-- shadow logs would-be rejections to claude_memory_validation_log and lets the
-- write through; live rejects. The triggers here stay simple and always on:
-- the retro rule is a hard provenance requirement (no mode can make a retro
-- row without a source acceptable) and the batch rule only relabels.
--
-- Apply through the LP MCP supabase_run_query tool AFTER Mark approves the
-- statement (memory-project ground rule 5). Mirrored in
-- src/memory/memory-migrations.js as a presence check (trigger + table).
--
-- TWO DROP FUNCTION STATEMENTS, on purpose (section D). Postgres cannot change
-- a function's RETURNS TABLE shape (match_memory_embeddings gains
-- date_confidence) or its argument list (claude_memory_search gains
-- p_include_closed) with CREATE OR REPLACE — the old signature has to go
-- first, or the two-argument call becomes ambiguous. Both are recreated in
-- the same file; no data is involved. When applying statement by statement
-- through the MCP tool, those two need confirm_destructive: true.
--
-- ROLLBACK (no data loss): DROP TRIGGER trg_claude_guard_session_insert ON
-- claude_session_logs; DROP TRIGGER trg_claude_inherit_provenance ON
-- claude_decision_log and claude_known_issues; set MEMORY_GUARD_MODE=off;
-- re-run sql/094 section match_memory_embeddings and sql/097 section B for the
-- pack; sql/090 section B for claude_memory_search. Columns and tables are
-- harmless if left in place.

-- ─── A. Columns ──────────────────────────────────────────────────────────────

ALTER TABLE claude_session_logs
  ADD COLUMN IF NOT EXISTS source_chat_updated_at timestamptz,               -- from the search result that produced a retro row
  ADD COLUMN IF NOT EXISTS validation_status      text NOT NULL DEFAULT 'unchecked',  -- unchecked | passed | flagged
  ADD COLUMN IF NOT EXISTS validation_notes       jsonb;

ALTER TABLE claude_decision_log
  ADD COLUMN IF NOT EXISTS date_confidence   text NOT NULL DEFAULT 'exact',   -- exact | write_date
  ADD COLUMN IF NOT EXISTS conflict_group_id integer;

ALTER TABLE claude_known_issues
  ADD COLUMN IF NOT EXISTS date_confidence text NOT NULL DEFAULT 'exact';

ALTER TABLE claude_memory_embeddings
  ADD COLUMN IF NOT EXISTS date_confidence text,                             -- synced nightly from the source row
  ADD COLUMN IF NOT EXISTS stale_embedding boolean NOT NULL DEFAULT false;    -- source row gone; never deleted, just hidden

CREATE INDEX IF NOT EXISTS idx_claude_sessions_validation ON claude_session_logs (validation_status);
CREATE INDEX IF NOT EXISTS idx_claude_sessions_live_recent ON claude_session_logs (created_at DESC) WHERE log_origin = 'live';

-- ─── B. Tables ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS claude_memory_conflicts (
  id          serial PRIMARY KEY,
  kind        text NOT NULL,                     -- decision | issue
  row_a       integer NOT NULL,
  row_b       integer NOT NULL,                  -- row_a < row_b, always
  similarity  real NOT NULL,                     -- cosine on claude_memory_embeddings
  detected_at timestamptz DEFAULT now(),
  status      text NOT NULL DEFAULT 'open',      -- open | a_supersedes_b | b_supersedes_a | not_a_conflict | merged
  ruled_by    text,
  ruled_at    timestamptz,
  UNIQUE (kind, row_a, row_b)
);
CREATE INDEX IF NOT EXISTS idx_claude_memory_conflicts_status ON claude_memory_conflicts (status, detected_at DESC);

CREATE TABLE IF NOT EXISTS claude_memory_validation_log (
  id           serial PRIMARY KEY,
  ran_at       timestamptz DEFAULT now(),
  check_name   text NOT NULL,
  mode         text,                             -- shadow | live | nightly | dry_run
  rows_checked integer,
  rows_flagged integer,
  sample       jsonb,
  notes        text
);
CREATE INDEX IF NOT EXISTS idx_claude_memory_validation_log_ran_at ON claude_memory_validation_log (ran_at DESC);

-- ─── C. Provenance guard triggers ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION claude_guard_session_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  recent_live integer;
BEGIN
  -- retro rows must say where they came from
  IF NEW.log_origin = 'retro' AND (NEW.chat_url IS NULL OR NEW.source_chat_updated_at IS NULL) THEN
    RAISE EXCEPTION 'retro session requires chat_url and source_chat_updated_at'
      USING ERRCODE = 'check_violation';
  END IF;
  -- a "live" row dated today, arriving in a burst, is the sweep pattern
  IF NEW.log_origin = 'live' AND NEW.session_date = CURRENT_DATE THEN
    SELECT count(*) INTO recent_live FROM claude_session_logs
     WHERE log_origin = 'live' AND created_at > now() - interval '5 minutes';
    IF recent_live >= 3 THEN                    -- 3+ live checkpoints in 5 min = batch, not a session
      NEW.log_origin        := 'retro';
      NEW.date_confidence   := 'write_date';
      NEW.validation_status := 'flagged';
      NEW.validation_notes  := coalesce(NEW.validation_notes, '{}'::jsonb)
                               || jsonb_build_object('reason', 'batch_pattern_relabeled',
                                                     'live_rows_last_5_min', recent_live,
                                                     'at', now());
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER trg_claude_guard_session_insert
  BEFORE INSERT ON claude_session_logs
  FOR EACH ROW EXECUTE FUNCTION claude_guard_session_insert();

-- Children inherit the parent's provenance when the caller left the defaults
-- (origin 'live', confidence 'confirmed', date_confidence 'exact'). An explicit
-- non-default value — e.g. a retro decision that quotes Mark and is therefore
-- confidence='confirmed' with origin='retro' — is left alone.
CREATE OR REPLACE FUNCTION claude_inherit_provenance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  j jsonb := to_jsonb(NEW);
  parent_id integer;
  p_origin text; p_date_conf text;
BEGIN
  parent_id := CASE TG_TABLE_NAME
                 WHEN 'claude_decision_log' THEN (j->>'session_id')::int
                 WHEN 'claude_known_issues' THEN (j->>'reported_session_id')::int
               END;
  IF parent_id IS NULL THEN RETURN NEW; END IF;
  SELECT log_origin, date_confidence INTO p_origin, p_date_conf
    FROM claude_session_logs WHERE id = parent_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF p_origin = 'retro' AND coalesce(NEW.origin, 'live') = 'live' THEN
    NEW.origin := 'retro';
    IF coalesce(NEW.confidence, 'confirmed') = 'confirmed' THEN NEW.confidence := 'reconstructed'; END IF;
  END IF;
  IF p_date_conf = 'write_date' AND coalesce(NEW.date_confidence, 'exact') = 'exact' THEN
    NEW.date_confidence := 'write_date';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER trg_claude_inherit_provenance
  BEFORE INSERT ON claude_decision_log
  FOR EACH ROW EXECUTE FUNCTION claude_inherit_provenance();
CREATE OR REPLACE TRIGGER trg_claude_inherit_provenance
  BEFORE INSERT ON claude_known_issues
  FOR EACH ROW EXECUTE FUNCTION claude_inherit_provenance();

-- ─── D. Search: hide closed rows by default, expose date_confidence ──────────
-- Same parameter names as sql/094 (memory-search.js calls them by name); only
-- the include_closed default flips to false and the closed set grows. History
-- stays searchable with include_closed = true; it just stops outranking current
-- truth. status = 'duplicate' and stale_embedding rows are never returned.

DROP FUNCTION IF EXISTS match_memory_embeddings(vector, float8, integer, text, text, boolean);
CREATE OR REPLACE FUNCTION match_memory_embeddings (
  query_embedding vector(1536),
  match_threshold FLOAT8  DEFAULT 0.30,
  match_count     INTEGER DEFAULT 20,
  filter_area     TEXT    DEFAULT NULL,
  filter_kind     TEXT    DEFAULT NULL,   -- decision | issue | session | pending
  include_closed  BOOLEAN DEFAULT false
)
RETURNS TABLE (
  kind TEXT, source_id INTEGER, text TEXT, area TEXT, origin TEXT, status TEXT,
  severity TEXT, category TEXT, row_date DATE, similarity FLOAT8, date_confidence TEXT
)
LANGUAGE sql STABLE AS $$
  SELECT
    CASE e.source_table
      WHEN 'claude_decision_log'  THEN 'decision'
      WHEN 'claude_known_issues'  THEN 'issue'
      WHEN 'claude_session_logs'  THEN 'session'
      WHEN 'claude_pending_items' THEN 'pending' END AS kind,
    e.source_id, left(e.embedded_text, 300) AS text, e.area, e.origin, e.status,
    e.severity, e.category, e.row_date,
    1 - (e.embedding <=> query_embedding) AS similarity,
    coalesce(e.date_confidence, 'exact') AS date_confidence
  FROM claude_memory_embeddings e
  WHERE coalesce(e.status,'') <> 'duplicate'
    AND NOT e.stale_embedding
    AND (filter_area IS NULL OR e.area = filter_area)
    AND (filter_kind IS NULL OR e.source_table = CASE filter_kind
          WHEN 'decision' THEN 'claude_decision_log'
          WHEN 'issue'    THEN 'claude_known_issues'
          WHEN 'session'  THEN 'claude_session_logs'
          WHEN 'pending'  THEN 'claude_pending_items' END)
    AND (include_closed OR coalesce(e.status,'') NOT IN
          ('superseded','rejected','resolved','done','dropped','archived','expired','wont_fix'))
    AND (1 - (e.embedding <=> query_embedding)) >= match_threshold
  ORDER BY e.embedding <=> query_embedding
  LIMIT greatest(1, least(coalesce(match_count, 20), 100));
$$;

-- claude_memory_search(query, limit, include_closed). The two-argument call
-- claude_memory_context() makes still resolves (default false). Decisions now
-- return their real status (sql/090 returned NULL) so the fuser can weight it.
DROP FUNCTION IF EXISTS claude_memory_search(text, integer);
CREATE OR REPLACE FUNCTION claude_memory_search(p_query text, p_limit integer DEFAULT 20, p_include_closed boolean DEFAULT false)
RETURNS TABLE (
  kind text, id integer, date date, text text, origin text, status text,
  category text, session_id integer, rank real
)
LANGUAGE sql STABLE AS $$
  SELECT m.kind, m.id, m.date, m.text, m.origin, m.status, m.category, m.session_id, m.rank
  FROM (
    SELECT 'decision'::text AS kind, d.id, d.decision_date AS date,
           left(d.decision, 300) AS text, d.origin, d.status,
           d.category, d.session_id,
           (ts_rank(to_tsvector('english', coalesce(d.decision,'') || ' ' || coalesce(d.rationale,'')),
                    websearch_to_tsquery('english', p_query))
            + CASE WHEN d.decision ILIKE '%' || p_query || '%' THEN 0.5 ELSE 0 END)::real AS rank
    FROM claude_decision_log d
    WHERE (to_tsvector('english', coalesce(d.decision,'') || ' ' || coalesce(d.rationale,''))
            @@ websearch_to_tsquery('english', p_query)
       OR d.decision ILIKE '%' || p_query || '%')
      AND (p_include_closed OR coalesce(d.status,'active') NOT IN ('superseded','rejected','duplicate','expired'))
    UNION ALL
    SELECT 'issue', i.id, i.reported_date,
           left(i.description, 300), i.origin, i.status,
           i.category, i.reported_session_id,
           (ts_rank(to_tsvector('english', coalesce(i.description,'') || ' ' || coalesce(i.impact,'')),
                    websearch_to_tsquery('english', p_query))
            + CASE WHEN i.description ILIKE '%' || p_query || '%' THEN 0.5 ELSE 0 END)::real
    FROM claude_known_issues i
    WHERE (to_tsvector('english', coalesce(i.description,'') || ' ' || coalesce(i.impact,''))
            @@ websearch_to_tsquery('english', p_query)
       OR i.description ILIKE '%' || p_query || '%')
      AND (p_include_closed OR coalesce(i.status,'open') NOT IN ('duplicate','wont_fix','archived','expired'))
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

-- ─── E. claude_memory_context() v5 ──────────────────────────────────────────
-- sql/097 v4 copied verbatim, with ONLY these edits:
--   1. open_issues_priority   the issue's OWN date_confidence joins the session's
--                             as the first sort key (write_date rows last).
--   2. decisions_30d          decisions whose own date_confidence = 'write_date'
--                             are dropped along with those from write_date
--                             sessions.
--   3. open_conflicts         up to 5 open rows from claude_memory_conflicts
--                             (kind, ids, similarity) so a session start sees
--                             what is waiting on a ruling.
--   4. counts                 adds open_conflicts, unlinked_sessions,
--                             write_date_sessions, flagged_sessions.
-- Everything else is unchanged from sql/097.

CREATE OR REPLACE FUNCTION claude_memory_context(p_topic text DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'generated_at', now(),
    'topic', p_topic,
    'how_to_read', 'Ranked pack, ~8k tokens. counts shows what is NOT here. For anything else use claude_memory_search(query). Pending work lives in claude_pending_items; close items with UPDATE, never re-paste. open_conflicts need a ruling (memory_precheck shows the pair).',

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
                                       ORDER BY session_date DESC, created_at DESC LIMIT 1)
          AND coalesce(s.date_confidence,'exact') <> 'write_date'
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
        (SELECT count(*) FROM claude_decision_log WHERE status = 'active') AS active_decisions,
        (SELECT count(*) FROM claude_session_logs) AS sessions,
        (SELECT count(*) FROM claude_memory_conflicts WHERE status = 'open') AS open_conflicts,
        (SELECT count(*) FROM claude_session_logs WHERE chat_url IS NULL) AS unlinked_sessions,
        (SELECT count(*) FROM claude_session_logs WHERE date_confidence = 'write_date') AS write_date_sessions,
        (SELECT count(*) FROM claude_session_logs WHERE validation_status = 'flagged') AS flagged_sessions) c)
  );
$$;

-- ─── Verification ───────────────────────────────────────────────────────────
-- SELECT json_agg(row_to_json(v)) FROM (
--   SELECT
--     (SELECT count(*) FROM pg_trigger WHERE tgname IN ('trg_claude_guard_session_insert','trg_claude_inherit_provenance')) AS triggers,  -- 3
--     (SELECT count(*) FROM information_schema.tables WHERE table_name IN ('claude_memory_conflicts','claude_memory_validation_log')) AS tables, -- 2
--     (SELECT count(*) FROM information_schema.columns WHERE table_name='claude_session_logs'
--        AND column_name IN ('source_chat_updated_at','validation_status','validation_notes')) AS session_cols,                          -- 3
--     (SELECT count(*) FROM pg_proc WHERE proname='claude_memory_search' AND pronargs = 3) AS search_fn,                                  -- 1
--     (SELECT date_confidence FROM claude_session_logs
--        WHERE id = (claude_memory_context('memory system')->'last_session'->>'id')::int) AS last_session_confidence,                    -- 'exact'
--     length(claude_memory_context('memory system')::text) AS pack_chars                                                                  -- 25000-40000
-- ) v;
--
-- Guard smoke test (inside a transaction, then ROLLBACK):
--   INSERT INTO claude_session_logs (session_title, log_origin) VALUES ('x','retro');
--   → ERROR: retro session requires chat_url and source_chat_updated_at
