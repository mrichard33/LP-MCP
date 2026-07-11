/**
 * Appointment-create claim — src/services/appointment-sync-claim.js
 *
 * Cross-worker double-create guard for the LP→GHL appointment reconciler. The
 * decision-engine dedup (hasDuplicatePendingActions) already blocks the common
 * case — two of the same LP_APPT_GHL_SYNC_* rule queued at once. This is the
 * belt-and-suspenders backstop for any create that still reaches
 * reconcileLpAppointmentToGhl twice for the same contact+slot: a manual event
 * re-emit, an executor retry, or two DIFFERENT sync rules racing. Two such
 * reconciles each read "no appointment" and each POST a create, double-booking
 * the slot (canary: Sue Shanks — two confirmed 2:00 PM appts on a closed-won).
 *
 * Mechanism: an atomic claim on (contact_id, slot_ms) via a PRIMARY-KEY INSERT.
 * Exactly one concurrent worker wins the INSERT; the loser (unique violation,
 * SQLSTATE 23505) skips the create. The claim persists for CLAIM_TTL_SECONDS so
 * a near-simultaneous second create is still blocked while GHL propagates the
 * first (the read-after-write lag this whole class of bug lives in); after the
 * TTL a stale claim is reclaimable (a crashed create must not block the slot
 * forever). releaseAppointmentCreate() drops the claim when the create FAILS so
 * the executor's retry can re-attempt.
 *
 * FAIL-OPEN everywhere: no supabase, a bad key, or any DB error → claimed:true
 * (proceed). This is a backstop, not the primary guard; a transient infra issue
 * must never strand a legitimate booking. The `client` option injects a supabase
 * client for unit tests; production passes none and uses the shared client.
 */

import defaultSupabase from '../supabase.js';

export const CLAIM_TTL_SECONDS = 300;
const TABLE = 'appointment_sync_claims';

/**
 * Try to claim (contact_id, slot_ms) for a create.
 * @returns {Promise<{ claimed: boolean, reason: string }>} claimed:false only on
 *   a live conflict (another worker holds a fresh claim). All error/guard paths
 *   fail OPEN (claimed:true).
 */
export async function claimAppointmentCreate(contactId, slotMs, { ttlSeconds = CLAIM_TTL_SECONDS, client } = {}) {
  const supabase = client ?? defaultSupabase;
  if (!supabase) return { claimed: true, reason: 'no_supabase_open' };
  if (!contactId || !Number.isFinite(slotMs)) return { claimed: true, reason: 'bad_key_open' };

  try {
    const staleBefore = new Date(Date.now() - ttlSeconds * 1000).toISOString();
    // Reclaim a stale claim for THIS key (a prior create that crashed or aged
    // out past the TTL). Targeted by key — never touches other contacts/slots.
    await supabase.from(TABLE).delete()
      .eq('contact_id', contactId).eq('slot_ms', slotMs).lt('claimed_at', staleBefore);

    const { error } = await supabase.from(TABLE).insert({ contact_id: contactId, slot_ms: slotMs });
    if (!error) return { claimed: true, reason: 'claimed' };
    if (error.code === '23505') return { claimed: false, reason: 'held' };  // another worker owns it
    console.warn(`[apptSyncClaim] claim error for ${contactId}@${slotMs} (fail-open): ${error.message}`);
    return { claimed: true, reason: 'error_open' };
  } catch (err) {
    console.warn(`[apptSyncClaim] claim threw for ${contactId}@${slotMs} (fail-open): ${err.message}`);
    return { claimed: true, reason: 'throw_open' };
  }
}

/** Drop the claim (best-effort) so a retry can re-attempt after a failed create. */
export async function releaseAppointmentCreate(contactId, slotMs, { client } = {}) {
  const supabase = client ?? defaultSupabase;
  if (!supabase || !contactId || !Number.isFinite(slotMs)) return false;
  try {
    await supabase.from(TABLE).delete().eq('contact_id', contactId).eq('slot_ms', slotMs);
    return true;
  } catch (err) {
    console.warn(`[apptSyncClaim] release threw for ${contactId}@${slotMs}: ${err.message}`);
    return false;
  }
}
