/**
 * Post-demo rehash replies — src/agentic/rehash.js
 *
 * Pure and dependency-free. response-generator.js decides the identity and the
 * prompt; send-message-handler.js sends the #contact-rehash card through
 * src/notifications/rehash-call.js.
 *
 * WHAT (Mark, 2026-10-01)
 *   A lead who already had their in-home demo sits in GHL workflow F.0
 *   Post-Appointment Follow-Up and carries the tag `active-f.0` for as long as
 *   they are in it. F.0 texts them from 727-800-4578, signed
 *   {{custom_values.rehash_rep_name}}: "this is <rep> from Reece… just text me
 *   here and I'll help". When they text back, the bot must:
 *     - answer AS that rep (the name in the custom value), on that line;
 *     - know they are post-demo and already have a proposal;
 *     - aim for one thing: a phone call with the rep, to see what we can do
 *       for them. The offer is hinted at, never named (no price, no discount,
 *       no amount — Mark's ruling);
 *     - once they agree, ask for a good time and tell the rehash team in
 *       #contact-rehash, so the rep makes the call.
 *
 * WHAT IT REPLACES
 *   The reply signed "— Reece Team" (727-800-4578 was an unknown number to
 *   resolveSmsSenderIdentity) and the post-appointment ban forbade offering
 *   any call at all — the opposite of the job.
 */

import { simModeOverrides } from '../simulator/sim-overrides.js';

export const F0_ACTIVE_TAG = 'active-f.0';
export const REHASH_NUMBER_DEFAULT = '7278004578';
export const REHASH_REP_CUSTOM_VALUE = 'rehash_rep_name';
/** #contact-rehash (Mark created it 2026-10-01). */
export const SLACK_CHANNEL_REHASH_DEFAULT = 'C0C5YMHNYJH';

