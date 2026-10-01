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

export const F0_ACTIVE_TAG = 'active-f.0';
export const REHASH_NUMBER_DEFAULT = '7278004578';
export const REHASH_REP_CUSTOM_VALUE = 'rehash_rep_name';
/** #contact-rehash (Mark created it 2026-10-01). */
export const SLACK_CHANNEL_REHASH_DEFAULT = 'C0C5YMHNYJH';

const last10 = (raw) => {
  const d = String(raw ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
};

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
  const hasTag = (Array.isArray(tags) ? tags : []).some((t) => String(t).trim().toLowerCase() === F0_ACTIVE_TAG);
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

/** Sentences that name or promise a concrete offer. Pure. */
export function findOfferTalk(text) {
  return splitSentences(text).filter((s) => OFFER_TALK_RX.test(s));
}

export const OFFER_HINT_LINE = 'I may be able to do something for you on that, and it is easier to go over on a quick call.';

/** Strip offer talk; keep the reply moving with the approved hint. Pure. */
export function stripOfferTalk(text) {
  const hits = findOfferTalk(text);
  if (!hits.length) return { text: String(text || ''), stripped: [] };
  const kept = splitSentences(text).filter((s) => !hits.includes(s));
  const hasQuestion = kept.some((s) => s.includes('?'));
  const out = hasQuestion ? kept : [...kept, OFFER_HINT_LINE];
  return { text: out.join(' ').trim(), stripped: hits };
}

/** The GHL contact link for a card. Pure. */
export function ghlContactUrl(locationId, contactId) {
  return `https://app.gohighlevel.com/v2/location/${locationId}/contacts/detail/${contactId}`;
}

/**
 * The #contact-rehash card. Plain English, built once (CLAUDE.md). Pure.
 * Never a pronoun for the contact — the card uses their first name.
 */
export function formatRehashCallCard({ firstName, phone, market, repName, preferredTime, lastMessage, contactUrl }) {
  const who = firstName || 'A post-demo lead';
  return [
    `📞 REHASH CALL REQUEST`,
    `${who} (post-demo, F.0) said yes to a call${repName ? ` with ${repName}` : ''}.`,
    `Best time: ${preferredTime || 'not given yet. Call soon.'}`,
    `Phone: ${phone || 'not on file'}`,
    market ? `Market: ${market}` : null,
    lastMessage ? `${who} said: "${String(lastMessage).slice(0, 300)}"` : null,
    contactUrl ? `Contact: ${contactUrl}` : null,
    `→ Call ${firstName || 'them'} at that time and see what we can do.`,
  ].filter(Boolean).join('\n');
}

/** One card per contact per Eastern day. Pure. */
export function rehashCallIdempotencyKey(contactId, nowMs = Date.now()) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs));
  return `f0_rehash_call_${contactId}_${day}`;
}
