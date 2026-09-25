/**
 * guide-delivery — src/agentic/guide-delivery.js
 *
 * 2026-09-25 (GHL BazzY5Ihu2heR4osVlBF, Mark Test). The bot offered the
 * Hurricane Preparedness Guide "to the email on file", the lead said "Yeah
 * sure", and nothing added the tag that sends it. Then "I didn't get it?" got
 * silence too. Three separate gaps, one module:
 *
 *   1. An accepted offer must attach its delivery. The responder only knew an
 *      offer was OUTSTANDING from the hurricane-guide-offered tag, which the
 *      bot's own offer never sets — so "Yeah sure" read as a fresh turn.
 *      lastOutboundOfferedGuide() reads the offer off the transcript instead.
 *   2. A reply may only say "sending" when the same turn delivers. A layer3
 *      guide_send dispatch delivers through a sibling add_tag, not a
 *      companion, so the send-promise guard could not see it.
 *      deliveryTagsFromSubActions() names those tags so the send path can.
 *   3. "Didn't get it" must re-send. U.GUIDE Hurricane Guide Delivery
 *      (GHL 0f51bc3d-3acf-4ef7-abda-81107aa1f696) listens for
 *      send-hurricane-guide / hurricane-guide-queue, and SKIPS the email when
 *      hurricane-guide-sent is already on the contact — so a plain re-add
 *      would be swallowed. guideResendOps() clears that gate first.
 *
 * Pure and dependency-free, unit-tested in scripts/test-guide-delivery.js.
 */

// The tag U.GUIDE listens for (verified live 2026-09-25: trigger conditions
// tagsAdded = send-hurricane-guide OR hurricane-guide-queue). Its first step
// removes both, so a later re-add enrolls again.
export const HURRICANE_GUIDE_TAG = 'send-hurricane-guide';
// U.GUIDE's own "already sent" gate — checked after its 5-minute wait.
export const HURRICANE_GUIDE_SENT_TAG = 'hurricane-guide-sent';

// Uniform fulfillment convention on layer3_action_dispatch id 17:
// send-{{guide_type}}-guide. A blank guide_type interpolates to "send--guide",
// which delivers nothing, so it must not count as a delivery.
const DELIVERY_TAG_RX = /^send-[a-z0-9]+(?:-[a-z0-9]+)*-guide$/;

export function isGuideDeliveryTag(tag) {
  return typeof tag === 'string' && DELIVERY_TAG_RX.test(tag.trim().toLowerCase());
}

export function guideTagForType(type) {
  const t = String(type || '').trim().toLowerCase();
  if (!t) return null;
  const tag = `send-${t}-guide`;
  return isGuideDeliveryTag(tag) ? tag : null;
}

/**
 * The delivery tags a batch of queued sub-actions will add.
 * @param {Array<{action_type: string, action_payload?: object}>} rows
 * @returns {string[]}
 */
export function deliveryTagsFromSubActions(rows) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r?.action_type !== 'add_tag') continue;
    const tag = r.action_payload?.tag;
    if (isGuideDeliveryTag(tag) && !out.includes(tag)) out.push(tag.trim().toLowerCase());
  }
  return out;
}

// Which guide a message is about. Ordered: the flagship DHP name first, then
// the topic guides. "hurricane guide" / "Hurricane Preparedness Guide" both
// count; a bare "guide" does not name one.
const GUIDE_NAMES = [
  ['dhp', /\bdocumented home protection guide\b/i],
  ['hurricane', /\bhurricane\s+(?:preparedness\s+|prep\s+)?guide\b/i],
  ['energy', /\benergy\s+savings\s+(?:guide|breakdown)\b/i],
  ['security', /\bhome\s+security\s+guide\b/i],
  ['financing', /\bfinancing\s+(?:options|guide)\b/i],
];

export function guideTypeMentioned(text) {
  const s = String(text || '');
  for (const [type, rx] of GUIDE_NAMES) if (rx.test(s)) return type;
  return null;
}

/**
 * The guide the bot's most recent outbound OFFERED, or null. An offer is a
 * message that names a guide and asks a question ("Want us to send that
 * over?"). A confirmation ("It'll hit your inbox") is not an offer.
 *
 * @param {Array<{direction: string, text: string}>|null} conversation oldest first
 * @returns {string|null} guide type
 */
export function lastOutboundOfferedGuide(conversation) {
  if (!Array.isArray(conversation)) return null;
  for (let i = conversation.length - 1; i >= 0; i--) {
    const m = conversation[i];
    if (m?.direction !== 'outbound') continue;
    const text = String(m.text || '');
    if (!text.includes('?')) return null;
    return guideTypeMentioned(text);
  }
  return null;
}

