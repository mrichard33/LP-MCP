-- 106_bot_review_inc2.sql — Bot Review increment 2:
--   review lanes, retraction, dismissals, completed view.
-- Apply BY HAND in the LP Supabase SQL editor, sections A→E in order.
-- Doctrine: sql/README.md. LP MCP degrades gracefully if this is not yet applied.
--
-- Requires sql/103_bot_feedback_core.sql, sql/104_bot_review_views.sql and
-- sql/105_bot_review_contact_identity.sql.
--
-- WHAT THIS IS NOT: it does not touch the send path, agent_actions, or any
-- table the Decision Engine writes. Every write surface added here is a human
-- review artefact. Dropping all of it breaks only the Bot Review page.
--
-- ROLLBACK: at the foot of this file.

-- ═══ A. Settings for the three review lanes ═══════════════════════════
--
-- Read at QUERY time by the queue view, never baked into it, so Mark can change
-- the spot-check rate in one UPDATE and the lanes re-partition on the next page
-- load with no deploy.
INSERT INTO bot_settings (key, value) VALUES
  ('spot_check_rate','0.15'),            -- share of non-must-review messages sampled
  ('must_review_score_below','60'),      -- AI score at or below this always needs a human
  ('must_review_include_skips','true')   -- bot staying silent always needs a human
ON CONFLICT (key) DO NOTHING;

-- ═══ B. Retraction — "delete" that keeps the audit trail ══════════════
-- bot_feedback is append-only by trigger, and that stays true. A retracted
-- review stops counting everywhere and leaves the queue, but the row remains
-- so the change log and reviewer-agreement history stay honest.
ALTER TABLE bot_feedback
  ADD COLUMN IF NOT EXISTS retracted_at     timestamptz,
  ADD COLUMN IF NOT EXISTS retracted_by     text,
  ADD COLUMN IF NOT EXISTS retract_reason   text;

CREATE INDEX IF NOT EXISTS idx_bf_active
  ON bot_feedback (context_id)
  WHERE undone_at IS NULL AND retracted_at IS NULL;

-- Guard v2: still no DELETE, still only undone_at inside its window, PLUS a
-- one-way retraction. Retraction has no time limit (a bad review found a week
-- later must still be removable) but it cannot be reversed — re-reviewing is
-- the way back, and that leaves its own row.
--
-- supersedes_id is deliberately NOT mutable here. Guard v1 already refused it,
-- which is why every edit since Phase 1 shipped failed to link (see the FINDING
-- in the PR body): feedback.js inserted the new row and then tried to UPDATE
-- supersedes_id onto it, and the trigger rejected the update. The fix is in the
-- service — supersedes_id is now set on the INSERT — not a hole in the guard.
CREATE OR REPLACE FUNCTION bot_feedback_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mutable text[] := ARRAY['undone_at','retracted_at','retracted_by','retract_reason'];
        k text;
        a jsonb := to_jsonb(OLD);
        b jsonb := to_jsonb(NEW);
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bot_feedback is append-only — retract instead';
  END IF;

  FOREACH k IN ARRAY mutable LOOP
    a := a - k; b := b - k;
  END LOOP;
  IF a <> b THEN
    RAISE EXCEPTION 'bot_feedback: only undone_at and the retraction fields may change';
  END IF;

  IF OLD.undone_at IS NULL AND NEW.undone_at IS NOT NULL
     AND now() > OLD.created_at + interval '15 seconds' THEN
    RAISE EXCEPTION 'bot_feedback: undo window closed';
  END IF;

  IF OLD.retracted_at IS NOT NULL AND NEW.retracted_at IS DISTINCT FROM OLD.retracted_at THEN
    RAISE EXCEPTION 'bot_feedback: a retraction cannot be changed or reversed';
  END IF;

  IF NEW.retracted_at IS NOT NULL
     AND length(coalesce(trim(NEW.retract_reason),'')) = 0 THEN
    RAISE EXCEPTION 'bot_feedback: a retraction needs a reason';
  END IF;

  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_bot_feedback_guard ON bot_feedback;
