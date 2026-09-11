-- ─── 102 — Command Center, Release 1 (Rulings lane) ─────────────────────────
--
-- WHY. About 385 things are waiting on a ruling from Mark right now: 375 open
-- pending items of the four ruling types (decision_needed, unconfirmed_decision,
-- open_question, approval_needed) and 10 open rows in claude_memory_conflicts.
-- Today they get ruled in chat, ten per screen, with no record of WHY and no way
-- to take one back. The ruling (2026-09-10) is:
--
--   Every ruling goes through ONE audited door, writes in ONE transaction, and
--   can be flipped back exactly — nothing is ever erased.
--
-- That door is claude_rule_apply(jsonb) below, wrapped by the memory_rule MCP
-- tool. The dashboard never writes a memory table; it reads the queue view and
-- calls the tool. Chat calls the same tool with via:'chat' and produces an
-- identical record.
--
-- WHAT this file changes, in the order Mark runs it — SIX SEPARATE EXECUTIONS,
-- A through F, in order:
--
--   A. Columns. rec_* (the nightly recommendation) and snooze_until on the three
--      card tables; rollout_stage / built_at / build_item_id / verification_note
--      / ruled_by on claude_decision_log.
--
--      verification_note is ALSO A BUG FIX. memory-checkpoint.js's same_as_id
--      path (re-confirming an existing decision instead of filing a second one)
--      writes verified_at AND verification_note to claude_decision_log — and the
--      table has never had that column. Every same_as_id re-confirmation would
--      have failed on "column verification_note does not exist". Adding the
--      column here fixes that path; no code change is needed for it.
--
--   B. claude_rulings_log — append-only. Every ruling is one row carrying the
--      exact before/after of the columns it changed, which is what makes a flip
--      an exact restore rather than a guess. A trigger rejects DELETE and rejects
--      every UPDATE except setting reversed_by once, from NULL.
--
--   C. claude_card_version(table, id) — the stale-card guard. md5 over ONLY the
--      content and state fields, so writing a recommendation onto an open card
--      never makes a screen someone is looking at "stale".
--
--   D. v_command_center_queue — the Rulings lane, pending items and conflicts in
--      one shape, with the risk-first sort keys precomputed.
--
--   E. Session rules. 'dashboard' joins the surface CHECK; the batch guard skips
--      it (one dashboard session per day legitimately collects many rulings, and
--      3 of them inside 5 minutes is normal, not a sweep); the session-start pack
--      (v7) excludes dashboard sessions from its session slots the same way
--      sql/101 excluded Omi, and gains counts.rulings_open.
--
--      C and D come FIRST on purpose. The pack in E counts the Rulings lane out
--      of v_command_center_queue, the view is built on claude_card_version, and
--      Postgres validates a SQL-language function body's references at CREATE
--      time (check_function_bodies). Applied in the other order, E fails with
--      "relation v_command_center_queue does not exist".
--
--   F. claude_rule_apply(jsonb) — the atomic writer. One ruling, one transaction:
--      the daily session, the stale check, the writes, the log row.
--
-- Every statement is additive and idempotent. No column is dropped, no row is
-- rewritten, no existing memory row changes meaning. The only DROP is of a CHECK
-- constraint, immediately re-added wider.
--
-- HOW TO APPLY. Supabase dashboard → SQL editor on the LP instance
-- (rcjcgjlqzepicbwhnnjl), as SIX separate executions, in order: A, B, C, D, E, F.
-- The verification query is at the bottom.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS claude_rule_apply(jsonb);
--   DROP VIEW     IF EXISTS v_command_center_queue;
--   DROP FUNCTION IF EXISTS claude_card_version(text, integer);
--   DROP TRIGGER  IF EXISTS trg_claude_rulings_log_append_only ON claude_rulings_log;
--   -- claude_rulings_log and the added columns should NOT be rolled back: the
--   -- log is the audit trail, and verification_note fixes shipped code.
--   -- Re-apply sql/101's pack definition to revert C.

-- ═══ A. Columns ════════════════════════════════════════════════════════════
-- Additive only. Every column is nullable with no default, so no table rewrite
-- and no existing row changes.

ALTER TABLE claude_pending_items
  ADD COLUMN IF NOT EXISTS rec_verdict text,
  ADD COLUMN IF NOT EXISTS rec_reason text,
  ADD COLUMN IF NOT EXISTS rec_evidence jsonb,
  ADD COLUMN IF NOT EXISTS rec_confidence text,
  ADD COLUMN IF NOT EXISTS rec_risk text,
  ADD COLUMN IF NOT EXISTS rec_group_key text,
  ADD COLUMN IF NOT EXISTS rec_decision_text text,
  ADD COLUMN IF NOT EXISTS rec_category text,
  ADD COLUMN IF NOT EXISTS rec_build_text text,
  ADD COLUMN IF NOT EXISTS rec_source_version text,
  ADD COLUMN IF NOT EXISTS rec_at timestamptz,
  ADD COLUMN IF NOT EXISTS snooze_until date;

ALTER TABLE claude_known_issues
  ADD COLUMN IF NOT EXISTS rec_verdict text,
  ADD COLUMN IF NOT EXISTS rec_reason text,
  ADD COLUMN IF NOT EXISTS rec_evidence jsonb,
  ADD COLUMN IF NOT EXISTS rec_confidence text,
  ADD COLUMN IF NOT EXISTS rec_risk text,
  ADD COLUMN IF NOT EXISTS rec_group_key text,
  ADD COLUMN IF NOT EXISTS rec_source_version text,
  ADD COLUMN IF NOT EXISTS rec_at timestamptz,
  ADD COLUMN IF NOT EXISTS snooze_until date;

ALTER TABLE claude_memory_conflicts
  ADD COLUMN IF NOT EXISTS rec_verdict text,
  ADD COLUMN IF NOT EXISTS rec_reason text,
  ADD COLUMN IF NOT EXISTS rec_evidence jsonb,
  ADD COLUMN IF NOT EXISTS rec_confidence text,
  ADD COLUMN IF NOT EXISTS rec_risk text,
  ADD COLUMN IF NOT EXISTS rec_decision_text text,
  ADD COLUMN IF NOT EXISTS rec_source_version text,
  ADD COLUMN IF NOT EXISTS rec_at timestamptz,
  ADD COLUMN IF NOT EXISTS snooze_until date,
  ADD COLUMN IF NOT EXISTS resolution_decision_id integer;

