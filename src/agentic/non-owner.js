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
//   - The lead says it THIS turn → the whole reply is the non-owner line: the
//     homeowner needs to be part of it, and the owner is welcome to reach out.
//     No times, no question, no booking.
//   - They said it earlier → any sentence that offers a time, asks to book,
//     or names a clock time is dropped; nothing left → the line.
//   A landlord ("we rent it out") owns the home (homeowner.js) and is a lead
//   (the user, 2026-10-20, superseding 2026-10-13's "no rentals"). A TENANT gets
//   TENANT_LINE (we only work with homeowners; the owner is welcome to reach
//   out); a non-owner who is not a tenant ("it's my parents' house", a property
//   manager) keeps the non-owner line.
//
// PURE. The callers drop the book_appointment companion when this fires.

import { homeownerFromThread, saysRenter } from './homeowner.js';
import { findBookingAsks } from './discovery-discipline.js';
import { TENANT_RX } from './job-scope.js';

// A tenant (the user, 2026-10-20: "we only work with owners not the renters"). It no
// longer says "we don't work on rental properties": an owner who rents the home out
// is a lead, so the owner is welcome to reach out.
export const TENANT_LINE = "Thanks for letting me know. We only work with homeowners, so we can't set up a visit for a home you rent. If the owner is interested, they're welcome to reach out to us anytime.";

export const NON_OWNER_LINE = "Thanks for letting me know. The homeowner needs to be part of the visit, so we can't set one up without them. The owner is welcome to reach out to us anytime.";

const CLOCK_RX = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)\b/i;
const VISIT_OFFER_RX = /\b(?:I\s+have\b[^.?!]*\bor\b|hold(?:ing)?\s+(?:a\s+time|that|it)|(?:schedule|book|set\s+up)\s+(?:a|the|your)\s+(?:visit|time|appointment|measure)|next\s+step\s+(?:would\s+be|is)|come\s+out\s+(?:and|to))\b/i;

function toTurns(thread = [], inbound = '') {
  const turns = (Array.isArray(thread) ? thread : []).map(m => ({
    direction: String(m?.direction || '').toLowerCase() === 'outbound' ? 'outbound' : 'inbound',
    text: String(m?.text ?? m?.body ?? ''),
  }));
  const last = turns[turns.length - 1];
  if (inbound && !(last && last.direction === 'inbound' && last.text === String(inbound))) turns.push({ direction: 'inbound', text: String(inbound) });
  return turns;
}

/** The line for a non-owner: TENANT_LINE for a tenant, else NON_OWNER_LINE (2026-10-20). Pure. */
export function nonOwnerLine(thread = [], inbound = '') {
  const tenant = toTurns(thread, inbound).some(t => t.direction === 'inbound' && TENANT_RX.test(t.text));
  return tenant ? TENANT_LINE : NON_OWNER_LINE;
}

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
  const turns = toTurns(thread, inbound);
  if (homeownerFromThread(turns) !== 'no') return { text, changed: false, reason: null };
  const line = nonOwnerLine(turns);
  if (text.trim() === line) return { text, changed: false, reason: null };
  if (saysRenter(inbound)) return { text: line, changed: true, reason: 'renter_said_now' };
  const asks = new Set(findBookingAsks(text));
  const kept = splitSentences(text).filter(s => !asks.has(s) && !CLOCK_RX.test(s) && !VISIT_OFFER_RX.test(s));
  const out = kept.join(' ').trim();
  if (out === text.trim()) return { text, changed: false, reason: null };
  return { text: out || line, changed: true, reason: out ? 'visit_offer_dropped' : 'renter_earlier' };
}

/** Is the lead, by their own words in this thread, not the owner? Pure. */
export function isNonOwner(thread = [], inbound = '') {
  const turns = (Array.isArray(thread) ? thread : []).map(m => ({ direction: String(m?.direction || '').toLowerCase() === 'outbound' ? 'outbound' : 'inbound', text: String(m?.text ?? m?.body ?? '') }));
  if (inbound) turns.push({ direction: 'inbound', text: String(inbound) });
  return homeownerFromThread(turns) === 'no';
}
