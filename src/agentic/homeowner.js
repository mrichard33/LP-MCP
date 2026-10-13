// ─── Does the lead own the home? — src/agentic/homeowner.js ─────────────────
//
// WHY (handoff "Lead Conversation Stage", 2026-10-12, batch 3 test 3)
//   A renter was offered two visit times, once in the same reply as "get his
//   okay first". Reece does not run single-leg visits: the owner has to be part
//   of it. Nothing in the planner read ownership; only the analyzer's
//   dq_detected and a person's LP note (lp-note-dq.js) did.
//
//   This is the one reader of the lead's own words about owning or renting,
//   shared by the stage recorder (lead-stage.js) and the qualifying guard.
//   A landlord ("we rent it out", "my tenants") OWNS the home: that is not a
//   renter. Since 2026-10-13 a rental is a no anyway (rentalFromThread and
//   property-scope.js), but the ownership answer stays true.
//
// PURE. No I/O.

// A rental owner talking about their own property. Exported for
// property-scope.js: since 2026-10-13 a rental is a no for the landlord too
// (the user: "We do not work on … rental units"), but the landlord still OWNS
// the home, so homeownerFromThread keeps answering 'yes' for them.
export const RENTAL_OWNER_RX = /\brent(?:ing|ed)?\s+(?:it|them|this|that|the\s+\w+|my\s+\w+|our\s+\w+)\s+out\b|\brent(?:ing)?\s+out\b|\brental\s+propert(?:y|ies)\b|\b(?:my|our)\s+tenants?\b|\b(?:i'?m|i\s+am|we'?re|we\s+are)\s+the\s+landlords?\b|\bi\s+own\s+(?:a\s+|the\s+)?rental\b/i;

// The home is rented out, by the landlord's words or a rental named as a
// thing (Airbnb, "it's a rental"). A tenant ("I'm renting") is RENTER_RX.
export const RENTAL_HOME_RX = new RegExp([
  RENTAL_OWNER_RX.source,
  '\\brental\\s+(?:units?|homes?|houses?|condos?|apartments?)\\b',
  '\\bapartment\\s+(?:building|complex)(?:es|s)?\\b',
  '\\b(?:airbnb|vrbo)\\b',
  '\\bshort[-\\s]term\\s+rentals?\\b',
  "\\b(?:it'?s|it\\s+is)\\s+(?:a|an)\\s+rental\\b",
].join('|'), 'i');

// A former rental the owner now lives in: not a rental any more.
export const LIVES_THERE_NOW_RX = /\b(?:used\s+to\s+(?:rent|be\s+a\s+rental)|was\s+a\s+rental|no\s+longer\s+(?:rent|a\s+rental))\b|\b(?:we|i)\s+(?:now\s+)?live\s+(?:there|in\s+it)\s+now\b/i;

