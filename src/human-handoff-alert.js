/**
 * Human Handoff Alert — src/human-handoff-alert.js
 *
 * The alert that fires when the bot stops replying and a person has to take
 * over.
 *
 * WHY THIS EXISTS
 * ───────────────
 * When the classifier short-circuits to a human handoff (HDL-HUMAN-01 — ANGRY
 * and friends), send_message applies the handoff tag, returns
 * `compliance_gate_handoff`, and SENDS NOTHING. That is correct: an angry lead
 * should not get another bot message. What was missing is the other half —
 * telling somebody.
 *
 * Reference case, Alfredo Fontan (GHL VKMKhd8JQ4wsp3zMn8Lt, conversation
 * mivvUZnKmGScwo5FoVUR, LP lead 575210, ORL), 2026-09-11:
 *
 *   agent_actions 448032 (19:59Z) — `compliance_gate_handoff`, intent ANGRY,
 *   HDL-HUMAN-01, tag hdl:human-handoff. No reply was sent. No action-needed
 *   alert fired. The lead sat unanswered from 19:57Z.
 *
 * WHY IT IS NOT THE EXISTING SHORT-CIRCUIT CARD
 * ─────────────────────────────────────────────
 * handleShortCircuit already posts a "🛑 AGENTIC SHORT-CIRCUIT" line to
 * GroupMe. It ends "→ GHL workflow on tag now owns the response", which is TRUE
 * for the callback tags (hdl:callback-sales → I.HDL-1, hdl:callback-service →
 * I.HDL-2 both send an SMS and queue the call) and FALSE for a silent human
 * handoff, where no workflow listens and nothing further happens. A status line
 * that says someone else has it is not an alert; it is the opposite of one.
 *
 * So this fires ONLY on the handoffs nothing answers, as the 🚨 SALES PRIORITY
 * class (the existing action-required class — deliberately not `intelligence`,
 * which is the read-it-later class). Firing on every short-circuit would put
 * two cards in GroupMe for every callback and train reps to scroll past both.
 */

// Handoff tags a live GHL workflow answers. A short-circuit carrying one of
// these is handed to an automation that WILL reply and queue the call — no
// human alert needed. Everything else goes silent, and silence is the thing
// this module exists to break. Verified live: only these two have tag triggers
// (see the CALLBACK resolution note in src/send-message-handler.js).
export const WORKFLOW_ANSWERED_HANDOFF_TAGS = new Set([
  'hdl:callback-sales',
  'hdl:callback-service',
]);

/** One alert per contact per this many minutes, via the send_notification cooldown. */
export const HANDOFF_ALERT_COOLDOWN_MINUTES = 30;

/** The rule key the cooldown lookup dedups on, together with target_id. */
export const HANDOFF_ALERT_RULE = 'HUMAN_HANDOFF_ALERT';

/**
 * Does this handoff leave the lead with nobody talking to them?
 *
 * @param {string|null} handoffTag
 * @returns {boolean}
 */
export function handoffNeedsHumanAlert(handoffTag) {
  const tag = String(handoffTag || '').trim().toLowerCase();
  if (!tag) return true; // tagless handoff: nothing can be listening
  return !WORKFLOW_ANSWERED_HANDOFF_TAGS.has(tag);
}

/** The GHL conversation deep link, or the contact record when we have no thread. */
export function ghlConversationLink(contactId, conversationId = null) {
  const loc = process.env.GHL_LOCATION_ID || 'SsBG7j5KQAIP1SFP2Sca';
  return conversationId
    ? `https://app.gohighlevel.com/v2/location/${loc}/conversations/conversations/${conversationId}`
    : `https://app.gohighlevel.com/v2/location/${loc}/contacts/detail/${contactId}`;
}

/**
 * The send_notification action_payload for a human-handoff alert. Pure;
 * exported for tests.
 *
 * The card's name / phone / contact ID / market lines are rendered by
 * buildClassifiedNotification from the enrichment layer, so they are NOT
 * repeated in the narrative — only the facts the card cannot resolve on its
 * own go there: what the lead actually said, why the bot stopped, and where to
 * go and answer them.
 *
 * @param {object} args
 * @param {string} args.contactId
 * @param {string} [args.intentClass]
 * @param {string} [args.handlerCode]
 * @param {string} [args.handoffTag]
 * @param {string} [args.lastInbound]      the lead's last message
 * @param {string} [args.conversationId]   GHL conversation id, when known
 * @returns {object} action_payload
 */
export function buildHumanHandoffAlertPayload({
  contactId,
  intentClass = null,
  handlerCode = null,
  handoffTag = null,
  lastInbound = '',
  conversationId = null,
} = {}) {
  const inbound = String(lastInbound || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const intent = intentClass || 'unknown';
  const handler = handlerCode ? ` / ${handlerCode}` : '';

  const narrative =
    `The bot stopped replying and handed this lead to a person — intent ${intent}${handler}` +
    `${handoffTag ? `, tag ${handoffTag}` : ''}. No automated reply follows this handoff, ` +
    `so nobody is talking to them until someone here does. ` +
    (inbound ? `They last said: "${inbound}". ` : '') +
    `Open the thread and answer them: ${ghlConversationLink(contactId, conversationId)}`;

  return {
    // 🚨 SALES PRIORITY — the existing action-required class.
    notification_class: 'priority',
    action_verb: 'HUMAN NEEDED NOW — bot stopped replying',
    tier: 'Imminent',
    status: `Awaiting a human reply (${intent})`,
    act_within: '15 minutes',
    narrative,
    flush_now: true, // never sit in the debounce buffer behind other cards
    // One alert per contact per 30 minutes — the existing send_notification
    // cooldown, keyed on (rule_applied, target_id).
    cooldown_minutes: HANDOFF_ALERT_COOLDOWN_MINUTES,
  };
}

export default {
  handoffNeedsHumanAlert,
  buildHumanHandoffAlertPayload,
  ghlConversationLink,
  HANDOFF_ALERT_RULE,
  HANDOFF_ALERT_COOLDOWN_MINUTES,
  WORKFLOW_ANSWERED_HANDOFF_TAGS,
};
