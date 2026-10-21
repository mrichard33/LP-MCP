// ─── 1 Leg phone presentation — src/agentic/one-leg-presentation.js ──────────
//
// Handoff v3 (Mark, 2026-10-20): a lead whose visit ran with only one decision
// maker home ("1 Leg" in LP) is offered a PHONE PRESENTATION instead of another
// home visit: both decision makers on the call, the price gone over on the call
// (never a number in a text), two REAL open times on the Phone Presentation
// calendar (PHONE_PRESENTATION_CALENDAR_ID), and nothing booked until the lead
// says both of them will be on it.
//
// Only a contact whose OPEN objection state is APPOINTMENT_DISRUPTION.one_leg
// (contact_objection_states, the row v_active_objection_states shows; rule
// LP_DISP_1LEG_TO_ONELEG sets it) ever sees it. Every other contact, a
// "my wife isn't home" new lead included, keeps the normal offer.
//
// Division of labor: GHL S5.2 Appointment Rescue v2, branch "I. 1 Leg", owns
// every 1 Leg message, its timing and the Ross assignment. This is a REPLY
// branch only: it changes what the bot offers when the lead writes in, never
// sends on its own, never enrols or assigns anyone.
//
// The calendar is GHL-only (isGhlOnlyCalendarId): a 1Leg lead is post-issue
// (POST_ISSUE_DISPOSITIONS), so an LP SetAppointment would mint a new LP lead.
//
// ONE_LEG_PRESENTATION_MODE off|live, default live: inert until
// PHONE_PRESENTATION_CALENDAR_ID is set (Mark supplies it). off is the rollback.

export const ONE_LEG_STATE = 'APPOINTMENT_DISRUPTION.one_leg';
export const PHONE_PRESENTATION_MINUTES = 30;
const READ_CAP_MS = 4000;

