/**
 * Inbound Idempotency — src/services/idempotency.js
 *
 * Wraps the decision engine's per-event entry point with a claim/record
 * pattern backed by the `processed_events` table.
 *
 * idempotency_key format:
 *   {contact_id}:{message_id}     for ghl.reply_received with payload.message_id
 *   {entity_id}:evt-{event_id}    for everything else
 *
 * Behavior:
 *   - tryClaimEvent INSERTs into processed_events. On 23505 unique-violation
 *     it returns { claimed: false, reason: 'already_processed' } — caller
 *     should skip.
 *   - On any other DB error we fail OPEN (claimed: true) so infra issues
 *     don't block the engine. The duplicate-event risk is bounded by the
 *     downstream dedup logic already in createActionsFromRule.
 *   - recordResult writes the engine's return value back to the row for
 *     forensics.
 *
 * Related: see sql/019_mvi_antifragile_v2.5.sql for the table.
 */

import supabase from '../supabase.js';

export function buildIdempotencyKey(event) {
  if (event.event_type === 'ghl.reply_received' && event.payload?.message_id) {
    return `${event.ghl_contact_id || event.entity_id}:${event.payload.message_id}`;
  }
  const id = event.entity_id || event.ghl_contact_id || 'unknown';
  return `${id}:evt-${event.id}`;
}

export async function tryClaimEvent(event) {
  if (!supabase) return { claimed: true, key: null, reason: 'no_supabase' };
  const key = buildIdempotencyKey(event);
  const { error } = await supabase
    .from('processed_events')
    .insert({
      idempotency_key: key,
      contact_id: event.ghl_contact_id || event.entity_id || 'unknown',
      message_id: event.payload?.message_id || null,
      event_type: event.event_type,
      source_event_id: event.id,
    });

  if (error?.code === '23505') {
    return { claimed: false, key, reason: 'already_processed' };
  }
  if (error) {
    console.error(`[idempotency] claim error for key=${key}: ${error.message}`);
    return { claimed: true, key, reason: 'claim_error_open' };
  }
  return { claimed: true, key };
}

export async function recordResult(key, result) {
  if (!supabase || !key) return;
  const { error } = await supabase
    .from('processed_events')
    .update({ result })
    .eq('idempotency_key', key);
  if (error) console.error(`[idempotency] recordResult error for key=${key}: ${error.message}`);
}
