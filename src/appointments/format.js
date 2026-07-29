/**
 * Appointment title + address formatter — src/appointments/format.js
 *
 * WHY THIS EXISTS
 * LP MCP writes a bare calendar name as the appointment title and never sets an
 * address. Measured 2026-07-29 over 30 days on the three booking calendars:
 * of 1,951 LP MCP (createdBy.source = third_party) appointments, 13 carried a
 * contact name — 0.7%. The GHL workflow I.LP-IN carried one on 1,504 of 1,504.
 *
 * The title renders in reminders, notifications, and anything using
 * {{appointment.title}}, so a bare "Window Estimate" tells a rep nothing about
 * who they are driving to.
 *
 * ADDRESS — the gap is entirely at CREATION, not a conditional skip. No LP MCP
 * create path sets `address` at all; the key is absent from every POST body.
 * The 63% that appear populated acquired one LATER, from another writer, as the
 * appointment advanced past `new`. Measured over the same 30 days:
 *
 *     status      n     has address
 *     new        545         4.0%
 *     confirmed  592        99.8%
 *     showed     349        95.4%
 *     noshow     129        96.1%
 *     cancelled  336        47.3%
 *
 * Source data is available and provably present for in-home bookings —
 * evaluateInHomePrerequisites (actions/handlers/appointments.js:175) hard-blocks
 * a booking without contact.address1 + postalCode — so setting it on create
 * should move `new` from 4% to ~100%.
 *
 * PHONE IS DELIBERATELY EXCLUDED. GHL appointments have no phone field, and
 * putting one in the title would push it into every reminder template. Reps tap
 * through to the contact. Do not add it.
 *
 * DO NOT BACKFILL existing titles. Updating ~1,900 live appointments would fire
 * appointment-updated webhooks into A.WE Window Estimate Handler, which triggers
 * on all six statuses and runs 16 webhooks. Separate ticket.
 */

import { isPlaceholderName } from '../services/identity-extraction.js';

/**
 * Calendar ID → the name to put in an appointment title.
 *
 * A THIRD map, deliberately. The two existing ones both disagree with what GHL
 * actually holds, and neither can be used here without changing behaviour
 * elsewhere:
 *
 *   • CALENDAR_NAME_MAP (lp-appointment-sync.js:251) uses SHORT internal forms
 *     — 'MV', 'HPA' — and feeds GroupMe cards and GHL notes. Changing it would
 *     rewrite those.
 *   • CALENDAR_MAP (actions/constants.js:103) is inverted (name → id) and is the
 *     name→id routing table for book_appointment. It uses long forms, but
 *     'Measurement Verification', not the string GHL actually carries.
 *
 * Values below are what every OTHER writer puts in the title, read off live
 * appointments on 2026-07-29 — this is the convention reps already see:
 *
 *   zEdPmkNccR2ovo3rQAd3  'Window Measurement Verification'  94 of 103
 *                          name-carrying titles across workflow, booking_widget,
 *                          contactdetails_page, conversations_ai and mobile_app.
 *                          LP MCP is the sole dissenter (9, and reversed).
 *   aJj14ONxh1oFyDcQ706O  'Window Estimate'                  1,499 of 1,499
 *   DQYMaJ22N6zL4SXjHukw  'Protection Profile Review'        matches the booking
 *                          router; CALENDAR_NAME_MAP's 'Review Session' does not
 *                          appear on a single live appointment.
 *   gFWoSQrlKIdfRbAPV842  'Confirmation Call'
 *   zS1wg0JqQ1zsszJyJqKX  no precedent — this calendar has ZERO appointments,
 *                          ever. Uses the canonical long form.
 *
 * Report the disagreement to Mark; change neither existing map.
 */
export const CALENDAR_TITLE_NAME = {
  'aJj14ONxh1oFyDcQ706O': 'Window Estimate',
  'zEdPmkNccR2ovo3rQAd3': 'Window Measurement Verification',
  'zS1wg0JqQ1zsszJyJqKX': 'Home Protection Assessment',
  'DQYMaJ22N6zL4SXjHukw': 'Protection Profile Review',
  'gFWoSQrlKIdfRbAPV842': 'Confirmation Call',
};

/** Feature flag — read per call, so tests can flip it without a redeploy. */
export function isFormatEnabled() {
  return String(process.env.APPT_FORMAT_ENABLED || '').trim().toLowerCase() === 'true';
}

/** The title-facing name for a calendar, preferring the id over a caller string. */
export function calendarTitleName(calendarId, fallbackName) {
  const mapped = CALENDAR_TITLE_NAME[String(calendarId || '').trim()];
  if (mapped) return mapped;
  const fb = String(fallbackName || '').trim();
  return fb || null;
}

/**
 * `{First} {Last} - {Calendar Name}`, e.g. "Jenette Victory - Window Estimate".
 *
 * With no usable name, returns the BARE calendar name. I.LP-IN emits
 * "  - Window Estimate" in that case — leading spaces and a dangling separator,
 * verified live on 6 of 1,503 — and we deliberately do not reproduce it.
 *
 * A placeholder name ("Guest Visitor", the live-chat widget default) counts as
 * no name; isPlaceholderName is the same guard the booking prerequisites use.
 *
 * @returns {string|null} null only when there is no calendar name AND no person
 *   name, which leaves the caller's existing title untouched.
 */
export function buildAppointmentTitle({ firstName, lastName, calendarId, calendarName }) {
  const calName = calendarTitleName(calendarId, calendarName);

  const parts = [firstName, lastName]
    .map((p) => String(p || '').trim())
    .filter(Boolean);
  const fullName = parts.join(' ');

  const usableName = fullName && !isPlaceholderName(fullName) ? fullName : '';

  if (!usableName) return calName || null;
  if (!calName) return usableName;
  return `${usableName} - ${calName}`;
}

/**
 * Single-line service address for the appointment's `address` field.
 *
 * Mirrors the two existing unexported implementations — composeAddressOnFile
 * (response-generator.js:1071) and the block in identity-extraction.js:573 — so
 * the string shape reps see stays consistent across surfaces.
 *
 * Returns null without a street line. The phone calendars (Protection Profile
 * Review, Confirmation Call) bypass the in-home address gate entirely, so their
 * contacts can legitimately have city/state and no address1; emitting ", FL"
 * for those would be worse than emitting nothing.
 */
export function buildAppointmentAddress({ address1, city, state, postalCode }) {
  const street = String(address1 || '').trim();
  if (!street) return null;

  return [street, city, state, postalCode]
    .map((p) => String(p || '').trim())
    .filter(Boolean)
    .join(', ');
}

/**
 * Apply title + address to an outgoing GHL appointment body, in place.
 *
 * The single wiring point for all four create sites, so behaviour is identical
 * whether a booking arrives via the delegated endpoint or via a rule. No-op when
 * APPT_FORMAT_ENABLED is not 'true' — the body is returned untouched.
 *
 * @param {object} body    the GHL appointment body being built
 * @param {object} contact { firstName, lastName, address1, city, state, postalCode }
 * @returns {{ title: string|null, addressPopulated: boolean }} for event payloads
 */
export function applyAppointmentFormat(body, contact = {}) {
  if (!isFormatEnabled()) {
    return { title: body?.title || null, addressPopulated: false };
  }

  const title = buildAppointmentTitle({
    firstName: contact.firstName,
    lastName: contact.lastName,
    calendarId: body?.calendarId,
    calendarName: body?.title,
  });
  if (title) body.title = title;

  const address = buildAppointmentAddress(contact);
  if (address) body.address = address;

  return { title: body?.title || null, addressPopulated: Boolean(address) };
}
