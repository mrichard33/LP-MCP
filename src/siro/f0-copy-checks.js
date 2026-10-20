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
 *
 * 2026-10-19 (Mark, handoff v2): every formula refuses a sensitive detail
 * (ruling 7: a death, an illness, divorce, a lost job, debt, age) and a copy
 * of Siro's suggested text (ruling 2). formula 'four_step' (ruling 6) adds the
 * Four-Step checks: the first name first, "If I could" and the call question
 * naming the rep at positions 1-4, and every slot grounded in the visit
 * (verify, don't trust: CANON.K.047).
 */
import { findOfferTalk } from '../agentic/rehash.js';
import { POST_DEMO_REBUTTAL_RX, UNPROMISED_FOLLOW_UP_RX } from '../agentic/nepq-planner.js';
import { enforceRehashCallTiming } from '../agentic/team-hours.js';
import { hasSensitiveDetail } from './text-guards.js';
import { copiesSiroDraft, repQuoteRx } from './presentation-guard.js';
import { groundingSources, FOUR_STEP_SLOTS } from './f0-four-step.js';

export const F0_SMS_MAX = 300;
// 2026-10-20 (the first Four-Step previews): name + four parts + the call
// question ran 301-330 characters on 3 of 10 leads with nothing to cut. The
// prompt still asks for 300; the check allows two full SMS segments.
export const F0_FOUR_STEP_SMS_MAX = 320;
// The affirm slot is a short stock phrase ("that's fair with everything going
// on") the model often folds into the hesitation ("… makes sense"): either
// one word of the slot or an affirm phrase in the text counts.
const AFFIRM_PHRASE_RX = /\b(?:fair|makes?\s+(?:total\s+|complete\s+)?sense|understandable|reasonable|completely\s+understand|i\s+understand|smart)\b/i;
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
// Content words for the slot-grounding checks: lower case, 4+ letters, not a
// stop word, a plural or -ing/-ed ending folded ("rotting" = "rot",
// "wanted" = "want"), so the lead's words match Siro's summary of them.
const GROUND_STOP = new Set([...STOPWORDS, ...("they're it's that's really still make made sure think going getting fair understand totally makes sense customer homeowner homeowners visit".split(' '))]);
function stem(w) {
  return w.replace(/'s$/, '').replace(/(?:ing|ed|es|s)$/, '').replace(/(.)\1$/, '$1');
}
export function contentStems(s) {
  return new Set(tokens(s).filter(w => !GROUND_STOP.has(w)).map(stem).filter(w => w.length >= 3));
}
/** How many content words a slot shares with the visit facts it must come from. Pure. */
export function sharedWords(slot, sources) {
  const a = contentStems(slot);
  const b = contentStems((sources || []).join(' '));
  return [...a].filter(w => b.has(w)).length;
}

function startsWithName(body, firstName) {
  if (!firstName) return true;
  const n = String(firstName).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*(?:hi|hey|hello)?[\\s,]*${n}\\b`, 'i').test(body);
}

/** The Four-Step checks (formula 'four_step'). Pure. */
function fourStepFailures(body, { facts, position, repFirstName, slots, firstName }) {
  const fail = [];
  if (!startsWithName(body, firstName)) fail.push('first_name_not_first');
  if (position < CLOSE_POSITION) {
    if (!/\bif\s+i\s+could\b/i.test(body)) fail.push('no_if_i_could');
    const last = (body.match(/[^.!?]*\?\s*$/) || [''])[0];
    if (!last || !repFirstName || !new RegExp(`\\b${String(repFirstName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(last) || !/\bcall\b/i.test(last)) fail.push('no_call_question');
  }
  const s = slots || {};
  for (const k of FOUR_STEP_SLOTS) {
    if (!s[k]) continue;
    const words = [...contentStems(s[k])];
    const have = contentStems(body);
    const need = Math.min(2, words.length);
    if (k === 'affirm') {
      if (!words.some(w => have.has(w)) && !AFFIRM_PHRASE_RX.test(body)) fail.push('slot_not_in_text:affirm');
      continue;
    }
    if (need && words.filter(w => have.has(w)).length < need) fail.push(`slot_not_in_text:${k}`);
  }
  // No visit on file (the no-visit-data variant): nothing to ground a slot in.
  if (!facts) return fail;
  const src = groundingSources(facts);
  if (position <= 2) {
    if (!s.hesitation) fail.push('slot_missing:hesitation');
    if (!s.reframe) fail.push('slot_missing:reframe');
  }
  // P3's first slot is a future pace from what the home means to them.
  if (s.hesitation && position <= 3) {
    const from = position === 3 ? src.reframe : src.hesitation;
    if (sharedWords(s.hesitation, from) < 2) fail.push('slot_ungrounded:hesitation');
  }
  if (s.reframe && sharedWords(s.reframe, src.reframe) < 2) fail.push('slot_ungrounded:reframe');
  return fail;
}

/**
 * @param {string} text
 * @param {{facts?: object|null, position: number, repFirstName?: string,
 *   formula?: 'v1'|'four_step', slots?: object|null, firstName?: string|null,
 *   followupText?: string|null}} o
 * @returns {string[]} failure codes (empty = pass)
 */
export function checkF0Copy(text, { facts = null, position = 1, repFirstName = null, formula = 'v1', slots = null, firstName = null, followupText = null } = {}) {
  const body = String(text || '').trim();
  const fail = [];
  if (!body) return ['empty'];
  const fourStep = formula === 'four_step';
  if (body.length > (fourStep ? F0_FOUR_STEP_SMS_MAX : F0_SMS_MAX)) fail.push('too_long');

  const questions = (body.match(/\?/g) || []).length;
  if (position >= CLOSE_POSITION ? questions !== 0 : questions !== 1) fail.push('question_count');

  if (MONEY_RX.test(body)) fail.push('money');
  if (TIME_RX.test(body)) fail.push('time');
  if (DAY_RX.test(body)) fail.push('day');
  if (BOOKED_RX.test(body)) fail.push('booking_claim');
  // The hint is allowed once in the sequence, at position 4 only. Four-Step:
  // slot 4 hints at a better deal at every position that asks (1-4).
  const hintAllowed = fourStep ? position < CLOSE_POSITION : position === HINT_POSITION;
  if (findOfferTalk(body, { hintUsed: !hintAllowed }).length) fail.push('offer_talk');
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
  // Four-Step positions 1-4 end on the call question naming the rep instead.
  if (repFirstName && !(fourStep && position < CLOSE_POSITION) && !signedBy(body, repFirstName)) fail.push('missing_signature');
  // Ruling 7 (2026-10-19): never a death, an illness, divorce, a lost job,
  // debt or age, whatever the formula.
  if (hasSensitiveDetail(body)) fail.push('sensitive_detail');
  // The rep is never quoted back ("your rep Alex said…"; handoff v2 bad example).
  if (repQuoteRx(facts?.rep_first_name || null).test(body)) fail.push('rep_quoted');
  // Ruling 2: Siro's suggested text is a reference, never sent as written.
  if (followupText && copiesSiroDraft(body, followupText)) fail.push('siro_draft_copied');

  if (fourStep) {
    fail.push(...fourStepFailures(body, { facts, position, repFirstName, slots, firstName }));
  } else if (facts && position <= 3) {
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
    rep_quoted: 'Never quote the rep ("your rep said").',
    sensitive_detail: 'Never mention a death or loss, an illness, health, divorce, a lost job, debt or money trouble, or age.',
    siro_draft_copied: 'Do not copy the suggested follow-up; write your own text.',
    four_step_output: 'Answer as JSON: {"slots": {"hesitation", "affirm", "reframe", "if_i_could"}, "text"}.',
    first_name_not_first: 'Start the text with their first name.',
    no_if_i_could: 'Use "If I could …, would you …?" for the close.',
    no_call_question: 'End with the question "would you be open to a quick call with <rep first name>?"',
    'slot_missing:hesitation': 'Fill the hesitation slot from <visit_facts>.',
    'slot_missing:reframe': 'Fill the reframe slot from <visit_facts>.',
    'slot_ungrounded:hesitation': position === 3 ? 'Slot 1 must come from what the home means to them in <visit_facts>.' : 'The hesitation slot must restate their hesitation from <visit_facts>, in their words.',
    'slot_ungrounded:reframe': 'The reframe slot must name something they told us they wanted (wants, what_it_means or scope in <visit_facts>).',
  };
  const line = (f) => why[f] || (f.startsWith('slot_not_in_text:') ? `Use the ${f.split(':')[1]} slot's words in the text.` : f);
  return `IMPORTANT: the previous draft failed these checks. Fix every one:\n${failures.map(f => `- ${line(f)}`).join('\n')}`;
}