ALTER TABLE claude_decision_log
  -- NULL = not tracked (every decision that exists today). Only a ruling sets a
  -- stage: decided | built | verified | no_build.
  ADD COLUMN IF NOT EXISTS rollout_stage text,
  ADD COLUMN IF NOT EXISTS built_at timestamptz,
  ADD COLUMN IF NOT EXISTS build_item_id integer,
  -- Also fixes memory-checkpoint.js's same_as_id path — see the header.
  ADD COLUMN IF NOT EXISTS verification_note text,
  ADD COLUMN IF NOT EXISTS ruled_by text;

-- The queue view filters on these three predicates on every load.
CREATE INDEX IF NOT EXISTS idx_claude_pending_rulings_open
  ON claude_pending_items (created_at)
  WHERE status IN ('open','blocked')
    AND item_type IN ('decision_needed','unconfirmed_decision','open_question','approval_needed');
CREATE INDEX IF NOT EXISTS idx_claude_conflicts_open
  ON claude_memory_conflicts (detected_at) WHERE status = 'open';

-- ═══ B. claude_rulings_log — append-only ═══════════════════════════════════
--
-- `changes` is the whole point. It is an array of
--   {table, id, inserted: boolean, before: {col: val} | null, after: {col: val}}
-- carrying ONLY the columns this ruling actually changed. A flip reads it back,
-- checks every listed column still equals `after` (nobody edited the row since),
-- and restores `before`. Rows with inserted:true are withdrawn instead — a
-- decision goes to 'superseded' with a note, a pending item to 'dropped' — because
-- deleting memory is never an option here.

CREATE TABLE IF NOT EXISTS claude_rulings_log (
  id           serial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  ruled_by     text NOT NULL,
  via          text NOT NULL DEFAULT 'dashboard',      -- dashboard | chat
  lane         text NOT NULL,
  action       text NOT NULL,
  target_table text NOT NULL,
  target_id    integer NOT NULL,
  changes      jsonb NOT NULL,
  reason       text,
  reverses_id  integer REFERENCES claude_rulings_log(id),
  -- Set exactly once, by the flip that reverses this row. The only UPDATE the
  -- trigger below allows.
  reversed_by  integer,
  batch_id     uuid,
  session_id   integer,
  decision_id  integer,
  rec_verdict  text
);

CREATE INDEX IF NOT EXISTS idx_rulings_target ON claude_rulings_log (target_table, target_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_rulings_at ON claude_rulings_log (at DESC);

CREATE OR REPLACE FUNCTION claude_rulings_log_append_only()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'claude_rulings_log is append-only: ruling #% cannot be deleted', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- The one permitted UPDATE: a flip claiming the row it reverses.
  IF OLD.reversed_by IS NOT NULL THEN
    RAISE EXCEPTION 'ruling #% is already reversed by #%', OLD.id, OLD.reversed_by
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.reversed_by IS NULL THEN
    RAISE EXCEPTION 'claude_rulings_log is append-only: only reversed_by may be set'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - 'reversed_by') <> (to_jsonb(OLD) - 'reversed_by') THEN
    RAISE EXCEPTION 'claude_rulings_log is append-only: only reversed_by may be set on ruling #%', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_claude_rulings_log_append_only ON claude_rulings_log;
CREATE TRIGGER trg_claude_rulings_log_append_only
  BEFORE UPDATE OR DELETE ON claude_rulings_log
  FOR EACH ROW EXECUTE FUNCTION claude_rulings_log_append_only();

-- ═══ C. claude_card_version(table, id) — the stale-card guard ════════════
--
-- Hashes ONLY the fields that make a card what it is to the person ruling it:
-- its content and its state. Deliberately NOT hashed: the rec_* columns, updated_at,
-- area, priority. The nightly recommendation run writes rec_* onto open cards
-- constantly; if those were in the hash, every card on an open screen would go
-- stale overnight and every ruling the next morning would be rejected.

CREATE OR REPLACE FUNCTION claude_card_version(p_table text, p_id integer)
RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v text;
BEGIN
  IF p_table = 'claude_pending_items' THEN
    SELECT md5(concat_ws('|', status, item_type, description, options::text,
                         snooze_until::text, closed_at::text))
      INTO v FROM claude_pending_items WHERE id = p_id;
  ELSIF p_table = 'claude_known_issues' THEN
    SELECT md5(concat_ws('|', status, description, snooze_until::text, merged_into::text))
      INTO v FROM claude_known_issues WHERE id = p_id;
  ELSIF p_table = 'claude_memory_conflicts' THEN
    SELECT md5(concat_ws('|', status, row_a::text, row_b::text, snooze_until::text))
      INTO v FROM claude_memory_conflicts WHERE id = p_id;
  ELSIF p_table = 'claude_decision_log' THEN
    SELECT md5(concat_ws('|', status, superseded_by::text, decision, rollout_stage))
      INTO v FROM claude_decision_log WHERE id = p_id;
  ELSE
    RAISE EXCEPTION 'bad_input: claude_card_version does not know table %', p_table
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN v;   -- NULL when the row does not exist; callers treat that as stale
END $$;

GRANT EXECUTE ON FUNCTION claude_card_version(text, integer) TO service_role;

-- ═══ D. v_command_center_queue — the Rulings lane ════════════════════════
--
-- (a) pending items of the four ruling types, open or blocked, not snoozed
-- (b) open conflicts, not snoozed, with both sides' text resolved
--
-- The sort keys are computed here rather than in the dashboard so chat and the
-- page agree on what is next. Risk-first:
--   sort_conflict  conflicts before everything (a conflict means memory
--                  currently holds two contradictory truths)
--   sort_risk      money / live_leads / customer_messaging before the rest
--   sort_blocks    how many other open items name this one in blocked_by
--   area_rank      payroll-callcenter, partners-vendors, appointments,
--                  chatbot-lane, scorecard-reporting, then alphabetical
--   created_at     oldest first