CREATE TRIGGER trg_bot_feedback_guard BEFORE UPDATE OR DELETE ON bot_feedback
  FOR EACH ROW EXECUTE FUNCTION bot_feedback_guard();

-- ═══ C. Dismissals — "nothing to review here" ════════════════════════
-- Persistent, per-reviewer-team (not per person): if one reviewer says a
-- message needs no review, it should not reappear for the next reviewer.
-- Undoable, because a wrong dismissal must not be a dead end.
CREATE TABLE IF NOT EXISTS bot_review_dismissals (
  id             bigserial PRIMARY KEY,
  scope          text NOT NULL CHECK (scope IN ('message','conversation')),
  context_id     bigint REFERENCES bot_message_context(id),   -- required when scope='message'
  ghl_contact_id text,                                        -- required when scope='conversation'
  reason         text,
  dismissed_by   text NOT NULL,
  dismissed_at   timestamptz NOT NULL DEFAULT now(),
  undone_at      timestamptz,
  undone_by      text,
  CONSTRAINT brd_scope_target CHECK (
    (scope = 'message'      AND context_id IS NOT NULL) OR
    (scope = 'conversation' AND ghl_contact_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_brd_message
  ON bot_review_dismissals (context_id) WHERE scope='message' AND undone_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_brd_conversation
  ON bot_review_dismissals (ghl_contact_id) WHERE scope='conversation' AND undone_at IS NULL;
-- The Completed tab's Dismissed sub-filter reads newest first.
CREATE INDEX IF NOT EXISTS idx_brd_active
  ON bot_review_dismissals (dismissed_at DESC) WHERE undone_at IS NULL;

-- ═══ C2. v_bot_current_feedback v2 — retracted rows stop counting ════
--
-- "Current" now means four things: not undone, not RETRACTED, not superseded,
-- and the newest remaining. Adding the filter here rather than in each consumer
-- is what makes §8's "stops counting in review_count AND in reviewer agreement"
-- true by construction — the queue, the agreement view, the weekly quality view
-- and top issues all read this one view and inherit it.
--
-- A retracted row still SUPERSEDES the row it replaced. Retracting an edit must
-- not resurrect the verdict that edit replaced — the reviewer removed their
-- review of that message, full stop, and the message reads as unreviewed.
-- (undone_at keeps its old behavior in the NOT EXISTS: an undo inside 10
-- seconds means the edit never really happened.)
--
-- Column list, names, types and order are unchanged from sql/104, so
-- CREATE OR REPLACE is safe.
CREATE OR REPLACE VIEW v_bot_current_feedback AS
SELECT DISTINCT ON (f.message_type, f.message_ref, f.reviewer_email)
  f.id,
  f.message_type,
  f.message_ref,
  f.context_id,
  f.ghl_contact_id,
  f.reviewer_email,
  f.reviewer_role,
  f.verdict,
  f.reason_codes,
  f.better_text,
  f.note,
  f.seen_before,
  f.gold,
  f.is_calibration,
  f.counts,
  f.ai_score_at_review,
  f.supersedes_id,
  f.created_at
FROM bot_feedback f
WHERE f.undone_at IS NULL
  AND f.retracted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM bot_feedback s
    WHERE s.supersedes_id = f.id AND s.undone_at IS NULL
  )
ORDER BY f.message_type, f.message_ref, f.reviewer_email, f.created_at DESC, f.id DESC;

-- ═══ D. Queue view v2 — review_lane, dismissals, active-review state ══
--
-- Every column from sql/104 + sql/105 keeps its name, type and POSITION; the
-- seven new ones are appended. That is what lets this be a CREATE OR REPLACE
-- rather than a DROP CASCADE that would take v_bot_quality_weekly with it.
--
-- THE SAMPLE MUST NOT MOVE. A message's spot-check membership is a hash of
-- (message_type, message_ref) and NOTHING else — no score, no outcome, no
-- timestamp. An outcome landing an hour later must never pull a message into or
-- out of the sample, or the "random sample" the Good rate is built on becomes a
-- sample of messages whose outcomes arrived early.
--
--   ('x' || substr(md5(...),1,7))::bit(28)::int
--
-- 28 bits, not 32, on purpose: bit(28)::int is at most 268,435,455 and can
-- never be negative, so `% 10000` is always in [0, 9999]. A signed 32-bit cast
-- can come back negative and silently drop half the sample.
CREATE OR REPLACE VIEW v_bot_review_queue AS
WITH lane_settings AS (
  SELECT
    COALESCE((SELECT value #>> '{}' FROM bot_settings WHERE key = 'spot_check_rate')::numeric, 0.15)        AS spot_rate,
    COALESCE((SELECT value #>> '{}' FROM bot_settings WHERE key = 'must_review_score_below')::numeric, 60)  AS score_below,
    COALESCE((SELECT value #>> '{}' FROM bot_settings WHERE key = 'must_review_include_skips')::boolean, true) AS include_skips
),
scores AS (
  -- One score per action: the scorer can retry, so keep the newest.
  SELECT DISTINCT ON (s.action_id)
    s.action_id::text AS message_ref,
    s.overall_score,
    s.created_at
  FROM message_scores s
  WHERE s.action_id IS NOT NULL
  ORDER BY s.action_id, s.created_at DESC
),
office AS (
  SELECT DISTINCT ON (l.ghl_contact_id)
    l.ghl_contact_id,
    m.resolved_market_code
  FROM lp_leads l
  JOIN lp_lead_market_assignments m ON m.lead_id = l.lp_lead_id
  WHERE l.ghl_contact_id IS NOT NULL AND m.resolved_market_code IS NOT NULL
  ORDER BY l.ghl_contact_id, m.resolved_at DESC NULLS LAST
),
identity AS (
  SELECT DISTINCT ON (l.ghl_contact_id)
    l.ghl_contact_id,
    nullif(trim(concat_ws(' ', l.first_name, l.last_name)), '') AS contact_name,
    l.lp_prospect_id,
    l.lp_lead_id,
    l.city,
    l.phone,
    l.email,
    l.rep_name
  FROM lp_leads l
  WHERE l.ghl_contact_id IS NOT NULL
  ORDER BY l.ghl_contact_id, l.created_at_lp DESC NULLS LAST, l.lp_prospect_id DESC NULLS LAST
),
-- Reviews now come from v_bot_current_feedback v2, so a retracted review is
-- already gone from review_count and consensus_verdict. reviewed_at /
-- reviewed_by answer "who has this covered" for the Completed tab's row click.
reviews AS (
  SELECT
    cf.message_type,
    cf.message_ref,
    count(*)                                              AS review_count,
    count(*) FILTER (WHERE cf.counts)                     AS counting_count,
    count(*) FILTER (WHERE cf.counts AND cf.verdict = 'good')       AS good_count,
    count(*) FILTER (WHERE cf.counts AND cf.verdict = 'needs_work') AS needs_count,
    count(*) FILTER (WHERE cf.counts AND cf.verdict = 'unsafe')     AS unsafe_count,
    max(cf.verdict) FILTER (WHERE cf.reviewer_role = 'admin')       AS admin_verdict,
    max(cf.created_at)                                    AS reviewed_at,
    (array_agg(cf.reviewer_email ORDER BY cf.created_at DESC))[1]   AS reviewed_by
  FROM v_bot_current_feedback cf
  GROUP BY cf.message_type, cf.message_ref
),
-- A dismissal hides a message whether it was dismissed on its own or as part of
-- the whole conversation. Message scope wins the attribution when both exist,
-- because that is the more specific statement about this message.
dismissals AS (
  SELECT
    d.context_id,
    NULL::text AS ghl_contact_id,
    d.dismissed_by,
    d.dismissed_at
  FROM bot_review_dismissals d
  WHERE d.scope = 'message' AND d.undone_at IS NULL
),
convo_dismissals AS (
  SELECT
    d.ghl_contact_id,
    d.dismissed_by,
    d.dismissed_at
  FROM bot_review_dismissals d
  WHERE d.scope = 'conversation' AND d.undone_at IS NULL
),
-- The stop-bot tag family, applied through the Action Executor. This is an
-- ordinary LP-side join: agent_actions lives in LP Supabase alongside
-- bot_message_context, so no cross-database rule is bent here (handoff §1.4).
stop_tags AS (
  SELECT DISTINCT
    a.target_id AS ghl_contact_id,
    COALESCE(a.executed_at, a.created_at) AS tagged_at
  FROM agent_actions a
  WHERE a.action_type = 'add_tag'
    AND lower(coalesce(a.action_payload ->> 'tag','')) = 'stop-bot'
)
SELECT
  c.id                                   AS context_id,
  c.message_type,
  c.message_ref,
  c.ghl_contact_id,
  c.channel,
  c.rule_applied,
  c.workflow_code,
  c.intent_class,
  c.buyer_stage,
  c.inbound_text,
  c.reply_text,
  c.skip_reason,
  c.generated_at,
  c.sent_at,
  o.resolved_market_code                 AS office,
  CASE
    WHEN c.message_type = 'nurture' THEN round(am.confidence_score * 100)
    ELSE round(sc.overall_score * 100)
  END::numeric                           AS ai_score,
  bo.replied_at,
  bo.booked_at,
  bo.opted_out_at,
  (cardinality(c.guidance_version_ids) + cardinality(c.example_ids))::int AS learned_items_count,
  COALESCE(r.review_count, 0)::int       AS review_count,
  NULL::text                             AS my_verdict,
  CASE
    WHEN r.admin_verdict IS NOT NULL THEN r.admin_verdict
    WHEN COALESCE(r.counting_count, 0) = 0 THEN NULL
    WHEN r.unsafe_count > r.good_count AND r.unsafe_count >= r.needs_count THEN 'unsafe'
    WHEN r.good_count > (r.needs_count + r.unsafe_count) THEN 'good'
    WHEN (r.needs_count + r.unsafe_count) > r.good_count THEN 'needs_work'
    ELSE NULL
  END                                    AS consensus_verdict,
  CASE
    WHEN bo.opted_out_at IS NOT NULL THEN 1
    WHEN c.message_type = 'skip' THEN 2
    WHEN CASE WHEN c.message_type = 'nurture' THEN round(am.confidence_score * 100)
              ELSE round(sc.overall_score * 100) END < 60 THEN 3
    WHEN c.rule_applied LIKE 'OBJ\_%' OR c.rule_applied LIKE '%BOOKING%'
      OR c.rule_applied = 'LAYER3_DISPATCH' THEN 4
    ELSE 5
  END::int                               AS priority,
  -- ── sql/105: who this conversation is actually with ──────────────
  id2.contact_name,
  id2.lp_prospect_id,
  id2.lp_lead_id,
  id2.city                               AS contact_city,
  id2.phone                              AS contact_phone,
  id2.email                              AS contact_email,
  id2.rep_name,
  -- ── sql/106: which lane this message lands in, and why ───────────
  --
  -- Order matters and mirrors the handoff: opted out, then silence, then a low
  -- score, then a stop-bot tag. The FIRST match is the cause the chip shows,
  -- so the reviewer reads the most alarming reason rather than an arbitrary one.
  CASE
    WHEN bo.opted_out_at IS NOT NULL
     AND c.sent_at IS NOT NULL
     AND bo.opted_out_at <= c.sent_at + interval '24 hours' THEN 'must_review'
    WHEN c.message_type = 'skip' AND ls.include_skips THEN 'must_review'
    WHEN CASE WHEN c.message_type = 'nurture' THEN round(am.confidence_score * 100)
              ELSE round(sc.overall_score * 100) END <= ls.score_below THEN 'must_review'
    WHEN st.ghl_contact_id IS NOT NULL THEN 'must_review'
    WHEN (('x' || substr(md5(c.message_type || ':' || c.message_ref), 1, 7))::bit(28)::int % 10000)
         < ls.spot_rate * 10000 THEN 'spot_check'
    ELSE 'none'
  END                                    AS review_lane,
  CASE
    WHEN bo.opted_out_at IS NOT NULL
     AND c.sent_at IS NOT NULL
     AND bo.opted_out_at <= c.sent_at + interval '24 hours' THEN 'Opted out after'
    WHEN c.message_type = 'skip' AND ls.include_skips THEN 'Bot stayed silent'
    WHEN CASE WHEN c.message_type = 'nurture' THEN round(am.confidence_score * 100)
              ELSE round(sc.overall_score * 100) END <= ls.score_below THEN 'Low AI score'
    WHEN st.ghl_contact_id IS NOT NULL THEN 'Bot stopped after'
    ELSE NULL
  END                                    AS must_review_cause,
  (dm.context_id IS NOT NULL OR cd.ghl_contact_id IS NOT NULL)         AS dismissed,
  COALESCE(dm.dismissed_by, cd.dismissed_by)                           AS dismissed_by,
  COALESCE(dm.dismissed_at, cd.dismissed_at)                           AS dismissed_at,
  r.reviewed_at,
  r.reviewed_by
FROM bot_message_context c
CROSS JOIN lane_settings ls
LEFT JOIN scores sc            ON sc.message_ref = c.message_ref AND c.message_type <> 'nurture'
LEFT JOIN agentic_messages am  ON am.id::text = c.message_ref    AND c.message_type = 'nurture'
LEFT JOIN bot_outcomes bo      ON bo.message_type = c.message_type AND bo.message_ref = c.message_ref
LEFT JOIN office o             ON o.ghl_contact_id = c.ghl_contact_id
LEFT JOIN identity id2         ON id2.ghl_contact_id = c.ghl_contact_id
LEFT JOIN reviews r            ON r.message_type = c.message_type AND r.message_ref = c.message_ref
LEFT JOIN dismissals dm        ON dm.context_id = c.id
LEFT JOIN convo_dismissals cd  ON cd.ghl_contact_id = c.ghl_contact_id
-- The tag has to land AFTER the message and within two hours, or an unrelated
-- stop from last month would mark every message this lead ever got.
LEFT JOIN LATERAL (
  SELECT s.ghl_contact_id FROM stop_tags s
  WHERE s.ghl_contact_id = c.ghl_contact_id
    AND c.sent_at IS NOT NULL
    AND s.tagged_at >= c.sent_at
    AND s.tagged_at <= c.sent_at + interval '2 hours'
  LIMIT 1
) st ON true;

-- ═══ E. Completed views ══════════════════════════════════════════════
--
-- One row per review that still stands (not undone, not retracted), newest
-- first. Superseded rows are KEPT and flagged was_edited, because "I changed my
-- mind on this one" is part of what the Completed tab is for — hiding the
-- original would make an edit look like it never happened.
CREATE OR REPLACE VIEW v_bot_reviews_completed AS
SELECT
  f.id                                   AS feedback_id,
  f.created_at,
  f.reviewer_email,
  f.reviewer_role,
  f.counts,
  f.verdict,
  f.reason_codes,
  -- Labels, not codes: the table is read by people, and `shouldnt_have_messaged`
  -- is not a phrase anyone says out loud.
  COALESCE(
    (SELECT array_agg(br.label ORDER BY br.sort)
       FROM bot_feedback_reasons br
      WHERE br.code = ANY (f.reason_codes)),
    '{}'::text[]
  )                                      AS reason_labels,
  f.better_text,
  f.note,
  f.gold,
  f.is_calibration,
  EXISTS (
    SELECT 1 FROM bot_feedback s
     WHERE s.supersedes_id = f.id AND s.undone_at IS NULL AND s.retracted_at IS NULL
  )                                      AS was_edited,
  f.context_id,
  f.message_type,
  f.message_ref,
  f.ghl_contact_id,
  q.contact_name,
  q.contact_city,
  q.office,
  q.channel,
  q.rule_applied,
  q.workflow_code,
  q.reply_text,
  q.ai_score,
  q.replied_at,
  q.booked_at,
  q.opted_out_at,
  q.review_lane
FROM bot_feedback f
LEFT JOIN v_bot_review_queue q
  ON q.message_type = f.message_type AND q.message_ref = f.message_ref
WHERE f.undone_at IS NULL
  AND f.retracted_at IS NULL;

-- Same shape, retracted rows only. Retractions are VISIBLE rather than silently
-- vanishing — an admin has to be able to answer "who removed that review, and
-- what did it say" without opening the SQL editor.
CREATE OR REPLACE VIEW v_bot_reviews_retracted AS
SELECT
  f.id                                   AS feedback_id,
  f.created_at,
  f.reviewer_email,
  f.reviewer_role,
  f.counts,
  f.verdict,
  f.reason_codes,
  COALESCE(
    (SELECT array_agg(br.label ORDER BY br.sort)
       FROM bot_feedback_reasons br
      WHERE br.code = ANY (f.reason_codes)),
    '{}'::text[]
  )                                      AS reason_labels,
  f.better_text,
  f.note,
  f.gold,
  f.is_calibration,
  false                                  AS was_edited,
  f.context_id,
  f.message_type,
  f.message_ref,
  f.ghl_contact_id,
  q.contact_name,
  q.contact_city,
  q.office,
  q.channel,
  q.rule_applied,
  q.workflow_code,
  q.reply_text,
  q.ai_score,
  q.replied_at,
  q.booked_at,
  q.opted_out_at,
  q.review_lane,
  f.retracted_at,
  f.retracted_by,
  f.retract_reason
FROM bot_feedback f
LEFT JOIN v_bot_review_queue q
  ON q.message_type = f.message_type AND q.message_ref = f.message_ref
WHERE f.retracted_at IS NOT NULL;

-- ── Verify after applying ──────────────────────────────────────────────
-- Expect: 3, 3, 1, 4, 2.
-- SELECT
--  (SELECT count(*) FROM bot_settings WHERE key IN
--     ('spot_check_rate','must_review_score_below','must_review_include_skips')) AS settings_3,
--  (SELECT count(*) FROM information_schema.columns WHERE table_name='bot_feedback'
--     AND column_name IN ('retracted_at','retracted_by','retract_reason'))       AS retract_cols_3,
--  (SELECT count(*) FROM information_schema.tables
--     WHERE table_name='bot_review_dismissals')                                  AS dismissals_1,
--  (SELECT count(*) FROM information_schema.columns WHERE table_name='v_bot_review_queue'
--     AND column_name IN ('review_lane','must_review_cause','dismissed','reviewed_at')) AS queue_cols_4,
--  (SELECT count(*) FROM information_schema.tables
--     WHERE table_name IN ('v_bot_reviews_completed','v_bot_reviews_retracted')) AS views_2;
--
-- Lane distribution — must_review should be the small, explainable set:
-- SELECT review_lane, must_review_cause, count(*)
--   FROM v_bot_review_queue GROUP BY 1,2 ORDER BY 1,3 DESC;
--
-- Stability — run this, let outcomes land, run it again; the two must match:
-- SELECT message_type, message_ref, review_lane FROM v_bot_review_queue
--  WHERE review_lane = 'spot_check' ORDER BY 1,2;
--
-- The append-only guard still holds:
-- DELETE FROM bot_feedback WHERE id = -1;   -- must RAISE, not report 0 rows

-- ── Rollback ──────────────────────────────────────────────────────────────
-- DROP VIEW IF EXISTS v_bot_reviews_retracted;
-- DROP VIEW IF EXISTS v_bot_reviews_completed;
-- Re-apply sql/105_bot_review_contact_identity.sql to restore the queue view,
-- then sql/104 section A to restore v_bot_current_feedback. Both are
-- CREATE OR REPLACE and the sql/106 columns are appended, so no DROP is needed.
-- DROP TABLE IF EXISTS bot_review_dismissals;
-- ALTER TABLE bot_feedback
--   DROP COLUMN IF EXISTS retracted_at,
--   DROP COLUMN IF EXISTS retracted_by,
--   DROP COLUMN IF EXISTS retract_reason;
-- Then re-apply sql/103 section D to restore guard v1.
-- DELETE FROM bot_settings WHERE key IN
--   ('spot_check_rate','must_review_score_below','must_review_include_skips');
