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

export async function executeSyncLpAppointmentToGhl(action, context = {}) {
  const contactId = action.target_id;
  if (!contactId) throw new Error('sync_lp_appointment_to_ghl: action.target_id (ghl_contact_id) is required');
  if (!supabase) throw new Error('sync_lp_appointment_to_ghl: supabase not configured');

  const payload = action.action_payload || {};

  let query = supabase
    .from('lp_leads')
    .select('lp_lead_id, disposition_code, appointment_date, appointment_set, ghl_contact_id, first_name, last_name');
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

  return { action: 'lp_ghl_appointment_sync', ...result };
}
