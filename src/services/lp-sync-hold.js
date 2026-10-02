/**
 * LP sync hold for a dispatch-handled reschedule — src/services/lp-sync-hold.js
 *
 * 2026-10-02 (Mark): when the website chat moves a customer's appointment to
 * a new time, GHL is moved in place and #dispatch is told to change the time
 * in LP. Nothing automatic may touch LP for that move — above all it must not
 * create a new LP lead.
 *
 * The automatic path it has to stop: the GHL time change fires A.WE Window
 * Estimate Handler, whose "LP Appointment Sync" step POSTs
 * /webhook/ghl/set-lp-appointment (src/lp-appointment-sync.js). That resolves
 * the LP lead and re-sets the appointment, and when it cannot resolve the
 * lead it enrols lead creation — a second LP lead for someone who only
 * changed the day.
 *
 * The record of the move already exists: the `reschedule_appointment` row the
 * chat queued, with `action_payload.lp_sync = 'dispatch'`. So the hold is a
 * read of that row, not a new table. A recent row (HOLD_MINUTES) that is
 * executing or completed means "a person is changing LP for this contact".
 *
 * Fail OPEN on a read error: this check sits in front of EVERY LP appointment
 * sync, and a Supabase blip must not stop the syncs that have nothing to do
 * with the chat. The #dispatch card for the chat move posts either way.
 */

export const HOLD_MINUTES = 30;
const READ_CAP_MS = 3000;

/**
 * @returns {Promise<{held: boolean, action_id?: number, reason: string}>}
 */
export async function lpSyncHeldForDispatch(contactId, { deps = {}, nowMs = Date.now() } = {}) {
  if (!contactId) return { held: false, reason: 'no_contact' };
  try {
    const supabase = deps.supabase || (await import('../supabase.js')).default;
    if (!supabase) return { held: false, reason: 'no_supabase' };
    const since = new Date(nowMs - HOLD_MINUTES * 60_000).toISOString();
    const read = supabase
      .from('agent_actions')
      .select('id, status, created_at')
      .eq('action_type', 'reschedule_appointment')
      .eq('target_id', contactId)
      .eq('action_payload->>lp_sync', 'dispatch')
      .in('status', ['executing', 'completed'])
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(1);
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), deps.readCapMs ?? READ_CAP_MS); });
    const res = await Promise.race([read, timeout]).finally(() => clearTimeout(timer));
    if (res?.timedOut) return { held: false, reason: 'read_timeout' };
    if (res?.error) return { held: false, reason: `read_error: ${res.error.message}` };
    const row = Array.isArray(res?.data) ? res.data[0] : null;
    return row ? { held: true, action_id: row.id, reason: 'dispatch_reschedule' } : { held: false, reason: 'none' };
  } catch (err) {
    return { held: false, reason: `error: ${err.message}` };
  }
}
