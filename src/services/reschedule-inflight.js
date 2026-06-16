/**
 * Reschedule In-Flight Marker — src/services/reschedule-inflight.js
 *
 * A short-lived, self-expiring marker set on a contact while an agentic
 * reschedule is cancelling the OLD appointment slot. An agent-initiated
 * cancellation emits the same `ghl.appointment_cancelled` webhook a customer
 * cancellation does — and two priority-70 rules (GHL_APPT_CANCELLED_REBOOK_COLD
 * and GHL_APPT_CANCELLED_REBOOK) fire on it with no guard. Without a
 * correlation marker, the agent's own reschedule trips the customer-cancellation
 * cascade (this is part of the Jacqueline Virtue, fbC6JUcY9EDBrHoMiFmF, misfire).
 *
 * Modeled on src/services/outbound-locks.js: a TTL row in Supabase that
 * self-cleans by expiry. A transient GHL tag was rejected because the cancel
 * webhook is processed ~15-30s later by the decision-engine heartbeat — after
 * the handler returns — so a tag would race its own removal. A TTL row has no
 * removal step to race.
 *
 * Default TTL 300s: comfortably above the cancel-webhook processing lag, small
 * enough to minimize masking a genuine near-simultaneous customer cancellation.
 *
 * Fail-open on missing params / DB errors (consistent with the other guards):
 * isRescheduleInflight returns false so a transient infra issue never silently
 * drops a real customer cancellation. The trade-off is that an error during an
 * agent reschedule could let the cascade fire — rare, and preferable to
 * dropping customer cancels.
 */

import supabase from '../supabase.js';

const DEFAULT_TTL_SECONDS = 300;

export async function markRescheduleInflight(contactId, ttlSeconds = DEFAULT_TTL_SECONDS) {
  if (!supabase) return { marked: false, reason: 'no_supabase' };
  if (!contactId) return { marked: false, reason: 'missing_contact' };
  const expires_at = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const { error } = await supabase
    .from('reschedule_inflight')
    .upsert(
      { contact_id: String(contactId), expires_at, acquired_at: new Date().toISOString() },
      { onConflict: 'contact_id' },
    );
  if (error) {
    console.error(`[reschedule-inflight] mark error for ${contactId}: ${error.message}`);
    return { marked: false, error: error.message };
  }
  return { marked: true, expires_at };
}

export async function isRescheduleInflight(contactId) {
  if (!supabase || !contactId) return false;
  const { data, error } = await supabase
    .from('reschedule_inflight')
    .select('expires_at')
    .eq('contact_id', String(contactId))
    .maybeSingle();
  if (error) {
    console.error(`[reschedule-inflight] lookup error for ${contactId}: ${error.message}`);
    return false; // fail-open — never block a customer cancellation on a transient error
  }
  if (!data) return false;
  return new Date(data.expires_at) > new Date();
}
