/**
 * Agentic send-message flow — src/actions/send-message-flow.js
 *
 * The lock/dedup/defer orchestration around executeSendMessage, extracted
 * from src/actions/index.js in the 2026-07-03 evening hotfix (dropped-replies
 * incident, contact 0kk3xz6XatILy8jajymX). All I/O arrives via `deps` so the
 * whole flow is testable with in-memory fakes (scripts/test-send-flow.js) —
 * the repo's pure-core pattern, one level up.
 *
 * Gate order:
 *   1. checkSuppression                — tag-based universal gate (snapshot)
 *   2. acquireSlot (agentic_reply_locks) — per-contact single-flight +
 *      cooldown + supersede, now atomic + re-entrant via RPC
 *   3. tryLock (outbound_locks)        — per (contact, trigger_id) dedup
 *   4. recheckBeforeSend (optional)    — 2026-07-23 Phase 5: LIVE suppression
 *      re-check against GHL immediately before the send. Gate 1 runs at flow
 *      START and reads the (lagging) snapshot; the GHL call happens three
 *      steps later. Both measured 30-day races (tag landed in GHL 0.7–1.1s
 *      before the send) are caught here. Optional dep — absent in older
 *      tests/callers → behavior unchanged.
 *   5. executeSend                     — the actual handler / GHL call
 *
 * What changed vs the pre-hotfix wrapper:
 *
 *   DEFER, DON'T DROP. A send blocked by the agentic cooldown or a live
 *   outbound lock returns { deferred: true, retry_at } and the executor
 *   parks the action as status='pending' + retry_at (DB-persisted). The old
 *   in-process setTimeout reschedules died on every Railway redeploy — that
 *   is exactly how the incident's replies were stranded. Only supersession
 *   (a newer inbound produced a newer reply job) is terminal.
 *
 *   RE-ENTRANT + SENT-MARKER ACQUIRE. A retry of a job whose prior attempt
 *   is still in flight re-enters its own slot (never blocked by its own
 *   lock); a retry whose prior (zombie) attempt already DELIVERED gets
 *   'already_sent' + the recorded GHL message id and completes as a dedup —
 *   no resend. (The 60s handler watchdog is a Promise.race that never
 *   cancels the loser; the loser used to deliver, get marked failed, and
 *   the retry could double-send after lock expiry.)
 *
 *   GUARANTEED RELEASE. The slot release lives in a finally — no exit path
 *   can strand the slot. The only deliberate exception is the lock-held
 *   deferral, which keeps the slot so older jobs stay superseded; that is
 *   now restart-safe because the re-run is a DB row (retry_at), and the
 *   slot self-heals via TTL reclaim + the heartbeat stale-lock reaper.
 *
 *   PRESUMED-SENT, NARROWED. The old guard keyed on status==='skipped' and
 *   missed watchdog-orphaned re-runs (status 'pending'), letting a job
 *   self-deadlock on its own leaked outbound lock. Now: an expired-
 *   unreleased outbound lock previously held by ANOTHER sender is presumed
 *   sent (conservative terminal skip, exactly one reply per inbound); one
 *   previously held by THIS action proceeds — if that prior attempt had
 *   delivered, the acquire would have returned 'already_sent'.
 */

import { decideLockHeldReschedule, shouldKeepOutboundLock } from '../services/outbound-locks.js';

/** The outbound-lock sender tag for an action — self-attribution (D3). */
export function senderTagFor(actionId) {
  return `agent_executor:a${actionId}`;
}

/**
 * @param {object} action   agent_actions row
 * @param {object} context  executor context (event payload, batch cache)
 * @param {object} deps     injected I/O:
 *   checkSuppression(contact_id) → { suppressed, matched_tag, all_matches }
 *   resolveTriggerId(action, context) → string|null
 *   acquireSlot({contact_id, job_id, trigger_id, holder}) → see agentic-reply-locks
 *   releaseSlot(contact_id, job_id, { holderToken })
 *   commitSend(contact_id, job_id, { message_id, conversation_id })
 *   tryLock({contact_id, trigger_id, sender, message_preview, priority}) → see outbound-locks
 *   releaseLock(contact_id, trigger_id, { expected_expires_at })
 *   executeSend(action, context) → handler result
 *   now() → ms epoch (injectable clock for tests)
 */