const last10 = (raw) => {
  const d = String(raw ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
};

// 2026-10-21 (the user, after Jim Anderson's thread): "Bot messages must show
// as the bot, never as John." rep = the 2026-10-01 voice (written as the rehash
// rep, signed with their first name); team = signed "— Reece Team", the rep
// named in the third person ("John can give you a quick call"). Default rep
// until the gate has run with team.
export const REHASH_VOICE_MODES = Object.freeze(['rep', 'team']);
export function rehashVoiceMode(env = process.env) {
  const v = String(simModeOverrides().rehashVoiceMode ?? env?.REHASH_VOICE_MODE ?? '').trim().toLowerCase();
  return REHASH_VOICE_MODES.includes(v) ? v : 'rep';
}

export function rehashNumber(env = process.env) {
  return last10(env.AGENTIC_SMS_NUMBER_REHASH || REHASH_NUMBER_DEFAULT);
}

export function rehashSlackChannel(env = process.env) {
  return String(env.SLACK_CHANNEL_REHASH || SLACK_CHANNEL_REHASH_DEFAULT).trim() || null;
}

/**
 * Is this reply a rehash reply? The tag is the record of the stage; the
 * number catches a lead whose tag write lags the text. Pure.
 */
export function isRehashContact({ tags = [], fromNumber = null, env = process.env } = {}) {
  // 2026-10-09: the `rehash` tag (src/agentic/rehash-state.js) counts too: an
  // OPPFDN demo outside F.0's 14-day entry window is still a rehash lead.
  const hasTag = (Array.isArray(tags) ? tags : []).some((t) => {
    const v = String(t).trim().toLowerCase();
    return v === F0_ACTIVE_TAG || v === 'rehash';
  });
  const n = last10(fromNumber);
  return hasTag || (!!n && n === rehashNumber(env));
}

/** The model's `rehash_call` output, normalized; null when absent or malformed. Pure. */
export function normalizeRehashCall(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const agreed = raw.agreed === true;
  const t = typeof raw.preferred_time === 'string' ? raw.preferred_time.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  return { agreed, preferred_time: t || null };
}

// ── the offer is hinted at, never named (Mark, 2026-10-01) ─────────────────
// A dollar figure, a percentage, "discount", "promo", "special price", "a deal"
// in a text from the rehash line is a promise the rep has not made. The prompt
// forbids it; this strips any sentence that does it anyway.
const OFFER_TALK_RX = /\$\s?\d|\b\d{1,3}(?:\.\d+)?\s?%|\bper\s*cent\b|\bdiscount|\bpromo(?:tion|tional)?\b|\bcoupon|\brebate|\b\d+\s+off\b|\bspecial\s+(?:price|pricing|rate|deal|discount|financing)\b|\b(?:a|the|this|that|great|better|special|best|good)\s+deal\b|\bknock\s+(?:it\s+)?down\b|\blower\s+(?:the\s+)?price\b|\bprice\s+(?:drop|cut|match)\b/i;

const splitSentences = (t) => String(t || '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);

// 2026-10-11 (rehash NEPQ handoff): the ONE approved hint. "Making sure you're
// getting the best deal possible" says something may be possible without
// naming it, so these exact phrasings are taken out before the offer test.
// Anything else in the sentence still counts: "the best deal for you: $500
// off" is stripped for the $500. "a deal", "a great deal", "a special deal"
// stay banned. Once per conversation (hintUsed): a second time is stripped.
const BEST_DEAL_HINT_RX = /\b(?:getting\s+)?the\s+best\s+deal\s+(?:possible|for\s+you)\b|\bgetting\s+the\s+best\s+deal\b|\bbest\s+deal\s+for\s+you\b/gi;

/** Sentences that name or promise a concrete offer. Pure. */
export function findOfferTalk(text, { hintUsed = false } = {}) {
  return splitSentences(text).filter((s) => {
    if (hintUsed && /\bbest\s+deal\b/i.test(s)) return true;
    return OFFER_TALK_RX.test(s.replace(BEST_DEAL_HINT_RX, ' '));
  });
}

export const OFFER_HINT_LINE = "I want to make sure you're getting the best deal possible, and it's easier to go over on a quick call.";
// The hint was already said once: the same line without it.
export const OFFER_HINT_LINE_AFTER = "I may be able to do something for you, and it's easier to go over on a quick call.";

/**
 * Strip offer talk; keep the reply moving with the approved hint. Pure.
 * @param {string} text
 * @param {{hintUsed?: boolean}} [o]  "best deal" was already said in this conversation
 */
// 2026-10-21 (Part 2, REHASH_BETTER_PRICE_FRAMING_ENABLED; the caller passes
// betterPrice): the line put back after a strip gives the reason for the call.
export const OFFER_BETTER_PRICE_LINE = 'If I could get you a better price, would you be open to a quick call?';

export function stripOfferTalk(text, { hintUsed = false, betterPrice = false } = {}) {
  const hits = findOfferTalk(text, { hintUsed });
  if (!hits.length) return { text: String(text || ''), stripped: [] };
  const kept = splitSentences(text).filter((s) => !hits.includes(s));
  const hasQuestion = kept.some((s) => s.includes('?'));
  const out = hasQuestion ? kept : [...kept, betterPrice ? OFFER_BETTER_PRICE_LINE : hintUsed ? OFFER_HINT_LINE_AFTER : OFFER_HINT_LINE];
  return { text: out.join(' ').trim(), stripped: hits };
}

/** "best deal" already said in our earlier messages. Pure. */
export function bestDealHintUsed(conversation = []) {
  return (Array.isArray(conversation) ? conversation : [])
    .some((m) => String(m?.direction || '').toLowerCase() === 'outbound' && /\bbest\s+deal\b/i.test(String(m?.text ?? m?.body ?? '')));
}

/** The GHL contact link for a card. Pure. */
export function ghlContactUrl(locationId, contactId) {
  return `https://app.gohighlevel.com/v2/location/${locationId}/contacts/detail/${contactId}`;
}

/**
 * The #contact-rehash card. Plain English, built once (CLAUDE.md). Pure.
 * Never a pronoun for the contact — the card uses their first name.
 */
export function formatRehashCallCard({ firstName, phone, market, repName, preferredTime, lastMessage, contactUrl, bookedSlot = null, assigneeName = null }) {
  const who = firstName || 'A post-demo lead';
  // 2026-10-11: a call booked on the Rehash Call calendar names the slot and
  // the team member it is booked with.
  if (bookedSlot) {
    return [
      `📞 REHASH CALL BOOKED`,
      `${who} (post-demo) booked a call on the Rehash Call calendar.`,
      `When: ${bookedSlot}`,
      `With: ${assigneeName || 'the rehash team (no name on file for the assigned user)'}`,
      `Phone: ${phone ? String(phone).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '') : 'not on file'}`,
      market ? `Market: ${market}` : null,
      lastMessage ? `${who} said: "${String(lastMessage).slice(0, 300)}"` : null,
      contactUrl ? `Contact: ${contactUrl}` : null,
      `→ ${assigneeName || 'The assigned rep'}: call ${firstName || 'them'} at that time and see what we can do.`,
    ].filter(Boolean).join('\n');
  }
  return [
    `📞 REHASH CALL REQUEST`,
    `${who} (post-demo, F.0) said yes to a call${repName ? ` with ${repName}` : ''}.`,
    `Best time: ${preferredTime || 'not given yet. Call soon.'}`,
    `Phone: ${phone ? String(phone).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '') : 'not on file'}`,
    market ? `Market: ${market}` : null,
    lastMessage ? `${who} said: "${String(lastMessage).slice(0, 300)}"` : null,
    contactUrl ? `Contact: ${contactUrl}` : null,
    `→ Call ${firstName || 'them'} at that time and see what we can do.`,
  ].filter(Boolean).join('\n');
}

/** One card per contact per Eastern day. Pure. */
export function rehashCallIdempotencyKey(contactId, nowMs = Date.now(), { booked = false } = {}) {
  return `f0_rehash_call_${booked ? 'booked_' : ''}${contactId}_${etDay(nowMs)}`;
}

/** 'YYYY-MM-DD' in Eastern time. Pure. */
export function etDay(nowMs = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs));
}

