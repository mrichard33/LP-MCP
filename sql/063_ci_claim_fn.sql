-- ============================================================================
-- 063 — Call Intelligence worker claim function
--
-- WHY A FUNCTION: the claim is a data-modifying CTE, which Postgres only
-- allows at the top level of a statement — and runSQL() wraps what it is given
-- in a SELECT. Putting the UPDATE ... FOR UPDATE SKIP LOCKED inside a SQL
-- function means the call site is `select * from claim_ci_calls(...)`, a plain
-- SELECT that wraps safely, while the locking happens inside. Same shape as
-- claim_site_identify_events (src/site-stitch.js) and claim_agent_actions
-- (sql/migrations/2026-07-03_agentic_send_hotfix.sql).
--
-- WHAT IT GUARANTEES: two workers never take the same call. Rows are claimed
-- by flipping locked_until/locked_by, and SKIP LOCKED means a worker walks
-- past a row another transaction holds instead of blocking behind it.
--
-- WHY A LEASE RATHER THAN A FLAG: locked_until is a TTL, so a worker that dies
-- mid-stage releases its claim by expiry instead of stranding the call
-- forever. The lease is the reason this is restart-safe.
--
-- ORDERING matches ci_calls_status_retry_idx (status, next_retry_at,
-- call_start) from sql/061 so the claim uses the index rather than sorting the
-- table.
--
-- NEWEST CALL FIRST (2026-08-25, reversed from oldest-first).
-- A CRM note is worth most while the call is still live for the rep working
-- the record — a note on this morning's conversation changes the next call;
-- one on a five-day-old conversation is history. Oldest-first put every fresh
-- call behind the entire backlog: with 1,509 calls queued from 08-19..08-21,
-- a call taken now would have been the 1,510th processed.
--
-- WHY THIS DOES NOT STARVE THE BACKLOG. Throughput is batch 25 every 30s
-- (~72k calls/day of capacity) against ~650 eligible calls/day of real volume,
-- so the queue empties to zero many times over in a day and old calls are
-- reached in the gaps. If that ratio ever inverts — a much larger batch of
-- history, or a much slower per-stage cost — revisit this: strict LIFO starves
-- the tail, and the fix then is a reserved share of each batch for the oldest
-- rows rather than flipping back to oldest-first.
--
-- A call too fresh to have audio yet is NOT a problem here: stageFetchRecording
-- defers it (recording_not_yet_available) until CI_RECORDING_WAIT_HOURS, and
-- next_retry_at then excludes it from this claim, so it costs one SFTP listing
-- and steps aside rather than blocking the batch.
--
-- Mirrored in runMigrations() (src/index.js). Additive; creates one function
-- and no tables. Safe to re-run — CREATE OR REPLACE.
--
-- ROLLBACK: DROP FUNCTION IF EXISTS claim_ci_calls(text[], integer, integer, text);
-- ============================================================================

CREATE OR REPLACE FUNCTION claim_ci_calls(
  p_statuses     text[],
  p_limit        integer,
  p_lease_seconds integer,
  p_worker       text
)
RETURNS SETOF ci_calls
LANGUAGE sql
AS $fn$
  WITH claimed AS (
    SELECT id FROM ci_calls
    WHERE status = ANY(p_statuses)
      AND eligible
      AND (next_retry_at IS NULL OR next_retry_at <= now())
      AND (locked_until  IS NULL OR locked_until  <  now())
    ORDER BY call_start DESC
    LIMIT GREATEST(1, p_limit)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE ci_calls c
  SET locked_until = now() + make_interval(secs => GREATEST(30, p_lease_seconds)),
      locked_by    = p_worker,
      updated_at   = now()
  FROM claimed cl
  WHERE c.id = cl.id
  RETURNING c.*;
$fn$;

COMMENT ON FUNCTION claim_ci_calls(text[], integer, integer, text) IS
  'Atomically lease eligible ci_calls rows in the given statuses. FOR UPDATE SKIP LOCKED so concurrent workers never collide; locked_until is a TTL so a dead worker self-releases.';

-- ─── Verification ────────────────────────────────────────────────────────────
-- Function exists with the expected signature:
--   SELECT p.proname, pg_get_function_arguments(p.oid)
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.proname = 'claim_ci_calls';
-- Claiming an empty table returns zero rows and errors nothing:
--   SELECT count(*) FROM claim_ci_calls(ARRAY['discovered'], 10, 300, 'verify');
-- A second immediate claim returns nothing (the first holds the lease):
--   SELECT count(*) FROM claim_ci_calls(ARRAY['discovered'], 10, 300, 'verify2');
