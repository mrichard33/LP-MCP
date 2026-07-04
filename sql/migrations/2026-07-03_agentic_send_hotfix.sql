-- =============================================================================
-- 2026-07-03_agentic_send_hotfix.sql
--
-- P0 hotfix for the 2026-07-03 evening incident (test contact
-- 0kk3xz6XatILy8jajymX, ~21:42-21:48 UTC): after the 21:39 direct-send
-- deploy, 8 consecutive send_message actions terminal-skipped
-- (outbound_lock_held / agentic_cooldown / superseded_by_newer_job) and the
-- substantive reply was dropped. Companion code changes live on branch
-- claude/lock-deadlock-dropped-replies-218ns4.
--
-- Run in: LP MCP Supabase → SQL Editor, BEFORE deploying the code.
-- Everything here is idempotent and backward compatible: the currently
-- deployed code ignores the new columns and functions, and claim v2 behaves
-- identically for rows whose retry_at is NULL (all existing rows).
--
-- Contents:
--   (a) agent_actions.retry_at            — DB-persisted deferral ("defer,
--       don't drop"): cooldown/lock-held sends park as status='pending' with
--       a future retry_at instead of an in-process setTimeout that dies on
--       every Railway redeploy (which is exactly how the incident's replies
--       were stranded).
--   (b) agentic_reply_locks sent marker   — last_message_id/-conversation_id
--       written the moment GHL returns 2xx. A watchdog-timed-out ("zombie")
--       send that actually delivered is detected by its retry via this
--       marker and completed as a dedup instead of re-sent.
--   (c) acquire_agentic_reply_lock()      — atomic, re-entrant, row-locked
--       slot acquisition replacing the app-side read-then-write loop. Also
--       fixes the superseded_by forensics (was writing the NEW job's own id
--       — the incident's self-referential 165923/165923 row) and adds
--       newest-job-wins ordering so a stale retry can never displace a
--       newer reply.
--   (d) claim_agent_actions() v2          — retry_at gate. Live v1 body was
--       captured via pg_get_functiondef on 2026-07-03 and is identical to
--       this one minus the retry_at predicate.
-- =============================================================================

-- ── (a) deferral column ─────────────────────────────────────────────────────
ALTER TABLE agent_actions ADD COLUMN IF NOT EXISTS retry_at timestamptz;

COMMENT ON COLUMN agent_actions.retry_at IS
  'Earliest instant the executor may claim this pending row. NULL = claimable now. Set by deferral outcomes (agentic_cooldown, outbound_lock_held) so a blocked send is delayed, never dropped.';

CREATE INDEX IF NOT EXISTS idx_agent_actions_pending_retry
  ON agent_actions (retry_at)
  WHERE status = 'pending' AND retry_at IS NOT NULL;

-- ── (b) sent marker + superseded_by forensics fix ───────────────────────────
ALTER TABLE agentic_reply_locks ADD COLUMN IF NOT EXISTS last_message_id text;
ALTER TABLE agentic_reply_locks ADD COLUMN IF NOT EXISTS last_conversation_id text;

COMMENT ON COLUMN agentic_reply_locks.last_message_id IS
  'GHL message id of the holder''s delivered send, written at GHL 2xx (before any post-send work). A retry of the same job_id that finds this marker completes as a dedup instead of re-sending.';
COMMENT ON COLUMN agentic_reply_locks.superseded_by IS
  'job_id of the DISPLACED (older, unsent) job recorded at takeover time. Forensic only — supersession detection compares job_id. (Pre-hotfix code wrote the new job''s own id here.)';

-- ── (c) atomic re-entrant slot acquisition ──────────────────────────────────
-- Outcomes (jsonb {outcome, ...}):
--   acquired            — fresh row inserted; caller holds the slot
--   already_held        — re-entrant: this job already holds the in_flight row
--   already_sent        — this job's prior attempt committed a send; carries
--                         message_id/conversation_id for the dedup completion
--   cooldown            — cooldown_until is in the future; carries retry_at
--   yield_to_newer      — a NEWER numeric job holds the slot live; this older
--                         job is the stale one and must terminal-skip
--   superseded          — this job displaced an older live unsent holder;
--                         carries superseded_job_id (the displaced id)
--   reclaim_expired     — took over a crashed holder (in_flight past TTL)
--   reclaim_after_send  — took over a sent row whose cooldown has passed
CREATE OR REPLACE FUNCTION acquire_agentic_reply_lock(
  p_contact_id text,
  p_job_id     text,
  p_trigger_id text,
  p_holder     text,
  p_ttl_sec    integer DEFAULT 120
) RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  r agentic_reply_locks%ROWTYPE;
  v_new_numeric bigint;
  v_old_numeric bigint;
BEGIN
  SELECT * INTO r FROM agentic_reply_locks WHERE contact_id = p_contact_id FOR UPDATE;

  IF NOT FOUND THEN
    BEGIN
      INSERT INTO agentic_reply_locks
        (contact_id, job_id, status, holder, trigger_id, superseded_by,
         locked_at, cooldown_until, last_message_id, last_conversation_id, updated_at)
      VALUES
        (p_contact_id, p_job_id, 'in_flight', p_holder, p_trigger_id, NULL,
         now(), NULL, NULL, NULL, now());
      RETURN jsonb_build_object('outcome', 'acquired');
    EXCEPTION WHEN unique_violation THEN
      -- lost the insert race; fall through to the row-locked decision below
      SELECT * INTO r FROM agentic_reply_locks WHERE contact_id = p_contact_id FOR UPDATE;
    END;
  END IF;

  -- Re-entrant: this job already holds the slot (retry after watchdog timeout,
  -- double dispatch, etc.). Never blocked by its own lock. The row adopts the
  -- caller's fresh holder token so a prior zombie attempt's late release
  -- (conditional on ITS token) can no longer delete this attempt's row.
  IF r.status = 'in_flight' AND r.job_id = p_job_id THEN
    UPDATE agentic_reply_locks SET
      holder = p_holder, locked_at = now(), updated_at = now()
    WHERE contact_id = p_contact_id;
    RETURN jsonb_build_object('outcome', 'already_held', 'prior_holder', r.holder);
  END IF;

  -- This job's prior attempt already delivered (zombie sent, then the action
  -- row was retried). Retry completes as a dedup — no resend, ever.
  IF r.status = 'sent' AND r.job_id = p_job_id THEN
    RETURN jsonb_build_object('outcome', 'already_sent',
      'message_id', r.last_message_id,
      'conversation_id', r.last_conversation_id);
  END IF;

  -- Cooldown keys on the last SUCCESSFUL send (cooldown_until is armed only
  -- by the commit-at-2xx), never on attempt timestamps.
  IF r.cooldown_until IS NOT NULL AND r.cooldown_until > now() THEN
    RETURN jsonb_build_object('outcome', 'cooldown', 'retry_at', r.cooldown_until);
  END IF;

  -- Live in_flight holder: newest numeric job wins. A stale (lower-id) retry
  -- meeting a newer live holder yields; a newer job displaces the older
  -- UNSENT holder (which aborts at its pre-POST supersession check).
  IF r.status = 'in_flight' AND (now() - r.locked_at) <= make_interval(secs => p_ttl_sec) THEN
    v_new_numeric := CASE WHEN p_job_id ~ '^[0-9]+$' THEN p_job_id::bigint END;
    v_old_numeric := CASE WHEN r.job_id  ~ '^[0-9]+$' THEN r.job_id::bigint  END;
    IF v_new_numeric IS NOT NULL AND v_old_numeric IS NOT NULL
       AND v_new_numeric < v_old_numeric THEN
      RETURN jsonb_build_object('outcome', 'yield_to_newer', 'newer_job_id', r.job_id);
    END IF;
    UPDATE agentic_reply_locks SET
      job_id = p_job_id, status = 'in_flight', holder = p_holder,
      trigger_id = p_trigger_id,
      superseded_by = r.job_id,          -- the DISPLACED job's id
      locked_at = now(), cooldown_until = NULL,
      last_message_id = NULL, last_conversation_id = NULL, updated_at = now()
    WHERE contact_id = p_contact_id;
    RETURN jsonb_build_object('outcome', 'superseded', 'superseded_job_id', r.job_id);
  END IF;

  -- Expired in_flight (crashed holder) or sent row past cooldown: reclaim.
  UPDATE agentic_reply_locks SET
    job_id = p_job_id, status = 'in_flight', holder = p_holder,
    trigger_id = p_trigger_id, superseded_by = NULL,
    locked_at = now(), cooldown_until = NULL,
    last_message_id = NULL, last_conversation_id = NULL, updated_at = now()
  WHERE contact_id = p_contact_id;
  RETURN jsonb_build_object('outcome',
    CASE WHEN r.status = 'in_flight' THEN 'reclaim_expired' ELSE 'reclaim_after_send' END);
END
$fn$;

-- ── (d) claim v2: retry_at gate ─────────────────────────────────────────────
-- Identical to the live v1 (captured 2026-07-03) plus the retry_at predicate,
-- so deferred rows become claimable exactly at their retry_at.
CREATE OR REPLACE FUNCTION claim_agent_actions(p_limit integer)
RETURNS SETOF agent_actions
LANGUAGE sql
AS $fn$
  UPDATE agent_actions
  SET status = 'executing', updated_at = now()
  WHERE id IN (
    SELECT id FROM agent_actions
    WHERE status = 'pending'
      AND (retry_at IS NULL OR retry_at <= now())
    ORDER BY priority ASC NULLS LAST, created_at ASC, sequence_order ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
$fn$;