CREATE OR REPLACE VIEW v_command_center_queue AS
WITH blocks AS (
  -- How many OPEN items are waiting on each id. blocked_by is free text, so the
  -- match is on the '#<id>' token the checkpoint tool writes, bounded so '#4'
  -- does not match '#42'.
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
-- (a) pending items
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
  coalesce(ar.rank, 6)                              AS area_rank
FROM claude_pending_items p
LEFT JOIN block_counts bc ON bc.blocker_id = p.id
LEFT JOIN area_rank ar ON ar.area = p.area
WHERE p.status IN ('open','blocked')
  AND p.item_type IN ('decision_needed','unconfirmed_decision','open_question','approval_needed')
  AND (p.snooze_until IS NULL OR p.snooze_until <= CURRENT_DATE)

UNION ALL

-- (b) open conflicts. kind 'decision' resolves both sides from
-- claude_decision_log; kind 'issue' from claude_known_issues.
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
  coalesce(ar.rank, 6)                                  AS area_rank
FROM claude_memory_conflicts c
LEFT JOIN claude_decision_log da ON c.kind = 'decision' AND da.id = c.row_a
LEFT JOIN claude_decision_log db ON c.kind = 'decision' AND db.id = c.row_b
LEFT JOIN claude_known_issues  ia ON c.kind = 'issue'    AND ia.id = c.row_a
LEFT JOIN claude_known_issues  ib ON c.kind = 'issue'    AND ib.id = c.row_b
LEFT JOIN area_rank ar ON ar.area = coalesce(da.area, ia.area)
WHERE c.status = 'open'
  AND (c.snooze_until IS NULL OR c.snooze_until <= CURRENT_DATE);

GRANT SELECT ON v_command_center_queue TO service_role;

-- ═══ E. Session rules — the dashboard is a surface ═══════════════════════
--
-- One session per ET day collects that day's rulings. It is a real session (it
-- holds the decisions), but it is NOT a chat, so it must not become the pack's
-- last_session or count as an unlinked chat — exactly the treatment sql/101 gave
-- Omi.

ALTER TABLE claude_session_logs DROP CONSTRAINT IF EXISTS claude_session_logs_surface_check;
ALTER TABLE claude_session_logs ADD CONSTRAINT claude_session_logs_surface_check
  CHECK (surface = ANY (ARRAY['chat','cowork','code','n8n','omi','dashboard']));

-- claude_guard_session_insert() — copied verbatim from the live definition
-- (pg_get_functiondef, 2026-09-11) with ONE edit, marked `-- sql/102`.
-- The batch-pattern branch relabels a 4th 'live' session inside 5 minutes as
-- retro. The daily dashboard session is log_origin 'live' by design and would be
-- relabelled the moment three rulings landed in a burst, which is the normal way
-- the page is used.
CREATE OR REPLACE FUNCTION public.claude_guard_session_insert()
RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE
  recent_live integer;
BEGIN
  -- retro rows must say where they came from
  IF NEW.log_origin = 'retro' AND (NEW.chat_url IS NULL OR NEW.source_chat_updated_at IS NULL) THEN
    RAISE EXCEPTION 'retro session requires chat_url and source_chat_updated_at'
      USING ERRCODE = 'check_violation';
  END IF;
  -- a "live" row dated today, arriving in a burst, is the sweep pattern
  IF NEW.log_origin = 'live' AND NEW.session_date = CURRENT_DATE
     AND NEW.surface <> 'dashboard' THEN                               -- sql/102
    SELECT count(*) INTO recent_live FROM claude_session_logs
     WHERE log_origin = 'live' AND created_at > now() - interval '5 minutes';
    IF recent_live >= 3 THEN
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
END $function$;

-- claude_memory_context() v7 — copied verbatim from the live v6 definition
-- (pg_get_functiondef, 2026-09-11) with SIX edits, each marked `-- sql/102`:
--   last_session / recent_sessions / open_pending_recent (×2)  skip dashboard
--   counts.unlinked_sessions   dashboard sessions are unlinked by design
--   counts.rulings_open        NEW: the Rulings-lane count, straight from the view
--
-- `coalesce(surface,'')` for the same reason sql/101 used it on log_origin: both
-- columns are nullable and a bare `<>` is NULL (false) for a NULL row, which
-- would silently drop legacy sessions out of the pack.
CREATE OR REPLACE FUNCTION claude_memory_context(p_topic text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE sql STABLE AS $function$
  SELECT jsonb_build_object(
    'generated_at', now(),
    'topic', p_topic,
    'how_to_read', 'Ranked pack, ~8k tokens. counts shows what is NOT here. For anything else use claude_memory_search(query). Pending work lives in claude_pending_items; close items with UPDATE, never re-paste. open_conflicts need a ruling (memory_precheck shows the pair). counts.omi_open_unconfirmed = things heard on Omi, unconfirmed: confirm one with memory_checkpoint (decision) + close_pending {status:''ratified''}. counts.rulings_open = the Command Center Rulings lane: rule one with memory_rule, or open /command-center.',

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
          AND coalesce(l.log_origin,'') <> 'omi'                       -- sql/101
          AND coalesce(l.surface,'') <> 'dashboard'                    -- sql/102
        ORDER BY l.session_date DESC, l.created_at DESC LIMIT 1) s),

    'recent_sessions', (SELECT jsonb_agg(r) FROM (
        SELECT id, session_date, session_title
        FROM claude_session_logs
        WHERE date_confidence <> 'write_date'
          AND coalesce(log_origin,'') <> 'omi'                         -- sql/101
          AND coalesce(surface,'') <> 'dashboard'                      -- sql/102
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
                                         AND coalesce(log_origin,'') <> 'omi'      -- sql/101
                                         AND coalesce(surface,'') <> 'dashboard'   -- sql/102
                                       ORDER BY session_date DESC, created_at DESC LIMIT 1)
          AND coalesce(s.date_confidence,'exact') <> 'write_date'
          AND coalesce(s.log_origin,'') <> 'omi'                       -- sql/101
          AND coalesce(s.surface,'') <> 'dashboard'                    -- sql/102
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
        (SELECT count(*) FROM claude_pending_items WHERE origin = 'omi' AND status = 'open') AS omi_open_unconfirmed,            -- sql/101
        (SELECT count(*) FROM v_command_center_queue WHERE lane = 'rulings') AS rulings_open,                                    -- sql/102
        (SELECT count(*) FROM claude_decision_log WHERE status = 'active') AS active_decisions,
        (SELECT count(*) FROM claude_session_logs) AS sessions,
        (SELECT count(*) FROM claude_memory_conflicts WHERE status = 'open') AS open_conflicts,
        (SELECT count(*) FROM claude_session_logs WHERE chat_url IS NULL
           AND coalesce(surface,'chat') <> 'omi'
           AND coalesce(surface,'chat') <> 'dashboard') AS unlinked_sessions,                                                    -- sql/101, sql/102
        (SELECT count(*) FROM claude_session_logs WHERE date_confidence = 'write_date') AS write_date_sessions,
        (SELECT count(*) FROM claude_session_logs WHERE validation_status = 'flagged') AS flagged_sessions) c)
  );
$function$;

