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

/**
 * Strict priority preemption rule. Smaller priority value = higher priority
 * (matches agent_actions.priority). A challenger preempts a live holder ONLY
 * when both priorities are finite and the challenger is strictly higher
 * priority (lower number). Equal or missing priorities → no preempt, so
 * callers without a priority (hl_mcp_send, drift_detector) keep the legacy
 * first-come-first-served behaviour and are never displaced.
 */
export function shouldPreemptByPriority(challengerPriority, holderPriority) {
  return (
    Number.isFinite(challengerPriority) &&
    Number.isFinite(holderPriority) &&
    challengerPriority < holderPriority
  );
}

export async function tryAcquireLock({ contact_id, trigger_id, sender, message_preview, priority, ttl_seconds = DEFAULT_TTL_SECONDS }) {
  if (!supabase) return { acquired: true, reason: 'no_supabase' };
  if (!contact_id || !trigger_id) {
    return { acquired: true, reason: 'missing_params_open' };
  }
  const lock_key = `${contact_id}:${trigger_id}`;
  const expires_at = new Date(Date.now() + ttl_seconds * 1000).toISOString();
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
      return { acquired: true, reason: 'reacquired_after_expiry', lock_key };
    }
    // Deterministic-by-priority: a strictly-higher-priority challenger (lower
    // number) takes the slot from a live lower-priority holder so the intended
    // primary send wins regardless of which raced to INSERT first.
    if (shouldPreemptByPriority(holder_priority, data?.holder_priority)) {
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
      return { acquired: true, reason: 'preempted_by_priority', lock_key, preempted_holder: data?.sender, preempted_priority: data?.holder_priority };
    }
    return { acquired: false, reason: 'lock_held', held_by: data?.sender || 'unknown', expires_at: data?.expires_at };
  }
  if (error) {
    console.error(`[outbound-locks] acquire error for ${lock_key}: ${error.message}`);
    return { acquired: true, reason: 'acquire_error_open', lock_key };
  }
  return { acquired: true, lock_key };
}

export async function releaseLock(contact_id, trigger_id) {
  if (!supabase || !contact_id || !trigger_id) return;
  const { error } = await supabase
    .from('outbound_locks')
    .update({ released_at: new Date().toISOString() })
    .eq('lock_key', `${contact_id}:${trigger_id}`);
  if (error) console.error(`[outbound-locks] release error for ${contact_id}:${trigger_id}: ${error.message}`);
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
