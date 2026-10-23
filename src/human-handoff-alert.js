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

// 2026-10-23 — handoffs that mean "never contact this person again". STOP and
// WRONG_NUMBER are disqualifiers: the bot is silent BY DESIGN and nobody may
// reply, so "HUMAN NEEDED NOW" for them was a false alarm (Srsa58u9ldtV9B2MGdtx,
// "Ok muchas gracias" → WRONG_NUMBER, agent_actions 630601: a 15-minute
// priority card telling the team to answer a number that is not our lead).
export const NO_CONTACT_HANDOFF_TAGS = new Set([
  'hdl:stop',
  'hdl:wrong-number',
]);

/** One alert per contact per this many minutes, via the send_notification cooldown. */
export const HANDOFF_ALERT_COOLDOWN_MINUTES = 30;

/** The rule key the cooldown lookup dedups on, together with target_id. */
export const HANDOFF_ALERT_RULE = 'HUMAN_HANDOFF_ALERT';

/**
 * Does this handoff leave the lead with nobody talking to them?
 *
 * A disqualifier (the classifier's is_disqualifier) or a no-contact tag never
 * needs one: there is nobody a person should be talking to.
 *
 * @param {string|null} handoffTag
 * @param {{ isDisqualifier?: boolean }} [opts]
 * @returns {boolean}
 */
export function handoffNeedsHumanAlert(handoffTag, { isDisqualifier = false } = {}) {
  if (isDisqualifier) return false;
  const tag = String(handoffTag || '').trim().toLowerCase();
  if (!tag) return true; // tagless handoff: nothing can be listening
  if (NO_CONTACT_HANDOFF_TAGS.has(tag)) return false;
  return !WORKFLOW_ANSWERED_HANDOFF_TAGS.has(tag);
}

/**
 * Should the "🛑 AGENTIC SHORT-CIRCUIT" card post? (2026-10-23)
 *
 * A disqualifier whose tags went on is mechanical: the tags and suppress-
 * automation did the job, the agent_actions row and the log line are the audit
 * trail, and the card asked nobody to do anything. A disqualifier whose tag
 * write FAILED still posts: the contact is not suppressed, and only a person
 * can fix that. Every other short-circuit posts as before.
 *
 * @param {{ isDisqualifier?: boolean, tagApplied?: boolean }} args
 * @returns {boolean}
 */
export function shortCircuitNoticeNeeded({ isDisqualifier = false, tagApplied = false } = {}) {
  if (!isDisqualifier) return true;
  return !tagApplied;
}

// ── The disengagement card behind a disqualifier handoff (2026-10-23) ──────
// BEHAVIORAL_DISENGAGEMENT_SEVERE fires on the same inbound as the STOP /
// WRONG_NUMBER short-circuit and posted "DISENGAGEMENT CLASSIFIED" for a lead
// we must not contact. In the reference case its card went out at 15:02:38 and
// the short-circuit finished at 15:02:48 (same event 4498304), so a look-back
// alone misses it: while a send_message on the same event is still running,
// the card waits briefly for its verdict.
export const DQ_QUIET_NOTIFICATION_RULES = new Set(['BEHAVIORAL_DISENGAGEMENT_SEVERE']);
/** A disqualifier handoff this recent on the contact skips the live card. */
export const DQ_HANDOFF_LOOKBACK_MINUTES = 5;
/** How long one wait for the sibling send lasts. */
export const DQ_SIBLING_WAIT_SECONDS = 20;
/** Past this age the card stops waiting and posts (a stuck send must not swallow it). */
export const DQ_SIBLING_MAX_WAIT_MS = 3 * 60 * 1000;

/**
 * Pure. What the disengagement card does given what the reads found.
 * Unknown (a failed read) posts: that is today's behaviour, never silence.
 *
 * @param {object} args
 * @param {boolean|null} args.dqHandoffRecent  a completed DQ handoff in the window (null = unreadable)
 * @param {boolean|null} args.siblingSendOpen  a send_message on the same event still running (null = unreadable)
 * @param {number|null}  args.ageMs            how old this notification row is
 * @returns {{ verdict: 'send'|'skip'|'defer', reason: string }}
 */
export function dqQuietNotificationDecision({ dqHandoffRecent = null, siblingSendOpen = null, ageMs = null } = {}) {
  if (dqHandoffRecent === true) return { verdict: 'skip', reason: 'disqualifier_handoff_recent' };
  if (siblingSendOpen === true && Number.isFinite(ageMs) && ageMs < DQ_SIBLING_MAX_WAIT_MS) {
    return { verdict: 'defer', reason: 'awaiting_sibling_send_verdict' };
  }
  return { verdict: 'send', reason: dqHandoffRecent === null ? 'dq_read_unknown' : 'no_disqualifier_handoff' };
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
 * @param {boolean} [args.botReplied]      the bot answered too (2026-09-24);
 *                                         a person still has to follow up
 * @returns {object} action_payload
 */
export function buildHumanHandoffAlertPayload({
  contactId,
  intentClass = null,
  handlerCode = null,
  handoffTag = null,
  lastInbound = '',
  conversationId = null,
  botReplied = false,
} = {}) {
  const inbound = String(lastInbound || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const intent = intentClass || 'unknown';
  const handler = handlerCode ? ` / ${handlerCode}` : '';

  if (botReplied) {
    return {
      notification_class: 'priority',
      action_verb: 'HUMAN FOLLOW-UP NEEDED',
      tier: 'Imminent',
      status: `Bot acknowledged; a person must follow up (${intent})`,
      act_within: '1 hour',
      narrative:
        `The bot answered this lead, but it needs a person — intent ${intent}${handler}` +
        `${handoffTag ? `, tag ${handoffTag}` : ''}. ` +
        (inbound ? `They last said: "${inbound}". ` : '') +
        `Follow up here: ${ghlConversationLink(contactId, conversationId)}`,
      flush_now: true,
      cooldown_minutes: HANDOFF_ALERT_COOLDOWN_MINUTES,
    };
  }

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
  shortCircuitNoticeNeeded,
  dqQuietNotificationDecision,
  NO_CONTACT_HANDOFF_TAGS,
  buildHumanHandoffAlertPayload,
  ghlConversationLink,
  HANDOFF_ALERT_RULE,
  HANDOFF_ALERT_COOLDOWN_MINUTES,
  WORKFLOW_ANSWERED_HANDOFF_TAGS,
};
