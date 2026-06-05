/**
 * Send-Dedup — src/services/send-dedup.js
 *
 * Logical-identity idempotency for non-idempotent senders (send_notification,
 * create_task). The action executor (src/actions/index.js) claims a mark
 * BEFORE dispatch and releases it if the handler throws.
 *
 * Why this exists (2026-06-05):
 *   The executor's per-handler Promise.race watchdog does NOT cancel the
 *   losing promise. When it fires, the action is retried while the original
 *   POST may still land → duplicate. The pre-existing send_notification
 *   guards miss two cases:
 *     - sibling rows emitted near-simultaneously (different action.id, same
 *       payload) — the cooldown gate is opt-in + matches status='completed'
 *       only, so simultaneous siblings race past it; checkForActionRef keys
 *       on action.id, blind to a sibling.
 *     - retries whose original POST lands after the GroupMe-history read.
 *
 *   This guard keys on LOGICAL identity (action_type + target_id + payload
 *   hash), so siblings AND retries collapse to one send. The claim is atomic
 *   (PRIMARY KEY on dedup_key); the first writer wins, everyone else within
 *   the window short-circuits.
 *
 * Design:
 *   - claimSendMark: INSERT the key. Success → claimed (send). Unique
 *     violation → a prior mark exists; if younger than SEND_DEDUP_WINDOW_MS
 *     → duplicate (skip); if older (stale prior send) → refresh + claim.
 *   - releaseSendMark: delete the mark IFF this action owns it, so a
 *     genuinely-failed send retries without wrongly deleting a sibling's
 *     fresh claim.
 *   - Fail-open everywhere: any infra error claims (sends). We never block a
 *     send because the dedup table misbehaved.
 *
 * Tunable: SEND_DEDUP_WINDOW_MS (default 120000).
 */
import crypto from 'crypto';
import supabase from '../supabase.js';

const WINDOW_MS = Math.max(1000, parseInt(process.env.SEND_DEDUP_WINDOW_MS || '120000', 10));

/**
 * Deterministic stringify — sorts object keys recursively so two action rows
 * with the same logical payload hash identically even if jsonb round-tripping
 * reordered their keys.
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/**
 * Logical-identity key: action_type + target_id + sha256(stable payload).
 * Intentionally does NOT include rule_applied — two identical cards to the
 * same contact within the window are noise regardless of which rule emitted
 * them, and should collapse.
 */
export function makeDedupKey(action) {
  const payload = action?.action_payload || {};
  const hash = crypto.createHash('sha256').update(stableStringify(payload)).digest('hex').slice(0, 16);
  return `${action.action_type}:${action.target_id || ''}:${hash}`;
}

/**
 * Atomically claim a send. Returns:
 *   { claimed: true }                                  → proceed to send
 *   { claimed: false, duplicate: true, first_action_id, age_ms } → skip
 * Fail-open: returns { claimed: true } on any infra error.
 */
export async function claimSendMark(dedupKey, action) {
  try {
    const { error } = await supabase.from('agent_send_marks').insert({
      dedup_key: dedupKey,
      action_id: action.id,
      action_type: action.action_type,
      target_id: action.target_id != null ? String(action.target_id) : null,
      created_at: new Date().toISOString(),
    });
    if (!error) return { claimed: true };
    const isConflict =
      error.code === '23505' || /duplicate key|unique constraint/i.test(error.message || '');
    if (!isConflict) {
      console.warn(`[SendDedup] claim insert failed (fail-open): ${error.message}`);
      return { claimed: true };
    }
    // A mark already exists. Decide duplicate vs stale-prior-send.
    const { data: existing } = await supabase
      .from('agent_send_marks')
      .select('action_id, created_at')
      .eq('dedup_key', dedupKey)
      .maybeSingle();
    if (!existing) return { claimed: true }; // race: row vanished, proceed
    const ageMs = Date.now() - new Date(existing.created_at).getTime();
    if (ageMs <= WINDOW_MS) {
      return { claimed: false, duplicate: true, first_action_id: existing.action_id, age_ms: ageMs };
    }
    // Stale mark from a prior send beyond the window — reclaim it for this action.
    await supabase
      .from('agent_send_marks')
      .update({ action_id: action.id, action_type: action.action_type, created_at: new Date().toISOString() })
      .eq('dedup_key', dedupKey);
    return { claimed: true, refreshed_stale: true };
  } catch (e) {
    console.warn(`[SendDedup] claim error (fail-open): ${e.message}`);
    return { claimed: true };
  }
}

/**
 * Release a claim so a genuinely-failed send can retry. Only deletes the
 * mark if THIS action owns it (guards against deleting a sibling's claim).
 */
export async function releaseSendMark(dedupKey, actionId) {
  try {
    await supabase.from('agent_send_marks').delete().eq('dedup_key', dedupKey).eq('action_id', actionId);
  } catch (e) {
    console.warn(`[SendDedup] release error: ${e.message}`);
  }
}
