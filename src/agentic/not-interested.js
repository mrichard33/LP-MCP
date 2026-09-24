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
 * Pure and dependency-free, unit-tested in scripts/test-not-interested.js.
 */

// Bare "no thanks" is deliberately NOT here: it usually declines a time slot
// or an offer, not the company.
const NOT_INTERESTED_RX =
  /\b(?:not|no\s+longer)\s+(?:really\s+)?interested\b|\bnot\s+for\s+(?:me|us)\b|\bcount\s+(?:me|us)\s+out\b/i;

// The ask this module puts in the bot's mouth. A prior outbound containing it
// means turn 1 already happened.
const ASKED_WHY_RX = /\bwhat\s+changed\b/i;

/** Does this inbound say the lead is not interested? */
export function isNotInterested(text) {
  return NOT_INTERESTED_RX.test(String(text || ''));
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
  if (!isNotInterested(triggerMessage)) return null;
  return alreadyAskedWhy(conversation) ? 'close' : 'ask';
}