// Our own "will both of you be on the call?" ask, read by meaning (the model
// words it): "both" with "on the call / join / make it / be there".
export const PP_DM_ASK_RX = /\bboth\b[^?]{0,80}\b(?:on\s+the\s+(?:call|phone)|join|make\s+it|be\s+there|available)\b[^?]*\?/i;
// The lead says both will be there: a yes, "we both can", "she'll be on too".
// The lead says it would be one of them only, or not both.
export const PP_ONLY_ONE_RX = /^\s*(?:no|nope|nah)\b|\b(?:not|can'?t|cannot|won'?t)\b|\b(?:just|only)\s+(?:be\s+)?(?:me|myself|one\s+of\s+us)\b|\bby\s+myself\b/i;
export const PP_BOTH_YES_RX = /\b(?:yes|yeah|yep|yup|sure|ok(?:ay)?|definitely|absolutely|of\s+course|we\s+(?:both\s+)?(?:can|will)|both\s+of\s+us|(?:she|he|they)(?:'ll|\s+will)\s+(?:be|join))\b/i;

/** ONE_LEG_PRESENTATION_MODE off|live, default live (a typo is live: the calendar id still gates). */
export function onePresentationMode(env = process.env) {
  return String(env.ONE_LEG_PRESENTATION_MODE ?? '').trim().toLowerCase() === 'off' ? 'off' : 'live';
}

export function phonePresentationCalendarId(env = process.env) {
  const id = String(env.PHONE_PRESENTATION_CALENDAR_ID || '').trim();
  return id || null;
}

// booking-calendar-router.js's isGhlOnlyCalendarId reads this (every LP guard
// goes through that), so this module keeps no static imports.
export function isPhonePresentationCalendarId(calendarId, env = process.env) {
  const id = phonePresentationCalendarId(env);
  return !!id && String(calendarId || '').trim() === id;
}

export function phonePresentationMinutes(env = process.env) {
  const n = Number(env.PHONE_PRESENTATION_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : PHONE_PRESENTATION_MINUTES;
}

/** Is this contact in the 1 Leg state? objectionState: context.objection_state. Pure. */
export function isOneLegContact(objectionState) {
  return String(objectionState?.state_code || '') === ONE_LEG_STATE;
}

// 2026-10-21 (the user): a lead assigned to an outside partner's phone team
// (GHL tag `phone-team`, added by our partner sync for RFED and by S5.2's
// 1 Leg branch) is worked by phone: "Our chatbot should still respond to any SMS
// messaging and try to book the call." Same calendar, same two real times, same
// both-decision-makers hold as the 1 Leg branch.
export const PHONE_TEAM_TAG = 'phone-team';

/** Does this contact carry the phone-team tag? Pure. */
export function isPhoneTeamContact(tags) {
  return Array.isArray(tags) && tags.some((t) => String(t || '').trim().toLowerCase() === PHONE_TEAM_TAG);
}

/** Does this reply turn get the phone presentation branch? Pure. */
export function phonePresentationActive({ objectionState, tags = [], postDemo = false, rehash = false, channel = 'sms', env = process.env } = {}) {
  return channel === 'sms' && !postDemo && !rehash && (isOneLegContact(objectionState) || isPhoneTeamContact(tags))
    && onePresentationMode(env) === 'live' && !!phonePresentationCalendarId(env);
}

/** Did the lead say both decision makers will be on the call, answering our ask? Pure. */
export function bothConfirmedInThread(turns = []) {
  const list = Array.isArray(turns) ? turns : [];
  for (let i = list.length - 1; i > 0; i--) {
    const t = list[i];
    if (t.direction !== 'inbound') continue;
    const prev = [...list.slice(0, i)].reverse().find((x) => x.direction === 'outbound')?.text || '';
    if (PP_DM_ASK_RX.test(prev) && PP_BOTH_YES_RX.test(t.text) && !PP_ONLY_ONE_RX.test(t.text)) return true;
  }
  return false;
}

// Reference lines. The model writes its own version (Part 7); every offer keeps
// "I have … or …?" (SLOT_OFFER_RX, offeredSlots, heldSlot read it) and the hold
// keeps "I'm holding … for you." (heldSlot).
const pair = (slots) => slots.map((s) => `${s.rel || s.day} at ${s.time}${s.tz ? ` ${s.tz}` : ''}`).join(' or ');
const label = (s) => `${s.rel || s.day} at ${s.time}${s.tz ? ` ${s.tz}` : ''}`;
export const PP_LINES = Object.freeze({
  offer: (slots, hi = '') => `The easiest next step${hi} is a short phone presentation with both of you on the call. We go over the options and the price together then. I have ${pair(slots)}. Which works better?`,
  hold_dm: (slot) => `Great, I'm holding ${label(slot)} for you. Will both of you be able to be on the call together?`,
  dm_no: 'No problem. The call works best with both of you on it, so we can answer both of your questions. What day and time works for both of you?',
  // One sentence on purpose: "all set" (NOT_A_CALLBACK_RX) keeps the booked
  // call out of promisedCallback, so it is never a Five9 Callback Request.
  confirm: (slot) => `You're all set for ${label(slot)}, and we'll go over the options and the price with both of you on the call.`,
});
export const PP_MARKERS = Object.freeze({
  offer: [{ rx: /\bphone\b|\bcall\b/i, say: 'say it is a short phone call' }, { rx: /\bboth\b/i, say: 'say both of them are on the call' }],
  dm: [{ rx: /\bI'm holding\b/i, say: 'say "I\'m holding [the time] for you"' }, { rx: PP_DM_ASK_RX, say: 'ask "will both of you be able to be on the call?"' }],
  dm_no: [{ rx: /\bboth\b/i, say: 'say the call works best with both of them' }],
  confirm: [{ rx: /\byou'?re all set for\b/i, say: 'say "You\'re all set for [the time]"' }],
});

/**
 * The open times on the Phone Presentation calendar, or null. Never throws.
 * @returns {Promise<{ calendarId, offer: object[], all: object[], tz } | null>}
 */
export async function readPhonePresentationSlots({ contactId, timezone, tzLabel = 'ET', env = process.env } = {}, deps = {}) {
  const calendarId = phonePresentationCalendarId(env);
  if (!calendarId) return null;
  try {
    const d = { ...deps };
    if (!d.fetchFreeSlots || !d.selectOfferableSlots || !d.spreadCallOffer) {
      const cal = await import('../knowledge/calendar-availability.js');
      d.fetchFreeSlots ||= cal.fetchFreeSlots;
      d.selectOfferableSlots ||= cal.selectOfferableSlots;
      d.spreadCallOffer ||= cal.spreadCallOffer;
    }
    if (!d.isOpen) d.isOpen = (await import('./team-hours.js')).isTeamOpen;
    const cap = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), READ_CAP_MS))]);
    const av = await cap(d.fetchFreeSlots(calendarId, { timezone, maxSlots: 120, minNoticeHours: 0.5 }));
    if (!av || !Array.isArray(av.slots)) return null;
    const sel = d.selectOfferableSlots(av, null, { call: true, isOpen: d.isOpen });
    const all = d.selectOfferableSlots(av, null, { call: true, isOpen: d.isOpen, offerWindowHours: 24 * 14, maxOffer: 500 })?.slots || [];
    const withTz = (s) => ({ ...s, tz: s.tz || tzLabel });
    let offer = (sel?.slots || []).slice(0, 2);
    if (offer.length < 2 && all.length >= 2) offer = d.spreadCallOffer(all, 2);
    return { calendarId, offer: offer.map(withTz), all: all.map(withTz), tz: tzLabel };
  } catch (err) {
    console.warn(`[OneLegPresentation] ${contactId}: calendar read failed (${err.message}) — the normal reply goes instead`);
    return null;
  }
}

/** The book_appointment for a picked phone presentation time, both decision makers confirmed. Pure. */
export function phonePresentationBooking({ slot, calendarId, env = process.env }) {
  return {
    action_type: 'book_appointment',
    action_payload: {
      calendar_id: calendarId,
      calendar_name: 'Phone Presentation',
      start_time: slot.iso,
      duration_minutes: phonePresentationMinutes(env),
      title: 'Phone Presentation',
      status: 'new',
      phone_presentation: true,
      qualifying_data: { decision_makers_present: true },
    },
    reasoning: '1 Leg lead picked a real open Phone Presentation time and said both decision makers will be on the call (handoff v3, 2026-10-20).',
  };
}