// The lead says they rent. "Can renters get a quote?" counts: batch 3 asked it
// exactly that way about their own home.
export const RENTER_RX = /\b(?:i'?m|i\s+am|we'?re|we\s+are)\s+(?:a\s+|just\s+a\s+)?(?:renters?|tenants?)\b|\b(?:i'?m|i\s+am|we'?re|we\s+are)\s+(?:currently\s+|just\s+)?renting\b|\b(?:i|we)\s+(?:currently\s+|just\s+)?rent\s+(?:here|this|the|my|our|a|an)\b|\b(?:i|we)\s+rent\s*[.!?]*$|\b(?:my|our|the)\s+landlord\b|\b(?:i|we)\s+(?:don'?t|do\s+not|dont)\s+own\b|\bnot\s+the\s+(?:home\s*|house\s*|property\s*)?owners?\b|\b(?:can|do)\s+renters\b|\bas\s+a\s+(?:renter|tenant)\b|\bi'?m\s+not\s+(?:the\s+)?(?:home\s*)?owner\b/i;

// The lead says they own it.
const OWNER_RX = /\b(?:i|we)\s+(?:do\s+)?own\s+(?:the|my|our|this|it|that)\b|\b(?:i'?m|i\s+am|we'?re|we\s+are)\s+(?:the\s+)?(?:home\s*|house\s*|property\s*)?owners?\b|\bi'?m\s+a\s+homeowner\b|\bit'?s\s+(?:my|our)\s+(?:own\s+)?(?:home|house)\b|\bwe\s+bought\s+(?:the|this|our)\s+(?:home|house)\b/i;

// Our question about ownership, read by meaning (the model words it).
export const OWNER_ASK_RX = /\b(?:do\s+you\s+own|are\s+you\s+the\s+(?:home\s*)?owner|own\s+the\s+(?:home|house|property)|homeowner)\b[^?]*\?/i;

const YES_REPLY_RX = /^\s*(?:y(?:es|eah|ep|up)|sure|i\s+do|we\s+do|correct|that'?s\s+right|absolutely|of\s+course|yup)\b/i;
const NO_REPLY_RX = /^\s*(?:no(?:pe)?|nah|not\s+(?:really|exactly)|i\s+don'?t|we\s+don'?t)\b/i;

/** Does this one message say the lead rents (and is not a landlord)? Pure. */
export function saysRenter(text) {
  const t = String(text || '');
  if (RENTAL_OWNER_RX.test(t)) return false;
  return RENTER_RX.test(t);
}

/** Does this one message say the lead owns the home? Pure. */
export function saysOwner(text) {
  const t = String(text || '');
  return RENTAL_OWNER_RX.test(t) || (OWNER_RX.test(t) && !RENTER_RX.test(t));
}

/**
 * 'yes' | 'no' | 'unknown' from the thread (oldest first, {direction, text}).
 * The newest decisive message wins: a renter who then says "actually my wife
 * and I own it" is an owner. A bare yes/no counts only as the reply to our own
 * ownership question. Pure.
 */
export function homeownerFromThread(turns = []) {
  const list = (Array.isArray(turns) ? turns : []).map(m => ({
    direction: String(m?.direction || '').toLowerCase() === 'outbound' ? 'outbound' : 'inbound',
    text: String(m?.text ?? m?.body ?? ''),
  }));
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.direction !== 'inbound') continue;
    if (saysRenter(m.text)) return 'no';
    if (saysOwner(m.text)) return 'yes';
    const prevOut = [...list.slice(0, i)].reverse().find(x => x.direction === 'outbound')?.text || '';
    if (OWNER_ASK_RX.test(prevOut)) {
      if (YES_REPLY_RX.test(m.text)) return 'yes';
      if (NO_REPLY_RX.test(m.text)) return 'no';
    }
  }
  return 'unknown';
}

/**
 * Is the home a rental, by the lead's own words (the user, 2026-10-13: no
 * rental units at all)? 'tenant' (they rent it), 'landlord' (they rent it
 * out), 'none' (the newest decisive message says they own it and nothing
 * about renting it out), 'unknown'. The newest decisive message wins, as in
 * homeownerFromThread: "we used to rent it out but we live there now" ends
 * on an owner. Pure.
 */
export function rentalFromThread(turns = []) {
  const owner = homeownerFromThread(turns);
  if (owner === 'no') return 'tenant';
  const list = (Array.isArray(turns) ? turns : []).map(m => ({
    direction: String(m?.direction || '').toLowerCase() === 'outbound' ? 'outbound' : 'inbound',
    text: String(m?.text ?? m?.body ?? ''),
  }));
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.direction !== 'inbound') continue;
    if (RENTAL_HOME_RX.test(m.text) && !LIVES_THERE_NOW_RX.test(m.text)) return 'landlord';
    if (saysOwner(m.text) || LIVES_THERE_NOW_RX.test(m.text)) return 'none';
  }
  return 'unknown';
}

