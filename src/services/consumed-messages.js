/**
 * Consumed Messages — src/services/consumed-messages.js
 *
 * Hard message-level dedup for inbound analysis. Every inbound message an
 * analysis pass is about to consume (reply-buffer flush OR the solo
 * analyzePendingReplies poller) is claimed here first, atomically. Whoever
 * inserts first owns the message; every later pass drops it from its input.
 * If that leaves a pass with nothing to analyze, the pass is skipped and the
 * source event marked action_taken='deduped'.
 *
 * This closes the exact double-analysis pattern from the Steve Nkzhm
 * incident (2026-07-03, system_events 1696289/90/91): the same inbound was
 * analyzed solo AND inside a combined buffer flush because the two callers
 * shared only an in-memory TTL cache (message-analyzer.js analysisCache),
 * and every ghl.reply_received payload had message_id: null so the inbound
 * idempotency key (idempotency.js) degraded to per-event keys that never
 * collide.
 *
 * Table: agentic_consumed_messages
 *   (sql/migrations/2026-07-03_agentic_consumed_messages.sql)
 *
 * Fail-open: on any infra error the caller is told all keys are fresh so a
 * DB hiccup never drops a customer reply. The in-memory analysisCache stays
 * in place as the cheap first layer.
 */

import crypto from 'node:crypto';
import supabase from '../supabase.js';

/**
 * Deterministic key for an inbound message. Uses the GHL message id when the
 * webhook delivered one; otherwise synthesizes sha1(contactId|body|10s-bucket)
 * so the same physical message seen by two consumers within the window maps
 * to the same key. Pure — unit-tested in scripts/test-consumed-message-key.js.
 */
export function buildMessageKey(contactId, messageId, body, epochMs = Date.now()) {
  if (messageId) return String(messageId);
  const bucket = Math.floor(epochMs / 10000); // floor(epoch_seconds / 10)
  return 'syn-' + crypto.createHash('sha1')
    .update(`${contactId}|${body || ''}|${bucket}`)
    .digest('hex');
}

/**
 * Atomically claim a set of message keys for one contact.
 *
 * Returns { fresh: [...keys we now own], consumed: [...keys someone else
 * already owns] }. Uses upsert with ignoreDuplicates (ON CONFLICT DO
 * NOTHING) + select-back: rows returned by the upsert are the ones WE
 * inserted; keys missing from the return were already claimed.
 *
 * IMPORTANT: claim once per logical analysis attempt, BEFORE any retry loop —
 * a retry re-claiming its own keys would see them consumed and drop them.
 */
export async function claimConsumedMessages(contactId, messageKeys) {
  const keys = (messageKeys || []).filter(Boolean).map(String);
  if (!keys.length) return { fresh: [], consumed: [] };
  if (!supabase || !contactId) return { fresh: keys, consumed: [], reason: 'no_supabase_open' };

  const rows = keys.map((k) => ({
    contact_id: String(contactId),
    message_key: k,
  }));

  const { data, error } = await supabase
    .from('agentic_consumed_messages')
    .upsert(rows, { onConflict: 'contact_id,message_key', ignoreDuplicates: true })
    .select('message_key');

  if (error) {
    console.error(`[consumed-messages] claim error for ${contactId}: ${error.message} — failing open (all fresh)`);
    return { fresh: keys, consumed: [], reason: 'claim_error_open' };
  }

  const owned = new Set((data || []).map((r) => r.message_key));
  const fresh = keys.filter((k) => owned.has(k));
  const consumed = keys.filter((k) => !owned.has(k));
  if (consumed.length) {
    console.log(`[consumed-messages] ${consumed.length}/${keys.length} message(s) already consumed for ${contactId} — dropped from this pass`);
  }
  return { fresh, consumed };
}

/**
 * Release claims after an analysis that ultimately FAILED (retries
 * exhausted, nothing produced). Without this, the failed consumer's claim
 * would make the durable processing-cycle backstop drop the message as a
 * duplicate — the reply would be lost permanently instead of retried.
 */
export async function releaseConsumedMessages(contactId, messageKeys) {
  const keys = (messageKeys || []).filter(Boolean).map(String);
  if (!keys.length || !supabase || !contactId) return;
  const { error } = await supabase
    .from('agentic_consumed_messages')
    .delete()
    .eq('contact_id', String(contactId))
    .in('message_key', keys);
  if (error) {
    console.error(`[consumed-messages] release error for ${contactId}: ${error.message}`);
  }
}
