-- ============================================================================
-- 071 — Call Intelligence: a sync row can say "sent, not yet confirmed"
--
-- WHY: /api/SalesApi/AddNotes answers every successful write with the constant
-- string "UPDATED SUCCESSFULLY!" — no id, no echo, nothing that varies with
-- what was written. So the only signal the write site has is that lpPost did
-- not raise, which proves LP returned 2xx and nothing more.
--
-- ci_syncs had no state for that. `synced` was written on the strength of a
-- non-throw, so a delivered note and a note LP accepted-then-dropped were the
-- same row. On 2026-08-24 that let 286 rows record `synced` over four hours
-- with nobody able to tell which of them a rep could actually read.
--
-- These three columns let the row tell the truth: syncToLp records
-- 'sent_unconfirmed', and src/ci/verify.js promotes it to 'synced' only after
-- reading the note back out of LP.
--
-- ── 'sent_unconfirmed' IS A LIVE STATE, NOT AN ERROR ───────────────────────
-- It means "LP accepted this write and we have not looked yet" — the normal
-- state of every LP note for the first couple of minutes of its life. It is
-- NOT a failure and NOT a retry signal: the idempotency key is already held,
-- so nothing will re-send it, which is exactly right for a write that may well
-- have landed. Anything reading ci_syncs for delivery counts must treat
-- ('synced' + 'sent_unconfirmed') as "went out" and only 'synced' as "proven".
--
-- ── WHY external_ref FINALLY GETS A VALUE ──────────────────────────────────
-- The read-back carries the real lp_note_id, which AddNotes refuses to return.
-- Verified rows populate external_ref with it, so an audit can join a ci_syncs
-- row to the note a rep read. Rows written before this migration keep NULL and
-- that stays correct — see the comment at the LP write site in src/ci/sync.js.
--
-- ── verify_attempts COUNTS READS, NOT WRITES ───────────────────────────────
-- Deliberately separate from `attempts`, which counts delivery attempts and
-- drives the retry backoff. These count how many times we have LOOKED. Merging
-- them would make a slow LP read look like a failed note delivery, and the
-- backoff would then delay a note that was already sitting on the record.
--
-- Only a SUCCESSFUL read that did not contain the note increments this. A read
-- that failed leaves it alone: unknown is not absent, and burning attempts on
-- an LP outage would fail notes that were delivered.
--
-- Mirrored in runMigrations() (src/index.js). Purely additive: two nullable
-- columns and a WIDENED check constraint. Widening admits a new value and
-- rejects nothing that was previously allowed, so no existing row can violate
-- it and no row is rewritten.
--
-- ROLLBACK (drain first — see below):
--   UPDATE ci_syncs SET status = 'pending' WHERE status = 'sent_unconfirmed';
--   ALTER TABLE ci_syncs DROP CONSTRAINT ci_syncs_status_check;
--   ALTER TABLE ci_syncs ADD CONSTRAINT ci_syncs_status_check
--     CHECK (status = ANY (ARRAY['pending','shadow','synced','failed','skipped']));
--   ALTER TABLE ci_syncs DROP COLUMN IF EXISTS verify_attempts;
--   ALTER TABLE ci_syncs DROP COLUMN IF EXISTS verified_at;
--   -- The UPDATE must come FIRST. Narrowing the constraint while any row is
--   -- still 'sent_unconfirmed' fails the ALTER, and 'pending' is the honest
--   -- landing spot: the key is still held, so nothing re-sends.
-- ============================================================================

ALTER TABLE ci_syncs ADD COLUMN IF NOT EXISTS verified_at     timestamptz;
ALTER TABLE ci_syncs ADD COLUMN IF NOT EXISTS verify_attempts integer NOT NULL DEFAULT 0;

ALTER TABLE ci_syncs DROP CONSTRAINT IF EXISTS ci_syncs_status_check;
ALTER TABLE ci_syncs ADD CONSTRAINT ci_syncs_status_check
  CHECK (status = ANY (ARRAY['pending','shadow','synced','sent_unconfirmed','failed','skipped']));

-- The verify sweep claims the oldest unconfirmed LP notes each tick. Without
-- this it seq-scans ci_syncs every five minutes for a handful of rows.
CREATE INDEX IF NOT EXISTS ci_syncs_unconfirmed_idx
  ON ci_syncs (synced_at)
  WHERE status = 'sent_unconfirmed';

-- ─── Verification ────────────────────────────────────────────────────────────
-- The new value is admitted and the old ones still are:
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conname = 'ci_syncs_status_check';
--   -- expect all six of pending/shadow/synced/sent_unconfirmed/failed/skipped
--
-- Both columns present, verify_attempts never null:
--   SELECT column_name, data_type, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_name = 'ci_syncs'
--      AND column_name IN ('verified_at','verify_attempts');
--   -- expect verified_at timestamptz/YES, verify_attempts integer/NO/0
--
-- A verified row carries its receipt (0 rows, always — verify.js sets both or
-- neither):
--   SELECT count(*) FROM ci_syncs
--    WHERE verified_at IS NOT NULL AND status <> 'synced';
--   -- expect 0
--
-- Nothing is stuck unconfirmed. A handful of recent rows is HEALTHY — that is
-- the settle window (CI_VERIFY_DELAY_MS, default 2 min). Rows older than an
-- hour mean the sweep is not running or LP reads are failing:
--   SELECT count(*) FILTER (WHERE synced_at > now() - interval '10 minutes') AS settling,
--          count(*) FILTER (WHERE synced_at < now() - interval '1 hour')     AS STUCK
--     FROM ci_syncs WHERE status = 'sent_unconfirmed';
--   -- expect STUCK = 0
--
-- Notes LP accepted but does not hold — the 08-24 failure mode, now visible:
--   SELECT count(*) FROM ci_syncs
--    WHERE status = 'failed' AND error LIKE 'not_present_in_lp%';
--   -- expect 0; anything else is a real delivery defect, not a retry backlog
--
-- Delivery counts must include BOTH live states, or a dashboard reads the
-- settle window as an outage:
--   SELECT status, count(*) FROM ci_syncs WHERE target = 'lp' GROUP BY 1;
