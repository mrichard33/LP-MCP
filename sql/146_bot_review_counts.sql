-- 146_bot_review_counts.sql
--
-- 2026-10-06 (Bot Review thread cleanup; pairs with Reece-Dashboard
-- lib/queries/botReview.ts). Apply from the Supabase dashboard (LP project).
--
-- 1. bot_review_counts(p_since) — ONE read for the six numbers the Bot Review
--    page used to fetch with six count queries on every click: getHeaderCounts
--    (to review, this week's total, this week's reviewed) and getLaneCounts
--    (must review, spot check, everything). Same conditions as those queries,
--    one scan of v_bot_review_queue. The view itself is unchanged.
--    It also returns bot_settings.review_thread_cutover_at, so the page reads
--    that setting without a seventh round trip.
--    The dashboard falls back to the old six queries when this function is
--    missing, so it can deploy before this file is applied.
--
-- 2. bot_settings.review_thread_cutover_at — Mark's ruling 2026-10-06: Bot
--    Review must not show anything from before the new agentic system took
--    over (old GHL Conversation AI history). Hidden on screen, never deleted:
--    the GHL history is the customer record. Reviews were recorded from
--    2026-09-11 on. ON CONFLICT DO NOTHING, so an edited value survives a re-run.
--
-- Mirrored in src/admin/startup-mirrors.js (sql/146) for the function only.

CREATE OR REPLACE FUNCTION bot_review_counts(p_since timestamptz)
RETURNS json
LANGUAGE sql
STABLE
AS $fn$
  SELECT json_build_object(
    'to_review',     count(*) FILTER (WHERE q.review_count = 0),
    'week_total',    count(*) FILTER (WHERE q.generated_at >= p_since),
    'week_reviewed', count(*) FILTER (WHERE q.generated_at >= p_since AND q.review_count > 0),
    'must_review',   count(*) FILTER (WHERE q.review_lane = 'must_review' AND q.dismissed IS FALSE AND q.review_count = 0),
    'spot_check',    count(*) FILTER (WHERE q.review_lane = 'spot_check'  AND q.dismissed IS FALSE AND q.review_count = 0),
    'everything',    count(*),
    'thread_cutover_at', (SELECT s.value #>> '{}' FROM bot_settings s WHERE s.key = 'review_thread_cutover_at')
  )
  FROM v_bot_review_queue q;
$fn$;

-- Same grant posture as sql/145: the dashboard reads with the service-role key.
REVOKE EXECUTE ON FUNCTION bot_review_counts(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION bot_review_counts(timestamptz) TO service_role;

INSERT INTO bot_settings (key, value)
VALUES ('review_thread_cutover_at', '"2026-09-11T19:00:00Z"'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Verify:
--   SELECT bot_review_counts(now() - interval '7 days');
--   SELECT value FROM bot_settings WHERE key = 'review_thread_cutover_at';
-- Rollback:
--   DROP FUNCTION IF EXISTS bot_review_counts(timestamptz);
--   DELETE FROM bot_settings WHERE key = 'review_thread_cutover_at';
