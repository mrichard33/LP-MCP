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
// 2026-07-06: PPR corrected 30 → 15 — the live PPR calendar runs 15-minute
// slots and every customer-facing framing says "quick 15-minute call"; the
// old 30 was stale and made slot fetching disagree with the offer.
const CALENDAR_DURATION_MINUTES = {
  PROTECTION_PROFILE_REVIEW:  15,
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

// 2026-07-06 (Sentinel §8 / dynamic appointment naming) — per-calendar
// CUSTOMER-FACING language for the generation prompt. The bot never uses
// internal labels (PPR/MV/WE/HPA) with a lead; whatever it describes must
// match the booked calendar in type, duration, and label. The lead's own
// word (quote/estimate/call) always mirrors back over these labels.
const CUSTOMER_FRAMING = {
  PROTECTION_PROFILE_REVIEW: {
    label: 'a quick 15-minute call',
    type: 'phone',
    duration_text: '15 minutes',
    framing: 'A quick 15-minute phone call where we build their Protection Profile — the full name "Protection Profile Review" is allowed (it is the customer-facing offer name), never abbreviated to "PPR". NEVER describe this as a visit or anything in-home.',
  },
  HOME_PROTECTION_ASSESSMENT: {
    label: 'your free in-home estimate',
    type: 'in_home',
    duration_text: 'about 90 minutes',
    framing: 'A high-value in-home assessment — measure everything, exact pricing on the spot. Never "a sales appointment", never "someone will come give you a quote" as your framing, never "HPA".',
  },
  WINDOW_ESTIMATE: {
    label: 'your free in-home estimate',
    type: 'in_home',
    duration_text: 'about 90 minutes',
    framing: 'A high-value in-home assessment — measure everything to Florida code, exact pricing to the penny, yours to keep. Never "a sales appointment", never "someone will come give you a quote" as your framing, never "WE".',
  },
  MEASUREMENT_VERIFICATION: {
    label: 'a quick visit to verify your measurements and finalize exact pricing',
    type: 'in_home',
    duration_text: 'about 90 minutes',
    framing: 'Verify the measurements from their estimate and finalize exact pricing. Never "MV".',
  },
  CONFIRMATION_CALL: {
    label: 'a quick call',
    type: 'phone',
    duration_text: '1-2 minutes',
    framing: 'A quick confirmation call — 1 to 2 minutes. Never oversell it.',
  },
};

/** Customer-facing naming/framing block for a resolved calendar key. */
export function customerFramingForKey(calendarKey) {
  return CUSTOMER_FRAMING[calendarKey] || null;
}

// 2026-07-06 — active-entry values whose funnel default is the DIRECT in-home
// Window Estimate (Sentinel §3C): pre-sold or high-intent entries only.
// Everything else that isn't risk-report/calculator defaults to the low-
// commitment Protection Profile Review phone call unless readiness signals
// say otherwise.
const WE_DEFAULT_ENTRY_TAGS = new Set([
  'active-entry:referral',
  'active-entry:high-intent-digital',
]);

/**
 * Resolve which calendar a bot-driven booking targets.
 *
 * 2026-07-06 rework (Bot 2/3/4 consolidation) — routing hierarchy is LOCKED:
 *   1. EXPLICIT LEAD REQUEST WINS (opts.requestedFulfillment, from the
 *      analyzer's requested_fulfillment — only ever set from the lead's own
 *      words). A risk-report lead who asks for an in-home estimate books the
 *      estimate; a calculator lead who asks for a call gets the call.
 *   2. No explicit request → funnel default by active-entry:* (Sentinel §3C):
 *      risk-report → PPR (→ HPA once the PPR call is completed) ·
 *      estimate-calculator → MV · referral / High-Intent Digital /
 *      rep-qualified / canvassing-confirmed → Window Estimate ·
 *      canvassing UNconfirmed → phone-first PPR (no in-home push before
 *      lp-lead-issued / lp-lead-confirmed) · chatbot/web/offline-media/
 *      unknown → PPR unless readiness signals (hyperactive fast-track or
 *      buyer stage 4+) justify the direct in-home estimate.
 *   3. Unfulfillable requests never reach this router — the generator's
 *      universal fallback offers human outreach via the callback path.
 *
 * @param {Object} contact
 * @param {string[]} contact.tags      Contact's current tags.
 * @param {string}   contact.id        GHL contact id (for the had-call check).
 * @param {Object} [opts]
 * @param {string}  [opts.requestedFulfillment]  'in_home_estimate' | 'phone_call'
 *        | 'info_only' | 'unspecified' — the lead's explicit ask this turn.
 * @param {boolean} [opts.fastTrack=false]   hyperactive-buyer readiness signal.
 * @param {number}  [opts.buyerStage]        inferred buyer stage (1-5).
 * @param {boolean} [opts.isGenericCallRequest=false]  legacy CALLBACK flag —
 *        kept for back-compat; superseded by requestedFulfillment==='phone_call'.
 * @returns {Promise<{calendar_id:string, calendar_key:string, reason:string}>}
 */
export async function resolveBookingCalendar(contact, opts = {}) {
  const tags = Array.isArray(contact?.tags) ? contact.tags : [];
  const has = (t) => tags.includes(t);

  // ── 1. Explicit lead request — beats every funnel default. ──
  if (opts.requestedFulfillment === 'in_home_estimate') {
    // Calculator leads' in-home visit IS Measurement Verification; everyone
    // else's explicit "come out and give me an estimate" is the Window Estimate.
    if (has('active-entry:estimate-calculator') || has('active-entry:calculator')) {
      return { calendar_id: BOOKING_CALENDARS.MEASUREMENT_VERIFICATION,
               calendar_key: 'MEASUREMENT_VERIFICATION', reason: 'explicit_estimate_request_calculator' };
    }
    return { calendar_id: BOOKING_CALENDARS.WINDOW_ESTIMATE,
             calendar_key: 'WINDOW_ESTIMATE', reason: 'explicit_estimate_request' };
  }
  if (opts.requestedFulfillment === 'phone_call' || opts.isGenericCallRequest) {
    return { calendar_id: BOOKING_CALENDARS.CONFIRMATION_CALL,
             calendar_key: 'CONFIRMATION_CALL', reason: 'explicit_call_request' };
  }

  // ── 2. Funnel defaults (no explicit request). ──

  // Risk-report entry: PPR phone call, unless the call already happened.
  if (has('active-entry:risk-report') || has('active-entry:hrr-completed')) {
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

  // Estimate-calculator entry → measurement verification.
  if (has('active-entry:estimate-calculator') || has('active-entry:calculator')) {
    return { calendar_id: BOOKING_CALENDARS.MEASUREMENT_VERIFICATION,
             calendar_key: 'MEASUREMENT_VERIFICATION', reason: 'estimate_calculator_entry' };
  }

  // Pre-sold / high-intent entries → direct in-home Window Estimate.
  if (tags.some((t) => WE_DEFAULT_ENTRY_TAGS.has(t)) || has('rep-qualified')) {
    return { calendar_id: BOOKING_CALENDARS.WINDOW_ESTIMATE,
             calendar_key: 'WINDOW_ESTIMATE', reason: 'presold_entry_direct_in_home' };
  }

  // Canvassing: confirmation-first — direct in-home only once the call
  // center has confirmed the lead (lp-lead-issued / lp-lead-confirmed).
  if (has('active-entry:canvassing')) {
    if (has('lp-lead-issued') || has('lp-lead-confirmed')) {
      return { calendar_id: BOOKING_CALENDARS.WINDOW_ESTIMATE,
               calendar_key: 'WINDOW_ESTIMATE', reason: 'canvassing_confirmed' };
    }
    return { calendar_id: BOOKING_CALENDARS.PROTECTION_PROFILE_REVIEW,
             calendar_key: 'PROTECTION_PROFILE_REVIEW', reason: 'canvassing_unconfirmed_phone_first' };
  }

  // Readiness override for the unknown/low-signal default: a hyperactive
  // buyer or a stage-4 negotiator earns the direct in-home estimate.
  if (opts.fastTrack === true || Number(opts.buyerStage) >= 4) {
    return { calendar_id: BOOKING_CALENDARS.WINDOW_ESTIMATE,
             calendar_key: 'WINDOW_ESTIMATE', reason: 'readiness_signal_direct_in_home' };
  }

  // ── 3. Default for unknown/low-signal entries (chatbot/web/offline-media/
  // no active-entry): the low-commitment PPR phone call (Sentinel §3C —
  // supersedes the old default_window_estimate). ──
  return { calendar_id: BOOKING_CALENDARS.PROTECTION_PROFILE_REVIEW,
           calendar_key: 'PROTECTION_PROFILE_REVIEW', reason: 'default_ppr_low_signal_entry' };
}
