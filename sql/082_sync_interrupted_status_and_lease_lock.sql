-- 082_sync_interrupted_status_and_lease_lock.sql
--
-- WO-6 / PR A — sync container stability.
--
-- Two problems, one migration:
--
-- 1. `failed_syncs` has been counting container kills as sync failures.
--    Over the 48h to 2026-09-04, 192 of 198 "failures" were SIGTERM rows
--    written when Railway shut a container down during a deploy. Six were
--    real record-level failures. The metric is real but it does not mean
--    what its name says, which is why a "23% failure rate" sat unexamined.
--    Fix: a distinct terminal status `interrupted`, and a backfill that
--    moves the historical infrastructure rows out of `failed`.
--
-- 2. The single-flight guard is an in-memory boolean (`syncInProgress` in
--    src/sync-log.js). It cannot coordinate across processes. Railway runs
--    ONE replica, but `drainingSeconds=120` / `overlapSeconds=20` means the
--    outgoing container keeps running for up to two minutes after the new
--    one boots — so during a deploy two processes each hold their own
--    in-memory lock and each start a sweep. Measured 2026-09-04 02:28:15:
--    three separate 6-row sweep batches opened 265ms apart.
--    Fix: a leased lock row that any process can see, with an expiry rather
--    than a boolean that depends on clean shutdown to release.
--
-- Safe to re-run. No data is deleted.

BEGIN;

-- ─── 1. Paging telemetry columns (A4) ────────────────────────────
--
-- Sync duration is bimodal — most runs 0.2-0.5 min, with blowouts to 4.9,
-- 9.2, 24.7, 54.1 and 147.9 min. The standing theory is LP's deep-offset
-- paging (PageSize=1 past a deep StartIndex, ~13 rows/min), but that has
-- not been confirmed with data. These columns make the theory testable:
-- `paging_mode` is written from the branch actually taken, never inferred.

ALTER TABLE lp_sync_log ADD COLUMN IF NOT EXISTS api_calls   integer;
ALTER TABLE lp_sync_log ADD COLUMN IF NOT EXISTS paging_mode text;

COMMENT ON COLUMN lp_sync_log.api_calls IS
  'LP API round trips made by the sweep that owns this row. NULL for rows written before 082 and for entities whose sweep does not page LP directly.';
COMMENT ON COLUMN lp_sync_log.paging_mode IS
  'normal | deep — set from the paging branch actually taken, not inferred from duration. deep = LP served one row per call at a deep StartIndex.';

-- ─── 2. `interrupted` terminal status (A2) ───────────────────────
--
-- There is no CHECK constraint on lp_sync_log.status (verified against
-- pg_constraint 2026-09-04: primary key only), so no constraint edit is
-- needed. Documenting the vocabulary here instead so the next reader does
-- not have to go looking.

COMMENT ON COLUMN lp_sync_log.status IS
  'running | completed | failed | interrupted. failed = real record-level failures ONLY. interrupted = the process was killed (SIGTERM/SIGINT on deploy) or its row was orphaned by a kill and reclaimed on boot. Never alert on interrupted; alert on failed.';

-- ─── 3. Backfill: reclassify infrastructure rows (A2.4) ──────────
--
-- These four patterns are every string the codebase writes for a
-- non-data-failure terminal state:
--   'SIGTERM — container terminated'   src/sync-engine.js SIGTERM handler
--   'SIGINT — process interrupted'     src/sync-engine.js SIGINT handler
--   'Process terminated'               markRunningLogsAsFailed default
--   'Stale lock — cleaned up on boot'  boot reclaim of orphaned rows
--
-- A stale-lock row is an orphan left by a kill that could not run its own
-- shutdown handler. It is the same infrastructure event one boot later, so
-- it reclassifies with the rest.
--
-- The count is printed rather than assumed — expect ~186 SIGTERM rows for
-- the last 48h alone and more across full history.

DO $$
DECLARE
  moved integer;
