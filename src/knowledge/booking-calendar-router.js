/**
 * Booking Calendar Router — src/knowledge/booking-calendar-router.js
 *
 * Resolves which GHL calendar a bot-driven booking targets, from where the
 * lead is in the funnel. First match wins. See BUILD HANDOFF §0.
 */
import { hasPriorCompletedAppointment } from './contact-appointments.js';

export const BOOKING_CALENDARS = {
  PROTECTION_PROFILE_REVIEW:  'DQYMaJ22N6zL4SXjHukw', // Tier-1 phone call
  HOME_PROTECTION_ASSESSMENT: 'zS1wg0JqQ1zsszJyJqKX', // in-home, after the call
  WINDOW_ESTIMATE:            'aJj14ONxh1oFyDcQ706O', // default booking
  MEASUREMENT_VERIFICATION:   'zEdPmkNccR2ovo3rQAd3', // estimate-calculator entry
  CONFIRMATION_CALL:          'gFWoSQrlKIdfRbAPV842', // wants to talk, not schedule
};

// In-home calendars require the decision-maker + address gate (a rep visits).
// Phone calendars (PPR, Confirmation Call) do not — the bot just books a time.
const IN_HOME_CALENDAR_KEYS = new Set([
  'HOME_PROTECTION_ASSESSMENT',
  'WINDOW_ESTIMATE',
  'MEASUREMENT_VERIFICATION',
]);

// Booking duration per calendar key. In-home visits run 90 min; phone calls
// are short. Used so phone bookings don't inherit the 90-min in-home default.
const CALENDAR_DURATION_MINUTES = {
  PROTECTION_PROFILE_REVIEW:  30,
  HOME_PROTECTION_ASSESSMENT: 90,
  WINDOW_ESTIMATE:            90,
  MEASUREMENT_VERIFICATION:   90,
  CONFIRMATION_CALL:          15,
};

// Canonical calendar name per key — used for the human-facing appointment
// title only. NOTE: routing is by calendar_id, never by name; CALENDAR_MAP
// maps the PPR id to "Review Session", so trusting a model-echoed name would
// misroute PPR. Booking actions are stamped with calendar_id server-side.
const CALENDAR_NAME = {
  PROTECTION_PROFILE_REVIEW:  'Protection Profile Review',
  HOME_PROTECTION_ASSESSMENT: 'Home Protection Assessment',
  WINDOW_ESTIMATE:            'Window Estimate',
  MEASUREMENT_VERIFICATION:   'Measurement Verification',
  CONFIRMATION_CALL:          'Confirmation Call',
};

// Calendar IDs for the in-home calendars (derived from the keys above) — used
// by server-side booking guards that only have the calendar_id on hand.
const IN_HOME_CALENDAR_IDS = new Set(
  [...IN_HOME_CALENDAR_KEYS].map((key) => BOOKING_CALENDARS[key])
);

/** True if the resolved calendar needs the decision-maker + address gate. */
export function requiresInHomeGate(calendarKey) {
  return IN_HOME_CALENDAR_KEYS.has(calendarKey);
}

/** True if `calendarId` is one of the in-home (rep-visits) calendars. */
export function isInHomeCalendarId(calendarId) {
  return IN_HOME_CALENDAR_IDS.has(calendarId);
}

/** Default appointment duration (minutes) for a resolved calendar key. */
export function durationForCalendar(calendarKey) {
  return CALENDAR_DURATION_MINUTES[calendarKey] || 90;
}

/** Canonical human-facing name for a resolved calendar key (title only). */
export function calendarNameForKey(calendarKey) {
  return CALENDAR_NAME[calendarKey] || null;
}

/**
 * @param {Object} contact
 * @param {string[]} contact.tags      Contact's current tags.
 * @param {string}   contact.id        GHL contact id (for the had-call check).
 * @param {Object} [opts]
 * @param {boolean} [opts.isGenericCallRequest=false]  true when the lead wants a
 *        phone conversation rather than to book an appointment (CALLBACK-style).
 * @returns {Promise<{calendar_id:string, calendar_key:string, reason:string}>}
 */
export async function resolveBookingCalendar(contact, opts = {}) {
  const tags = Array.isArray(contact?.tags) ? contact.tags : [];
  const has = (t) => tags.includes(t);

  // 1 & 2 — risk-report entry: PPR phone call, unless the call already happened.
  if (has('active-entry:risk-report')) {
    const hadCall = await hasPriorCompletedAppointment(
      contact.id, BOOKING_CALENDARS.PROTECTION_PROFILE_REVIEW
    ).catch(() => false);
    if (hadCall) {
      return { calendar_id: BOOKING_CALENDARS.HOME_PROTECTION_ASSESSMENT,
               calendar_key: 'HOME_PROTECTION_ASSESSMENT', reason: 'risk_report_call_completed' };
    }
    return { calendar_id: BOOKING_CALENDARS.PROTECTION_PROFILE_REVIEW,
             calendar_key: 'PROTECTION_PROFILE_REVIEW', reason: 'risk_report_entry' };
  }

  // 3 — estimate-calculator entry → measurement verification.
  if (has('active-entry:estimate-calculator')) {
    return { calendar_id: BOOKING_CALENDARS.MEASUREMENT_VERIFICATION,
             calendar_key: 'MEASUREMENT_VERIFICATION', reason: 'estimate_calculator_entry' };
  }

  // 4 — wants to talk, not book → Confirmation Call (checked before the default).
  // NOTE: currently dormant by design. CALLBACK is a tag_and_handoff intent
  // (priority 150) that short-circuits to a human handoff before booking_context
  // is built, so callers pass isGenericCallRequest=false. Re-enabling this route
  // requires making CALLBACK reach the booking flow (net-new intent work).
  if (opts.isGenericCallRequest) {
    return { calendar_id: BOOKING_CALENDARS.CONFIRMATION_CALL,
             calendar_key: 'CONFIRMATION_CALL', reason: 'generic_call_request' };
  }

  // 5 — default booking → window estimate.
  return { calendar_id: BOOKING_CALENDARS.WINDOW_ESTIMATE,
           calendar_key: 'WINDOW_ESTIMATE', reason: 'default_window_estimate' };
}
