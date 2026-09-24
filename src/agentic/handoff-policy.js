/**
 * handoff-policy — src/agentic/handoff-policy.js
 *
 * 2026-09-24 (Mark): "the bot should never deactivate unless an opt out."
 *
 * Until now every classifier handoff (`tag_and_handoff`) was SILENT: the
 * handoff tag went on, and the lead got nothing back. On GHL
 * BazzY5Ihu2heR4osVlBF the bot promised an email it never sent. The lead
 * texted "I didn't get anything?" and then "I checked my email.". Both
 * messages classified FULFILLMENT_NOT_RECEIVED (0.90 / 0.92), and both got
 * silence plus an alert. Of the 11 live handoff classes, only STOP is an opt-out.
 *
 * The handoff tag and the alert still happen. What changes is who answers:
 *
 *   silent    an opt-out. STOP, and WRONG_NUMBER, which Mark ruled is treated
 *             as one (a stranger, and texting them on is a compliance risk).
 *   workflow  a live GHL workflow answers the tag (hdl:callback-sales /
 *             hdl:callback-service, and the CALLBACK placeholder that
 *             send-message-handler resolves to one of them or answers with
 *             the HDL.3 probe). Replying too would double-text the lead.
 *   reply     everything else. The bot answers, and the handoff note below
 *             tells it what this moment calls for.
 *
 * Pure and dependency-free, unit-tested in scripts/test-handoff-policy.js.
 */

import { WORKFLOW_ANSWERED_HANDOFF_TAGS } from '../human-handoff-alert.js';

/** Intents that end the conversation. Everything else keeps the bot talking. */
export const OPT_OUT_HANDOFF_INTENTS = new Set(['STOP', 'WRONG_NUMBER']);

// The CALLBACK placeholder never reaches GHL: handleShortCircuit resolves it
// to a workflow tag, or answers with the customer-status probe itself.
const CALLBACK_PLACEHOLDER_TAG = 'hdl:callback-pending-classification';

// A person has to act on these, even though the bot replied: an upset lead
// asking for a manager, and a lead chasing something we promised and did not
// deliver. The others (who is this, moved, renter, mobile) the reply handles.
export const HUMAN_FOLLOW_UP_INTENTS = new Set(['ANGRY', 'FULFILLMENT_NOT_RECEIVED']);

/**
 * @param {{ intent_class?: string, ghl_handoff_tag?: string }} classification
 * @returns {'silent' | 'workflow' | 'reply'}
 */
export function handoffReplyPolicy(classification = {}) {
  const intent = String(classification.intent_class || '').toUpperCase();
  if (OPT_OUT_HANDOFF_INTENTS.has(intent)) return 'silent';
  const tag = String(classification.ghl_handoff_tag || '').trim().toLowerCase();
  if (tag === CALLBACK_PLACEHOLDER_TAG || WORKFLOW_ANSWERED_HANDOFF_TAGS.has(tag)) return 'workflow';
  return 'reply';
}

const NOTES = {
  ANGRY:
    'The lead is upset or asked for a manager. Apologize once, plainly, in one or two sentences, ' +
    'and say a manager has been told and will reach out to them personally. Do not sell, do not ' +
    'ask a booking question, do not defend or explain.',
  FULFILLMENT_NOT_RECEIVED:
    'The lead says they never got something they were promised. Apologize once, plainly. If this ' +
    'conversation promised an email and an email is on file, send it now with send_info_email and ' +
    'say it was just sent. Otherwise say a team member has been told and will follow up today. ' +
    'Never promise it again without sending it.',
  WHO_IS_THIS:
    'The lead does not recognize us. In one or two sentences say who we are (Reece Windows & Doors, ' +
    'impact windows and doors in Florida) and why they are hearing from us, using how they came in if ' +
    'you know it. Offer to stop texting if they would rather. No pitch, no booking ask.',
  MOVED:
    'The lead no longer lives at or owns the property. Thank them, and ask one question only: whether ' +
    'their new home could use a look, or whether they would rather we stop texting. No pitch.',
  RENTER:
    'The lead rents their home. Thank them and say plainly that impact windows are the owner\'s ' +
    'decision, and the owner is welcome to reach out to us. Do not offer to email anything: a ' +
    'disqualified contact cannot be sent one. No booking ask.',
  MOBILE:
    'The lead lives in a mobile or manufactured home, which we do not install in. Thank them warmly ' +
    'and say so plainly and kindly. No booking ask, no pitch.',
};

/**
 * The SCRIPT DIRECTIVE text for a reply that follows a handoff. Only the
 * HUMAN_FOLLOW_UP_INTENTS notes say a person has been told, because only
 * those page one — the reply must never promise a follow-up nobody was asked for.
 *
 * @param {string} intentClass
 * @returns {string}
 */
export function handoffReplyNote(intentClass) {
  const specific = NOTES[String(intentClass || '').toUpperCase()] ||
    'A person on the team has been told about this conversation. Reply briefly and helpfully, and do not sell.';
  return `HANDOFF REPLY (${intentClass || 'unknown'}): ${specific} Never mention tags, systems, or handoffs.`;
}
