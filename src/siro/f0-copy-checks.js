/**
 * F.0 v2 copy checks — src/siro/f0-copy-checks.js (2026-10-16)
 *
 * Pure. Runs on every F.0 draft after the nurture safety validator. A draft
 * that fails gets ONE re-write with the failures named, then
 * suppressed_low_conf — never a fixed fallback text (the user's Part 7
 * ruling: every message is custom).
 *
 * The rules are the post-demo track's, reused rather than restated:
 * stripOfferTalk / findOfferTalk (src/agentic/rehash.js: "the best deal
 * possible" is the ONE hint, allowed at position 4 only), POST_DEMO_REBUTTAL_RX
 * and UNPROMISED_FOLLOW_UP_RX (src/agentic/nepq-planner.js, Shawn Eastman
 * 2026-10-15), enforceRehashCallTiming (src/agentic/team-hours.js, Monica
 * 2026-10-09). A visit that was recorded is never mentioned as recorded.
 */
import { findOfferTalk } from '../agentic/rehash.js';
import { POST_DEMO_REBUTTAL_RX, UNPROMISED_FOLLOW_UP_RX } from '../agentic/nepq-planner.js';
import { enforceRehashCallTiming } from '../agentic/team-hours.js';

export const F0_SMS_MAX = 300;
export const HINT_POSITION = 4;
export const CLOSE_POSITION = 5;

const MONEY_RX = /\$|\b\d[\d,]*(?:\.\d+)?\s*(?:dollars|bucks|k\b|%\s*off)|\bpercent\s+off\b/i;
const TIME_RX = /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b|\b\d{1,2}:\d{2}\b|\bnoon\b|\bmidnight\b/i;
const DAY_RX = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|this\s+(?:morning|afternoon|evening|week(?:end)?))\b/i;
const BOOKED_RX = /\byou'?re\s+(?:all\s+)?set\b|\b(?:you'?re|is|are)\s+(?:booked|confirmed|scheduled)\b|\bsee\s+you\s+(?:then|on)\b|\bon\s+the\s+calendar\b/i;
const RECORDED_RX = /\brecord(?:ed|ing)\b|\bsiro\b|\btranscri/i;
const WARRANTY_RX = /\bwarrant(?:y|ies)\b|\bguarantee\b/i;
const REHASH_RX = /\brehash\b/i;
const SALES_REP_RX = /\b(?:your|the)\s+(?:sales\s+)?rep\s+will\b|\bsales\s+rep\b/i;
const EMOJI_RX = /\p{Extended_Pictographic}/u;
const GENERIC_OPENER_RX = /^\s*(?:hi|hey|hello)?[\s,]*(?:[a-z]+[,!.]?\s+)?(?:thanks?(?:\s+you)?\s+(?:again\s+)?for\s+having\s+us|just\s+(?:checking|following)\s+(?:in|up)|hope\s+(?:you|all|this)|i\s+wanted\s+to\s+(?:check|follow)|touching\s+base)/i;

const STOPWORDS = new Set(('about after again also because been before being both could does doing each from have having here into just like more most much only other over same should some such than that their them then there these they this those through very what when where which while will with would your yours you\'re window windows door doors home house price cost').split(' '));

