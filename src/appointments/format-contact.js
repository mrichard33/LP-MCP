/**
 * Contact-reading wrapper for the appointment formatter —
 * src/appointments/format-contact.js
 *
 * Split from format.js on purpose. format.js is pure (string in, string out) and
 * therefore unit-testable with no stubbing; the moment it imports the contact
 * cache it drags in ghl.js → axios and the whole GHL surface. Everything that
 * needs I/O lives here instead.
 */

import { getContactCached } from '../actions/contact-cache.js';
import { applyAppointmentFormat, isFormatEnabled } from './format.js';

/**
 * applyAppointmentFormat for the in-process call sites, which hold a contactId
 * rather than a contact object. Reads through the executor's contact cache, so a
 * booking that already ran the in-home prerequisite gate pays nothing extra.
 *
 * Checks the flag BEFORE the read, so a dark deploy adds no GHL calls at all.
 *
 * FAILS OPEN: a contact-read error leaves the body untouched and the booking
 * proceeds. Formatting is cosmetic and must never strand a booking the bot has
 * already promised — the same stance evaluateInHomePrerequisites takes on a
 * contact-read failure (actions/handlers/appointments.js:163).
 *
 * @returns {Promise<{ title: string|null, addressPopulated: boolean }>}
 */
export async function applyAppointmentFormatForContact(body, contactId, contactCache) {
  if (!isFormatEnabled()) {
    return { title: body?.title || null, addressPopulated: false };
  }
  try {
    const contact = await getContactCached(contactId, contactCache);
    return applyAppointmentFormat(body, {
      firstName: contact?.firstName,
      lastName: contact?.lastName,
      address1: contact?.address1,
      city: contact?.city,
      state: contact?.state,
      postalCode: contact?.postalCode,
    });
  } catch (err) {
    console.warn(`[ApptFormat] contact read failed for ${contactId}: ${err.message} — leaving title/address as-is`);
    return { title: body?.title || null, addressPopulated: false };
  }
}