/**
 * 2026-10-14 (John Manieri): the other rehash cards, one per kind per contact
 * per Eastern day. kind: 'quote' | 'concern' | 'digest'. Pure.
 */
export function rehashReplyIdempotencyKey(kind, contactId, nowMs = Date.now()) {
  return `f0_rehash_${kind}_${contactId}_${etDay(nowMs)}`;
}

const cardPhone = (phone) => {
  const d = String(phone ?? '').replace(/\D/g, '');
  if (!d) return 'not on file';
  return d.length === 11 && d[0] === '1' ? d.slice(1) : d;
};

/**
 * 2026-10-14 (John Manieri): most "call requests" were leads asking for the
 * quote the salesperson promised to email. That is not a call, and the card
 * says so. Plain English, first name only. Pure.
 */
export function formatRehashQuoteCard({ firstName, phone, repName = null, lastMessage, contactUrl }) {
  const who = firstName || 'A post-demo lead';
  return [
    `📄 QUOTE REQUEST`,
    `${who} (post-demo) is asking for their quote — not a call.`,
    lastMessage ? `${who} said: "${String(lastMessage).slice(0, 300)}"` : null,
    repName ? `Rep on the demo: ${repName}` : null,
    `Phone: ${cardPhone(phone)}`,
    contactUrl ? `Contact: ${contactUrl}` : null,
    `→ Send ${firstName || 'them'} the full quote (all pages) today.`,
  ].filter(Boolean).join('\n');
}

/** An upset post-demo reply ("that is fraud", "Bill did not receive a call"). Pure. */
export function formatRehashConcernCard({ firstName, phone, repName = null, lastMessage, contactUrl }) {
  const who = firstName || 'A post-demo lead';
  return [
    `⚠️ POST-DEMO CONCERN`,
    `${who} (post-demo) sounds unhappy. This is not a call request.`,
    lastMessage ? `${who} said: "${String(lastMessage).slice(0, 300)}"` : null,
    repName ? `Rep on the demo: ${repName}` : null,
    `Phone: ${cardPhone(phone)}`,
    contactUrl ? `Contact: ${contactUrl}` : null,
    `→ Someone on the rehash team: read the thread and reach out to ${firstName || 'them'} today.`,
  ].filter(Boolean).join('\n');
}
