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
 * Four-Step checks: the first name first, a conditional offer (any wording,
 * 2026-10-22) and the call question
 * naming the rep at positions 1-4, and every slot grounded in the visit
 * (verify, don't trust: CANON.K.047).
 */
import { findOfferTalk } from '../agentic/rehash.js';
import { POST_DEMO_REBUTTAL_RX, UNPROMISED_FOLLOW_UP_RX } from '../agentic/nepq-planner.js';
import { enforceRehashCallTiming } from '../agentic/team-hours.js';
import { hasSensitiveDetail } from './text-guards.js';
import { copiesSiroDraft, repQuoteRx } from './presentation-guard.js';
import { groundingSources, FOUR_STEP_SLOTS, CONDITIONAL_OFFER_RX, closeRepeats } from './f0-four-step.js';
import { findExclamations } from '../agentic/discovery-discipline.js';
import { F0_EMAIL_SUBJECT_MAX, F0_EMAIL_PREHEADER_MAX, F0_EMAIL_BODY_WORDS, F0_TEAM_SIGNATURE, F0_TEAM_CALL_FALLBACK } from './f0-email.js';

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
// 2026-10-21 (Mark, the position-0 email): the email never says "deal" (not
// even the one hint), never calls Randy the founder (his FATHER founded Reece
// in 1972), never writes the template's footer, an address or an unsubscribe
// line, and never says "your rep".
const DEAL_RX = /\bdeals?\b/i;
const FOUNDER_RX = /\bfound(?:er|ed|ing)\b/i;
const FOOTER_RX = /\bunsubscribe\b|\bopt[\s-]?out\b|\bprotecting\s+families\s+since\b|©|\bcopyright\b|\ball\s+rights\s+reserved\b|\b\d{2,6}\s+(?:[A-Z][a-z]+\s+){1,3}(?:St|Street|Ave|Avenue|Blvd|Boulevard|Rd|Road|Dr|Drive|Ln|Lane|Way|Ct|Court|Hwy|Highway|Pkwy|Parkway)\b/;
const YOUR_REP_RX = /\byour\s+(?:sales\s+)?(?:rep|representative|consultant)\b/i;
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
// 2026-10-20 (the first Four-Step previews): "-tion" folds too ("protection" =
// "protect"), and the stop list is read again AFTER the fold, so "home's" and
// "windows" are stop words on both sides: before, the slot kept "home" while
// the visit facts dropped it, and a grounded slot read as ungrounded.
function stem(w) {
  return w.replace(/'s$/, '').replace(/(?<=t)ions?$/, '').replace(/(?:ing|ed|es|s)$/, '').replace(/(.)\1$/, '$1');
}
export function contentStems(s) {
  return new Set(tokens(s).filter(w => !GROUND_STOP.has(w)).map(stem)
    .filter(w => w.length >= 3 && !GROUND_STOP.has(w) && !GROUND_STOP.has(`${w}s`)));
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
    // 2026-10-22 (the user): "if I could, would you" is the strategy, not the
    // words. Any conditional offer to make it work better counts.
    if (!CONDITIONAL_OFFER_RX.test(body)) fail.push('no_conditional_offer');
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

const escRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const firstSentence = (s) => (String(s || '').replace(/^\s*(?:hi|hey|hello|dear)?[\s,]*[A-Z][\w'’-]*\s*,\s*/i, '').match(/^[^.!?]*[.!?]?/) || [''])[0];
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The position-0 email's own checks (formula 'email', Mark 2026-10-21): the
 * subject, preheader and P.S. are part of the email, so the content checks
 * read all four parts; the question and the call invite are the body's. Pure.
 */
function emailFailures(body, { subject = '', preheader = '', ps = '', salesRepFirstName = null } = {}) {
  const fail = [];
  const all = [subject, preheader, body, ps].filter(Boolean).join('\n');
  if (!String(subject).trim() || String(subject).length > F0_EMAIL_SUBJECT_MAX) fail.push('subject_length');
  if (!String(preheader).trim() || String(preheader).length > F0_EMAIL_PREHEADER_MAX) fail.push('preheader_length');
  const fs = norm(firstSentence(body));
  const ph = norm(preheader);
  if (ph && fs && (fs === ph || fs.startsWith(ph) || ph.startsWith(fs))) fail.push('preheader_repeats_body');
  const words = body.split(/\s+/).filter(Boolean).length;
  if (words < F0_EMAIL_BODY_WORDS.min || words > F0_EMAIL_BODY_WORDS.max) fail.push('body_length');
  if ((all.match(/\?/g) || []).length !== 1) fail.push('question_count');
  if (findExclamations(all)) fail.push('exclamation');
  if (DEAL_RX.test(all)) fail.push('deal_word');
  if (FOUNDER_RX.test(all)) fail.push('founder');
  if (FOOTER_RX.test(all)) fail.push('footer_text');
  if (YOUR_REP_RX.test(all)) fail.push('your_rep');
  // The sales rep who visited may be named ONCE, as the person who came out;
  // never as the one who will follow up (2026-10-11: the rehash team owns it).
  if (salesRepFirstName) {
    const n = escRx(salesRepFirstName);
    if ((all.match(new RegExp(`\\b${n}\\b`, 'gi')) || []).length > 1) fail.push('sales_rep_named_twice');
    if (new RegExp(`\\b${n}\\b[^.?!]{0,50}\\b(?:will|'ll|is\\s+going\\s+to|plans?\\s+to)\\b[^.?!]{0,30}\\b(?:follow(?:ing)?\\s+up|reach(?:ing)?\\s+out|call|be\\s+in\\s+touch|get\\s+back)`, 'i').test(all)) fail.push('sales_rep_follow_up');
  }
  return fail;
}

// The Reece Team email (Mark, 2026-10-22): written as "we", never "I", and the
// invite names the resolved rehash rep (or "our team" when no name was found).
// 2026-10-23 (the user): the GHL template signs it ("The Reece Team / Reece
// Windows & Doors"), so the body ends on the call question with no sign-off;
// before, the body's "The Reece Team" sat above the template's "John".
const TEAM_SIGNATURE_RX = new RegExp(`^${escRx(F0_TEAM_SIGNATURE)}\\.?$`, 'i');
const FIRST_PERSON_I_RX = /\bI(?:['’](?:m|ve|d|ll))?\b/;
const FIRST_PERSON_OBJ_RX = /\b(?:me|my|mine|myself)\b/i;
const SIGN_OFF_WORD_RX = /\b(?:best|thanks|thank\s+you|regards|sincerely|warmly|cheers|talk\s+soon|all\s+the\s+best)\b/i;
const PERSON_LINE_RX = /^[-–—]?\s*\p{Lu}[\p{L}'’-]*(?:\s+\p{Lu}[\p{L}'’-]*)?\.?$/u;

/**
 * The body before its sign-off and the sign-off itself: everything after the
 * last "?" (the call invite) is the sign-off. Pure.
 */
export function splitTeamSignature(body) {
  const text = String(body || '').trim();
  const q = text.lastIndexOf('?');
  if (q < 0) return { content: text, signature: '' };
  return { content: text.slice(0, q + 1).trim(), signature: text.slice(q + 1).trim() };
}

/** The Reece Team email's own checks (voice 'team'). Pure. */
function teamVoiceFailures(body, { subject = '', preheader = '', ps = '', callWith = null, salesRepFirstName = null } = {}) {
  const fail = [];
  const { content, signature } = splitTeamSignature(body);
  if (signature) {
    const person = !TEAM_SIGNATURE_RX.test(signature) && !/\breece\b/i.test(signature)
      && (SIGN_OFF_WORD_RX.test(signature) || signature.split(/\n/).some(l => PERSON_LINE_RX.test(l.trim())));
    fail.push(person ? 'signed_as_person' : 'signature_in_body');
  }
  const all = [subject, preheader, content, ps].filter(Boolean).join('\n');
  if (FIRST_PERSON_I_RX.test(all) || FIRST_PERSON_OBJ_RX.test(all)) fail.push('first_person');
  // The invite names the resolved rehash rep and nobody else.
  const want = String(callWith || F0_TEAM_CALL_FALLBACK).trim();
  const named = (content.match(/\bcall\s+with\s+([^?]{1,60})\?\s*$/i) || [])[1];
  if (named) {
    const words = named.trim().split(/\s+/);
    const wantWords = new Set(want.toLowerCase().split(/\s+/));
    const hasWant = new RegExp(`\\b${escRx(want)}\\b`, 'i').test(named);
    const other = words.some(w => /^\p{Lu}/u.test(w) && !wantWords.has(w.toLowerCase().replace(/[^\p{L}'’-]/gu, '')) && !/^reece$/i.test(w))
      || (salesRepFirstName && new RegExp(`\\b${escRx(salesRepFirstName)}\\b`, 'i').test(named) && salesRepFirstName.toLowerCase() !== want.toLowerCase());
    if (!hasWant || other) fail.push('call_names_other');
  }
  return { fail, content };
}

/**
 * @param {string} text
 * @param {{facts?: object|null, position: number, repFirstName?: string,
 *   formula?: 'v1'|'four_step'|'email', voice?: 'rep'|'team', callWith?: string|null, slots?: object|null, firstName?: string|null,
 *   followupText?: string|null, subject?: string, preheader?: string, ps?: string}} o
 * @returns {string[]} failure codes (empty = pass)
 */
export function checkF0Copy(text, { facts = null, position = 1, repFirstName = null, formula = 'v1', slots = null, firstName = null, followupText = null, subject = '', preheader = '', ps = '', voice = 'rep', callWith = null, earlierMessages = [] } = {}) {
  let body = String(text || '').trim();
  const fail = [];
  if (!body) return ['empty'];
  const email = formula === 'email';
  // The Reece Team email (Mark, 2026-10-22): the sign-off and voice are
  // checked here; every other check reads the body without its sign-off.
  if (email && voice === 'team') {
    const team = teamVoiceFailures(body, { subject, preheader, ps, callWith, salesRepFirstName: facts?.rep_first_name || null });
    fail.push(...team.fail);
    body = team.content;
  }
  const fourStep = formula === 'four_step';
  if (!email && body.length > (fourStep ? F0_FOUR_STEP_SMS_MAX : F0_SMS_MAX)) fail.push('too_long');

  const questions = (body.match(/\?/g) || []).length;
  // The email counts its question across every part (emailFailures).
  if (!email && (position >= CLOSE_POSITION ? questions !== 0 : questions !== 1)) fail.push('question_count');

  if (MONEY_RX.test(body)) fail.push('money');
  if (TIME_RX.test(body)) fail.push('time');
  if (DAY_RX.test(body)) fail.push('day');
  if (BOOKED_RX.test(body)) fail.push('booking_claim');
  // The hint is allowed once in the sequence, at position 4 only. Four-Step:
  // slot 4 hints at a better deal at every position that asks (1-4). The
  // email allows no offer word at all, the P.S. included (Mark, 2026-10-21).
  const hintAllowed = email ? false : fourStep ? position < CLOSE_POSITION : position === HINT_POSITION;
  const offerText = email ? [subject, preheader, body, ps].filter(Boolean).join('\n') : body;
  if (findOfferTalk(offerText, { hintUsed: !hintAllowed }).length) fail.push('offer_talk');
  if (POST_DEMO_REBUTTAL_RX.test(body)) fail.push('rebuttal');
  if (UNPROMISED_FOLLOW_UP_RX.test(body)) fail.push('unpromised_follow_up');
  if (enforceRehashCallTiming(body).changed) fail.push('call_now');
  if (RECORDED_RX.test(body)) fail.push('recorded');
  if (WARRANTY_RX.test(body)) fail.push('warranty_pitch');
  if (REHASH_RX.test(body)) fail.push('rehash_word');
  if (SALES_REP_RX.test(body)) fail.push('sales_rep_follow_up');
  if (EMOJI_RX.test(body)) fail.push('emoji');
  if (/[—–]/.test(body)) fail.push('em_dash');
  // The email's job is to thank them for the visit, so its opener may.
  if (!email && GENERIC_OPENER_RX.test(body)) fail.push('generic_opener');
  // Four-Step positions 1-4 end on the call question naming the rep instead;
  // the email's sign-off is the GHL template's.
  if (repFirstName && !email && !(fourStep && position < CLOSE_POSITION) && !signedBy(body, repFirstName)) fail.push('missing_signature');
  // Ruling 7 (2026-10-19): never a death, an illness, divorce, a lost job,
  // debt or age, whatever the formula.
  const sensitiveText = email ? [subject, preheader, body, ps].filter(Boolean).join('\n') : body;
  if (hasSensitiveDetail(sensitiveText)) fail.push('sensitive_detail');
  if (email && (MONEY_RX.test(`${subject}\n${preheader}\n${ps}`)) && !fail.includes('money')) fail.push('money');
  // The rep is never quoted back ("your rep Alex said…"; handoff v2 bad example).
  if (repQuoteRx(facts?.rep_first_name || null).test(body)) fail.push('rep_quoted');
  // Ruling 2: Siro's suggested text is a reference, never sent as written.
  if (followupText && copiesSiroDraft(body, followupText)) fail.push('siro_draft_copied');
  // 2026-10-22 (the user): never the same close twice in one thread.
  if ((email || fourStep) && closeRepeats(body, earlierMessages)) fail.push('close_repeated');

  if (email) {
    fail.push(...emailFailures(body, { subject, preheader, ps, salesRepFirstName: facts?.rep_first_name || null }));
    // The Four-Step close and slots, as at position 1: the first name first,
    // a conditional offer and the call invite naming the rehash rep, both slots
    // required and grounded in the visit. A recording is required (no facts =
    // no email), so the grounding always runs.
    const team = voice === 'team';
    fail.push(...fourStepFailures(body, { facts, position: 1, repFirstName: team ? (callWith || F0_TEAM_CALL_FALLBACK) : repFirstName, slots, firstName }));
    if (!facts) fail.push('no_visit_facts');
  } else if (fourStep) {
    fail.push(...fourStepFailures(body, { facts, position, repFirstName, slots, firstName }));
  } else if (facts && position <= 3) {
    const want = personalizationTokens(facts);
    const have = new Set(tokens(body));
    if (want.size && ![...want].some(w => have.has(w))) fail.push('not_personalized');
  }
  return fail;
}

/** One line per failure for the re-write note. Pure. */
export function f0RetryNote(failures, { position, formula = 'v1', voice = 'rep' }) {
  const email = formula === 'email';
  const teamEmail = email && voice === 'team';
  const why = {
    too_long: `Keep it under ${formula === 'four_step' ? F0_FOUR_STEP_SMS_MAX : F0_SMS_MAX} characters.`,
    question_count: email ? 'Ask exactly one question in the whole email (subject, preheader, body and P.S.): the call invite at the end of the body.'
      : position >= CLOSE_POSITION ? 'Ask no question.' : 'Ask exactly one question.',
    money: 'No price, dollar figure or discount.',
    time: 'No clock time.',
    day: 'No day of the week or "tomorrow".',
    booking_claim: 'Do not say anything is booked or confirmed.',
    offer_talk: email ? 'No offer, deal, discount, promotion or price talk anywhere in the email.' : position === HINT_POSITION ? 'Only "the best deal possible" may hint at an offer.' : 'No offer or deal talk at all.',
    rebuttal: 'Do not argue with their hesitation; acknowledge it.',
    unpromised_follow_up: 'Do not promise someone will reach out.',
    call_now: 'Never promise a call right now, today or shortly.',
    recorded: 'Never mention a recording or transcript.',
    warranty_pitch: 'Do not pitch the warranty.',
    rehash_word: 'Never use the word "rehash".',
    sales_rep_follow_up: email ? 'Never say the person who visited will follow up, call or reach out; the call is with the rep named in the invite.' : 'Do not say the sales rep will follow up.',
    emoji: 'No emoji.',
    em_dash: 'No dashes like — or –.',
    generic_opener: 'Do not open with "thanks for having us" or "just checking in".',
    missing_signature: 'Sign with the rep first name at the very end.',
    signature_in_body: 'End the body on the call question. No sign-off and no name after it: the template signs the email.',
    not_personalized: 'Name one specific thing from their visit.',
    empty: 'Write the message.',
    rep_quoted: 'Never quote the rep ("your rep said").',
    sensitive_detail: 'Never mention a death or loss, an illness, health, divorce, a lost job, debt or money trouble, or age.',
    siro_draft_copied: 'Do not copy the suggested follow-up; write your own text.',
    four_step_output: 'Answer as JSON: {"slots": {"hesitation", "affirm", "reframe", "if_i_could"}, "text"}.',
    first_name_not_first: 'Start the text with their first name.',
    no_conditional_offer: 'Before the call question, offer to make it work better for them, in your own words (for example "if there\'s a way to …", "we may be able to …"). It does not have to say "If I could".',
    close_repeated: 'The close repeats one we already sent this lead. Word the call question a new way, and do not use "if I could" or "if we could" again.',
    no_call_question: teamEmail ? 'End the email on one question asking for a quick call with <CALL WITH>, in your own words, and nothing after it.' : 'End with one question asking for a quick call with <rep first name>, in your own words.',
    'slot_missing:hesitation': 'Fill the hesitation slot from <visit_facts>.',
    'slot_missing:reframe': 'Fill the reframe slot from <visit_facts>.',
    'slot_ungrounded:hesitation': position === 3 ? 'Slot 1 must come from what the home means to them in <visit_facts>.' : 'The hesitation slot must restate their hesitation from <visit_facts>, in their words.',
    'slot_ungrounded:reframe': 'The reframe slot must name something they told us they wanted (wants, what_it_means or scope in <visit_facts>).',
    subject_length: `Write a subject of ${F0_EMAIL_SUBJECT_MAX} characters or fewer.`,
    preheader_length: `Write a preheader of ${F0_EMAIL_PREHEADER_MAX} characters or fewer.`,
    preheader_repeats_body: 'The preheader must not repeat the first sentence of the body.',
    body_length: `Write the body in ${F0_EMAIL_BODY_WORDS.min} to ${F0_EMAIL_BODY_WORDS.max} words.`,
    exclamation: 'No exclamation marks.',
    deal_word: 'Never use the word "deal".',
    founder: 'Never call anyone the founder.',
    footer_text: 'No footer, address, copyright or unsubscribe text; the template adds the footer.',
    your_rep: 'Never say "your rep"; name the person who visited at most once, as the one who came out.',
    sales_rep_named_twice: 'Name the person who visited at most once.',
    no_visit_facts: 'There is no visit on file.',
    first_person: 'Write as the Reece Team: "we", "us", "our". Never "I", "me" or "my".',
    signed_as_person: 'Never sign as a person, and write no sign-off at all: the body ends on the call question and the template signs the email.',
    call_names_other: 'The call invite names only the rep given in CALL WITH.',
    email_output: 'Answer as JSON: {"subject", "preheader", "body", "ps", "slots": {"hesitation", "affirm", "reframe", "if_i_could"}}.',
  };
  const line = (f) => why[f] || (f.startsWith('slot_not_in_text:') ? `Use the ${f.split(':')[1]} slot's words in the text.` : f);
  return `IMPORTANT: the previous draft failed these checks. Fix every one:\n${failures.map(f => `- ${line(f)}`).join('\n')}`;
}
