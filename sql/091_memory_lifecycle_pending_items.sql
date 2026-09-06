-- ─── 091 — Memory lifecycle: issue triage columns, decision status, pending items ─
--
-- Second migration of the Reece Memory System Optimization plan (sql/090 was
-- the first). Priorities #4 (issue-tracker triage) and #5 (lifecycle fields +
-- a pending-items table) both ran on 2026-09-05; this file is the record of
-- every column and table they added. Everything here was applied to Reece
-- Lead Perfection Sync (rcjcgjlqzepicbwhnnjl) the same day through the LP MCP
-- supabase_run_query tool (memory-project ground rule 5), statement by
-- statement, after Mark approved each batch. Do NOT re-apply: every statement
-- is idempotent, but the data updates the triage performed are NOT in this
-- file — they were one-time, approved marks (17 duplicates, 18 reclassified,
-- 5 resolved, 1 wont_fix, 601 stale flags) and are documented in
-- claude_session_logs #697.
--
-- Design rule carried from the audit: MARK, NEVER DELETE. Every change below
-- adds a status, a flag, or a pointer. No row was removed.
--
-- ─── A. claude_known_issues — triage columns ────────────────────────────────
--
--   merged_into        the surviving row when this one is a duplicate. The
--                      duplicate keeps its own date, text and session link;
--                      status becomes 'duplicate'. Keep rule: live beats retro;
--                      otherwise highest severity, then most complete text.
--   issue_type         'defect' (default) | 'initiative' (a build/plan item
--                      that was filed as an issue) | 'metric' (a measurement,
--                      not a problem). Only 'defect' rows count as open issues
--                      in claude_memory_context(); initiatives keep status
--                      'open' but leave the defect list; metrics are archived.
--   verified_at        when a human or a code check last confirmed the row's
--                      state — resolved OR still-open. Activity is not
--                      verification: the stale sweep looks at this column.
--   verification_note  one line saying what proved it (file, PR, live check).
--   stale              open defect, no verified_at, untouched 60+ days
--                      ('untouched' = updated_at for live rows, reported_date
--                      for retro rows, whose updated_at is only the promotion
--                      timestamp). A flag, never a status. Cleared by setting
--                      verified_at, not by editing the row.
--
-- Status vocabulary after this migration (plain TEXT, sql/051 convention):
--   open · in_progress · resolved · duplicate · wont_fix · archived

ALTER TABLE claude_known_issues
  ADD COLUMN IF NOT EXISTS merged_into       integer REFERENCES claude_known_issues(id),
  ADD COLUMN IF NOT EXISTS issue_type        text    NOT NULL DEFAULT 'defect',
  ADD COLUMN IF NOT EXISTS verified_at       timestamptz,
  ADD COLUMN IF NOT EXISTS verification_note text,
  ADD COLUMN IF NOT EXISTS stale             boolean NOT NULL DEFAULT false;

-- ─── B. claude_decision_log — lifecycle ─────────────────────────────────────
--
--   status         'active' (default) | 'superseded' | 'rejected'. A superseded
--                  decision stays so "why did we change our mind" remains
--                  answerable; claude_memory_context() lists active only.
--   superseded_by  the decision that replaced it.
--   verified_at    when Mark last re-confirmed the decision. The 20 decisions
--                  ratified from the Unconfirmed Decisions review (ids 795-814)
--                  carry 2026-09-05.

ALTER TABLE claude_decision_log
  ADD COLUMN IF NOT EXISTS status        text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS superseded_by integer REFERENCES claude_decision_log(id),
  ADD COLUMN IF NOT EXISTS verified_at   timestamptz;

-- ─── C. claude_pending_items — open work gets a lifecycle ───────────────────
--
-- Before this table, pending items and next steps lived only inside the
-- session row that wrote them (1,550 + 1,304 JSON elements across 690
-- sessions, 373 with no type, nothing ever marked done). One row per item,
-- migrated from every session (see the INSERT ... SELECT pattern in the
-- 2026-09-05 session log; not repeated here because it is a one-time data
-- move, and re-running it is a no-op thanks to the UNIQUE constraint).
--
--   source_session_id / source_field / source_index
--                  provenance: which session, which JSON array
--                  ('pending_items' | 'next_steps' for migrated rows,
--                  'live' for rows written by the v4 skill), which position.
--   kind           'pending' | 'next_step'
--   item_type      action_needed · decision_needed · verification_needed ·
--                  open_question · build_needed · unconfirmed_decision ·
--                  next_step · (null for the 373 untyped migrated rows)
--   status         open (default) · blocked · deferred · done · dropped ·
--                  superseded · ratified. Free-text statuses found in the
--                  JSON were normalised on migration; the original element is
--                  kept whole in `raw`.
--   resolved_session_id
--                  the session that closed it (source_session_id never
--                  changes).
--   raw            the original JSON element, untouched, for provenance.
--
-- The session row's pending_items / next_steps columns are NOT dropped — the
-- 690 pre-v4 rows keep them as provenance — but the reece-session-continuity
-- skill (v4) writes '[]' there and inserts rows here instead.

