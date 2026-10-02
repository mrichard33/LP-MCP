/**
 * NEPQ turn planner — src/agentic/nepq-planner.js
 *
 * 2026-10-02 (Mark): NEPQ is the backbone of BOTH bots, enforced in code, not
 * only described in a prompt. The 2026-10-02 review found NEPQ well written
 * into the prompt and loosely enforced: the "think it over" hold offer was
 * stripped by the booking-ask cap, two think-it-over plays contradicted each
 * other, live chat skipped the price clarify, neither bot handed off after two
 * no's, and the live chat quoted "$89–$149/mo, no money down".
 *
 * The owner's shortened NEPQ for text:
 *   - a short, low-pressure opener; ONE question per message in their words;
 *     ONE gentle "what happens if you wait?" question; 2–3 REAL slots; spouse
 *     → a time when both can be there.
 *   - never prices, savings or financing figures in chat; no pressure, no fake
 *     urgency, no unapproved stats.
 *   - a person takes over on a complaint, a price insisted on after one ask,
 *     or two no's.
 *   - objection lines and the booking sequence below are Mark's wording.
 *
 * This module decides the ONE move for this turn from the thread itself (the
 * stateless shape of not-interested.js and the live-chat cancel flow). It is
 * pure: callers render the plan into the prompt (nepq-backbone.js), enforce
 * it on the draft (enforceNepqPlan), and run the side effects.
 */

import { isNotInterested } from './not-interested.js';
import { isLeadQuestion, findBookingAsks } from './discovery-discipline.js';

export const NEPQ_PLANNER_VERSION = '1.0';

/** off | shadow | live. Anything else is off. */
export function nepqBackboneMode(env = process.env) {
  const v = String(env.NEPQ_BACKBONE_MODE || 'off').trim().toLowerCase();
  return v === 'live' || v === 'shadow' ? v : 'off';
}

// ── signals in the lead's words ──────────────────────────────────────────

export const PRICE_RX = /\b(?:how\s+much|price[sd]?|pricing|costs?|quotes?|estimates?|ballpark|rough\s+(?:number|idea|figure)|what\s+(?:would|does|will)\s+(?:it|that|this)\s+(?:cost|run))\b/i;
export const INSIST_RX = /\b(?:just|only)\s+(?:want|need)\s+(?:a|the|to\s+(?:get|know)(?:\s+(?:a|the))?)\s+(?:price|quote|number|cost|estimate)\b|\b(?:give|tell|send|text)\s+me\s+(?:a|the|your)\s+(?:price|number|quote|ballpark|figure|estimate)\b/i;
// "how much a month" asks for a figure; "do you offer financing?" does not.
const MONEY_FIGURE_ASK_RX = /\bhow\s+much\b[^?]{0,30}\b(?:a|per)\s+month\b|\bmonthly\s+payments?\s+(?:be|run)\b/i;
const FINANCING_ONLY_RX = /\b(?:financ\w*|payment\s+plans?)\b/i;

