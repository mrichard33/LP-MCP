-- 104_bot_review_views.sql — Bot Review Phase 1 read models.
-- Apply in LP Supabase SQL editor, in order. Requires sql/103_bot_feedback_core.sql.
--
-- Handoff §4.2. The column contract is fixed by the handoff; the SQL is ours.
-- Every view is a pure read — no table is written here, and dropping any of
-- them breaks only the dashboard's Bot Review page, never the send path.
--
-- DDL doctrine: sql/README.md. Applied BY HAND in the dashboard.
--
-- Views are CREATE OR REPLACE, so re-running this file is safe. Column lists
-- are pinned by name (never SELECT *) because CREATE OR REPLACE VIEW cannot
-- change a column's name, type or position — a future edit that reorders them
-- has to DROP first, and the drop block at the foot of this file is there for
-- exactly that.

-- ═══════════════════════════════════════════════════════════════════
-- A. v_bot_current_feedback — one live row per reviewer per message
-- ═══════════════════════════════════════════════════════════════════
--
-- "Current" means three things at once, and all three matter:
--   · not undone            (undone_at IS NULL — the 10s undo window)
--   · not superseded        (no later row points at it via supersedes_id)
--   · the newest remaining  (a reviewer who edits twice has two survivors
--                            otherwise, and every rate would double-count them)
--
-- bot_feedback is append-only, so an edit is a NEW row carrying supersedes_id.
-- Everything downstream reads this view, never the table, so the append-only
-- history stays intact while the reports see exactly one verdict per reviewer.
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
  AND NOT EXISTS (
    SELECT 1 FROM bot_feedback s
    WHERE s.supersedes_id = f.id AND s.undone_at IS NULL
  )
ORDER BY f.message_type, f.message_ref, f.reviewer_email, f.created_at DESC, f.id DESC;

