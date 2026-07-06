/**
 * Appointment Field Sync — src/actions/handlers/appointment-field-sync.js
 *
 * syncCancelledAppointmentState(contactId, opts): mirror an appointment
 * cancellation onto the contact record and the local LP snapshot.
 *
 * Why this exists (2026-07-06, Mark Test incident): cancelling an
 * appointment — via the agentic cancel companion, a rep in the GHL UI, or
 * the lead through a cancel link — updated ONLY the calendar event. The
 * contact's appointment mirror fields (LP Appointment Date/Time,
 * Appointment Status) and the lp_leads snapshot (appointment_set, which no
 * code path ever reset) kept describing the cancelled appointment as
 * upcoming. The responder then anchored replies to a visit that no longer
 * existed ("your visit Wednesday…").
 *
 * What it writes (all fail-soft — a mirror-sync failure must never block
 * or unwind the cancellation itself):
 *   GHL custom fields (updateGHLContactFields):
 *     - jHFRKGGsYJJFRbWwthkG  Appointment Status → the calendar-matched
 *       "Canceled - …" option (skipped for calendars with no matching
 *       option, so we never write a mislabeled status)
 *     - GL1rM4cnXBETsBkqxkZw  LP Appointment Date  → cleared
 *     - iRuo2towFCpyKnnIUtLH  LP Appointment Time  → cleared
 *     - bja3R0i0pGRmz6fFVdxb  Last Cancelled Appointment ID → appointmentId
 *       (when known)
 *     History is deliberately preserved in Last Appointment Start Date/Time
 *     (x8KO5o89WPLfC7ivia3A / U67epWMNqjbf0SHAllEZ) — those are GHL-owned
 *     "last" mirrors, not "upcoming" state.
 *   Supabase:
 *     - lp_leads.appointment_set = false for the contact's row(s). The next
 *       LP ingest re-asserts LP truth; this closes the gap between the GHL
 *       cancellation and that sync.
 *
 * NOT written here: Cooling Active (owned by the disengagement flow) and
 * the legacy field IDs still holding values on some contacts
 * (JZrfqPkpa8KyeEYTYGv1, smaNQm4EKP5uTAapmFaR, S7La5BNrpxXlJ2T8Hd7k,
 * JcsrsRdq6bjcgcklGIrL) — those no longer exist in the location's field
 * definitions, so writes to them are no-ops at best.
 */

import supabase from '../../supabase.js';
import { updateGHLContactFields } from '../../ghl.js';

const APPT_STATUS_FIELD        = 'jHFRKGGsYJJFRbWwthkG'; // SINGLE_OPTIONS
const LP_APPT_DATE_FIELD       = 'GL1rM4cnXBETsBkqxkZw'; // DATE
const LP_APPT_TIME_FIELD       = 'iRuo2towFCpyKnnIUtLH'; // TEXT
const LAST_CANCELLED_APPT_ID   = 'bja3R0i0pGRmz6fFVdxb'; // TEXT

// Calendar ID → the Appointment Status picklist option for a cancellation.
// Options verified against the live field definition 2026-07-06:
// Booked/Canceled × Conf Call / Estimate / Measurement Verification.
// Calendars with no matching option (Review Session / HPA) skip the status
// write rather than mislabel it.
const CANCELLED_STATUS_BY_CALENDAR = {
  'aJj14ONxh1oFyDcQ706O': 'Canceled - Estimate',                 // Window Estimate
  'zEdPmkNccR2ovo3rQAd3': 'Canceled - Measurement Verification', // MV
  'gFWoSQrlKIdfRbAPV842': 'Canceled - Conf Call',                // Confirmation Call
};

/**
 * @param {string} contactId GHL contact ID
 * @param {object} [opts]
 * @param {string} [opts.appointmentId] cancelled GHL appointment/event ID
 * @param {string} [opts.calendarId]    calendar the appointment lived on
 * @returns {object} summary of what was synced (for handler results/logs)
 */
export async function syncCancelledAppointmentState(contactId, opts = {}) {
  const { appointmentId = null, calendarId = null } = opts;
  const summary = { fields_synced: [], lp_snapshot_updated: false, errors: [] };
  if (!contactId) return summary;

  const fields = [
    { id: LP_APPT_DATE_FIELD, field_value: '' },
    { id: LP_APPT_TIME_FIELD, field_value: '' },
  ];
  const cancelledStatus = calendarId ? CANCELLED_STATUS_BY_CALENDAR[calendarId] : null;
  if (cancelledStatus) fields.push({ id: APPT_STATUS_FIELD, field_value: cancelledStatus });
  if (appointmentId) fields.push({ id: LAST_CANCELLED_APPT_ID, field_value: String(appointmentId) });

  try {
    const result = await updateGHLContactFields(contactId, fields);
    if (result && result !== 'not_found') {
      summary.fields_synced = fields.map(f => f.id);
    } else {
      summary.errors.push(`ghl_field_update_${result === 'not_found' ? 'not_found' : 'failed'}`);
    }
  } catch (err) {
    summary.errors.push(`ghl_field_update_threw:${err.message}`);
    console.warn(`[ApptFieldSync] GHL field sync failed for ${contactId}: ${err.message}`);
  }

  try {
    const { error } = await supabase
      .from('lp_leads')
      .update({ appointment_set: false })
      .eq('ghl_contact_id', contactId)
      .eq('appointment_set', true);
    if (error) {
      summary.errors.push(`lp_snapshot_update:${error.message}`);
      console.warn(`[ApptFieldSync] lp_leads snapshot update failed for ${contactId}: ${error.message}`);
    } else {
      summary.lp_snapshot_updated = true;
    }
  } catch (err) {
    summary.errors.push(`lp_snapshot_threw:${err.message}`);
    console.warn(`[ApptFieldSync] lp_leads snapshot update threw for ${contactId}: ${err.message}`);
  }

  console.log(`[ApptFieldSync] cancelled-appointment mirror sync for ${contactId}: fields=${summary.fields_synced.length ? summary.fields_synced.join(',') : 'none'} lp_snapshot=${summary.lp_snapshot_updated}${summary.errors.length ? ` errors=${summary.errors.join('|')}` : ''}`);
  return summary;
}
