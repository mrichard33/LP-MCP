// ─── A renter gets no visit — src/agentic/non-owner.js ──────────────────────
//
// WHY (handoff "Lead Conversation Stage" PR 3, 2026-10-12; batch 3 test 3)
//   A renter was offered two visit times twice, once in the SAME reply as
//   "you'll want to get his okay first". Reece does not run single-leg
//   visits: the homeowner has to be part of it. This pass makes a time offer
//   to a lead who said they rent impossible to send, on both bots, whatever
//   LEAD_STAGE_MODE says (the user's ruling: the no-single-leg rule ships
//   active).
//
//   - The lead says it THIS turn → the whole reply is the non-owner line (we
//     don't work on rental units). No times, no question, no booking.
//   - They said it earlier → any sentence that offers a time, asks to book,
//     or names a clock time is dropped; nothing left → the line.
//   A landlord ("we rent it out") owns the home (homeowner.js), and since
//   2026-10-13 gets the same answer: the user, "We do not work on commercial
//   properties or rental units", and ruled that a home rented out is a no
//   whoever is asking. The line no longer sends the tenant to the owner: the
//   owner of a rental cannot book either.
//
// PURE. The callers drop the book_appointment companion when this fires.

import { rentalFromThread, saysRenter, RENTAL_HOME_RX, LIVES_THERE_NOW_RX } from './homeowner.js';
import { findBookingAsks } from './discovery-discipline.js';

export const NON_OWNER_LINE = "Thanks for letting me know. We don't work on rental units, so we can't set up a visit for this home.";

// A reply that already says no to a rental (property-scope.js's answer, or
// the model's own) is left alone.
const RENTAL_NO_RX = /\b(?:don'?t|do\s+not|can'?t|cannot|isn'?t|aren'?t|not)\b[^.!?]*\brent/i;

function saysRentedOutNow(text) {
  const t = String(text || '');
  return RENTAL_HOME_RX.test(t) && !LIVES_THERE_NOW_RX.test(t);
}

const CLOCK_RX = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)\b/i;
const VISIT_OFFER_RX = /\b(?:I\s+have\b[^.?!]*\bor\b|hold(?:ing)?\s+(?:a\s+time|that|it)|(?:schedule|book|set\s+up)\s+(?:a|the|your)\s+(?:visit|time|appointment|measure)|next\s+step\s+(?:would\s+be|is)|come\s+out\s+(?:and|to))\b/i;

function splitSentences(text) {
  return String(text || '').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
}

/**
 * @param {string} draft
 * @param {object} a
 * @param {Array}  a.thread   the conversation, oldest first ({direction, text})
 * @param {string} a.inbound  the lead's newest message
 * @returns {{ text: string, changed: boolean, reason: string|null }}
 */
export function enforceNonOwner(draft, { thread = [], inbound = '' } = {}) {
  const text = String(draft || '');
  const turns = [...(Array.isArray(thread) ? thread : []).map(m => ({
    direction: String(m?.direction || '').toLowerCase() === 'outbound' ? 'outbound' : 'inbound',
    text: String(m?.text ?? m?.body ?? ''),
  }))];
  const last = turns[turns.length - 1];
  if (inbound && !(last && last.direction === 'inbound' && last.text === inbound)) turns.push({ direction: 'inbound', text: String(inbound) });
  const rental = rentalFromThread(turns);
  if (rental !== 'tenant' && rental !== 'landlord') return { text, changed: false, reason: null };
  if (saysRenter(inbound) || saysRentedOutNow(inbound)) {
    if (text.trim() === NON_OWNER_LINE || RENTAL_NO_RX.test(text)) return { text, changed: false, reason: null };
    return { text: NON_OWNER_LINE, changed: true, reason: rental === 'tenant' ? 'renter_said_now' : 'rental_said_now' };
  }
  const asks = new Set(findBookingAsks(text));
  const kept = splitSentences(text).filter(s => !asks.has(s) && !CLOCK_RX.test(s) && !VISIT_OFFER_RX.test(s));
  const out = kept.join(' ').trim();
  if (out === text.trim()) return { text, changed: false, reason: null };
  return { text: out || NON_OWNER_LINE, changed: true, reason: out ? 'visit_offer_dropped' : 'renter_earlier' };
}

/** Is this home, by the lead's own words in this thread, one we cannot book
 *  (they rent it, or they rent it out)? Pure. */
export function isNonOwner(thread = [], inbound = '') {
  const turns = (Array.isArray(thread) ? thread : []).map(m => ({ direction: String(m?.direction || '').toLowerCase() === 'outbound' ? 'outbound' : 'inbound', text: String(m?.text ?? m?.body ?? '') }));
  if (inbound) turns.push({ direction: 'inbound', text: String(inbound) });
  const rental = rentalFromThread(turns);
  return rental === 'tenant' || rental === 'landlord';
}
