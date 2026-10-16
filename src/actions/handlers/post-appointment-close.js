/**
 * close_past_lp_appointment — src/actions/handlers/post-appointment-close.js
 *
 * The event path of the post-appointment close (2026-10-16, Roberta Ritchie;
 * decisions in src/appointments/post-appointment-close.js). Rule LP_APPT_GHL_CLOSE
 * queues it when LP dispositions a visit (demo, NoHome, CXL, CCC, NG); the parity
 * watchdog's Class F pass is the backstop for an event that never came.
 *
 * Reads the contact's GHL estimates (72h back and ahead) and its lp_leads rows,
 * then closes each candidate through closeOne (shadow / live by
 * POST_APPT_CLOSE_MODE). Never touches LP.
 */

import {
  closeCandidates, closeOne, postApptCloseMode, CLOSE_LOOKBACK_HOURS,
} from '../../appointments/post-appointment-close.js';

/**
 * deps: { supabase, fetchRecentAndUpcomingAppointments, readLive(lead), putAppointment(id, body),
 *         queueAction(row), emitEvent, mode, nowMs, log }
 */
export async function executeClosePastLpAppointment(action, context = {}, deps = {}) {
  const contactId = action?.target_id;
  if (!contactId) throw new Error('close_past_lp_appointment: action.target_id (ghl_contact_id) is required');
  const mode = deps.mode || postApptCloseMode();
  if (mode === 'off') return { action: 'close_past_lp_appointment', outcome: 'noop', skipped: true, reason: 'mode_off', contact_id: contactId };
  const nowMs = deps.nowMs ?? Date.now();

  const { data: leads, error } = await deps.supabase.from('lp_leads')
    .select('lp_lead_id, lp_prospect_id, ghl_contact_id, disposition_code, appointment_date, synced_at, updated_at_lp, created_at_lp, set_date, last_contact_date')
    .eq('ghl_contact_id', contactId);
  if (error) throw new Error(`close_past_lp_appointment: lp_leads read failed: ${error.message}`);
  if (!leads?.length) return { action: 'close_past_lp_appointment', outcome: 'noop', skipped: true, reason: 'no_lp_lead', contact_id: contactId };

  const appts = await deps.fetchRecentAndUpcomingAppointments(contactId, { pastHours: CLOSE_LOOKBACK_HOURS });
  // Fail closed: GHL unreadable → throw, so the executor retries.
  if (!Array.isArray(appts)) throw new Error(`close_past_lp_appointment: GHL appointment read failed for ${contactId}`);
  const ghlRows = appts.map((a) => ({
    ghl_contact_id: contactId, ghl_appointment_id: a.appointment_id, ghl_calendar_id: a.calendar_id,
    status: a.status, start_time: a.start_time,
  }));
  const candidates = closeCandidates({ ghlRows, leadsByContact: new Map([[contactId, leads]]), nowMs });
  const results = [];
  for (const appt of candidates) {
    results.push(await closeOne({ contactId, appt, leads, deps: { ...deps, mode, nowMs } }));
  }
  const closed = results.filter((r) => r.op === 'close');
  return {
    action: 'close_past_lp_appointment',
    outcome: closed.some((r) => r.applied) ? 'closed' : (closed.length ? 'would_close' : 'noop'),
    skipped: !closed.length,
    reason: closed.length ? null : (results[0]?.reason || 'no_open_estimate'),
    mode,
    contact_id: contactId,
    results: results.map((r) => ({ appointment_id: r.appointment_id, op: r.op, reason: r.reason, status: r.status || null, applied: r.applied, reschedule_to: r.rescheduleTo || null, lp_lead_id: r.lp_lead_id || null })),
  };
}
