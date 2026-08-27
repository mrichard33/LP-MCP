-- ═══════════════════════════════════════════════════════════════════
-- GroupMe notification content dedup — 2026-08-27
--
-- The LAST line of defence against a duplicate card. Changes 1 and 2 of this
-- branch remove the two known duplicate PRODUCERS (the canvassing intake race
-- and the two-events-per-appointment defect); this table catches the third
-- identical card and every future emitter, without having to hunt each one
-- down as it appears.
--
-- Why it is needed at all: both "LP Appointment Set" emitters call
-- sendGroupMeMessage(text) with no opts, which is groupme.js's IMMEDIATE path
-- — no debounce, no dedup. Byte-identical cards therefore always send. The
-- v1.7 debounce layer does not help: it only consolidates messages that carry
-- a contactId and are not flushNow, and it is in-memory per process.
--
-- One row per (channel, exact card text) hash:
--   dedup_hash    sha256 of `${channel}|${text.trim()}`, hex.
--   channel       the logical GroupMe channel ('main', 'canvass', 'ops'), so
--                 the SAME text deliberately still sends to a DIFFERENT
--                 channel — two audiences, two legitimate cards.
--   sample        leading slice of the text, for reading the table by eye.
--   first_sent_at when this hash was last actually sent. Rewritten (not
--                 inserted) once the suppression window lapses, so a card that
--                 recurs tomorrow is news again.
--   hit_count     1 + the number of suppressions since first_sent_at, i.e.
--                 how much noise this row absorbed.
--
-- Suppression is windowed (GROUPME_DEDUP_WINDOW_MIN, default 60), never
-- permanent. A daily digest or a genuinely recurring alarm must still get
-- through tomorrow.
--
-- FAIL-OPEN on every access: any DB error, missing table, or throw sends the
-- card. Never drop a card because the dedup table is unhappy. Killable without
-- a redeploy via GROUPME_DEDUP_ENABLED=false.
--
-- Rows are pruned opportunistically at 7 days by src/groupme.js (once per
-- process-hour, never blocking a send).
--
-- DDL runs in the Supabase dashboard SQL editor, not through MCP. Apply this
-- BEFORE merging — src/index.js runMigrations mirrors it so a fresh deploy
-- self-heals, but the fail-open contract means a missing table degrades
-- silently to "no dedup at all" rather than erroring.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS groupme_notification_marks (
  dedup_hash    text PRIMARY KEY,
  channel       text,
  sample        text,
  first_sent_at timestamptz NOT NULL DEFAULT now(),
  hit_count     integer NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_gnm_first_sent_at
  ON groupme_notification_marks (first_sent_at DESC);

COMMENT ON TABLE groupme_notification_marks IS
  'Content-hash dedup backstop for outbound GroupMe cards (src/groupme.js). One row per (channel, exact text); suppression is windowed by GROUPME_DEDUP_WINDOW_MIN, not permanent. Fail-open — any error sends the card. Approval cards bypass this entirely (opts.noDedup).';
