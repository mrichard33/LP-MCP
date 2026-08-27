/**
 * LP Appointment card — src/services/appointment-card.js
 *
 * ONE builder for the "LP Appointment Set" GroupMe card, called by BOTH
 * producers of that card:
 *   - src/actions/handlers/lp-appointment.js  (agentic set_lp_appointment)
 *   - src/lp-appointment-sync.js              (webhook GHL→LP sync)
 *
 * Why shared (2026-08-27): the two paths hand-rolled the same four-line card
 * independently and had ALREADY drifted apart — see the 2026-06-02 note in the
 * lp-appointment.js header, which records one being brought back in line with
 * the other. By the time this module was written they had drifted again: only
 * the agentic path rendered the ghl_status segment (the Victor Lopez
 * decision-maker-confirmation parity fix, v1.1 2026-07-04), only it treated the
 * literal "N/A" as an absent calendar, and the two disagreed on whether a
 * missing prospect prints "NONE" or "N/A". Two copies means the next card fix
 * gets made once and forgotten once. Same reasoning as
 * services/lead-note-lines.js.
 *
 * The card now routes through buildClassifiedNotification rather than string
 * concatenation, so it carries the required Market and Src lines every other
 * classified card has, plus the address, job context and LP reference that make
 * it actionable without opening GHL.
 *
 * The value written to LP is NOT this module's business and does not change.
 */

import { buildClassifiedNotification } from '../actions/notification-classifier.js';
import { resolveMarket } from '../actions/enrichment.js';
import { formatApptTime12h } from '../format-helpers.js';

/**
 * "N/A" is treated as absent so legacy callers passing the literal string don't
 * render "Calendar: N/A". Moved here from lp-appointment.js (2026-05-27 v2) so
 * both paths apply the same rule — the sync path used a bare truthiness check
 * and would have rendered it.
 */
export function hasMeaningfulCalendar(name) {
  if (!name) return false;
  const s = String(name).trim();
  if (!s) return false;
  if (s.toUpperCase() === 'N/A') return false;
  return true;
}

/**
 * Single-line postal address, or undefined when there is no street to anchor
 * it. City/state/zip alone is not an address anyone can drive to, and a card
 * line reading "📍 , FL" is worse than no line at all.
 */
export function formatAddressLine({ address1, city, state, zip } = {}) {
  const street = String(address1 || '').trim();
  if (!street) return undefined;
  const tail = [String(city || '').trim(), [String(state || '').trim(), String(zip || '').trim()].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(' ');
  return tail ? `${street}, ${tail}` : street;
}

/**
 * The 📅 line: date, 12-hour Eastern time, then the calendar and the GHL
 * decision-maker-confirmation state when each is known.
 *
 * ghl_status parity (v1.1, Victor Lopez incident 2026-07-04): LP's
 * SetAppointment API has no status field, so the card is the only surface where
 * an LP-side rep can see the confirmation state GHL holds. "new" = decision
 * makers have not confirmed; "confirmed" = they have.
 */
export function buildAppointmentDisplay({ apptDate, apptTime, calendarName, ghlStatus } = {}) {
  const calendarSegment = hasMeaningfulCalendar(calendarName) ? ` | ${calendarName}` : '';
  const status = String(ghlStatus || '').toLowerCase();
  const statusSegment = status === 'new'
    ? ' | ⏳ DM confirm pending'
    : (status === 'confirmed' ? ' | ✅ confirmed' : '');
  const time = apptTime ? formatApptTime12h(apptTime) : '';
  return `${apptDate}${time ? ` ${time}` : ''}${calendarSegment}${statusSegment}`;
}

/**
 * Build the LP Appointment Set card.
 *
 * Market resolution is fail-soft: this runs after LP has already accepted the
 * write, so a market lookup that errors must degrade to the classifier's
 * "Unknown" rather than throw away the whole notification.
 *
 * @param {object} args
 * @param {string} args.contactId
 * @param {string} [args.name]        — contact display name
 * @param {string} [args.phone]
 * @param {string} [args.email]
 * @param {string} args.lpLeadId      — LP lds_id
 * @param {string} [args.prospectId]
 * @param {string} [args.lpSource]    — raw LP source (formatted by the classifier)
 * @param {string} [args.lpSourceDetail]
 * @param {string} [args.address1]
 * @param {string} [args.city]
 * @param {string} [args.state]
 * @param {string} [args.zip]
 * @param {string} args.apptDate
 * @param {string} [args.apptTime]
 * @param {string} [args.calendarName]
 * @param {string} [args.ghlStatus]
 * @param {object} [args.ghlContact]  — passed to resolveMarket when the caller has one
 * @param {object} [args.lpLead]      — passed to resolveMarket
 * @param {string} [args.narrative]
 * @returns {Promise<string>} the card text
 */
export async function buildLpAppointmentCard({
  contactId,
  name,
  phone,
  email,
  lpLeadId,
  prospectId,
  lpSource,
  lpSourceDetail,
  address1,
  city,
  state,
  zip,
  apptDate,
  apptTime,
  calendarName,
  ghlStatus,
  ghlContact = null,
  lpLead = null,
  narrative,
} = {}) {
  let market = null;
  try {
    market = await resolveMarket({ ghlContact, lpLead, zip });
  } catch (err) {
    console.warn(`[LP-APPT] market resolution failed for ${contactId} (card renders Unknown): ${err.message}`);
  }

  return buildClassifiedNotification({
    notification_class: 'system',
    action_verb: 'LP APPOINTMENT SET',
    name,
    phone,
    contactId,
    prospectId,
    market,
    lpSource,
    lpSourceDetail,
    address: formatAddressLine({ address1, city, state, zip }),
    email: email || undefined,
    lpRef: `Lead ${lpLeadId} | Prospect ${prospectId || 'NONE'}`,
    appointmentDisplay: buildAppointmentDisplay({ apptDate, apptTime, calendarName, ghlStatus }),
    tier: 'Hot',
    status: 'Appointment Set',
    narrative: narrative
      || 'Appointment written to Lead Perfection. The LP-side team works it from here.',
  });
}

export default { buildLpAppointmentCard, buildAppointmentDisplay, formatAddressLine, hasMeaningfulCalendar };