BEGIN
  UPDATE lp_sync_log
     SET status = 'interrupted'
   WHERE status = 'failed'
     AND (
          error_message LIKE 'SIGTERM%'
       OR error_message LIKE 'SIGINT%'
       OR error_message LIKE 'Process terminated%'
       OR error_message LIKE 'Stale lock%'
     );
  GET DIAGNOSTICS moved = ROW_COUNT;
  RAISE NOTICE '082: reclassified % lp_sync_log rows from failed -> interrupted', moved;
END $$;

-- get_sync_health filters a 24h window by status on every call.
CREATE INDEX IF NOT EXISTS idx_lp_sync_log_started_status
  ON lp_sync_log (started_at DESC, status);

-- ─── 4. Leased single-flight lock (A3) ───────────────────────────
--
-- One row per lock key. Held by lease, not by a boolean: a holder that is
-- killed mid-sweep leaves a row whose lease simply expires, and the next
-- worker takes it cleanly with no boot cleanup step. That is the property
-- the in-memory guard could not have — it required a clean shutdown to
-- release, and a SIGKILL is not a clean shutdown.

CREATE TABLE IF NOT EXISTS lp_sync_lock (
  lock_key          text PRIMARY KEY,
  holder            text        NOT NULL,
  acquired_at       timestamptz NOT NULL DEFAULT now(),
  heartbeat_at      timestamptz NOT NULL DEFAULT now(),
  lease_expires_at  timestamptz NOT NULL
);

COMMENT ON TABLE lp_sync_lock IS
  'Cross-process single-flight lock for sync sweeps. Leased: lease_expires_at is authoritative, a holder that dies is superseded on expiry. Rows are permanent — released means lease_expires_at in the past, never a DELETE.';
COMMENT ON COLUMN lp_sync_lock.holder IS
  'Opaque owner token, unique per acquisition. Only the current holder may heartbeat or release, so a zombie process cannot release the lock its successor now holds.';

-- Acquire. Returns TRUE only if the caller now holds the lock.
--
-- The whole decision is one INSERT .. ON CONFLICT DO UPDATE .. WHERE, so
-- two callers racing on the same key cannot both win: the second one's
-- WHERE sees the first one's committed row and updates zero rows.
CREATE OR REPLACE FUNCTION lp_acquire_sync_lock(
  p_key     text,
  p_holder  text,
  p_ttl_sec integer
) RETURNS boolean
LANGUAGE sql
AS $$
  INSERT INTO lp_sync_lock (lock_key, holder, acquired_at, heartbeat_at, lease_expires_at)
  VALUES (p_key, p_holder, now(), now(), now() + make_interval(secs => p_ttl_sec))
  ON CONFLICT (lock_key) DO UPDATE
     SET holder           = EXCLUDED.holder,
         acquired_at      = EXCLUDED.acquired_at,
         heartbeat_at     = EXCLUDED.heartbeat_at,
         lease_expires_at = EXCLUDED.lease_expires_at
   -- Take it only if the incumbent lease has run out. A live holder wins.
   WHERE lp_sync_lock.lease_expires_at <= now()
  RETURNING true;
$$;

-- Extend the lease. Only the current holder can, and only while its lease
-- is still live — a process that stalled past its own expiry must not be
-- able to reclaim a lock another worker has since taken.
CREATE OR REPLACE FUNCTION lp_heartbeat_sync_lock(
  p_key     text,
  p_holder  text,
  p_ttl_sec integer
) RETURNS boolean
LANGUAGE sql
AS $$
  UPDATE lp_sync_lock
     SET heartbeat_at     = now(),
         lease_expires_at = now() + make_interval(secs => p_ttl_sec)
   WHERE lock_key = p_key
     AND holder   = p_holder
     AND lease_expires_at > now()
  RETURNING true;
$$;

-- Release by expiring the lease in place. Never deletes the row, so the
-- lock's history (who held it, when) survives for diagnosis.
CREATE OR REPLACE FUNCTION lp_release_sync_lock(
  p_key    text,
  p_holder text
) RETURNS boolean
LANGUAGE sql
AS $$
  UPDATE lp_sync_lock
     SET lease_expires_at = now()
   WHERE lock_key = p_key
     AND holder   = p_holder
  RETURNING true;
$$;

COMMIT;