export async function runSendMessageFlow(action, context, deps) {
  const params = action.action_payload || {};
  const contact_id = action.target_id;
  const now = deps.now || Date.now;

  // ── 1. Universal suppression gate — before any lock is taken ──
  const suppression = await deps.checkSuppression(contact_id);
  if (suppression.suppressed) {
    console.log(
      `[ActionExecutor] send_message suppressed: contact=${contact_id} ` +
      `matched_tag=${suppression.matched_tag} all=${(suppression.all_matches || []).join(',')}`
    );
    return {
      skipped: true,
      reason: 'suppressed',
      matched_tag: suppression.matched_tag,
      all_matches: suppression.all_matches,
      contact_id,
    };
  }

  const trigger_id = await deps.resolveTriggerId(action, context);

  // ── 2. Per-contact single-flight + cooldown + supersede ──
  const agenticJobId = String(action.id ?? `job-${trigger_id || contact_id}`);
  const slot = await deps.acquireSlot({
    contact_id,
    job_id: agenticJobId,
    trigger_id,
    holder: 'agent_executor',
  });

  if (!slot.acquired) {
    if (slot.reason === 'already_sent') {
      // A prior (zombie) attempt of THIS job delivered to GHL — complete as
      // a dedup, never resend. This is the delivered-but-watchdog-timed-out
      // action 165896 class from the incident.
      console.log(
        `[ActionExecutor] send_message dedup: action ${action.id} already delivered ` +
        `(message_id=${slot.message_id || 'unknown'}) — completing without resend`
      );
      return {
        action: 'message_sent',
        deduped_prior_send: true,
        contact_id,
        trigger_id,
        message_id: slot.message_id || null,
        conversation_id: slot.conversation_id || null,
      };
    }
    if (slot.reason === 'cooldown') {
      // Defer to the cooldown expiry (cooldown_until keys on the last
      // SUCCESSFUL send). Executor re-claims the row at retry_at.
      console.log(
        `[ActionExecutor] send_message inside agentic cooldown: contact=${contact_id} ` +
        `action=${action.id} — deferring to ${slot.retry_at}`
      );
      return {
        deferred: true,
        reason: 'agentic_cooldown',
        retry_at: slot.retry_at,
        contact_id,
        trigger_id,
      };
    }
    if (slot.reason === 'yield_to_newer') {
      // A NEWER reply job holds the slot — this job is the stale one.
      // Supersession is the only terminal skip for a reply job.
      console.log(
        `[ActionExecutor] send_message job ${agenticJobId} yields to newer job ${slot.newer_job_id} for contact ${contact_id}`
      );
      return {
        skipped: true,
        reason: 'superseded_by_newer_job',
        superseded_by: slot.newer_job_id,
        contact_id,
        trigger_id,
      };
    }
    // Unknown non-acquire reason — fail open (mirrors lock-service philosophy).
    console.warn(`[ActionExecutor] send_message unknown slot outcome ${slot.reason} for ${contact_id} — proceeding fail-open`);
  }

  if (slot.superseded_job_id) {
    console.log(
      `[ActionExecutor] send_message job ${agenticJobId} superseded unsent job ${slot.superseded_job_id} for contact ${contact_id}`
    );
  }

  const holderToken = slot.holder_token || null;
  // 'held' → finally releases; 'kept_deferred' → deliberate keep (lock-held
  // deferral); 'committed' → sent, commitSend owns the row now.
  let slotState = slot.acquired ? 'held' : 'not_held';

  try {
    // ── 3. Outbound dedup lock, per (contact, trigger_id) ──
    const lock = await deps.tryLock({
      contact_id,
      trigger_id,
      sender: senderTagFor(action.id),
      message_preview: params.message || params.body,
      priority: Number.isFinite(action.priority) ? action.priority : undefined,
    });

    if (!lock.acquired) {
      // Live holder. Defer past it — a held lock must delay the reply,
      // never kill it. Attempt budget survives restarts in execution_result.
      const attempt = Number(action.execution_result?.lock_held_attempts) || 0;
      const decision = decideLockHeldReschedule(lock.expires_at, now(), { attempt });
      if (decision.reschedule) {
        console.log(
          `[ActionExecutor] send_message lock held: contact=${contact_id} action=${action.id} ` +
          `attempt=${attempt + 1} — deferring to ${decision.retryAt} (${decision.reason})`
        );
        // Keep the slot: releasing it here would un-supersede older jobs
        // (the pre-#475 stale-send bug). Restart-safe now — the re-run is a
        // DB row, and the slot self-heals via TTL reclaim + reaper.
        slotState = 'kept_deferred';
        return {
          deferred: true,
          reason: 'outbound_lock_held',
          retry_at: decision.retryAt,
          lock_held_attempts: attempt + 1,
          held_by: lock.held_by,
          lock_expires_at: lock.expires_at,
          contact_id,
          trigger_id,
        };
      }
      console.warn(
        `[ActionExecutor] send_message lock-held retries exhausted: contact=${contact_id} action=${action.id}`
      );
      return {
        skipped: true,
        reason: 'outbound_lock_retry_exhausted',
        held_by: lock.held_by,
        lock_expires_at: lock.expires_at,
        contact_id,
        trigger_id,
      };
    }

    // ── Presumed-sent (narrowed) ──
    // We reacquired a lock that ran to full TTL WITHOUT being released. Its
    // holder either sent (sends keep the lock until TTL by design) or
    // hard-crashed. If that holder was ANOTHER sender, presume sent — one
    // reply per inbound, drop over duplicate. If it was THIS action's own
    // prior attempt, proceed: had it delivered, acquireSlot would have
    // returned 'already_sent' (the marker is written at GHL 2xx).
    if (lock.reason === 'reacquired_after_expiry'
        && lock.prior_sender
        && lock.prior_sender !== senderTagFor(action.id)) {
      console.warn(
        `[ActionExecutor] send_message action ${action.id}: prior lock ${contact_id}:${trigger_id} ` +
        `expired unreleased (held by ${lock.prior_sender}) — holder presumed sent, skipping`
      );
      // Deliberately KEEP (do not release) the reacquired lock: an
      // expired-unreleased row is the evidence that this inbound was
      // consumed. Releasing it here would hand the next sibling a
      // 'reacquired_after_release' (= prior holder aborted, safe to send)
      // and produce exactly the duplicate this guard exists to prevent.
      return {
        skipped: true,
        reason: 'holder_expired_unreleased_presumed_sent',
        held_by: lock.prior_sender,
        contact_id,
        trigger_id,
      };
    }

    // ── 4. Send-time live re-check (Phase 5, optional dep) ──
    // Last look at the CONTACT'S CURRENT state before the irreversible GHL
    // call. On a block: release the outbound lock (mirrors the error path
    // below) and terminal-skip; slotState stays 'held' so the finally
    // releases the slot. The dep itself fails open — a null/undefined or
    // non-suppressed result proceeds.
    if (deps.recheckBeforeSend) {
      let recheck = null;
      try {
        recheck = await deps.recheckBeforeSend(action, context);
      } catch (err) {
        // Fail-open — a re-check fault must never block outbound.
        console.warn(`[ActionExecutor] send-time recheck failed for ${contact_id} (fail-open): ${err?.message || err}`);
      }
      if (recheck?.suppressed) {
        console.log(
          `[ActionExecutor] send_message blocked at send time: contact=${contact_id} ` +
          `action=${action.id} matched_tag=${recheck.matched_tag} reason=${recheck.reason}`
        );
        if (trigger_id) {
          await deps.releaseLock(contact_id, trigger_id, { expected_expires_at: lock.expires_at });
        }
        return {
          skipped: true,
          reason: 'suppressed_at_send_time',
          matched_tag: recheck.matched_tag,
          contact_id,
          trigger_id,
        };
      }
    }

    // ── 5. The send itself ──
    try {
      const result = await deps.executeSend(action, context);
      if (result?.action === 'message_sent') {
        // The handler commits the sent marker at GHL 2xx (_agentic_committed).
        // Safety net for paths that predate that (or fallback sends).
        if (result._agentic_committed !== true && !result.deduped_prior_send) {
          await deps.commitSend(contact_id, agenticJobId, {
            message_id: result.message_id || null,
            conversation_id: result.conversation_id || null,
          });
        }
        slotState = 'committed';
      }
      // Non-send outcomes leave slotState 'held' → finally releases, so a
      // superseding or deferred job is never deadlocked until lock expiry.
      if (!shouldKeepOutboundLock(result?.action) && trigger_id) {
        await deps.releaseLock(contact_id, trigger_id, { expected_expires_at: lock.expires_at });
      }
      return {
        ...result,
        _outbound_lock: { acquired: true, trigger_id, lock_key: lock.lock_key, reason: lock.reason },
      };
    } catch (err) {
      if (trigger_id) {
        await deps.releaseLock(contact_id, trigger_id, { expected_expires_at: lock.expires_at });
      }
      throw err;
    }
  } finally {
    // FIX 2 — no path may exit holding the slot (except the deliberate,
    // restart-safe kept_deferred case and a committed send, whose row now
    // carries the sent marker + cooldown).
    if (slotState === 'held') {
      await deps.releaseSlot(contact_id, agenticJobId, { holderToken });
    }
  }
}

export default { runSendMessageFlow, senderTagFor };
