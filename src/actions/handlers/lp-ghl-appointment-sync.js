/**
 * sync_lp_appointment_to_ghl — src/actions/handlers/lp-ghl-appointment-sync.js
 *
 * LP→GHL appointment authority. Fired by the LP_APPT_GHL_SYNC_SET/CNF/CXL
 * rules on lp.disposition_changed; converges the GHL Window Estimate calendar
 * to the lp_leads row via the shared reconciler
 * (src/services/lp-ghl-appointment-reconciler.js — see its header for the
 * LP-as-authority semantics, loop safety, and fail-closed lookup rationale).
 *
 * Lead resolution: the disposition event's payload carries neither lp_lead_id
 * nor appointment_date (getEventContext spreads only system_events.payload),
 * so the handler re-reads the AUTHORITATIVE row itself: newest lp_leads row
 * for the target contact by created_at_lp — the same ordering as the
 * decision engine's isNewestLeadForContact gate, which already drops
 * disposition events from non-newest leads. payload.lp_lead_id is an explicit
 * override for backfill/manual invocations.
 *
 * By design, not a bug: an LP CXL arriving AFTER the slot has passed no-ops
 * with nothing_to_cancel — the appointment is no longer "upcoming", so the
 * GHL object keeps its last status (don't rewrite history). Show/no-show
 * reconciliation is a separate flow.
 *
 * Notifications: none chained. The agent_actions audit row records the
 * outcome, and the ghl.appointment_* webhooks our writes trigger already
 * produce the existing notes/GroupMe surface.
 */

import supabase from '../../supabase.js';
import { reconcileLpAppointmentToGhl } from '../../services/lp-ghl-appointment-reconciler.js';
import { sendGroupMeMessage } from '../../groupme.js';

export async function executeSyncLpAppointmentToGhl(action, context = {}) {
  const contactId = action.target_id;
  if (!contactId) throw new Error('sync_lp_appointment_to_ghl: action.target_id (ghl_contact_id) is required');
  if (!supabase) throw new Error('sync_lp_appointment_to_ghl: supabase not configured');

  const payload = action.action_payload || {};

  let query = supabase
    .from('lp_leads')
    .select('lp_lead_id, disposition_code, appointment_date, appointment_set, ghl_contact_id, first_name, last_name, lead_source');
  query = payload.lp_lead_id
    ? query.eq('lp_lead_id', String(payload.lp_lead_id))
    : query.eq('ghl_contact_id', contactId).order('created_at_lp', { ascending: false }).limit(1);
  const { data: lead, error } = await query.maybeSingle();

  if (error) throw new Error(`sync_lp_appointment_to_ghl: lp_leads read failed: ${error.message}`);
  if (!lead) {
    return {
      action: 'lp_ghl_appointment_sync',
      outcome: 'noop',
      skipped: true,
      reason: 'no_lp_lead',
      contact_id: contactId,
      lp_lead_id: payload.lp_lead_id || null,
    };
  }

  if (payload.disposition_code && payload.disposition_code !== lead.disposition_code) {
    // Row wins: it is fresher than the event that queued this action.
    console.warn(`[LpGhlApptSync] payload disposition '${payload.disposition_code}' differs from lp_leads row '${lead.disposition_code}' for lead ${lead.lp_lead_id} — using the row`);
  }

  const result = await reconcileLpAppointmentToGhl({
    contactId,
    lead,
    toNotify: !payload.suppress_notifications,
    contactCache: context._contactCache,
  });

  if (result?.reason === 'impossible_hour') {
    await notifyImpossibleHour({ contactId, lead, result }).catch((err) =>
      console.warn(`[LpGhlApptSync] impossible-hour card failed for ${contactId}: ${err.message}`));
  }

  return { action: 'lp_ghl_appointment_sync', ...result };
}

// ─── Impossible-hour notification (2026-07-22) ────────────────────────
// The reconciler blocks set/confirm mirrors whose ET hour falls outside
// business hours and returns reason 'impossible_hour'. The block itself is
// silent by design (the reconciler is supabase-free); this handler owns the
// human surface: ONE priority GroupMe card per (lead, date), claim-before-
// send against lp_sync_failure_notices (sql/047) so executor retries and
// re-fired disposition events can't card twice. Mirrors claimFailureNotice
// semantics in src/lp-appointment-sync.js — deliberately NOT imported from
// there (routes module; cycle risk through admin/lp-force-addlead):
//   duplicate key 23505  → suppress the card (already claimed)
//   missing table 42P01  → send UNGUARDED (out-of-order deploy degrades
//                          to noisy, never silent)
//   any other DB error   → suppress the card; the block still stands and
//                          the agent_actions row still records the outcome.
// Lifecycle: a later successful sync for the contact releases its notices
// via clearSyncFailedTag → releaseFailureNotices, so a NEW bad date after a
// correction is allowed to card again.
async function claimImpossibleHourNotice({ contactId, lead, result }) {
  const dateKey = String(lead.appointment_date || '').slice(0, 10) || 'nodate';
  const noticeKey = `impossible-hour:${lead.lp_lead_id || contactId}:${dateKey}`;
  try {
    const { error } = await supabase
      .from('lp_sync_failure_notices')
      .insert({
        notice_key: noticeKey,
        contact_id: contactId,
        appt_date: dateKey,
        appt_time: result?.appointment_hour_et != null
          ? `${String(result.appointment_hour_et).padStart(2, '0')}:00`
          : null,
      });
    if (!error) return true;
    if (error.code === '23505') {
      console.log(`[LpGhlApptSync] impossible-hour card already claimed for ${noticeKey} — no repeat`);
      return false;
    }
    if (error.code === '42P01') {
      console.error('[LpGhlApptSync] lp_sync_failure_notices missing — apply sql/047 — sending card UNGUARDED');
      return true;
    }
    console.warn(`[LpGhlApptSync] impossible-hour notice claim errored (card suppressed): ${error.message}`);
    return false;
  } catch (err) {
    console.warn(`[LpGhlApptSync] impossible-hour notice claim threw (card suppressed): ${err.message}`);
    return false;
  }
}

async function notifyImpossibleHour({ contactId, lead, result }) {
  if (!(await claimImpossibleHourNotice({ contactId, lead, result }))) return;
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || contactId;
  const when = String(lead.appointment_date || '?').slice(0, 16).replace('T', ' ');
  await sendGroupMeMessage(
    `🚨 IMPOSSIBLE APPOINTMENT HOUR — GHL mirror BLOCKED\n` +
    `👤 ${name}\n` +
    `📋 LP Lead: ${lead.lp_lead_id || '?'} | GHL: ${contactId}\n` +
    `📅 LP holds: ${when} ET (hour ${result.appointment_hour_et})\n` +
    `📋 Src: ${lead.lead_source || '?'} | Disp: ${lead.disposition_code || '?'}\n` +
    `⚠️ The GHL calendar was NOT written. LP still holds the bad time and\n` +
    `Five9 lists repopulate at 6 AM — verify the real time with the\n` +
    `customer, correct it in LP FIRST, then re-fire the disposition to mirror.`,
    { flushNow: true }
  );
}
