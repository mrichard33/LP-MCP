-- =============================================================================
-- 2026-07-03_agentic_consumed_messages.sql
--
-- Hard message-level dedup for inbound analysis (Steve Nkzhm incident,
-- 2026-07-03: the same inbound was analyzed both solo AND inside a combined
-- reply-buffer flush — events 1696289/90/91 — producing multiple
-- LAYER3_DISPATCH sends for one message).
--
-- Every inbound message consumed by an analysis pass (solo poller or reply-
-- buffer flush) is claimed here first, atomically. A second consumer of the
-- same (contact_id, message_key) loses the claim and drops the message from
-- its input; if that leaves the input empty, the analysis is skipped and the
-- source event is marked action_taken='deduped'.
--
-- message_key: the GHL message id when the webhook delivers one; otherwise
-- synthesized as sha1(contactId + body + floor(epoch_seconds/10)) — see
-- src/services/agentic-reply-locks.js (buildMessageKey).
--
-- Application call sites:
--   src/behavioral-emitter.js  — reply-buffer flush
--   src/message-analyzer.js    — analyzePendingReplies solo path
-- =============================================================================

CREATE TABLE IF NOT EXISTS agentic_consumed_messages (
  message_key  text NOT NULL,
  contact_id   text NOT NULL,
  consumed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, message_key)
);

CREATE INDEX IF NOT EXISTS idx_agentic_consumed_messages_consumed_at
  ON agentic_consumed_messages (consumed_at);

COMMENT ON TABLE agentic_consumed_messages IS
  'One row per inbound message consumed by agentic analysis. Insert-once claim (ON CONFLICT DO NOTHING): whoever inserts first owns the message; every other analysis pass drops it. Closes the solo-vs-buffer double-analysis race.';
COMMENT ON COLUMN agentic_consumed_messages.message_key IS
  'GHL message id, or sha1(contactId+body+floor(epoch/10)) when the webhook omitted one.';