-- ═══ F. claude_rule_apply(jsonb) — the atomic writer ═══════════════════════
--
-- ONE ruling, ONE transaction. A plpgsql function body is a transaction: if any
-- statement below raises, the session row, the decision, the closed card and the
-- log row all go with it. There is no state in which a card is closed but its
-- decision is missing, or a decision exists with no audit row.
--
-- Input (built and validated by src/memory/memory-rule.js):
--   { "action", "target_table", "target_id", "card_version",
--     "ruled_by", "via", "reason",
--     "session":  { "date", "title", "checkpoint_key" },
--     "decision": { "text", "category", "rationale", "supersedes_id"?, "same_as_id"? },
--     "build":    { "description" }?,
--     "stage", "proof", "snooze_until",
--     "reverses_id"?, "then_action"?, "rec_verdict" }
--
-- Returns { ok, ruling_id, session_id, decision_id, build_item_id, rollback_item_id }.
--
-- EVERY exception message starts with a stable code so Node can map it without
-- string-matching prose:
--   stale_card | already_reversed | changed_since | reason_required |
--   proof_required | not_in_release | bad_input
--
-- The three helpers come first because they own the shapes claude_rule_apply
-- records in `changes` — each captures the row's BEFORE state, makes its change,
-- and reads the AFTER back off the row. Nothing about the previous state is
-- assumed (a card sitting at 'blocked' must flip back to 'blocked', not 'open').

CREATE OR REPLACE FUNCTION claude_rule_close_card(
  p_table text, p_id integer, p_status text, p_reason text, p_session integer)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  IF p_table = 'claude_pending_items' THEN
    SELECT jsonb_build_object('status', t.status, 'closed_by', t.closed_by,
                              'closed_reason', t.closed_reason, 'closed_at', t.closed_at,
                              'resolved_session_id', t.resolved_session_id,
                              'verified_at', t.verified_at, 'stale', t.stale)
      INTO v_before FROM claude_pending_items t WHERE t.id = p_id;
    IF v_before IS NULL THEN
      RAISE EXCEPTION 'bad_input: pending item #% not found', p_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    UPDATE claude_pending_items
       SET status = p_status, closed_by = 'command_center', closed_reason = p_reason,
           closed_at = now(), resolved_session_id = p_session,
           verified_at = now(), stale = false, updated_at = now()
     WHERE id = p_id;
    SELECT jsonb_build_object('status', t.status, 'closed_by', t.closed_by,
                              'closed_reason', t.closed_reason, 'closed_at', t.closed_at,
                              'resolved_session_id', t.resolved_session_id,
                              'verified_at', t.verified_at, 'stale', t.stale)
      INTO v_after FROM claude_pending_items t WHERE t.id = p_id;
    RETURN jsonb_build_array(jsonb_build_object(
      'table','claude_pending_items','id',p_id,'inserted',false,
      'before', v_before, 'after', v_after));

  ELSIF p_table = 'claude_known_issues' THEN
    SELECT jsonb_build_object('status', t.status, 'resolved_session_id', t.resolved_session_id,
                              'resolved_date', t.resolved_date, 'verified_at', t.verified_at,
                              'stale', t.stale)
      INTO v_before FROM claude_known_issues t WHERE t.id = p_id;
    IF v_before IS NULL THEN
      RAISE EXCEPTION 'bad_input: issue #% not found', p_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    UPDATE claude_known_issues
       SET status = CASE WHEN p_status = 'ratified' THEN 'resolved' ELSE 'closed' END,
           resolved_session_id = p_session, resolved_date = CURRENT_DATE,
           verified_at = now(), stale = false, updated_at = now()
     WHERE id = p_id;
    SELECT jsonb_build_object('status', t.status, 'resolved_session_id', t.resolved_session_id,
                              'resolved_date', t.resolved_date, 'verified_at', t.verified_at,
                              'stale', t.stale)
      INTO v_after FROM claude_known_issues t WHERE t.id = p_id;
    RETURN jsonb_build_array(jsonb_build_object(
      'table','claude_known_issues','id',p_id,'inserted',false,
      'before', v_before, 'after', v_after));
  END IF;
  RETURN '[]'::jsonb;
END $$;

CREATE OR REPLACE FUNCTION claude_rule_snooze(p_table text, p_id integer, p_until date)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_before text; v_found integer;
BEGIN
  EXECUTE format('SELECT id, snooze_until::text FROM %I WHERE id = $1', p_table)
    INTO v_found, v_before USING p_id;
  IF v_found IS NULL THEN
    RAISE EXCEPTION 'bad_input: %.% not found', p_table, p_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  EXECUTE format('UPDATE %I SET snooze_until = $1 WHERE id = $2', p_table)
    USING p_until, p_id;
  RETURN jsonb_build_array(jsonb_build_object(
    'table', p_table, 'id', p_id, 'inserted', false,
    'before', jsonb_build_object('snooze_until', v_before),
    'after',  jsonb_build_object('snooze_until', p_until::text)));
END $$;

-- Restore one column to a recorded `before` value. The value travels as JSON
-- text, so it has to be cast back to the column's REAL type on the way in —
-- `UPDATE t SET superseded_by = $1` with a text parameter is a type error, and
-- silently skipping it would make a flip quietly incomplete.
CREATE OR REPLACE FUNCTION claude_rule_restore_col(
  p_table text, p_id integer, p_col text, p_value text)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_type text;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod) INTO v_type
    FROM pg_attribute a
   WHERE a.attrelid = p_table::regclass AND a.attname = p_col AND a.attnum > 0 AND NOT a.attisdropped;
  IF v_type IS NULL THEN
    RAISE EXCEPTION 'bad_input: %.% is not a column', p_table, p_col
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  EXECUTE format('UPDATE %I SET %I = $1::%s WHERE id = $2', p_table, p_col, v_type)
    USING p_value, p_id;
END $$;

