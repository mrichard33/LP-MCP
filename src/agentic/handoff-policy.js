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
 *   workflow  (retired 2026-10-03) a GHL workflow answered hdl:callback-*.
 *             Those workflows bridged a GHL call; the bot now replies and
 *             Five9 makes the call (bot-callback.js).
 *   reply     everything else. The bot answers, and the handoff note below
 *             tells it what this moment calls for.
 *
 * Pure, unit-tested in scripts/test-handoff-policy.js.
 */

import { isKnockNotOptOut } from './do-not-knock.js';


/** Intents that end the conversation. Everything else keeps the bot talking. */
export const OPT_OUT_HANDOFF_INTENTS = new Set(['STOP', 'WRONG_NUMBER']);

// A person has to act on these, even though the bot replied: an upset lead
// asking for a manager, and a lead chasing something we promised and did not
// deliver. The others (who is this, moved, renter, mobile) the reply handles.
export const HUMAN_FOLLOW_UP_INTENTS = new Set(['ANGRY', 'FULFILLMENT_NOT_RECEIVED']);

/**
 * @param {{ intent_class?: string, ghl_handoff_tag?: string }} classification
 * @returns {'silent' | 'reply'}
 */
export function handoffReplyPolicy(classification = {}) {
  const intent = String(classification.intent_class || '').toUpperCase();
  if (OPT_OUT_HANDOFF_INTENTS.has(intent)) return 'silent';
  // 2026-10-03 (Mark: "The GHL instant call center ring should not happen"):
  // a call request is answered by the bot, and Five9 makes the call
  // (bot-callback.js). The hdl:callback-* workflows bridged a GHL call from a
  // GHL number, so nothing here hands the reply to them any more.
  return 'reply';
}

/**
 * A STOP that is really a door complaint (Mark, 2026-10-03): "Please stop
 * knocking on my door" is answered with the do-not-knock flow, not silence.
 * Only STOP is cleared, and only when the text names no texts, calls, email or
 * contact (isKnockNotOptOut). Pure.
 */
export function classificationAfterKnock(classification, text) {
  if (String(classification?.intent_class || '').toUpperCase() !== 'STOP') return classification;
  if (!isKnockNotOptOut(text)) return classification;
  return { ...classification, intent_class: 'UNCLEAR', ghl_handoff_tag: null, action_type: 'generate_response', reasoning: `knock_not_opt_out (was STOP): ${classification.reasoning || ''}`.slice(0, 300) };
}

const NOTES = {
  // 2026-10-03: a call request is answered by the bot; Five9 makes the call.
  CALLBACK:
    'The lead asked for a phone call. Say, in one or two sentences, that someone from our team will call them ' +
    '(at the time they named if they gave one and it is inside team hours; otherwise the next opening). ' +
    'No booking question, no pitch.',
  CUSTOMER_STATUS_AFFIRMATIVE:
    'The lead says they are already a Reece customer. Thank them and say a team member will reach out about it. ' +
    'No pitch, no booking question.',
  CUSTOMER_STATUS_NEGATIVE:
    'The lead says they are not a customer yet and wants a call. Say someone from our team will call them, in one ' +
    'or two sentences. No booking question.',
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
