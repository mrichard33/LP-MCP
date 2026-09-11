-- 106_intake_journal.sql — write-ahead journal for lead-carrying intake routes
--
-- WHY
-- ───
-- Several intake routes ack before doing the work: res.json(...) and then an
-- un-awaited handler. A container kill in between loses the work SILENTLY —
-- the sender already received a 200, so it never shows up as an error, and no
-- error-rate metric can ever prove the loss did not happen.
--
-- This table is the proof. Every lead-carrying request is written here BEFORE
-- its handler runs, and stamped again when the response finishes. A row left
-- at status='received' is a request that started and never finished, with its
-- payload preserved so it can be re-submitted by hand.
--
-- Run this in the Supabase dashboard SQL editor (LP instance) before merge.
-- runMigrations() mirrors the same statements so a deploy self-heals.
-- Additive only: new table, nothing existing is touched.
--
-- Volume note: only lead routes are journaled. /webhooks/ghl-tag (~40k/week)
-- is deliberately excluded — it is already durable via ghl_tag_inbox.

CREATE TABLE IF NOT EXISTS intake_journal (
  id               bigserial PRIMARY KEY,
  route            text        NOT NULL,
  method           text        NOT NULL DEFAULT 'POST',
  received_at      timestamptz NOT NULL DEFAULT now(),
  deployment_id    text,
  headers          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  query            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  body             jsonb,
  body_truncated   boolean     NOT NULL DEFAULT false,
  status           text        NOT NULL DEFAULT 'received'
                   CHECK (status IN ('received','done','rejected','failed')),
  response_status  integer,
  completed_at     timestamptz,
  error            text
);

-- The sweeper's hot path: unfinished and failed rows only. A partial index
-- keeps it tiny even as the 'done' rows accumulate.
CREATE INDEX IF NOT EXISTS idx_intake_journal_open
  ON intake_journal (received_at) WHERE status IN ('received','failed');

-- Powers GET /admin/intake-journal/summary (counts by route x status).
CREATE INDEX IF NOT EXISTS idx_intake_journal_route
  ON intake_journal (route, received_at DESC);
