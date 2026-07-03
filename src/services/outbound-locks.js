/**
 * Outbound Locks — src/services/outbound-locks.js
 *
 * One outbound per (contact_id, trigger_id) within TTL. The action executor
 * acquires a lock before invoking executeSendMessage; if the lock is held by
 * another sender within the TTL window, the send is skipped.
 *
 * lock_key format: "{contact_id}:{trigger_id}"
 * Default TTL: 300s. trigger_id should be the inbound message_id when the
 * outbound is a reply, or `evt-{source_event_id}` for system-driven sends.
 *
 * Senders observed in the wild:
 *   - agent_executor    — internal LP MCP send_message handler
 *   - hl_mcp_send       — manual / claude-driven sends via HL MCP
 *   - drift_detector    — informational sends (rare)
 *   - manual            — fallback / unspecified
 *
 * Fail-open on missing params or DB errors so transient infra issues don't
 * block legitimate sends. The dedup is best-effort — the hard guarantee
 * is for the steady-state path.
 *
 * Does NOT catch GHL native workflow sends (those bypass the agentic layer).
 * Drift detection is the after-the-fact catch for that class.
 */

import supabase from '../supabase.js';

const DEFAULT_TTL_SECONDS = 300;

export async function tryAcquireLock({ contact_id, trigger_id, sender, message_preview, priority, ttl_seconds = DEFAULT_TTL_SECONDS }) {
  if (!supabase) return { acquired: true, reason: 'no_supabase' };
  if (!contact_id || !trigger_id) {
    return { acquired: true, reason: 'missing_params_open' };
  }
  const lock_key = `${contact_id}:${trigger_id}`;
  const expires_at = new Date(Date.now() + ttl_seconds * 1000).toISOString();
  // Recorded for observability only — which action priority holds the slot.
  // NOT used to preempt: a live holder always wins (see 23505 branch below).
  // Preempt-and-resend was tried and reverted — it double-sent because an
  // already-delivered SMS cannot be recalled (Mark Test, evt-1575527).
  const holder_priority = Number.isFinite(priority) ? priority : null;

  const { error } = await supabase
    .from('outbound_locks')
    .insert({
      lock_key,
      contact_id: String(contact_id),
      trigger_id: String(trigger_id),
      sender: sender || 'unknown',
      message_preview: message_preview ? String(message_preview).slice(0, 200) : null,
      holder_priority,
      expires_at,
    });

  if (error?.code === '23505') {
    const { data } = await supabase
      .from('outbound_locks')
      .select('sender, expires_at, released_at, acquired_at, holder_priority')
      .eq('lock_key', lock_key)
      .maybeSingle();
    const isExpired = data && new Date(data.expires_at) < new Date();
    const isReleased = data?.released_at != null;
    if (isExpired || isReleased) {
      await supabase
        .from('outbound_locks')
        .update({
          sender: sender || 'unknown',
          holder_priority,
          message_preview: message_preview ? String(message_preview).slice(0, 200) : null,
          expires_at,
          released_at: null,
          acquired_at: new Date().toISOString(),
        })
        .eq('lock_key', lock_key);
      // Distinct reasons (2026-07-03): a released lock means the prior holder
      // aborted without sending — taking it over is always safe. An expired-
      // but-NEVER-released lock means the holder either sent (sends keep the
      // lock until TTL by design) or hard-crashed; callers that reschedule
      // around held locks treat that case as presumed-sent (see
      // executeSendMessageWithLock in src/actions/index.js).
      return {
        acquired: true,
        reason: isReleased ? 'reacquired_after_release' : 'reacquired_after_expiry',
        // 2026-07-03 hotfix: who held the expired/released lock. Lets the send
        // flow distinguish "our own prior attempt leaked this" (proceed — the
        // sent marker would exist if it delivered) from "someone else presumed
        // sent" (conservative terminal skip).
        prior_sender: data?.sender || null,
        lock_key,
        expires_at,
      };
    }
    // A live (non-expired, non-released) holder always blocks the challenger —
    // this is the hard "exactly one outbound per (contact,trigger)" guarantee.
    return { acquired: false, reason: 'lock_held', held_by: data?.sender || 'unknown', held_priority: data?.holder_priority, expires_at: data?.expires_at };
  }
  if (error) {
    console.error(`[outbound-locks] acquire error for ${lock_key}: ${error.message}`);
    return { acquired: true, reason: 'acquire_error_open', lock_key };
  }
  return { acquired: true, lock_key, expires_at };
}