export const DECLINE_RX = /\b(?:no\s+thanks?|no\s+thank\s+you|not\s+interested|leave\s+me\s+alone|good\s*bye|bye|never\s*mind|nevermind|(?:don'?t|do\s+not|dont)\s+(?:come|need|want|bother|call|text)|not\s+buying|waste\s+(?:your|my)\s+time|won'?t\s+be\s+allowed|stop\s+(?:texting|messaging|contacting)|not\s+for\s+me|no\s+time)\b/i;
const CLOSE_RX = /\b(?:good\s*bye|bye|leave\s+me\s+alone|never\s*mind|nevermind)\b/i;
const BARE_NO_RX = /^\s*(?:no|nope|nah|no\s+thanks?|not\s+really|not\s+now|no\s+sir|no\s+ma'?am|neither)\s*[.!]*\s*$/i;

// 2026-10-02 (ymnwp): "someone was supposed to come to my house today" is a
// missed visit and goes to a person; the bot pitched a measurement instead.
const COMPLAINT_RX = /\b(?:supposed\s+to\s+(?:come|show|be\s+(?:here|there)|call|arrive)|never\s+(?:came|showed(?:\s+up)?|arrived|called(?:\s+(?:me\s+)?back)?)|(?:didn'?t|did\s+not)\s+(?:come|show(?:\s+up)?|arrive|call(?:\s+(?:me\s+)?back)?)|stood\s+(?:me|us)\s+up|waited\s+all\s+(?:day|morning|afternoon)|(?:nobody|no\s+one|no-one)\s+(?:showed|came|called|answered)|complain\w*|ripped\s+off|rip[-\s]?off|scam\w*|refund|lawyer|attorney|sue\b|bbb|better\s+business|manager|supervisor|no[-\s]?show(?:ed)?|never\s+showed|(?:nobody|no\s+one)\s+(?:came|showed|called|answered)|unprofessional|rude|terrible\s+service|worst)\b/i;

const SPOUSE_RX = /\b(?:wife|husband|spouse|partner|fianc[ée]e?)\b/i;
const SPOUSE_OBJECTION_RX = /\b(?:talk|check|ask|discuss|run\s+(?:it|this))\b[^.?!]{0,40}\b(?:wife|husband|spouse|partner)\b|\b(?:wife|husband|spouse|partner)\b[^.?!]{0,40}\b(?:decides?|has\s+to|needs?\s+to|wants?\s+to|would\s+have\s+to|isn'?t\s+(?:here|home|sure))\b/i;
const SHOPPING_RX = /\b(?:(?:\d|two|three|four|few|couple(?:\s+of)?|multiple|other|more)\s+(?:quotes|estimates|bids|companies|contractors)|shopping\s+around|comparing|getting\s+(?:other\s+)?(?:quotes|estimates|bids))\b/i;
const THINK_RX = /\b(?:think\s+(?:it\s+over|about\s+it|on\s+it)|sleep\s+on\s+it|get\s+back\s+to\s+you|let\s+me\s+(?:think|see|check)|maybe\s+later|not\s+(?:right\s+)?now|need\s+(?:some\s+)?time)\b/i;
const YES_RX = /^\s*(?:y(?:es|eah|ep|up)|sure|ok(?:ay)?|sounds\s+good|that\s+works|please|absolutely|definitely|why\s+not|let'?s\s+do\s+it|i'?d\s+like\s+that)\b/i;
const NEITHER_RX = /\b(?:neither|none\s+of\s+(?:those|them)|(?:those|that)\s+(?:times?\s+)?(?:don'?t|won'?t|doesn'?t)\s+work|can'?t\s+do\s+(?:either|those|that)|not\s+(?:those|that)\s+(?:days?|times?))\b/i;
const DAY_OR_TIME_RX = /\b(?:mon|tues?|wed(?:nes)?|thurs?|fri|sat(?:ur)?|sun)(?:day)?\b|\btomorrow\b|\btoday\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)\b|\b(?:morning|afternoon|evening)\b|\bthe\s+(?:first|second|earlier|later)\s+one\b|\beither\b/i;

// The problem in their words, for the echo and the bridge.
const PROBLEM_RX = /\b(drafty|drafts?|fogg(?:y|ing)|fogged|condensation|moisture|leak(?:s|ing|y)?|noisy|noise|hot|heat|old|ugly|stuck|sticks?|sticking|broken|cracked|rott?(?:ed|ing)?|seals?|hurricanes?|storms?|insurance|electric\s+bill|energy\s+bills?|security|break-?ins?)\b/gi;
// 2026-10-02 simulation: "My windows are old and drafty" bridged as "since you
// mentioned old". The most specific problem wins (old/ugly come last), and the
// bridge names it as a phrase, never a bare adjective.
const PROBLEM_PHRASES = [
  [/^leak/, 'the leaks'], [/^condensation$/, 'the condensation'], [/^moisture$/, 'the moisture'], [/^fog/, 'the fogging'],
  [/^draft/, 'the drafts'], [/^nois/, 'the noise'], [/^(?:hot|heat)$/, 'the heat'], [/bill/, 'the bills'],
  [/^(?:hurricane|storm)/, 'storm protection'], [/^insurance$/, 'insurance'], [/^(?:security|break)/, 'security'],
  [/^(?:stuck|stick)/, 'them sticking'], [/^broken$/, 'the broken ones'], [/^cracked$/, 'the cracks'], [/^rot/, 'the rot'], [/^seals?$/, 'the seals'],
  [/^old$/, 'how old they are'], [/^ugly$/, 'how they look'],
];
function problemRank(word) {
  const i = PROBLEM_PHRASES.findIndex(([rx]) => rx.test(word));
  return i < 0 ? PROBLEM_PHRASES.length : i;
}
/** The bridge phrase for a problem word ("drafty" → "the drafts"), or null. Pure. */
export function problemPhrase(word) {
  const w = String(word || '').toLowerCase();
  return PROBLEM_PHRASES.find(([rx]) => rx.test(w))?.[1] || null;
}

// ── what the bot already did (read from its own words) ───────────────────

// 2026-10-02 simulation: the model paraphrases the consequence question ("how's
// that been sitting with you", "if those stay as is through this season"), and
// the narrow pattern missed it, so it was asked twice. These count too.
export const CONSEQUENCE_RX = /\bwhat\s+happens\s+if\b|\bif\s+you\s+(?:wait|hold\s+off|held\s+off|put\s+(?:it|this)\s+off)\b|\banother\s+(?:hurricane\s+)?season\b|\bpush\s+(?:it|this)\s+(?:off|down\s+the\s+road)\b|\bsitting\s+with\s+you\b|\bif\s+(?:those|they|it|that|this|nothing|things)\s+(?:stays?|changes?|keeps?|goes|go|gets?\s+worse)\b|\bthrough\s+(?:this|another|the)\s+(?:hurricane\s+|storm\s+)?season\b|\baffecting\s+you\b|\bwhat\s+would\s+(?:it|that)\s+mean\s+for\s+you\b/i;
const BRIDGE_RX = /\bbased\s+on\s+what\s+you\s+(?:told|said|mentioned)\b|\bthis\s+could\s+work\s+for\s+you\b|\bthe\s+next\s+step\s+would\s+be\b/i;
const STATUS_FRAME_RX = /\bpretty\s+simple\b|\bsee\s+what\s+you\s+have\s+now\b|\bif\s+it\s+might\s+be\s+a\s+fit\b/i;
const REVEAL_RX = /\banything\s+you'?re\s+wondering\s+about\b|\bbefore\s+your\s+visit\b/i;
const SLOT_OFFER_RX = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b[^?]{0,80}\bor\b|\bI\s+have\s+[^?]{0,80}\bor\b[^?]*\?/i;
const CONTACT_ASK_RX = /\b(?:phone|number|first\s+name|your\s+name|email|e-mail|zip|address)\b/i;
const DM_ASK_RX = /\b(?:decision|anyone\s+else|both\s+(?:of\s+you|home|there)|weigh\s+in|spouse|wife|husband|partner)\b/i;

// ── the owner's lines (Mark, 2026-10-02), run through the voice rules ────

export const LINES = Object.freeze({
  status_frame: "This is pretty simple. I just want to see what you have now and what you're hoping for, and if it might be a fit we can talk about next steps. Would that help?",
  price_play: "Totally fair. Every home is different, so any number I gave you now would be a guess. What are you hoping to see, so the estimate actually fits your home?",
  spouse_1: 'Makes sense. How does your spouse feel about getting this done?',
  spouse_2_slots: (slots) => `Would it be easier to pick a time when you're both home? I have ${slotPair(slots)}.`,
  spouse_2_no_slots: "Would it be easier to pick a time when you're both home? What day works best for you both?",
  shopping: "Smart move. Let's say everyone checks every box, price included. How would you decide?",
  think_slots: (slots) => `No problem at all. Want to grab a time now so you don't have to chase us down later? I have ${slotPair(slots)}.`,
  think_no_slots: "No problem at all. What day would work best if you did want someone to come out, so you don't have to chase us down later?",
  not_interested: (name) => `No problem${name ? `, ${name}` : ''}. What changed?`,
  ask_day: 'No problem. What day works best for you?',
  close: "Understood. Take care, and if anything changes, we're here.",
  offer_slots: (slots) => `I have ${slotPair(slots)}. Which works better?`,
  financing_yes: 'Yes, we offer financing. The details depend on your home, and our team walks you through them.',
  reveal: "Before your visit, is there anything you're wondering about that I can pass along?",
  confirm: (slot, tz, name) => `You're set for ${slot.day} at ${slot.time}${tz ? ` ${tz}` : ''}${name ? `, ${name}` : ''}. Our team will call to go over the details.`,
  handoff: {
    complaint: "I'm sorry about that. I'm getting someone from our team on this now.",
    price_insist: "Understood. I'll have someone from our team call you to talk it through.",
    two_nos: "No problem, I'll stop here. Someone from our team will check in with you directly.",
    repeat_objection: "Understood. I'll have someone from our team call you so you get a straight answer.",
  },
});

function slotPair(slots = []) {
  const s = slots.slice(0, 2).map(x => `${x.day} at ${x.time}${x.tz ? ` ${x.tz}` : ''}`);
  return s.length === 2 ? `${s[0]} or ${s[1]}` : (s[0] || '');
}

// ── helpers ─────────────────────────────────────────────────────────────

function splitSentences(text) {
  return String(text || '').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
}

// A visitor back after this long starts a new visit (2026-10-02, ymnwp: a
// "hello" 34 hours later got the bridge, because yesterday's three questions
// still counted toward the discovery cap).
export const SESSION_GAP_MS = 6 * 3600 * 1000;

/** The turns of the current visit: everything after the last gap longer than SESSION_GAP_MS. Pure. */
export function currentSession(conversation = [], gapMs = SESSION_GAP_MS) {
  const list = Array.isArray(conversation) ? conversation : [];
  const at = (m) => Date.parse(m?.timestamp || m?.sent_at || m?.dateAdded || m?.created_at || '');
  let start = 0;
  for (let i = 1; i < list.length; i++) {
    const a = at(list[i - 1]);
    const b = at(list[i]);
    if (Number.isFinite(a) && Number.isFinite(b) && b - a > gapMs) start = i;
  }
  return list.slice(start);
}

function normalizeThread(conversation, trigger) {
  const turns = currentSession(conversation)
    .map(m => ({ direction: String(m?.direction || '').toLowerCase() === 'outbound' ? 'outbound' : 'inbound', text: String(m?.text ?? m?.body ?? '') }))
    .filter(m => m.text.trim());
  const last = turns[turns.length - 1];
  if (trigger && !(last && last.direction === 'inbound' && last.text === trigger)) turns.push({ direction: 'inbound', text: String(trigger) });
  return turns;
}

/** Is this inbound a price or figure ask? Plain "do you offer financing?" is not. Pure. */
export function isPriceAsk(text) {
  const t = String(text || '');
  if (MONEY_FIGURE_ASK_RX.test(t)) return true;
  if (FINANCING_ONLY_RX.test(t) && !/\bhow\s+much\b/i.test(t)) return false;
  return PRICE_RX.test(t) || INSIST_RX.test(t);
}

/** A "no" for the two-no's rule. A no to a discovery question does not count. Pure. */
export function isNo(text, lastOutbound = '') {
  const t = String(text || '');
  if (DECLINE_RX.test(t) || isNotInterested(t)) return true;
  if (!BARE_NO_RX.test(t)) return false;
  // A bare "no" counts only when it answers an offer or a next step.
  return BRIDGE_RX.test(lastOutbound) || SLOT_OFFER_RX.test(lastOutbound) || /\bwould\s+that\s+help\b|\bgrab\s+a\s+time\b|\bpick\s+a\s+time\b|\bvisit\b|\bset\s+(?:it|that|a\s+time)\s+up\b/i.test(lastOutbound) || /\bwhat\s+changed\b/i.test(lastOutbound);
}

// The shopping play's question. The reply to it names what they decide on
// ("probably price and the warranty"): that is an answer, not a price ask
// (2026-10-02 simulation: it fired the price play, and the next "price"
// would have handed the lead to a person).
const SPOUSE_FEEL_Q_RX = /\bhow\s+does\s+your\s+(?:spouse|wife|husband|partner)\s+feel\b/i;
const DECIDE_Q_RX = /\bhow\s+would\s+you\s+(?:then\s+)?decide\b/i;
// Price named alongside other criteria is a list of what matters, not an ask.
const CRITERIA_LIST_RX = /\b(?:price|pricing|cost)\b[^.?!]{0,30}\b(?:and|or|plus|&)\b[^.?!]{0,30}\b(?:warranty|quality|reviews?|service|install\w*|reputation|brand|company|timeline|product)\b|\b(?:warranty|quality|reviews?|service|install\w*|reputation|brand|company|timeline|product)\b[^.?!]{0,30}\b(?:and|or|plus|&)\b[^.?!]{0,30}\b(?:price|pricing|cost)\b/i;
// A day AND a time of day the lead typed ("tomorrow evening 6 pm", "Saturday
// morning"): a booking request even when we never offered times (2026-10-02
// simulation: a live-chat visitor's "tomorrow evening 6 pm" was ignored).
const DAY_WORD = String.raw`(?:today|tonight|tomorrow|tmrw|this\s+(?:weekend|week)|(?:mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?|sun)(?:day)?)`;
const TIME_WORD = String.raw`(?:\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)|morning|afternoon|evening|night|noon)`;
export const TIME_REQUEST_RX = new RegExp(String.raw`\b${DAY_WORD}\b[^.?!]{0,30}\b${TIME_WORD}|\b${TIME_WORD}\b[^.?!]{0,30}\b${DAY_WORD}\b|\btonight\b`, 'i');

/** Did the lead answer the shopping play's "how would you decide?". Pure. */
export function isCriteriaReply(text, lastOutbound = '') {
  const t = String(text || '');
  // "Still comparing companies" after the play is the same objection again.
  return DECIDE_Q_RX.test(String(lastOutbound || '')) && !SHOPPING_RX.test(t) && !INSIST_RX.test(t) && !/\bhow\s+much\b/i.test(t);
}

/** The objection family in this text, or null. Pure. */
export function objectionType(text, lastOutbound = '') {
  const t = String(text || '');
  if (isCriteriaReply(t, lastOutbound)) return null;
  if (CRITERIA_LIST_RX.test(t) && !INSIST_RX.test(t) && !/\bhow\s+much\b/i.test(t)) return null;
  // Shopping before price: "getting 3 quotes" is about deciding, not a price ask.
  if (SHOPPING_RX.test(t)) return 'shopping';
  if (isPriceAsk(t)) return 'price';
  // The answer to Mark's spouse question is the spouse objection's second
  // turn, whoever it names (2026-10-02 re-test: "She has to see it before we
  // decide" read as discovery, the both-home time was stripped as a booking
  // ask, and the visitor got "Got it." alone).
  if (SPOUSE_FEEL_Q_RX.test(String(lastOutbound || '')) && !isNotInterested(t) && !DECLINE_RX.test(t)) return 'spouse';
  if (SPOUSE_OBJECTION_RX.test(t)) return 'spouse';
  if (THINK_RX.test(t)) return 'think';
  return null;
}

/** Discovery questions the bot asked: "?" sentences that are not booking, contact or decision-maker asks. Pure. */
export function discoveryQuestions(outbound = []) {
  return outbound.flatMap(m => splitSentences(m.text))
    .filter(s => s.includes('?'))
    .filter(s => !findBookingAsks(s).length && !CONTACT_ASK_RX.test(s) && !DM_ASK_RX.test(s) && !SLOT_OFFER_RX.test(s) && !REVEAL_RX.test(s) && !STATUS_FRAME_RX.test(s));
}

/** The lead's problem word: the newest message that names one, its most specific word. Pure. */
export function problemEcho(inbound = []) {
  for (let i = inbound.length - 1; i >= 0; i--) {
    const words = [...String(inbound[i].text || '').matchAll(PROBLEM_RX)].map(m => m[1].toLowerCase());
    if (words.length) return words.sort((a, b) => problemRank(a) - problemRank(b))[0];
  }
  return null;
}

/**
 * Plan this turn.
 *
 * @param {object} a
 * @param {'sms'|'livechat'} a.channel
 * @param {string} a.trigger              the lead's newest message
 * @param {Array} a.conversation          thread, oldest first ({direction, text})
 * @param {Array} [a.slots]               real offerable slots [{iso, day, time}]
 * @param {string} [a.tzLabel]
 * @param {string|null} [a.firstName]     a REAL first name, or null
 * @param {boolean} [a.hasAppointment]    an active appointment is on file
 * @param {string} [a.nextStepLabel]      what the visit is called ("a visit at your home")
 * @param {object} [a.discipline]         buildDiscipline() output, for the booking default
 */
export function planNepqTurn({
  channel = 'sms', trigger = '', conversation = [], slots = [], tzLabel = '', firstName = null,
  hasAppointment = false, nextStepLabel = 'a visit at your home', discipline = null,
} = {}) {
  const turns = normalizeThread(conversation, trigger);
  const inbound = turns.filter(t => t.direction === 'inbound');
  const outbound = turns.filter(t => t.direction === 'outbound');
  const lastOut = outbound[outbound.length - 1]?.text || '';
  const now = String(trigger || inbound[inbound.length - 1]?.text || '');
  const offerSlots = (Array.isArray(slots) ? slots : []).slice(0, 2).map(s => ({ ...s, tz: s.tz || tzLabel || '' }));

  // Counters, from the thread.
  let nos = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.direction !== 'inbound') continue;
    const prevOut = [...turns.slice(0, i)].reverse().find(x => x.direction === 'outbound')?.text || '';
    if (isNo(t.text, prevOut)) nos++;
    else break;
  }
  // Each inbound read against the bot message before it.
  const prevOutOf = (i) => [...turns.slice(0, i)].reverse().find(x => x.direction === 'outbound')?.text || '';
  const inboundTypes = turns.map((t, i) => (t.direction === 'inbound' ? objectionType(t.text, prevOutOf(i)) : undefined)).filter(x => x !== undefined);
  const priceAsks = inboundTypes.filter(x => x === 'price').length;
  const pricePlayed = outbound.some(m => /every\s+home\s+is\s+different|any\s+number\s+i\s+gave/i.test(m.text));
  const counters = {
    nos_in_a_row: nos,
    price_asks: priceAsks,
    discovery_questions_asked: discoveryQuestions(outbound).length,
    consequence_used: outbound.some(m => CONSEQUENCE_RX.test(m.text)),
    bridge_used: outbound.some(m => BRIDGE_RX.test(m.text)),
    slot_offers: outbound.filter(m => SLOT_OFFER_RX.test(m.text)).length,
    status_frame_used: outbound.some(m => STATUS_FRAME_RX.test(m.text)),
    reveal_used: outbound.some(m => REVEAL_RX.test(m.text)),
  };
  const cap = channel === 'livechat' ? 2 : 3;
  const echoWord = problemEcho(inbound);
  const objType = objectionType(now, lastOut);
  const attempt = objType ? inboundTypes.filter(x => x === objType).length : 0;
  // Everything the lead sent since our last message (a live-chat burst).
  const lastOutIdx = turns.map(t => t.direction).lastIndexOf('outbound');
  const pending = turns.slice(lastOutIdx + 1).filter(t => t.direction === 'inbound').map(t => t.text);
  const timeRequest = !SLOT_OFFER_RX.test(lastOut) ? (pending.find(t => TIME_REQUEST_RX.test(t)) || null) : null;

  const plan = {
    version: NEPQ_PLANNER_VERSION,
    channel,
    step: 'discover',
    required_move: 'probe',
    booking: { allowed: discipline?.booking?.allowed ?? true, reason: discipline?.booking?.reason || 'default' },
    allowed: { consequence: false, dm_question: false, slot_offer: false },
    objection: objType ? { type: objType, attempt, line: null } : null,
    handoff: null,
    echo: { word: echoWord },
    counters,
    slots_to_offer: [],
    fixed_line: null,
    discovery_cap: cap,
    next_step_label: nextStepLabel,
    // "Do you offer financing?" must still get its yes after the money strip.
    financing_ask: FINANCING_ONLY_RX.test(now) && !isPriceAsk(now),
    criteria_reply: isCriteriaReply(now, lastOut),
    time_request: timeRequest,
    answer_first: false,
  };
  plan.echo.phrase = problemPhrase(echoWord);
  const fixed = (move, line, extra = {}) => Object.assign(plan, { required_move: move, fixed_line: line }, extra);
  const handoff = (reason) => fixed('handoff', LINES.handoff[reason], { step: 'handoff', handoff: { reason, line: LINES.handoff[reason] }, booking: { allowed: false, reason: `nepq:handoff_${reason}` } });
  const withSlots = (line) => { plan.slots_to_offer = offerSlots; plan.allowed.slot_offer = true; plan.booking = { allowed: true, reason: 'nepq:slot_offer' }; return line; };

  // 1. A person takes over: complaint, price insisted after the play, two no's.
  if (COMPLAINT_RX.test(now)) return handoff('complaint');
  if (objType === 'price' && (pricePlayed || priceAsks >= 2)) return handoff('price_insist');
  if (nos >= 2) return handoff('two_nos');
  if ((objType === 'shopping') && attempt >= 2) return handoff('repeat_objection');

  // 2. A first "no". To our two times → ask for a day. A goodbye → a warm
  // close with no question. Not interested / don't come → ONE question.
  if (nos === 1 && SLOT_OFFER_RX.test(lastOut) && !isNotInterested(now)) {
    return fixed('ask_day', LINES.ask_day, { step: 'ask_day', booking: { allowed: true, reason: 'nepq:ask_day' } });
  }
  if (CLOSE_RX.test(now)) {
    return fixed('close', LINES.close, { step: 'close', booking: { allowed: false, reason: 'nepq:close' } });
  }
  if (isNotInterested(now) || (DECLINE_RX.test(now) && nos === 1)) {
    return fixed('objection_play', LINES.not_interested(firstName), { step: 'not_interested', objection: { type: 'not_interested', attempt: 1, line: LINES.not_interested(firstName) }, booking: { allowed: false, reason: 'nepq:not_interested' } });
  }

  // 3. Already booked: the Reveal once, otherwise just answer.
  if (hasAppointment) {
    if (!counters.reveal_used && !isLeadQuestion(now)) return fixed('reveal', LINES.reveal, { step: 'booked', booking: { allowed: false, reason: 'nepq:booked' } });
    return Object.assign(plan, { step: 'booked', required_move: 'answer', booking: { allowed: false, reason: 'nepq:booked' } });
  }

  // 4. Objection plays (Mark's wording).
  if (objType === 'price') return fixed('objection_play', LINES.price_play, { objection: { type: 'price', attempt, line: LINES.price_play }, booking: { allowed: false, reason: 'nepq:price_clarify' } });
  if (objType === 'spouse') {
    if (attempt >= 2) {
      const line = offerSlots.length === 2 ? withSlots(LINES.spouse_2_slots(offerSlots)) : LINES.spouse_2_no_slots;
      return fixed('objection_play', line, { objection: { type: 'spouse', attempt, line } });
    }
    return fixed('objection_play', LINES.spouse_1, { objection: { type: 'spouse', attempt, line: LINES.spouse_1 }, booking: { allowed: false, reason: 'nepq:spouse_feel' } });
  }
  if (objType === 'shopping') return fixed('objection_play', LINES.shopping, { objection: { type: 'shopping', attempt, line: LINES.shopping }, booking: { allowed: false, reason: 'nepq:decider' } });
  if (objType === 'think') {
    // The Calendar Commitment. Exempt from the booking-ask cap: it is the one
    // booking ask NEPQ wants here (the review found it stripped).
    const line = offerSlots.length === 2 ? withSlots(LINES.think_slots(offerSlots)) : LINES.think_no_slots;
    return fixed('objection_play', line, { objection: { type: 'think', attempt, line } });
  }

  // 4b. They typed a day and a time with no offer on the table: two real
  // times near it. A question in the same burst is answered first.
  if (timeRequest) {
    const asked = isLeadQuestion(now) && !TIME_REQUEST_RX.test(now);
    if (offerSlots.length === 2 && !asked) return fixed('offer_slots', withSlots(LINES.offer_slots(offerSlots)), { step: 'offer_slots' });
    if (offerSlots.length === 2) {
      withSlots(null);
      return Object.assign(plan, { step: 'offer_slots', required_move: 'offer_slots', answer_first: true, offer_line: LINES.offer_slots(offerSlots) });
    }
    return Object.assign(plan, { step: 'offer_slots', required_move: asked ? 'answer' : 'offer_slots', booking: { allowed: true, reason: 'nepq:time_request' } });
  }
  // 4c. They answered "how would you decide?": speak to it, then the bridge.
  if (plan.criteria_reply) {
    return Object.assign(plan, { step: 'bridge', required_move: 'answer', booking: { allowed: false, reason: 'nepq:criteria' } });
  }

  // 5. Answering our slot offer.
  if (SLOT_OFFER_RX.test(lastOut)) {
    if (NEITHER_RX.test(now)) return fixed('ask_day', LINES.ask_day, { step: 'ask_day', booking: { allowed: true, reason: 'nepq:ask_day' } });
    if (DAY_OR_TIME_RX.test(now) || YES_RX.test(now)) return Object.assign(plan, { step: 'confirm', required_move: 'confirm', booking: { allowed: true, reason: 'nepq:confirm' } });
  }
  // They named a day after "what day works best?": offer two times that day.
  if (/\bwhat\s+day\s+works\s+best\b/i.test(lastOut) && DAY_OR_TIME_RX.test(now)) {
    if (offerSlots.length === 2) return fixed('offer_slots', withSlots(LINES.offer_slots(offerSlots)), { step: 'offer_slots' });
    return Object.assign(plan, { step: 'offer_slots', required_move: 'offer_slots', booking: { allowed: true, reason: 'nepq:offer_slots' } });
  }

  // 5b. They are ready (asked to schedule, answered a prerequisite or the
  // decision-maker question, stated a deadline): no more discovery. NEPQ
  // stops asking once the lead has done their own convincing.
  const READY = /^(?:lead_asked_about_scheduling|lead_answered_booking_prerequisite|lead_answered_decision_maker_ask|urgent_deadline_stated|recommended_action:)/;
  if (discipline?.booking?.allowed && READY.test(String(discipline.booking.reason || ''))) {
    if (offerSlots.length === 2 && !isLeadQuestion(now)) return fixed('offer_slots', withSlots(LINES.offer_slots(offerSlots)), { step: 'offer_slots' });
    return Object.assign(plan, { step: 'offer_slots', required_move: isLeadQuestion(now) ? 'answer' : 'offer_slots', booking: { allowed: true, reason: discipline.booking.reason } });
  }

  // 6. They asked us something: answer it first (one question after, at most).
  if (isLeadQuestion(now)) {
    plan.required_move = 'answer';
    plan.allowed.consequence = false;
    return plan;
  }

  // 7. Said yes to the bridge → two real times.
  if (BRIDGE_RX.test(lastOut) && YES_RX.test(now)) {
    if (offerSlots.length === 2) return fixed('offer_slots', withSlots(LINES.offer_slots(offerSlots)), { step: 'offer_slots' });
    return Object.assign(plan, { step: 'offer_slots', required_move: 'offer_slots', booking: { allowed: true, reason: 'nepq:offer_slots' } });
  }

  // 8. Discovery, short: probe in their words, one consequence question, then bridge.
  if (counters.discovery_questions_asked >= cap && !counters.bridge_used) {
    return Object.assign(plan, { step: 'bridge', required_move: 'bridge', booking: { allowed: false, reason: 'nepq:bridge_first' } });
  }
  if (counters.bridge_used) {
    // Bridged already and they did not say yes: answer and keep it soft.
    plan.required_move = 'answer';
    return plan;
  }
  if (!outbound.length) plan.step = 'open';
  plan.allowed.consequence = !!echoWord && !counters.consequence_used && counters.discovery_questions_asked >= 1;
  plan.required_move = plan.allowed.consequence ? 'consequence' : 'probe';
  plan.booking = { allowed: false, reason: 'nepq:discover_first' };
  return plan;
}

// ── the code guard: the plan, enforced on the draft ───────────────────────

// Money in chat (Mark, 2026-10-02: never prices, savings or financing
// figures). The live chat sent "$89–$149 per month, no money down" — that
// sentence goes, whatever its source.
const MONEY_RX = /\$\s?\d|\b\d[\d,]*\s*(?:dollars|bucks)\b|\b(?:per|a)\s+month\b|\/\s?mo\b|\bmonthly\s+payments?\b|\bno\s+money\s+down\b|\b0\s?%|\bapr\b|\b\d+\s?%\s+off\b|\bsave\s+(?:up\s+to\s+)?\d/i;
const URGENCY_RX = /\bonly\s+\d+\s+(?:spots?|slots?|openings?)\s+left\b|\bspots?\s+(?:are\s+)?filling\b|\bprices?\s+(?:are\s+)?going\s+up\b|\bact\s+(?:now|fast)\b|\blimited\s+time\b|\bbefore\s+(?:it'?s|its)\s+too\s+late\b|\bdon'?t\s+miss\b/i;
// Claims nobody approved (2026-10-02 simulation: "that's right at the edge of
// when Florida code tightened up", "with us at the peak of hurricane season").
// Code history and season-peak talk are pressure dressed as fact.
const CLAIMS_RX = /\bcode\s+(?:changed|tightened|got\s+(?:stricter|tighter)|was\s+(?:updated|changed))\b|\b(?:after|since|before)\s+(?:the\s+)?(?:19|20)\d\d\b[^.?!]{0,40}\bcode\b|\bcode\b[^.?!]{0,40}\b(?:after|since|before)\s+(?:19|20)\d\d\b|\bpeak\s+of\s+(?:the\s+)?(?:hurricane|storm)\s+season\b|\bmost\s+active\s+(?:stretch|part|time)\b/i;
const SEE_YOU_RX = /\bsee\s+you\s+(?:then|soon|there)\b/i;
const SIGNOFF_RX = /(?:^|\s)([—–-]\s*[A-Z][A-Za-z.'’ ]{0,40})\s*$/;
const FIXED_MOVES = new Set(['handoff', 'objection_play', 'ask_day', 'close', 'reveal', 'offer_slots']);
const NO_FIGURES_LINE = 'Exact numbers come from the visit, since every home is different.';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const ASK_FIELD_RX = {
  name: /\b(?:your|first|full)\s+name\b|\bwho\s+(?:am\s+i|i'?m)\s+(?:speaking|talking)\s+(?:to|with)\b/i,
  phone: /\b(?:phone|cell)(?:\s+number)?\b|\bbest\s+number\b|\bnumber\s+to\s+(?:reach|call)\b/i,
  email: /\be-?mail\b/i,
  zip: /\bzip(?:\s*code)?\b/i,
};

/** Does this question ask for a field we already have? Pure. */
export function asksForKnown(sentence, known = {}) {
  return Object.entries(ASK_FIELD_RX).some(([field, rx]) => known[field] && rx.test(sentence));
}

/** The bridge in their words, when the draft skipped it. Pure. */
export function bridgeLine(plan) {
  const phrase = plan.echo?.phrase || problemPhrase(plan.echo?.word);
  return `Based on what you told me, this could work for you${phrase ? `, since you mentioned ${phrase}` : ''}. The next step would be ${plan.next_step_label || 'a visit at your home'}. Would that help?`;
}

/**
 * Enforce a plan on a finished draft. Deterministic: no second model call.
 * @returns {{ text: string, changes: string[] }}
 */
export function enforceNepqPlan(draft, plan, { allowFigures = false, known = {} } = {}) {
  const original = String(draft || '');
  if (!plan) return { text: original, changes: [] };
  const changes = [];
  const signOff = original.match(SIGNOFF_RX);
  let body = signOff ? original.slice(0, signOff.index).trim() : original.trim();
  const withSignOff = (t) => (signOff ? `${t} ${signOff[1].trim()}` : t);

  // 1. A fixed move ships its line (the model's wording is not trusted here).
  if (plan.fixed_line && FIXED_MOVES.has(plan.required_move)) {
    if (norm(body) !== norm(plan.fixed_line)) changes.push(`fixed_line:${plan.required_move}`);
    return { text: withSignOff(plan.fixed_line), changes };
  }

  let sentences = splitSentences(body);
  const drop = (pred, tag) => {
    const before = sentences.length;
    sentences = sentences.filter(s => !pred(s));
    if (sentences.length !== before) changes.push(tag);
  };
  // 2. No money, no pressure.
  if (!allowFigures) drop(s => MONEY_RX.test(s), 'money_figures');
  drop(s => URGENCY_RX.test(s), 'fake_urgency');
  drop(s => CLAIMS_RX.test(s), 'unapproved_claim');
  // 2b. "Do you offer financing?" keeps its yes when the figure strip took the
  // answer sentence (2026-10-02 simulation: "Yes, we offer 0% APR financing"
  // went, and only "What's got you looking into windows now?" was left).
  if (plan.financing_ask && changes.includes('money_figures') && !sentences.some(s => /^(?:yes|yep|yeah|absolutely|we\s+(?:do|offer|have))\b/i.test(s) || /\bfinanc/i.test(s))) {
    sentences.unshift(LINES.financing_yes);
    changes.push('financing_yes');
  }
  // 2c. The consequence question once per conversation, however it is worded.
  if (plan.required_move !== 'consequence' && plan.counters?.consequence_used) drop(s => s.includes('?') && CONSEQUENCE_RX.test(s), 'consequence_repeat');
  // 3. No booking ask the plan does not allow.
  if (!plan.booking?.allowed) {
    const asks = new Set(findBookingAsks(sentences.join(' ')));
    drop(s => asks.has(s), 'booking_ask');
  }
  // 4. Never "see you then", never a final-sounding confirmation.
  drop(s => SEE_YOU_RX.test(s), 'see_you_then');
  // 4b. Never ask for what we already have (2026-10-02 review: the live chat
  // re-asked for a first name the visitor had typed). A question that asks
  // for a known name, phone, email or zip goes.
  drop(s => s.includes('?') && asksForKnown(s, known), 'reask_known');
  // 5. One question: keep the last one.
  const questions = sentences.filter(s => s.includes('?'));
  if (questions.length > 1) {
    const keep = questions[questions.length - 1];
    sentences = sentences.filter(s => !s.includes('?') || s === keep);
    changes.push('one_question');
  }
  body = sentences.join(' ').trim();

  // 5b. A time they typed, with a question in the same burst: the answer, then
  // the two real times verbatim (the model's own times never survive).
  if (plan.required_move === 'offer_slots' && plan.offer_line && !body.includes(plan.offer_line)) {
    body = [...sentences.filter(s => !s.includes('?') && !SLOT_OFFER_RX.test(s) && !/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i.test(s)), plan.offer_line].join(' ').trim();
    changes.push('offer_line');
  }

  // 6. The required move, when the draft skipped it.
  if (plan.required_move === 'bridge' && !BRIDGE_RX.test(body)) {
    body = bridgeLine(plan);
    changes.push('bridge');
  }
  if (!body) {
    body = changes.includes('money_figures') ? NO_FIGURES_LINE
      : (changes.includes('consequence_repeat') || changes.includes('unapproved_claim')) ? bridgeLine(plan)
        : (original.trim() || NO_FIGURES_LINE);
  }
  return { text: changes.length ? withSignOff(body) : original, changes };
}