-- ═══════════════════════════════════════════════════════════════════
-- B. v_bot_review_queue — one row per fingerprinted message
-- ═══════════════════════════════════════════════════════════════════
--
-- ai_score is normalised to 0–100 for BOTH sources, because the queue sorts and
-- badges on one number:
--   · replies  message_scores.overall_score, the scorer's 0.0–1.0 MIN across
--              its five dimensions (its own docs say "multiply by 100 for
--              percentage display"). The MIN, not the mean, because the queue
--              exists to surface the worst messages.
--   · nurture  agentic_messages.confidence_score, already the same 0–1 scale.
-- A message with no score yet is NULL, never 0 — unscored and bad are different
-- things, and priority 3 must not fire on the former.
--
-- message_ref is text in the fingerprint and bigint / uuid at the sources, so
-- every join casts the SOURCE to text. Casting the other way would throw on the
-- first non-numeric ref.
--
-- my_verdict is deliberately absent: it depends on who is looking, and a view
-- cannot know that. The app fills it per reviewer (handoff §4.2).
CREATE OR REPLACE VIEW v_bot_review_queue AS
WITH scores AS (
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
  -- GHL contact → LP lead → market. Many LP leads can share a contact, so pick
  -- one deterministically rather than fanning the queue out into duplicates.
  SELECT DISTINCT ON (l.ghl_contact_id)
    l.ghl_contact_id,
    m.resolved_market_code
  FROM lp_leads l
  JOIN lp_lead_market_assignments m ON m.lead_id = l.lp_lead_id
  WHERE l.ghl_contact_id IS NOT NULL AND m.resolved_market_code IS NOT NULL
  ORDER BY l.ghl_contact_id, m.resolved_at DESC NULLS LAST
),
reviews AS (
  SELECT
    cf.message_type,
    cf.message_ref,
    count(*)                                              AS review_count,
    count(*) FILTER (WHERE cf.counts)                     AS counting_count,
    count(*) FILTER (WHERE cf.counts AND cf.verdict = 'good')       AS good_count,
    count(*) FILTER (WHERE cf.counts AND cf.verdict = 'needs_work') AS needs_count,
    count(*) FILTER (WHERE cf.counts AND cf.verdict = 'unsafe')     AS unsafe_count,
    -- The admin's verdict wins outright when one exists; §4.2.
    max(cf.verdict) FILTER (WHERE cf.reviewer_role = 'admin')       AS admin_verdict
  FROM v_bot_current_feedback cf
  GROUP BY cf.message_type, cf.message_ref
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
  NULL::text                             AS my_verdict,   -- filled per reviewer in the app
  CASE
    WHEN r.admin_verdict IS NOT NULL THEN r.admin_verdict
    WHEN COALESCE(r.counting_count, 0) = 0 THEN NULL
    WHEN r.unsafe_count > r.good_count AND r.unsafe_count >= r.needs_count THEN 'unsafe'
    WHEN r.good_count > (r.needs_count + r.unsafe_count) THEN 'good'
    WHEN (r.needs_count + r.unsafe_count) > r.good_count THEN 'needs_work'
    ELSE NULL                                              -- a genuine tie is not a consensus
  END                                    AS consensus_verdict,
  CASE
    WHEN bo.opted_out_at IS NOT NULL THEN 1
    WHEN c.message_type = 'skip' THEN 2
    WHEN CASE WHEN c.message_type = 'nurture' THEN round(am.confidence_score * 100)
              ELSE round(sc.overall_score * 100) END < 60 THEN 3
    WHEN c.rule_applied LIKE 'OBJ\_%' OR c.rule_applied LIKE '%BOOKING%'
      OR c.rule_applied = 'LAYER3_DISPATCH' THEN 4
    ELSE 5
  END::int                               AS priority
FROM bot_message_context c
LEFT JOIN scores sc            ON sc.message_ref = c.message_ref AND c.message_type <> 'nurture'
LEFT JOIN agentic_messages am  ON am.id::text = c.message_ref    AND c.message_type = 'nurture'
LEFT JOIN bot_outcomes bo      ON bo.message_type = c.message_type AND bo.message_ref = c.message_ref
LEFT JOIN office o             ON o.ghl_contact_id = c.ghl_contact_id
LEFT JOIN reviews r            ON r.message_type = c.message_type AND r.message_ref = c.message_ref;

-- ═══════════════════════════════════════════════════════════════════
-- C. v_bot_reviewer_agreement — who counts, and how well they agree
-- ═══════════════════════════════════════════════════════════════════
--
-- Agreement is measured on the GOOD vs NOT-GOOD split, not on the three-way
-- verdict. A reviewer who says "unsafe" where Mark said "needs work" has caught
-- the same problem; treating that as a miss would punish caution, and caution is
-- the behavior this program wants.
--
-- Operators and admins are calibrated by role — they are the baseline everyone
-- else is measured against, so requiring them to calibrate against themselves
-- would be circular.
CREATE OR REPLACE VIEW v_bot_reviewer_agreement AS
WITH settings AS (
  SELECT
    COALESCE((SELECT value::text::numeric FROM bot_settings WHERE key = 'calibration_cases'), 30)      AS cal_cases,
    COALESCE((SELECT value::text::numeric FROM bot_settings WHERE key = 'calibration_agreement'), 0.80) AS cal_agreement
),
admin_verdicts AS (
  SELECT cf.message_type, cf.message_ref, bool_or(cf.verdict = 'good') AS admin_good
  FROM v_bot_current_feedback cf
  WHERE cf.reviewer_role = 'admin'
  GROUP BY cf.message_type, cf.message_ref
),
per_reviewer AS (
  SELECT
    cf.reviewer_email,
    max(cf.reviewer_role)                                                       AS reviewer_role,
    count(*) FILTER (WHERE cf.created_at > now() - interval '30 days')::int      AS reviews_30d,
    count(*) FILTER (WHERE cf.is_calibration)::int                              AS calibration_done,
    count(*) FILTER (WHERE av.admin_good IS NOT NULL
                       AND cf.reviewer_role <> 'admin')::int                    AS comparable,
    count(*) FILTER (WHERE av.admin_good IS NOT NULL
                       AND cf.reviewer_role <> 'admin'
                       AND (cf.verdict = 'good') = av.admin_good)::int          AS matched
  FROM v_bot_current_feedback cf
  LEFT JOIN admin_verdicts av
    ON av.message_type = cf.message_type AND av.message_ref = cf.message_ref
  GROUP BY cf.reviewer_email
)
SELECT
  p.reviewer_email,
  p.reviewer_role,
  p.reviews_30d,
  p.calibration_done,
  p.comparable                                   AS agreement_sample,
  CASE WHEN p.comparable = 0 THEN NULL
       ELSE round(p.matched::numeric / p.comparable, 4) END AS agreement,
  (
    p.reviewer_role IN ('operator', 'admin')
    OR (p.calibration_done >= s.cal_cases
        AND p.comparable > 0
        AND (p.matched::numeric / p.comparable) >= s.cal_agreement)
  )                                              AS calibrated,
  s.cal_cases::int                               AS calibration_target,
  s.cal_agreement                                AS agreement_target
FROM per_reviewer p CROSS JOIN settings s;

-- ═══════════════════════════════════════════════════════════════════
-- D. v_bot_quality_weekly — is the bot getting better, per path
-- ═══════════════════════════════════════════════════════════════════
--
-- The week is an ET week (handoff §0: the business runs on ET, timestamps are
-- stored UTC). date_trunc runs on the local timestamp and the result is stamped
-- back to ET, so a Sunday-11pm-ET message lands in the right week rather than
-- next week's UTC bucket.
--
-- "path" is rule_applied for replies and skips, workflow_code for nurture —
-- coalesced into one column so the Scoreboard has a single thing to group on.
--
-- enough_data guards every rate: below report_min_sample the dashboard renders
-- "Not enough data yet" rather than a percentage built on four reviews.
CREATE OR REPLACE VIEW v_bot_quality_weekly AS
WITH settings AS (
  SELECT COALESCE((SELECT value::text::numeric FROM bot_settings WHERE key = 'report_min_sample'), 30) AS min_sample
),
base AS (
  SELECT
    date_trunc('week', q.generated_at AT TIME ZONE 'America/New_York')::date AS et_week,
    COALESCE(q.rule_applied, q.workflow_code, '(none)')   AS path,
    COALESCE(q.channel, '(unknown)')                      AS channel,
    q.message_type,
    q.message_ref,
    q.ai_score,
    q.replied_at,
    q.booked_at,
    q.opted_out_at
  FROM v_bot_review_queue q
),
verdicts AS (
  SELECT
    cf.message_type,
    cf.message_ref,
    bool_or(cf.verdict = 'good')       AS any_good,
    bool_or(cf.verdict = 'needs_work') AS any_needs,
    bool_or(cf.verdict = 'unsafe')     AS any_unsafe
  FROM v_bot_current_feedback cf
  WHERE cf.counts
  GROUP BY cf.message_type, cf.message_ref
)
SELECT
  b.et_week,
  b.path,
  b.channel,
  count(*)::int                                                        AS sent,
  count(v.*)::int                                                      AS reviewed,
  -- One verdict per message: unsafe outranks needs_work outranks good, so a
  -- message two reviewers split on is counted once, at its worst reading.
  count(*) FILTER (WHERE v.any_good AND NOT v.any_needs AND NOT v.any_unsafe)::int AS good,
  count(*) FILTER (WHERE v.any_needs AND NOT v.any_unsafe)::int        AS needs_work,
  count(*) FILTER (WHERE v.any_unsafe)::int                            AS unsafe,
  CASE WHEN count(v.*) = 0 THEN NULL ELSE
    round(count(*) FILTER (WHERE v.any_good AND NOT v.any_needs AND NOT v.any_unsafe)::numeric
          / count(v.*), 4) END                                         AS good_rate,
  CASE WHEN count(v.*) = 0 THEN NULL ELSE
    round(100.0 * count(*) FILTER (WHERE v.any_needs OR v.any_unsafe)::numeric
          / count(v.*), 2) END                                         AS issues_per_100,
  round(avg(b.ai_score), 1)                                            AS avg_ai_score,
  round(count(*) FILTER (WHERE b.replied_at IS NOT NULL)::numeric   / NULLIF(count(*), 0), 4) AS reply_rate,
  round(count(*) FILTER (WHERE b.booked_at IS NOT NULL)::numeric    / NULLIF(count(*), 0), 4) AS booking_rate,
  round(count(*) FILTER (WHERE b.opted_out_at IS NOT NULL)::numeric / NULLIF(count(*), 0), 4) AS optout_rate,
  (count(v.*) >= (SELECT min_sample FROM settings))                    AS enough_data
FROM base b
LEFT JOIN verdicts v ON v.message_type = b.message_type AND v.message_ref = b.message_ref
GROUP BY b.et_week, b.path, b.channel;

-- ═══════════════════════════════════════════════════════════════════
-- E. v_bot_top_issues — which reason is hurting, this week vs last
-- ═══════════════════════════════════════════════════════════════════
--
-- One row per reason code, always: a reason that appeared last week and
-- vanished this week is the most useful row on the page, and an inner join
-- would hide it. Counts are per FLAG, not per message — a message flagged by
-- two reviewers for the same reason is two pieces of evidence for that reason.
CREATE OR REPLACE VIEW v_bot_top_issues AS
WITH weeks AS (
  -- `AT TIME ZONE` binds tighter than `-`, so the subtraction has to happen
  -- INSIDE the conversion or Postgres reads it as `interval AT TIME ZONE` and
  -- errors. Simpler still: the local timestamp cast straight to date already
  -- IS the ET week start — no round trip back to timestamptz needed.
  SELECT
    date_trunc('week', now() AT TIME ZONE 'America/New_York')::date                      AS this_week,
    (date_trunc('week', now() AT TIME ZONE 'America/New_York') - interval '7 days')::date AS last_week
),
flags AS (
  SELECT
    unnest(cf.reason_codes) AS reason_code,
    date_trunc('week', cf.created_at AT TIME ZONE 'America/New_York')::date AS et_week
  FROM v_bot_current_feedback cf
  WHERE cf.counts
)
SELECT
  r.code                                     AS reason_code,
  r.label,
  r.default_lane,
  r.severity,
  COALESCE(t.n, 0)::int                      AS this_week,
  COALESCE(p.n, 0)::int                      AS last_week,
  (COALESCE(t.n, 0) - COALESCE(p.n, 0))::int AS delta
FROM bot_feedback_reasons r
CROSS JOIN weeks w
LEFT JOIN (SELECT reason_code, count(*) AS n FROM flags, weeks
            WHERE flags.et_week = weeks.this_week GROUP BY reason_code) t ON t.reason_code = r.code
LEFT JOIN (SELECT reason_code, count(*) AS n FROM flags, weeks
            WHERE flags.et_week = weeks.last_week GROUP BY reason_code) p ON p.reason_code = r.code
WHERE r.active;

-- ── Verify (run after applying; views_5 should be 5) ───────────────────────
-- SELECT count(*) AS views_5 FROM information_schema.views
--  WHERE table_schema='public' AND table_name IN
--   ('v_bot_current_feedback','v_bot_review_queue','v_bot_reviewer_agreement',
--    'v_bot_quality_weekly','v_bot_top_issues');
-- SELECT count(*) FROM v_bot_review_queue;      -- 0 until the bot sends again
-- SELECT * FROM v_bot_top_issues ORDER BY this_week DESC;  -- 11 rows, all zero

-- ── Rollback ──────────────────────────────────────────────────────────────
-- Dependency order matters: the queue and agreement views read
-- v_bot_current_feedback, and quality/top-issues read both.
-- DROP VIEW IF EXISTS v_bot_top_issues;
-- DROP VIEW IF EXISTS v_bot_quality_weekly;
-- DROP VIEW IF EXISTS v_bot_reviewer_agreement;
-- DROP VIEW IF EXISTS v_bot_review_queue;
-- DROP VIEW IF EXISTS v_bot_current_feedback;
