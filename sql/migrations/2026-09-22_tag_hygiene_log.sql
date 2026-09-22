-- ═══════════════════════════════════════════════════════════════════
-- Tag hygiene log — 2026-09-22   (LP MCP Supabase — run in the dashboard)
--
-- One row per decision made by:
--   - the daily tag sweep            src/jobs/tag-hygiene-sweep.js     run_type 'sweep'
--   - the ND loss-routing backfill   scripts/backfill-loss-routing.js  run_type 'backfill_nd'
--   - the P2 loss-routing backfill   scripts/backfill-loss-routing.js  run_type 'backfill_p2'
--   - the L.6 auto-call after a P2 loss (executor)                     run_type 'l6_auto'
--
-- It is ALSO the idempotency record for L.6: a row with action='posted_l6' AND
-- mode='apply' for an opportunity_id means L.6 was already posted for it.
-- Dry runs log under mode='report' and never count.
--
-- Code ships before this is applied and fails safe without it: the sweep and
-- the executor log a warning and carry on; L.6 posts are refused (no
-- idempotency record, no post); the backfill refuses --apply.
--
-- Not mirrored in runMigrations().
--
-- ROLLBACK: DROP TABLE IF EXISTS tag_hygiene_log;
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tag_hygiene_log (
  id             bigserial PRIMARY KEY,
  run_id         text NOT NULL,
  run_type       text NOT NULL,          -- 'sweep' | 'backfill_nd' | 'backfill_p2' | 'l6_auto'
  mode           text NOT NULL,          -- 'report' | 'apply'
  contact_id     text,
  opportunity_id text,
  rule           text NOT NULL,
  action         text NOT NULL,          -- 'removed_tags' | 'retriggered_l1' | 'posted_l6' | 'needs_review' | 'skipped'
  tags           text[],
  detail         jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tag_hygiene_log_run_idx ON tag_hygiene_log (run_id);
CREATE INDEX IF NOT EXISTS tag_hygiene_log_contact_idx ON tag_hygiene_log (contact_id, created_at DESC);
-- Added beyond the handoff DDL: the L.6 idempotency read (hasPostedL6 in
-- src/tag-hygiene/log.js) filters on opportunity_id, once per post.
CREATE INDEX IF NOT EXISTS tag_hygiene_log_l6_idx ON tag_hygiene_log (opportunity_id)
  WHERE action = 'posted_l6' AND mode = 'apply';

-- Verification
-- SELECT count(*) FROM tag_hygiene_log;                         -- 0 right after creation
-- SELECT indexname FROM pg_indexes WHERE tablename = 'tag_hygiene_log';  -- pkey + the three above
