/**
 * not-interested — src/agentic/not-interested.js
 *
 * 2026-09-24 (Mark): a lead who says "not interested" gets ONE gentle
 * question to surface the real reason ("what changed?"). If they give one,
 * the existing objection rules route it (pre-demo: BEHAVIORAL_*_PRE_DEMO;
 * post-demo: O.0). If they say it again, the bot closes warmly and never asks
 * again. "Not interested" itself stays a decline, not an objection — the
 * 2026-06-17 ruling behind rule 297 (OBJECTION_ROUTE_NOT_INTERESTED, cooling
 * track) is unchanged. O.0 has no not-interested branch.
 *
 * Turn detection lives here, not in the OBJECTION STATE tracker: rule 297
 * writes that state in the same fan-out as the reply, so the reply can run
 * before or after it. The thread itself is the reliable record.
 *
 * 2026-10-19 (Thomas Geary, LP Prospect 461733, Mark's ruling): a firm decline
 * with a reason is a decline too. "We will not be investing 25 % of purchased
 * value when the market value will not justify the cost." matched none of the
 * phrases above, so the post-demo email reply worked it as a live objection and
 * closed on a question. REASONED_DECLINE_RX is the one list for that; it never
 * reads a question ("?"), a dated deferral ("won't be investing until spring",
 * detectDeferral wins) or a scheduling miss ("we will not be home Tuesday").
 *
 * Pure, unit-tested in scripts/test-not-interested.js.
 */

import { detectDeferral } from './post-demo-turn.js';

// Bare "no thanks" is deliberately NOT here: it usually declines a time slot
// or an offer, not the company.
const NOT_INTERESTED_RX =
  /\b(?:not|no\s+longer)\s+(?:really\s+)?interested\b|\bnot\s+for\s+(?:me|us)\b|\bcount\s+(?:me|us)\s+out\b/i;

// A firm decline that gives a reason (2026-10-19). Each one names the decision,
// not the time: "we will not be home" / "won't be available" never match.
const REASONED_DECLINE_RX = new RegExp([
  String.raw`\b(?:we|i)(?:\s+(?:will\s+not|won'?t|are\s+not|aren'?t|am\s+not)|'m\s+not|'re\s+not)\s+(?:be\s+)?(?:going\s+to\s+be\s+)?(?:investing|moving\s+forward|going\s+(?:forward|ahead)|proceeding|doing\s+(?:it|this|the\s+project)|buying|purchasing)\b`,
  String.raw`\b(?:we|i)(?:'?ve|\s+have)?\s+decided\s+(?:not\s+to|against)\s+(?:go(?:ing)?\s+ahead|mov(?:e|ing)\s+forward|do(?:ing)?\s+(?:it|this|the\s+project)|proceed(?:ing)?|invest(?:ing)?|buy(?:ing)?|purchas(?:e|ing))\b`,
  // "pass" alone, never "pass it along" / "pass this to my wife".
  String.raw`\b(?:we|i)(?:'re|\s+are|'m|\s+am)\s+going\s+to\s+pass\b(?!\s+(?:it|this|that|the|along|your|them|him|her)\b|\s+on\s+(?:your|the|my|to)\b)`,
  String.raw`\b(?:we|i)(?:'ll|\s+will)\s+(?:have\s+to\s+)?pass\b(?!\s+(?:it|this|that|the|along|your|them|him|her)\b|\s+on\s+(?:your|the|my|to)\b)`,
  String.raw`\b(?:cost|price|it)\s+(?:doesn'?t|does\s+not|won'?t|will\s+not|can'?t|cannot)\s+justify\b`,
  String.raw`\bnot\s+worth\s+it\s+(?:for|to)\s+(?:us|me)\b`,
].join('|'), 'i');

/** A firm, reasoned decline: never a question, never a dated deferral. Pure. */
export function isReasonedDecline(text) {
  const t = String(text || '').replace(/[’]/g, "'");
  if (!t.trim() || t.includes('?')) return false;
  if (!REASONED_DECLINE_RX.test(t)) return false;
  return !detectDeferral(t);
}

// The ask this module puts in the bot's mouth. A prior outbound containing it
// means turn 1 already happened.
const ASKED_WHY_RX = /\bwhat\s+changed\b/i;

/** Does this inbound say the lead is not interested? */
export function isNotInterested(text) {
  return NOT_INTERESTED_RX.test(String(text || '')) || isReasonedDecline(text);
}

/**
 * Has the bot already asked the "what changed?" question in this thread?
 * @param {Array<{direction: string, text: string}>|null} conversation
 */
export function alreadyAskedWhy(conversation) {
  if (!Array.isArray(conversation)) return false;
  return conversation.some(m => m?.direction === 'outbound' && ASKED_WHY_RX.test(String(m.text || '')));
}

/**
 * @param {string} triggerMessage the lead's message this reply answers
 * @param {Array|null} conversation context.conversation_recent
 * @returns {null | 'ask' | 'close'}
 */
export function notInterestedTurn(triggerMessage, conversation) {
  // The phrases only: a reasoned decline already gave its reason, so "what
  // changed?" would ask for what they just said (2026-10-19).
  if (!NOT_INTERESTED_RX.test(String(triggerMessage || ''))) return null;
  return alreadyAskedWhy(conversation) ? 'close' : 'ask';
}
