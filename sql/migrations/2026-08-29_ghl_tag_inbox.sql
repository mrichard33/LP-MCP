-- 2026-08-29 — GHL tag webhook durability (Project 2)
--
-- Backing store for the fast-ack path on POST /webhooks/ghl-tag.
--
-- The handler used to do the whole job inside the request: snapshot read,
-- diff, snapshot upsert, and one awaited system_events_filtered INSERT per
-- dropped tag. With ~16 tags/contact average (64 max) that serialised dozens
-- of round trips into HL MCP's 5s budget and produced 4,150 "operation was
-- aborted due to timeout" rows in webhook_failures, every one of them a
-- silently dropped tag event.
--
-- Now the handler validates, writes ONE row here, and returns 200. A worker
-- (src/jobs/ghl-tag-processor.js) drains the table and does the real work.
--
-- Deliberately NOT system_events. decision-engine.js processEvents() selects
-- every processed=false row with no event_type filter, so an envelope parked
-- there would be claimed by the Decision Engine, matched against zero rules,
-- and marked processed before the tag worker ever saw it — turning a fix for
-- dropped events into a new way to drop them. A dedicated inbox keeps
-- system_events meaning "something a rule may consume".

CREATE TABLE IF NOT EXISTS ghl_tag_inbox (
  id              bigserial   PRIMARY KEY,
  ghl_contact_id  text        NOT NULL,
  tags            text[]      NOT NULL,
  -- When the tag change happened at GHL (sent by HL MCP). Feeds the stable
  -- idempotency key on the emitted tag events so a replay cannot double-fire.
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  received_at     timestamptz NOT NULL DEFAULT now(),
  processed       boolean     NOT NULL DEFAULT false,
  processed_at    timestamptz,
  attempts        int         NOT NULL DEFAULT 0,
  last_error      text,
  -- Collapses duplicate deliveries of the same tag set for the same contact
  -- in the same minute (GHL retries, HL MCP retries, manual replay).
  idempotency_key text        UNIQUE
);

-- The worker's only read: unprocessed rows, oldest first. Ordering matters —
-- the snapshot diff is stateful, so two updates for one contact must be
-- applied in the order they arrived.
CREATE INDEX IF NOT EXISTS idx_ghl_tag_inbox_pending
  ON ghl_tag_inbox (received_at)
  WHERE processed = false;

CREATE INDEX IF NOT EXISTS idx_ghl_tag_inbox_contact
  ON ghl_tag_inbox (ghl_contact_id, received_at DESC);