// Short yes. Anchored and length-capped so "yeah but not right now" and "sure,
// what's the price?" are not read as acceptance of a guide.
const ACCEPT_RX = /^\s*(?:oh\s+)?(?:yes|yeah|yea|yep|yup|ya|sure|ok|okay|k|please|yes please|sure thing|sounds good|that works|go ahead|send it|send it over|absolutely|definitely|of course|why not|that would be great|that'd be great|great|perfect)\b[\s,.!]*(?:please|sure|thanks|thank you|send it|send it over|go ahead|that works|sounds good)?[\s.!]*$/i;
const NEGATION_RX = /\b(?:no|not|don't|dont|never|later|stop)\b/i;

export function isGuideAcceptance(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 60) return false;
  if (NEGATION_RX.test(s)) return false;
  return ACCEPT_RX.test(s);
}

// The lead names something that is not a guide ("I didn't get my estimate").
const OTHER_ITEM_RX = /\b(?:estimate|quote|proposal|contract|invoice|receipt|comparison|link|pric(?:e|es|ing)|appointment|confirmation|call|text)\b/i;

/**
 * For a "didn't get it" turn: which guide is the missing item, if any.
 *
 * Recency decides, because what is missing is what we most recently said we
 * would send. In order:
 *   1. the lead names another item and not a guide → not a guide;
 *   2. a delivery tag still on the contact (send-<type>-guide or
 *      hurricane-guide-queue — U.GUIDE removes both on entry, so one still
 *      present means the send never started);
 *   3. the most recent of the bot's last 4 messages that names a deliverable,
 *      if that deliverable is a guide (a bot-made offer never set a tag — the
 *      2026-09-25 gap).
 * Older signals (hurricane-guide-sent from months ago) are deliberately NOT
 * used: they say a guide once went, not that a guide is what is missing now.
 * A declined hurricane guide is never re-sent.
 *
 * @param {{ tags?: string[], conversation?: Array, inbound?: string }} input
 * @returns {string|null} guide type
 */
export function guideAwaitingDelivery({ tags = [], conversation = [], inbound = '' } = {}) {
  const said = String(inbound || '');
  if (OTHER_ITEM_RX.test(said) && !/\bguide\b/i.test(said)) return null;
  const t = (Array.isArray(tags) ? tags : []).map(x => String(x).toLowerCase());
  const declined = t.includes('hurricane-guide-declined');
  const allow = (type) => (type === 'hurricane' && declined ? null : type);

  for (const tag of t) {
    const m = tag.match(/^send-([a-z0-9-]+)-guide$/);
    if (m && isGuideDeliveryTag(tag)) return allow(m[1]);
  }
  if (t.includes('hurricane-guide-queue')) return allow('hurricane');

  const recentOutbound = (Array.isArray(conversation) ? conversation : [])
    .filter(m => m?.direction === 'outbound')
    .slice(-4)
    .reverse();
  for (const m of recentOutbound) {
    const text = String(m.text || '');
    const type = guideTypeMentioned(text);
    if (type) return allow(type);
    // The latest deliverable named was something else (a comparison, an
    // estimate) — that is what is missing, and it is not ours to re-tag.
    if (OTHER_ITEM_RX.test(text) && /\b(?:send|sending|sent|email)\b/i.test(text)) return null;
  }
  return null;
}

/**
 * The tag writes that make GHL send the guide again: remove, then add, so the
 * tag-added trigger fires even if the tag stuck. For the hurricane guide the
 * workflow's own "already sent" gate is cleared too, or U.GUIDE would enroll
 * and then skip the email.
 *
 * When the same batch already queues the delivery tag (a guide_send dispatch
 * on this turn), only the gate is cleared — a second add would enroll twice.
 *
 * @param {string} type guide type
 * @param {{ alreadyQueued?: boolean }} [opts]
 * @returns {{ tag: string, remove: string[], add: string[] } | null}
 */
export function guideResendOps(type, { alreadyQueued = false } = {}) {
  const tag = guideTagForType(type);
  if (!tag) return null;
  const gate = tag === HURRICANE_GUIDE_TAG ? [HURRICANE_GUIDE_SENT_TAG] : [];
  if (alreadyQueued) return { tag, remove: gate, add: [] };
  return { tag, remove: [tag, ...gate], add: [tag] };
}

const GUIDE_LABEL = {
  hurricane: 'Hurricane Preparedness Guide',
  dhp: 'Documented Home Protection Guide',
  energy: 'Energy Savings guide',
  security: 'Home Security Guide',
  financing: 'Financing Options guide',
};

export function guideLabel(type) {
  return GUIDE_LABEL[type] || 'guide';
}

/**
 * SCRIPT DIRECTIVE for a "didn't get it" turn where the guide is being re-sent
 * in the same turn. The reply is a holding reply, never silence (2026-09-25).
 */
export function guideResendReplyNote(type) {
  return (
    `GUIDE RESEND: the lead did not get the ${guideLabel(type)}. It is being re-sent to the email on file in this same turn. ` +
    `Reply in two short sentences, in this shape: "Sorry about that, [first name]. We're resending it now. Check your inbox and spam folder in a few minutes." ` +
    'Apologize once. No question, no pitch, no booking ask, and do not name the email address unless they asked which one.'
  );
}