function tokens(s) {
  return String(s || '').toLowerCase().match(/[a-z][a-z'-]{3,}/g) || [];
}

/** Words from the visit the draft may echo to prove it was written for this lead. */
export function personalizationTokens(facts) {
  if (!facts) return new Set();
  const out = new Set();
  const add = (s) => tokens(s).forEach(w => { if (!STOPWORDS.has(w)) out.add(w); });
  (facts.interests || []).forEach(add);
  (facts.objections || []).forEach(o => { add(o.said); });
  (facts.questions || []).forEach(add);
  (facts.summary_lines || []).forEach(l => add(String(l).replace(/^[^:]{0,40}:\s*/, '')));
  // An objection type a person would say back ("spouse", "timing") counts too.
  (facts.objections || []).forEach(o => { if (o.type && o.type !== 'other') out.add(o.type); });
  return out;
}

function signedBy(text, name) {
  if (!name) return false;
  const n = String(name).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s,.!-])${n}\\s*[.!]?\\s*$`, 'i').test(String(text || '').trim());
}

/**
 * @param {string} text
 * @param {{facts?: object|null, position: number, repFirstName?: string}} o
 * @returns {string[]} failure codes (empty = pass)
 */
export function checkF0Copy(text, { facts = null, position = 1, repFirstName = null } = {}) {
  const body = String(text || '').trim();
  const fail = [];
  if (!body) return ['empty'];
  if (body.length > F0_SMS_MAX) fail.push('too_long');

  const questions = (body.match(/\?/g) || []).length;
  if (position >= CLOSE_POSITION ? questions !== 0 : questions !== 1) fail.push('question_count');

  if (MONEY_RX.test(body)) fail.push('money');
  if (TIME_RX.test(body)) fail.push('time');
  if (DAY_RX.test(body)) fail.push('day');
  if (BOOKED_RX.test(body)) fail.push('booking_claim');
  // The hint is allowed once in the sequence, at position 4 only.
  if (findOfferTalk(body, { hintUsed: position !== HINT_POSITION }).length) fail.push('offer_talk');
  if (POST_DEMO_REBUTTAL_RX.test(body)) fail.push('rebuttal');
  if (UNPROMISED_FOLLOW_UP_RX.test(body)) fail.push('unpromised_follow_up');
  if (enforceRehashCallTiming(body).changed) fail.push('call_now');
  if (RECORDED_RX.test(body)) fail.push('recorded');
  if (WARRANTY_RX.test(body)) fail.push('warranty_pitch');
  if (REHASH_RX.test(body)) fail.push('rehash_word');
  if (SALES_REP_RX.test(body)) fail.push('sales_rep_follow_up');
  if (EMOJI_RX.test(body)) fail.push('emoji');
  if (/[—–]/.test(body)) fail.push('em_dash');
  if (GENERIC_OPENER_RX.test(body)) fail.push('generic_opener');
  if (repFirstName && !signedBy(body, repFirstName)) fail.push('missing_signature');

  if (facts && position <= 3) {
    const want = personalizationTokens(facts);
    const have = new Set(tokens(body));
    if (want.size && ![...want].some(w => have.has(w))) fail.push('not_personalized');
  }
  return fail;
}

/** One line per failure for the re-write note. Pure. */
export function f0RetryNote(failures, { position }) {
  const why = {
    too_long: `Keep it under ${F0_SMS_MAX} characters.`,
    question_count: position >= CLOSE_POSITION ? 'Ask no question.' : 'Ask exactly one question.',
    money: 'No price, dollar figure or discount.',
    time: 'No clock time.',
    day: 'No day of the week or "tomorrow".',
    booking_claim: 'Do not say anything is booked or confirmed.',
    offer_talk: position === HINT_POSITION ? 'Only "the best deal possible" may hint at an offer.' : 'No offer or deal talk at all.',
    rebuttal: 'Do not argue with their hesitation; acknowledge it.',
    unpromised_follow_up: 'Do not promise someone will reach out.',
    call_now: 'Never promise a call right now, today or shortly.',
    recorded: 'Never mention a recording or transcript.',
    warranty_pitch: 'Do not pitch the warranty.',
    rehash_word: 'Never use the word "rehash".',
    sales_rep_follow_up: 'Do not say the sales rep will follow up.',
    emoji: 'No emoji.',
    em_dash: 'No dashes like — or –.',
    generic_opener: 'Do not open with "thanks for having us" or "just checking in".',
    missing_signature: 'Sign with the rep first name at the very end.',
    not_personalized: 'Name one specific thing from their visit.',
    empty: 'Write the message.',
  };
  return `IMPORTANT: the previous draft failed these checks. Fix every one:\n${failures.map(f => `- ${why[f] || f}`).join('\n')}`;
}
