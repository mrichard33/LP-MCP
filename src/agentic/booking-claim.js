/**
 * booking-claim — src/agentic/booking-claim.js
 *
 * 2026-10-02 simulation (Mark Test, live chat, NEPQ live): the visitor said
 * "Yes, that would help" to the bridge and the bot answered "Perfect. You're
 * all set for a measurement visit at 16828 Crown Bridge Drive." Nothing was
 * booked, and the live chat cannot book from a model reply at all: it books
 * only when a visitor picks one of two real offered times (runNepqFixedMove).
 * The model copied the SMS prompt's booking confirmations (playbooks.js
 * PATH A/B). No guard read the wording, so a false confirmation shipped.
 *
 * Same shape as send-promise.js: a reply may only say a visit is set when
 * this turn actually booked it (or it names the appointment already on file).
 * Pure and dependency-free. Used by src/live-chat/fast-lane.js (rewrite) and
 * src/response-generator.js (regenerate once, then rewrite).
 */

const CLAIM_PATTERNS = [
  /\byou(?:'re|’re|\s+are)\s+(?:all\s+)?(?:set|booked|scheduled|confirmed|locked\s+in)\b/i,
  /\b(?:it'?s|that'?s|it\s+is|that\s+is)\s+(?:all\s+)?(?:booked|confirmed|scheduled|locked\s+in|on\s+the\s+(?:schedule|calendar|books))\b/i,
  /\b(?:is|are)\s+(?:now\s+)?on\s+the\s+(?:schedule|calendar|books)\b/i,
  /\b(?:i|we)(?:'ve|\s+have)?\s+(?:booked|scheduled|locked\s+in|confirmed)\s+(?:you|it|that|your|a)\b/i,
  /\bgot\s+you\s+(?:down|booked|scheduled|on\s+the\s+(?:schedule|calendar|books))\b/i,
  /\byour\s+(?:appointment|visit|measurement|consultation|assessment|review)\s+is\s+(?:all\s+)?(?:set|booked|confirmed|scheduled|locked\s+in)\b/i,
];

// 2026-10-02 (Mark, Oct 2 6:12 PM chat): "Usually on Wednesdays" got "We have
// Wednesdays blocked for you." Nothing was held. A hold is a claim too: it
// stands only when this turn's code held a real slot (opts.held).
const HOLD_PATTERNS = [
  /\b(?:we|i)(?:'ve|’ve|\s+have|'re|’re|\s+are|'m|’m|\s+am)?\s+(?:got\s+)?(?:[\w,]+\s+){0,4}?(?:blocked|reserved|held|holding|penciled|pencilled|saved|set\s+aside)\b(?:\s+(?:off|out|in))?\s+(?:for\s+you|for\s+the\s+visit)\b/i,
  /\b(?:blocked|reserved|held|penciled|pencilled|saved|set\s+aside)\s+(?:off\s+|out\s+)?for\s+you\b/i,
  /\b(?:i'?m|we'?re|i\s+am|we\s+are)\s+holding\b/i,
  /\b(?:is|are)\s+(?:now\s+)?(?:blocked|reserved|held)\b/i,
];

// A day or a time: a claim that names one can be about the appointment on file.
const DAY_OR_TIME_RX = /\b(?:mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?|sun)(?:day)?\b|\btoday\b|\btomorrow\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i;

export const BOOKING_CLAIM_REPLACEMENT = 'Our team will call to set up a time that works for you.';

function sentences(text) {
  return String(text || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
}

/**
 * The first sentence that says a visit is set when nothing backs it, or null.
 * @param {string} message
 * @param {{booked?: boolean, hasAppointment?: boolean}} [opts]
 *   booked          this turn booked (or carries the action that books)
 *   hasAppointment  an appointment is already on file; a claim that names a
 *                   day or time is then about that one and stands
 */
export function findUnbackedBookingClaim(message, { booked = false, hasAppointment = false, held = false } = {}) {
  if (booked) return null;
  for (const s of sentences(message)) {
    if (s.endsWith('?')) continue;
    const claim = CLAIM_PATTERNS.some(rx => rx.test(s)) || (!held && HOLD_PATTERNS.some(rx => rx.test(s)));
    if (!claim) continue;
    if (hasAppointment && DAY_OR_TIME_RX.test(s)) continue;
    return s;
  }
  return null;
}

/**
 * The reply with every unbacked claim replaced by the truth: the team will
 * call to set the time. The replacement is left out when the reply already
 * says someone will call. Pure.
 */
export function rewriteBookingClaims(message, opts = {}) {
  const parts = sentences(message);
  const claims = new Set();
  let claim;
  let rest = parts;
  while ((claim = findUnbackedBookingClaim(rest.join(' '), opts))) {
    claims.add(claim);
    rest = rest.filter(s => s !== claim);
  }
  if (!claims.size) return { text: String(message || ''), changed: false };
  const saysCall = rest.some(s => /\b(?:team|someone|specialist|we)\b[^.?!]{0,40}\bcall\b/i.test(s));
  // 2026-10-02: the live chat books real times itself, so its replacement is
  // the visit question (opts.replacement), not a promised call.
  const replacement = opts.replacement || BOOKING_CLAIM_REPLACEMENT;
  const out = [];
  let replaced = false;
  for (const s of parts) {
    if (!claims.has(s)) { out.push(s); continue; }
    if (!replaced && (!saysCall || opts.replacement)) out.push(replacement);
    replaced = true;
  }
  return { text: out.join(' ').trim() || replacement, changed: true };
}

/** The regeneration instruction for a draft that claimed a booking. */
export function bookingClaimNote(claim) {
  return (
    `Your previous draft told the lead their visit is set ("${String(claim).slice(0, 160)}"), but nothing was booked. ` +
    'Never say a visit is set, booked, confirmed or on the schedule unless this reply books a real time they picked. ' +
    'Offer the next step instead, or say our team will call to set up a time.'
  );
}
