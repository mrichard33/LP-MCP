/**
 * Send delivery verification — src/services/send-delivery-verify.js
 *
 * WHY: runSendMessageFlow marks a send complete when GHL returns 2xx with a
 * message id. Nothing re-reads that message afterward. GHL messages carry a
 * status (delivered / failed / undelivered), so a carrier-level rejection
 * currently records as `completed` with a null error_message and is invisible
 * to every dashboard and sweep.
 *
 * This is a RECONCILER, not a gate. It never blocks or delays a send. It
 * re-reads recently-completed send_message actions and flips the row to
 * 'failed' when GHL reports the message did not land, so the failure becomes
 * countable.
 *
 * Deliberately lagged by SEND_VERIFY_MIN_AGE_SEC: GHL's message-list API
 * propagates behind the send by up to a minute (observed 2026-08-31), so
 * checking too early produces false failures.
 *
 * Kill switch: SEND_VERIFY_ENABLED=false.
 */

import supabase from '../supabase.js';
import { ghlFetch } from '../actions/helpers.js';
import { emitEvent } from '../event-emitter.js';

const MIN_AGE_SEC = Math.max(60, parseInt(process.env.SEND_VERIFY_MIN_AGE_SEC || '120', 10));
const MAX_AGE_MIN = Math.max(5, parseInt(process.env.SEND_VERIFY_MAX_AGE_MIN || '60', 10));
const BATCH = Math.max(1, parseInt(process.env.SEND_VERIFY_BATCH || '25', 10));

const FAILED_STATUSES = new Set(['failed', 'undelivered', 'rejected', 'error']);

/**
 * Verify recently-completed sends against GHL. Returns a summary; never throws.
 */
export async function verifyRecentSends() {
  if (process.env.SEND_VERIFY_ENABLED === 'false') {
    return { skipped: true, reason: 'disabled' };
  }

  const now = Date.now();
  const notAfter = new Date(now - MIN_AGE_SEC * 1000).toISOString();
  const notBefore = new Date(now - MAX_AGE_MIN * 60_000).toISOString();

  const { data: rows, error } = await supabase
    .from('agent_actions')
    .select('id, target_id, execution_result, executed_at')
    .eq('action_type', 'send_message')
    .eq('status', 'completed')
    .gte('executed_at', notBefore)
    .lte('executed_at', notAfter)
    .order('executed_at', { ascending: false })
    .limit(BATCH);

  if (error) {
    console.warn(`[SendVerify] query failed (skipping pass): ${error.message}`);
    return { skipped: true, reason: 'query_error' };
  }

  let checked = 0, confirmed = 0, flagged = 0, unknown = 0;

  for (const row of rows || []) {
    const messageId = row.execution_result?.message_id;
    // No id to check (dedup completions, email-only paths) — nothing to verify.
    if (!messageId || row.execution_result?.delivery_verified) continue;
    if (row.execution_result?.deduped_prior_send) continue;

    checked++;
    let status = null;
    try {
      const msg = await ghlFetch('GET', `/conversations/messages/${messageId}`);
      status = String(msg?.message?.status || msg?.status || '').toLowerCase();
    } catch (err) {
      // Fail-open: a lookup error is not evidence of a failed send.
      console.warn(`[SendVerify] lookup failed for message ${messageId} (action ${row.id}): ${err.message}`);
      unknown++;
      continue;
    }

    if (!status) { unknown++; continue; }

    if (FAILED_STATUSES.has(status)) {
      flagged++;
      console.warn(`[SendVerify] action ${row.id}: GHL reports message ${messageId} status=${status} — flipping to failed`);
      await supabase.from('agent_actions').update({
        status: 'failed',
        error_message: `delivery_failed: GHL reports message ${messageId} status=${status}`,
        execution_result: { ...row.execution_result, delivery_verified: true, delivery_status: status },
        updated_at: new Date().toISOString(),
      }).eq('id', row.id);

      await emitEvent({
        event_type: 'agentic.send_delivery_failed',
        source: 'send_verify',
        entity_type: 'contact',
        entity_id: String(row.target_id || 'unknown'),
        ghl_contact_id: row.target_id || null,
        priority: 'high',
        bypass_filter: true,
        payload: { action_id: row.id, message_id: messageId, delivery_status: status },
        idempotency_key: `send_delivery_failed_${row.id}`,
      }).catch(() => {});
    } else {
      confirmed++;
      // Stamp so the next pass skips this row.
      await supabase.from('agent_actions').update({
        execution_result: { ...row.execution_result, delivery_verified: true, delivery_status: status },
        updated_at: new Date().toISOString(),
      }).eq('id', row.id).eq('status', 'completed');
    }
  }

  if (checked > 0) {
    console.log(`[SendVerify] checked=${checked} confirmed=${confirmed} flagged=${flagged} unknown=${unknown}`);
  }
  return { checked, confirmed, flagged, unknown };
}

export default { verifyRecentSends };