GRANT EXECUTE ON FUNCTION claude_rule_close_card(text, integer, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION claude_rule_snooze(text, integer, date) TO service_role;
GRANT EXECUTE ON FUNCTION claude_rule_restore_col(text, integer, text, text) TO service_role;

CREATE OR REPLACE FUNCTION claude_rule_apply(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_action      text    := nullif(p->>'action','');
  v_table       text    := nullif(p->>'target_table','');
  v_id          integer := nullif(p->>'target_id','')::integer;
  v_cardver     text    := nullif(p->>'card_version','');
  v_ruled_by    text    := coalesce(nullif(p->>'ruled_by',''), 'unknown');
  v_via         text    := coalesce(nullif(p->>'via',''), 'dashboard');
  v_reason      text    := nullif(p->>'reason','');
  v_sess        jsonb   := coalesce(p->'session', '{}'::jsonb);
  v_dec         jsonb   := coalesce(p->'decision', '{}'::jsonb);
  v_build       jsonb   := p->'build';
  v_stage       text    := nullif(p->>'stage','');
  v_proof       text    := nullif(p->>'proof','');
  v_snooze      date    := nullif(p->>'snooze_until','')::date;
  v_reverses    integer := nullif(p->>'reverses_id','')::integer;
  v_then        text    := nullif(p->>'then_action','');
  v_rec_verdict text    := nullif(p->>'rec_verdict','');

  v_date        date;
  v_key         text;
  v_session_id  integer;
  v_keys        jsonb   := '["Command Center","memory_rule","claude_rulings_log"]'::jsonb;
  v_changes     jsonb   := '[]'::jsonb;
  v_decision_id integer;
  v_build_id    integer;
  v_rollback_id integer;
  v_ruling_id   integer;
  v_live        text;
  v_sup         integer := nullif(v_dec->>'supersedes_id','')::integer;
  v_same        integer := nullif(v_dec->>'same_as_id','')::integer;
  v_note        text;
  v_next_index  integer;
  v_winner      integer;
  v_loser       integer;
  v_kind        text;
  v_row_a       integer;
  v_row_b       integer;
  v_orig        claude_rulings_log%ROWTYPE;
  v_chg         jsonb;
  v_before      jsonb;
  v_col         text;
  v_now_val     text;
  v_stage_prev  text;
  v_txt         text;
BEGIN
  IF v_action IS NULL OR v_table IS NULL OR v_id IS NULL THEN
    RAISE EXCEPTION 'bad_input: action, target_table and target_id are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_table NOT IN ('claude_pending_items','claude_memory_conflicts','claude_decision_log') THEN
    RAISE EXCEPTION 'bad_input: target_table % is not rulable', v_table
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- ── 1. The daily session ────────────────────────────────────────────────
  -- One per ET day, identified by checkpoint_key (UNIQUE, sql/096). Every
  -- ruling made today hangs off it, so a day's work reads as one session.
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

  -- ── 2. Stale guard ──────────────────────────────────────────────────────
  -- The card must be exactly as it was when it went on screen. A flip carries no
  -- card_version (it addresses a ruling, not a card) — its own changed_since
  -- check below is stricter.
  IF v_action <> 'flip' AND v_cardver IS NOT NULL THEN
    v_live := claude_card_version(v_table, v_id);
    IF v_live IS DISTINCT FROM v_cardver THEN
      RAISE EXCEPTION 'stale_card: % #% changed since it was loaded', v_table, v_id
        USING ERRCODE = 'serialization_failure';
    END IF;
  END IF;

  -- ── 3. Apply ────────────────────────────────────────────────────────────

  -- 3a. Rulings that produce a NEW decision and close the card.
  IF v_action IN ('approve','edit_approve','yes','pick_option','own_answer') THEN
    IF v_same IS NOT NULL THEN
      -- Not a second active decision on the same subject: re-confirm the one
      -- that already says this. (The column this writes is the one section A
      -- adds — see the header.)
      v_note := 'confirmed through Command Center on ' || v_date::text;
      SELECT jsonb_build_object('verified_at', d.verified_at,
                                'verification_note', d.verification_note,
                                'ruled_by', d.ruled_by)
        INTO v_before FROM claude_decision_log d WHERE d.id = v_same;
      IF v_before IS NULL THEN
        RAISE EXCEPTION 'bad_input: decision #% not found', v_same
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      UPDATE claude_decision_log
         SET verified_at = now(), verification_note = v_note, ruled_by = v_ruled_by
       WHERE id = v_same;
      v_decision_id := v_same;
      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'table','claude_decision_log','id',v_same,'inserted',false,
        'before', v_before,
        'after',  (SELECT jsonb_build_object('verified_at', d.verified_at,
                                             'verification_note', d.verification_note,
                                             'ruled_by', d.ruled_by)
                     FROM claude_decision_log d WHERE d.id = v_same)));
    ELSE
      IF nullif(v_dec->>'text','') IS NULL THEN
        RAISE EXCEPTION 'bad_input: decision.text is required for %', v_action
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      INSERT INTO claude_decision_log (
        session_id, decision_date, category, decision, rationale, options_considered,
        transcript_search_keys, reversible, origin, confidence, status,
        rollout_stage, ruled_by, created_at
      ) VALUES (
        v_session_id, v_date,
        coalesce(nullif(v_dec->>'category',''), 'operations'),
        v_dec->>'text', v_dec->>'rationale',
        '[]'::jsonb, v_keys, true, 'live', 'confirmed', 'active',
        CASE WHEN v_build IS NULL THEN 'no_build' ELSE 'decided' END,
        v_ruled_by, now()
      ) RETURNING id INTO v_decision_id;
      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'table','claude_decision_log','id',v_decision_id,'inserted',true,
        'before', NULL, 'after', jsonb_build_object('status','active')));

      IF v_sup IS NOT NULL THEN
        SELECT jsonb_build_object('status', d.status, 'superseded_by', d.superseded_by)
          INTO v_before FROM claude_decision_log d WHERE d.id = v_sup;
        IF v_before IS NULL THEN
          RAISE EXCEPTION 'bad_input: decision #% not found', v_sup
            USING ERRCODE = 'invalid_parameter_value';
        END IF;
        UPDATE claude_decision_log SET status = 'superseded', superseded_by = v_decision_id WHERE id = v_sup;
        -- Keep the vector index honest immediately; the nightly would catch it.
        UPDATE claude_memory_embeddings SET status = 'superseded'
         WHERE source_table = 'claude_decision_log' AND source_id = v_sup;
        v_changes := v_changes || jsonb_build_array(jsonb_build_object(
          'table','claude_decision_log','id',v_sup,'inserted',false,
          'before', v_before,
          'after',  jsonb_build_object('status','superseded','superseded_by', v_decision_id)));
      END IF;

      IF v_build IS NOT NULL THEN
        SELECT coalesce(max(source_index), -1) + 1 INTO v_next_index
          FROM claude_pending_items
         WHERE source_session_id = v_session_id AND source_field = 'rule';
        INSERT INTO claude_pending_items (
          source_session_id, source_field, source_index, kind, item_type, description,
          status, ref, origin, session_date, created_at, updated_at
        ) VALUES (
          v_session_id, 'rule', v_next_index, 'pending', 'build_needed',
          v_build->>'description', 'open', 'decision:' || v_decision_id,
          'live', v_date, now(), now()
        ) RETURNING id INTO v_build_id;
        UPDATE claude_decision_log SET build_item_id = v_build_id WHERE id = v_decision_id;
        v_changes := v_changes || jsonb_build_array(jsonb_build_object(
          'table','claude_pending_items','id',v_build_id,'inserted',true,
          'before', NULL, 'after', jsonb_build_object('status','open')));
      END IF;
    END IF;

    v_changes := v_changes || claude_rule_close_card(v_table, v_id, 'ratified', 'rule:' || v_action, v_session_id);

  -- 3b. Rejections. Saved AS A DECISION with status 'rejected', keeping the
  -- proposal's own wording, so memory_precheck finds it later and says
  -- "previously_rejected" instead of "clear".
  ELSIF v_action IN ('reject','no') THEN
    IF v_reason IS NULL THEN
      RAISE EXCEPTION 'reason_required: a rejection must say why'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF nullif(v_dec->>'text','') IS NULL THEN
      RAISE EXCEPTION 'bad_input: decision.text is required for %', v_action
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    INSERT INTO claude_decision_log (
      session_id, decision_date, category, decision, rationale, options_considered,
      transcript_search_keys, reversible, origin, confidence, status, ruled_by, created_at
    ) VALUES (
      v_session_id, v_date,
      coalesce(nullif(v_dec->>'category',''), 'operations'),
      v_dec->>'text', v_reason, '[]'::jsonb, v_keys, true, 'live', 'confirmed',
      'rejected', v_ruled_by, now()
    ) RETURNING id INTO v_decision_id;
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'table','claude_decision_log','id',v_decision_id,'inserted',true,
      'before', NULL, 'after', jsonb_build_object('status','rejected')));
    v_changes := v_changes || claude_rule_close_card(v_table, v_id, 'dropped', 'rule:' || v_action, v_session_id);

  -- 3c. Conflicts — pick a side.
  ELSIF v_action IN ('keep_left','keep_right') THEN
    SELECT kind, row_a, row_b INTO v_kind, v_row_a, v_row_b
      FROM claude_memory_conflicts WHERE id = v_id;
    IF v_kind IS NULL THEN
      RAISE EXCEPTION 'bad_input: conflict #% not found', v_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_action = 'keep_left' THEN v_winner := v_row_a; v_loser := v_row_b;
                              ELSE v_winner := v_row_b; v_loser := v_row_a; END IF;

    IF v_kind = 'decision' THEN
      v_note := 'kept in conflict #' || v_id;
      SELECT jsonb_build_object('verified_at', d.verified_at,
                                'verification_note', d.verification_note,
                                'ruled_by', d.ruled_by)
        INTO v_before FROM claude_decision_log d WHERE d.id = v_winner;
      UPDATE claude_decision_log
         SET verified_at = now(), verification_note = v_note, ruled_by = v_ruled_by
       WHERE id = v_winner;
      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'table','claude_decision_log','id',v_winner,'inserted',false,
        'before', v_before,
        'after',  (SELECT jsonb_build_object('verified_at', d.verified_at,
                                             'verification_note', d.verification_note,
                                             'ruled_by', d.ruled_by)
                     FROM claude_decision_log d WHERE d.id = v_winner)));

      SELECT jsonb_build_object('status', d.status, 'superseded_by', d.superseded_by)
        INTO v_before FROM claude_decision_log d WHERE d.id = v_loser;
      UPDATE claude_decision_log SET status = 'superseded', superseded_by = v_winner WHERE id = v_loser;
      UPDATE claude_memory_embeddings SET status = 'superseded'
       WHERE source_table = 'claude_decision_log' AND source_id = v_loser;
      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'table','claude_decision_log','id',v_loser,'inserted',false,
        'before', v_before,
        'after',  jsonb_build_object('status','superseded','superseded_by', v_winner)));
      v_decision_id := v_winner;
    ELSE
      -- kind 'issue': the loser is a duplicate of the winner, not superseded.
      SELECT jsonb_build_object('status', i.status, 'merged_into', i.merged_into)
        INTO v_before FROM claude_known_issues i WHERE i.id = v_loser;
      UPDATE claude_known_issues SET status = 'duplicate', merged_into = v_winner, updated_at = now()
       WHERE id = v_loser;
      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'table','claude_known_issues','id',v_loser,'inserted',false,
        'before', v_before,
        'after',  jsonb_build_object('status','duplicate','merged_into', v_winner)));
    END IF;

    SELECT jsonb_build_object('status', c.status, 'ruled_by', c.ruled_by, 'ruled_at', c.ruled_at)
      INTO v_before FROM claude_memory_conflicts c WHERE c.id = v_id;
    UPDATE claude_memory_conflicts
       SET status = CASE WHEN v_action = 'keep_left' THEN 'a_supersedes_b' ELSE 'b_supersedes_a' END,
           ruled_by = v_ruled_by, ruled_at = now()
     WHERE id = v_id;
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'table','claude_memory_conflicts','id',v_id,'inserted',false,
      'before', v_before,
      'after',  (SELECT jsonb_build_object('status', c.status, 'ruled_by', c.ruled_by, 'ruled_at', c.ruled_at)
                   FROM claude_memory_conflicts c WHERE c.id = v_id)));

  ELSIF v_action = 'not_a_conflict' THEN
    SELECT jsonb_build_object('status', c.status, 'ruled_by', c.ruled_by, 'ruled_at', c.ruled_at)
      INTO v_before FROM claude_memory_conflicts c WHERE c.id = v_id;
    IF v_before IS NULL THEN
      RAISE EXCEPTION 'bad_input: conflict #% not found', v_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    UPDATE claude_memory_conflicts
       SET status = 'not_a_conflict', ruled_by = v_ruled_by, ruled_at = now()
     WHERE id = v_id;
    v_changes := jsonb_build_array(jsonb_build_object(
      'table','claude_memory_conflicts','id',v_id,'inserted',false,
      'before', v_before,
      'after',  (SELECT jsonb_build_object('status', c.status, 'ruled_by', c.ruled_by, 'ruled_at', c.ruled_at)
                   FROM claude_memory_conflicts c WHERE c.id = v_id)));

  -- 3d. Conflict → neither side; write the real answer and supersede both.
  ELSIF v_action = 'new_answer' THEN
    IF nullif(v_dec->>'text','') IS NULL THEN
      RAISE EXCEPTION 'bad_input: decision.text is required for new_answer'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT kind, row_a, row_b INTO v_kind, v_row_a, v_row_b
      FROM claude_memory_conflicts WHERE id = v_id;
    IF v_kind IS DISTINCT FROM 'decision' THEN
      RAISE EXCEPTION 'not_in_release: new_answer is only available on a decision conflict'
        USING ERRCODE = 'feature_not_supported';
    END IF;
    INSERT INTO claude_decision_log (
      session_id, decision_date, category, decision, rationale, options_considered,
      transcript_search_keys, reversible, origin, confidence, status,
      rollout_stage, ruled_by, created_at
    ) VALUES (
      v_session_id, v_date,
      coalesce(nullif(v_dec->>'category',''), 'operations'),
      v_dec->>'text', v_dec->>'rationale', '[]'::jsonb, v_keys, true, 'live', 'confirmed',
      'active', 'decided', v_ruled_by, now()
    ) RETURNING id INTO v_decision_id;
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'table','claude_decision_log','id',v_decision_id,'inserted',true,
      'before', NULL, 'after', jsonb_build_object('status','active')));

    FOREACH v_loser IN ARRAY ARRAY[v_row_a, v_row_b] LOOP
      SELECT jsonb_build_object('status', d.status, 'superseded_by', d.superseded_by)
        INTO v_before FROM claude_decision_log d WHERE d.id = v_loser;
      CONTINUE WHEN v_before IS NULL;
      UPDATE claude_decision_log SET status = 'superseded', superseded_by = v_decision_id WHERE id = v_loser;
      UPDATE claude_memory_embeddings SET status = 'superseded'
       WHERE source_table = 'claude_decision_log' AND source_id = v_loser;
      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'table','claude_decision_log','id',v_loser,'inserted',false,
        'before', v_before,
        'after',  jsonb_build_object('status','superseded','superseded_by', v_decision_id)));
    END LOOP;

    SELECT jsonb_build_object('status', c.status, 'resolution_decision_id', c.resolution_decision_id,
                              'ruled_by', c.ruled_by, 'ruled_at', c.ruled_at)
      INTO v_before FROM claude_memory_conflicts c WHERE c.id = v_id;
    UPDATE claude_memory_conflicts
       SET status = 'merged', resolution_decision_id = v_decision_id,
           ruled_by = v_ruled_by, ruled_at = now()
     WHERE id = v_id;
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'table','claude_memory_conflicts','id',v_id,'inserted',false,
      'before', v_before,
      'after',  (SELECT jsonb_build_object('status', c.status, 'resolution_decision_id', c.resolution_decision_id,
                                           'ruled_by', c.ruled_by, 'ruled_at', c.ruled_at)
                   FROM claude_memory_conflicts c WHERE c.id = v_id)));

  -- 3e. Not now.
  ELSIF v_action = 'snooze' THEN
    IF v_snooze IS NULL OR v_snooze <= CURRENT_DATE THEN
      RAISE EXCEPTION 'bad_input: snooze_until must be a future date'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_changes := claude_rule_snooze(v_table, v_id, v_snooze);

  -- 3f. No longer relevant.
  ELSIF v_action = 'not_relevant' THEN
    IF v_table = 'claude_memory_conflicts' THEN
      SELECT jsonb_build_object('status', c.status, 'ruled_by', c.ruled_by, 'ruled_at', c.ruled_at)
        INTO v_before FROM claude_memory_conflicts c WHERE c.id = v_id;
      IF v_before IS NULL THEN
        RAISE EXCEPTION 'bad_input: conflict #% not found', v_id
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      UPDATE claude_memory_conflicts
         SET status = 'not_a_conflict', ruled_by = v_ruled_by, ruled_at = now()
       WHERE id = v_id;
      v_changes := jsonb_build_array(jsonb_build_object(
        'table','claude_memory_conflicts','id',v_id,'inserted',false,
        'before', v_before,
        'after',  (SELECT jsonb_build_object('status', c.status, 'ruled_by', c.ruled_by, 'ruled_at', c.ruled_at)
                     FROM claude_memory_conflicts c WHERE c.id = v_id)));
    ELSE
      v_changes := claude_rule_close_card(v_table, v_id, 'dropped', 'rule:not_relevant', v_session_id);
    END IF;

  -- 3g. Rollout stage on a decision.
  ELSIF v_action = 'stage' THEN
    IF v_table <> 'claude_decision_log' THEN
      RAISE EXCEPTION 'bad_input: stage applies to claude_decision_log only'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_stage IS NULL OR v_stage NOT IN ('built','verified','no_build') THEN
      RAISE EXCEPTION 'bad_input: stage must be built, verified or no_build'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_stage = 'verified' AND v_proof IS NULL THEN
      RAISE EXCEPTION 'proof_required: verified needs a line saying what proved it'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT jsonb_build_object('rollout_stage', d.rollout_stage, 'built_at', d.built_at,
                              'verified_at', d.verified_at, 'verification_note', d.verification_note,
                              'ruled_by', d.ruled_by)
      INTO v_before FROM claude_decision_log d WHERE d.id = v_id;
    IF v_before IS NULL THEN
      RAISE EXCEPTION 'bad_input: decision #% not found', v_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    UPDATE claude_decision_log
       SET rollout_stage = v_stage,
           built_at = CASE WHEN v_stage = 'built' THEN now() ELSE built_at END,
           verified_at = CASE WHEN v_stage = 'verified' THEN now() ELSE verified_at END,
           verification_note = CASE WHEN v_stage = 'verified' THEN v_proof ELSE verification_note END,
           ruled_by = v_ruled_by
     WHERE id = v_id;
    v_decision_id := v_id;
    v_changes := jsonb_build_array(jsonb_build_object(
      'table','claude_decision_log','id',v_id,'inserted',false,
      'before', v_before,
      'after',  (SELECT jsonb_build_object('rollout_stage', d.rollout_stage, 'built_at', d.built_at,
                                           'verified_at', d.verified_at, 'verification_note', d.verification_note,
                                           'ruled_by', d.ruled_by)
                   FROM claude_decision_log d WHERE d.id = v_id)));

  -- 3h. Flip — put everything back exactly as it was.
  ELSIF v_action = 'flip' THEN
    IF v_reason IS NULL THEN
      RAISE EXCEPTION 'reason_required: a flip must say why'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_reverses IS NULL THEN
      RAISE EXCEPTION 'bad_input: flip needs reverses_id'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT * INTO v_orig FROM claude_rulings_log WHERE id = v_reverses;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'bad_input: ruling #% not found', v_reverses
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_orig.action = 'flip' THEN
      -- Flipping a flip is a re-ruling, not an undo: rule the card again
      -- instead, so the log reads forwards.
      RAISE EXCEPTION 'not_in_release: ruling #% is itself a flip — rule the card again rather than flipping the flip', v_reverses
        USING ERRCODE = 'feature_not_supported';
    END IF;
    IF v_orig.reversed_by IS NOT NULL THEN
      RAISE EXCEPTION 'already_reversed: ruling #% was already reversed by #%', v_reverses, v_orig.reversed_by
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Nothing may have moved since. Compare only the columns this ruling wrote.
    FOR v_chg IN SELECT * FROM jsonb_array_elements(v_orig.changes) LOOP
      FOR v_col IN SELECT jsonb_object_keys(v_chg->'after') LOOP
        EXECUTE format('SELECT (to_jsonb(t) ->> %L) FROM %I t WHERE t.id = $1', v_col, v_chg->>'table')
          INTO v_now_val USING (v_chg->>'id')::integer;
        IF v_now_val IS DISTINCT FROM (v_chg->'after'->>v_col) THEN
          RAISE EXCEPTION 'changed_since: %.% on row % is now % — it was % when ruling #% was made',
            v_chg->>'table', v_col, v_chg->>'id', coalesce(v_now_val,'NULL'),
            coalesce(v_chg->'after'->>v_col,'NULL'), v_reverses
            USING ERRCODE = 'serialization_failure';
        END IF;
      END LOOP;
    END LOOP;

    -- Restore. Rows this ruling INSERTED are withdrawn, never deleted.
    FOR v_chg IN SELECT * FROM jsonb_array_elements(v_orig.changes) LOOP
      IF (v_chg->>'inserted')::boolean THEN
        IF v_chg->>'table' = 'claude_decision_log' THEN
          SELECT rollout_stage, decision INTO v_stage_prev, v_txt
            FROM claude_decision_log WHERE id = (v_chg->>'id')::integer;
          UPDATE claude_decision_log
             SET status = 'superseded',
                 verification_note = 'withdrawn by flip of ruling #' || v_reverses
           WHERE id = (v_chg->>'id')::integer;
          UPDATE claude_memory_embeddings SET status = 'superseded'
           WHERE source_table = 'claude_decision_log' AND source_id = (v_chg->>'id')::integer;
          -- A decision that was already BUILT or VERIFIED left something behind
          -- in the real world. Undoing the record is not undoing the build, so
          -- the flip files the undo as work.
          IF v_stage_prev IN ('built','verified') THEN
            SELECT coalesce(max(source_index), -1) + 1 INTO v_next_index
              FROM claude_pending_items
             WHERE source_session_id = v_session_id AND source_field = 'rule';
            INSERT INTO claude_pending_items (
              source_session_id, source_field, source_index, kind, item_type, description,
              status, priority, ref, origin, session_date, created_at, updated_at
            ) VALUES (
              v_session_id, 'rule', v_next_index, 'pending', 'build_needed',
              'ROLL BACK: decision #' || (v_chg->>'id') || ' reversed on ' || v_date::text
                || ' — undo: ' || coalesce(v_txt,''),
              'open', 1, 'decision:' || (v_chg->>'id'), 'live', v_date, now(), now()
            ) RETURNING id INTO v_rollback_id;
          END IF;
        ELSIF v_chg->>'table' = 'claude_pending_items' THEN
          UPDATE claude_pending_items
             SET status = 'dropped', closed_by = 'command_center',
                 closed_reason = 'flip of ruling #' || v_reverses,
                 closed_at = now(), updated_at = now()
           WHERE id = (v_chg->>'id')::integer;
        END IF;
      ELSE
        FOR v_col IN SELECT jsonb_object_keys(v_chg->'before') LOOP
          PERFORM claude_rule_restore_col(v_chg->>'table', (v_chg->>'id')::integer,
                                          v_col, v_chg->'before'->>v_col);
        END LOOP;
      END IF;
    END LOOP;

    v_changes := jsonb_build_array(jsonb_build_object(
      'table','claude_rulings_log','id',v_reverses,'inserted',false,
      'before', jsonb_build_object('reversed_by', NULL),
      'after',  jsonb_build_object('reversed_by', 'pending')));

  ELSE
    RAISE EXCEPTION 'not_in_release: action % is not part of Release 1', v_action
      USING ERRCODE = 'feature_not_supported';
  END IF;

  -- ── 4. The audit row ────────────────────────────────────────────────────
  INSERT INTO claude_rulings_log (
    ruled_by, via, lane, action, target_table, target_id, changes, reason,
    reverses_id, session_id, decision_id, rec_verdict
  ) VALUES (
    v_ruled_by, v_via, 'rulings', v_action, v_table, v_id, v_changes, v_reason,
    v_reverses, v_session_id, v_decision_id, v_rec_verdict
  ) RETURNING id INTO v_ruling_id;

  IF v_action = 'flip' THEN
    UPDATE claude_rulings_log SET reversed_by = v_ruling_id WHERE id = v_reverses;
    -- A two-sided ruling flips ACROSS, not just off: approve↔reject, yes↔no,
    -- keep_left↔keep_right. Node works out the opposite and passes it here so
    -- both halves land in the same transaction.
    IF v_then IS NOT NULL THEN
      RETURN jsonb_build_object(
        'ok', true, 'ruling_id', v_ruling_id, 'session_id', v_session_id,
        'decision_id', v_decision_id, 'build_item_id', v_build_id,
        'rollback_item_id', v_rollback_id,
        'then', claude_rule_apply(
          (p - 'action' - 'then_action' - 'reverses_id' - 'card_version')
          || jsonb_build_object('action', v_then)));
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'ruling_id', v_ruling_id, 'session_id', v_session_id,
    'decision_id', v_decision_id, 'build_item_id', v_build_id,
    'rollback_item_id', v_rollback_id);
END $$;

GRANT EXECUTE ON FUNCTION claude_rule_apply(jsonb) TO service_role;

-- ═══ Verification ══════════════════════════════════════════════════════════
-- Run after all six blocks. Expect fn = 2, queue about 385, log 0,
-- pack_last NOT 'dashboard'.
--
-- SELECT json_build_object(
--   'fn',        (SELECT count(*) FROM pg_proc WHERE proname IN ('claude_rule_apply','claude_card_version')),
--   'queue',     (SELECT count(*) FROM v_command_center_queue),
--   'log',       (SELECT count(*) FROM claude_rulings_log),
--   'pack_last', (claude_memory_context('memory')->'last_session'->>'surface'));