/**
 * Release a lock this caller acquired. Pass the expires_at returned by
 * tryAcquireLock as expected_expires_at to make the release compare-and-set:
 * if a later job reacquired the key (new expires_at), the release no-ops
 * instead of freeing the successor's live lock. Guards against the watchdog
 * Promise.race-loser zombie (a timed-out handler whose release fires long
 * after its action was retried — see executeSingleAction's watchdog notes in
 * src/actions/index.js).
 */
export async function releaseLock(contact_id, trigger_id, { expected_expires_at } = {}) {
  if (!supabase || !contact_id || !trigger_id) return;
  let query = supabase
    .from('outbound_locks')
    .update({ released_at: new Date().toISOString() })
    .eq('lock_key', `${contact_id}:${trigger_id}`);
  if (expected_expires_at) query = query.eq('expires_at', expected_expires_at);
  const { error } = await query;
  if (error) console.error(`[outbound-locks] release error for ${contact_id}:${trigger_id}: ${error.message}`);
}

/**
 * Pure decision: should a send blocked by a live outbound lock be
 * rescheduled, and after what delay? No I/O; unit-tested in
 * scripts/test-outbound-lock-reschedule.js (mirrors the decideSlotAcquisition
 * precedent in agentic-reply-locks.js).
 *
 * The delay is anchored to the holder's expires_at but clamped to
 * [minMs, maxMs]. The maxMs clamp turns a long wait into polling: after the
 * 2026-07-03 fix, holders that abort release their lock within seconds, so a
 * challenger sleeping the full 300s TTL would add minutes of needless reply
 * latency. Each re-run repeats the full send gate and, if still blocked,
 * reschedules again — attempt × maxMs comfortably carries the retry past any
 * lock's full TTL. At maxAttempts the caller terminal-skips.
 *
 * @param {string|null} expiresAtIso  holder's expires_at (may be missing)
 * @param {number} nowMs
 * @param {object} [opts]
 * @param {number} [opts.attempt=0]   how many reschedules already happened
 * @returns {{ reschedule: boolean, delayMs?: number, retryAt?: string, reason: string }}
 */
export function decideLockHeldReschedule(expiresAtIso, nowMs, {
  attempt = 0,
  maxAttempts = 8,
  minMs = 5_000,
  maxMs = 60_000,
  bufferMs = 1_500,
  fallbackMs = 30_000,
} = {}) {
  if (attempt >= maxAttempts) {
    return { reschedule: false, reason: 'retry_exhausted' };
  }
  const expiresMs = expiresAtIso ? Date.parse(expiresAtIso) : NaN;
  let delayMs;
  if (Number.isFinite(expiresMs)) {
    delayMs = Math.min(maxMs, Math.max(minMs, expiresMs - nowMs + bufferMs));
  } else {
    delayMs = Math.min(maxMs, Math.max(minMs, fallbackMs));
  }
  return {
    reschedule: true,
    delayMs,
    retryAt: new Date(nowMs + delayMs).toISOString(),
    reason: Number.isFinite(expiresMs) ? 'until_lock_expiry' : 'no_expiry_fallback',
  };
}

/**
 * Which handler outcomes keep their outbound lock until TTL? Only the ones
 * where the inbound was actually CONSUMED:
 *   message_sent            — the lock's post-send dedup purpose
 *   send_message_handed_off — handoff tags applied; a human/GHL workflow owns
 *                             the response. Releasing would let a same-trigger
 *                             sibling re-run, re-classify (non-deterministic),
 *                             and drop a bot SMS on top of the handoff.
 * Every other outcome sent nothing — the lock is released so a superseding
 * or rescheduled job is not deadlocked until TTL (the 2026-07-03 P0:
 * agent_actions 165762/165770, contact VZ52xEN3bsCUDWLMCHnk).
 * Keyed on result.action (not classify-status): a fallback send rides on
 * action 'message_sent' and must keep its lock even though it classifies as
 * 'failed'.
 */
export function shouldKeepOutboundLock(resultAction) {
  return resultAction === 'message_sent' || resultAction === 'send_message_handed_off';
}

export async function checkLock(contact_id, trigger_id) {
  if (!supabase || !contact_id || !trigger_id) return { held: false };
  const { data } = await supabase
    .from('outbound_locks')
    .select('sender, expires_at, released_at, acquired_at')
    .eq('lock_key', `${contact_id}:${trigger_id}`)
    .maybeSingle();
  if (!data) return { held: false };
  const expired = new Date(data.expires_at) < new Date();
  const released = data.released_at != null;
  return {
    held: !expired && !released,
    held_by: data.sender,
    acquired_at: data.acquired_at,
    expires_at: data.expires_at,
    released_at: data.released_at,
  };
}