CREATE TABLE IF NOT EXISTS claude_pending_items (
  id                  serial PRIMARY KEY,
  source_session_id   integer NOT NULL REFERENCES claude_session_logs(id),
  source_field        text    NOT NULL,
  source_index        integer NOT NULL,
  kind                text    NOT NULL,
  item_type           text,
  description         text    NOT NULL,
  status              text    NOT NULL DEFAULT 'open',
  priority            integer,
  effort              text,
  blocked_by          text,
  ref                 text,
  workflow_id         text,
  options             jsonb,
  owner               text,
  ruling              text,
  ruled_on            date,
  ruled_by            text,
  origin              text    NOT NULL,
  session_date        date    NOT NULL,
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  resolved_session_id integer REFERENCES claude_session_logs(id),
  raw                 jsonb,
  UNIQUE (source_session_id, source_field, source_index)
);

CREATE INDEX IF NOT EXISTS idx_claude_pending_status_date
  ON claude_pending_items (status, session_date DESC);

-- ─── D. claude_memory_context() v3 ──────────────────────────────────────────
--
-- Changes from the sql/090 version:
--   - last_session.open_items and open_pending_recent read claude_pending_items
--     (status open / blocked / deferred), not the session JSON.
--   - open_issues_priority and every issue count filter issue_type = 'defect';
--     fresh rows rank above stale ones.
--   - decisions_30d lists status = 'active' only.
--   - counts adds open_issues_fresh, open_initiatives, open_pending_items,
--     open_pending_items_30d, active_decisions.
-- Measured 2026-09-05 after apply: 34,514 characters (~8.6k tokens).
-- claude_memory_search() is unchanged from sql/090.

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
        FROM claude_session_logs l ORDER BY l.created_at DESC LIMIT 1) s),

    'recent_sessions', (SELECT jsonb_agg(r) FROM (
        SELECT id, session_date, session_title
        FROM claude_session_logs ORDER BY created_at DESC OFFSET 1 LIMIT 5) r),

    'open_issues_priority', (SELECT jsonb_agg(r) FROM (
        SELECT id, severity, category, left(description, 220) AS description,
               workflow_name, status, reported_date, origin, stale
        FROM claude_known_issues
        WHERE status IN ('open','in_progress') AND issue_type = 'defect'
          AND severity IN ('critical','high')
        ORDER BY (origin = 'live') DESC, stale ASC,
                 CASE severity WHEN 'critical' THEN 1 ELSE 2 END,
                 updated_at DESC
        LIMIT 25) r),

    'decisions_30d', (SELECT jsonb_agg(r) FROM (
        SELECT id, decision_date, category, left(decision, 240) AS decision, origin, status
        FROM claude_decision_log
        WHERE decision_date >= CURRENT_DATE - 30 AND status = 'active'
        ORDER BY decision_date DESC, id DESC LIMIT 25) r),

    'resolved_30d', (SELECT jsonb_agg(r) FROM (
        SELECT id, severity, left(description, 160) AS description, resolved_date
        FROM claude_known_issues
        WHERE status = 'resolved' AND resolved_date >= CURRENT_DATE - 30
        ORDER BY resolved_date DESC, id DESC LIMIT 15) r),

    'open_pending_recent', (SELECT jsonb_agg(r) FROM (
        SELECT p.id, p.source_session_id AS session_id, p.session_date, p.kind, p.item_type AS type,
               p.status, p.priority, left(p.description, 180) AS description
        FROM claude_pending_items p
        WHERE p.source_session_id <> (SELECT id FROM claude_session_logs ORDER BY created_at DESC LIMIT 1)
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

-- NOT mirrored in runMigrations() — same reasoning as sql/051 and sql/090:
-- LP-MCP's request path has no stake in the claude_* tables until the
-- priority #8 memory MCP tools ship, which is when 090 + 091 get mirrored
-- together.
--
-- ROLLBACK: DROP TABLE claude_pending_items; ALTER TABLE claude_known_issues
-- DROP COLUMN merged_into, issue_type, verified_at, verification_note, stale;
-- ALTER TABLE claude_decision_log DROP COLUMN status, superseded_by,
-- verified_at; then re-run the sql/090 CREATE OR REPLACE for
-- claude_memory_context(). Rolling back the columns discards the triage marks
-- — archive them first.
--
-- ─── Verification ───────────────────────────────────────────────────────────
-- SELECT json_agg(row_to_json(v)) FROM (
--   SELECT
--     (SELECT count(*) FROM claude_pending_items) AS pending_rows,           -- 2854 on 2026-09-05
--     (SELECT count(*) FROM claude_known_issues WHERE status='duplicate') AS dups,   -- 18
--     (SELECT count(*) FROM claude_known_issues WHERE stale) AS stale_rows,  -- 601
--     (SELECT count(*) FROM claude_decision_log WHERE verified_at IS NOT NULL) AS verified_decisions, -- 20
--     length(claude_memory_context('memory system')::text) AS pack_chars    -- 30000-40000
-- ) v;
