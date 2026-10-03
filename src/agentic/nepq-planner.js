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
import { isTeamOpen, nextTeamOpenLabel, requestedCallTime } from './team-hours.js';
import { heldSlot, COLLECT_ASK } from './booking-collect.js';
import { RECHECK_RX } from './contact-check.js';
import { slotMentionIndex } from '../live-chat/cancel-flow.js';
import { parseDayPreference, slotsForPreference, slotMatches, preferenceOfferLine } from './day-preference.js';
import { enforceOneAsk } from './one-ask.js';

export const NEPQ_PLANNER_VERSION = '1.0';

/** off | shadow | live. Anything else is off. */
export function nepqBackboneMode(env = process.env) {
  const v = String(env.NEPQ_BACKBONE_MODE || 'off').trim().toLowerCase();
  return v === 'live' || v === 'shadow' ? v : 'off';
}

// ── signals in the lead's words ──────────────────────────────────────────

// The lead would rather talk than have a visit: the 15-minute call is the
// backup (Mark, 2026-10-02: "Home visit for everyone. Use the call as a back
// up or secondary option").
export const VISIT_DECLINE_RX = /\b(?:just\s+)?call\s+me\s+instead\b|\brather\s+(?:do|have|get|just\s+do)\s+a\s+(?:phone\s+)?call\b|\bover\s+the\s+phone\b|\bon\s+the\s+phone\s+(?:instead|first)\b|\bphone\s+call\s+(?:instead|first|only)\b|\b(?:don'?t|do\s+not)\s+want\s+(?:anyone|someone|somebody|people|a\s+visit|a\s+rep|a\s+salesman)\b|\bno\s+(?:home\s+)?visits?\b/i;
/** Did the lead, anywhere in this conversation, ask for a call instead of a visit? Pure. */
export function prefersCall(conversation = [], trigger = '') {
  const texts = (Array.isArray(conversation) ? conversation : [])
    .filter(m => String(m?.direction || '').toLowerCase() !== 'outbound').map(m => String(m?.text ?? m?.body ?? ''));
  return [...texts, String(trigger || '')].some(t => VISIT_DECLINE_RX.test(t));
}

// "I want to schedule an estimate": a booking request, not a price ask
// (2026-10-02: it got the quote line). Two real times, no discovery needed.
// 2026-10-02 (Mark's test chat): "you're not able to set up a time now?" is a
// schedule ask too.
export const SCHEDULE_ASK_RX = /\b(?:schedule|book|set\s+up|make|get)\s+(?:an?\s+|the\s+|my\s+)?(?:free\s+|in[-\s]home\s+)?(?:estimate|appointment|consultation|visit|measure(?:ment)?|assessment)\b|\b(?:can|could)\s+(?:someone|you|somebody)\s+come\s+(?:out|by|over)\b|\bset\s+up\s+(?:a\s+)?time\b|\bset\s+(?:it|one|that)\s+up\b|\b(?:book|schedule)\s+(?:it|me|that|one|a\s+time|something)\b|\b(?:pick|grab|lock\s+in)\s+a\s+time\b/i;
export const PRICE_RX = /\b(?:how\s+much|price[sd]?|pricing|costs?|quotes?|estimates?|ballpark|rough\s+(?:number|idea|figure)|what\s+(?:would|does|will)\s+(?:it|that|this)\s+(?:cost|run))\b/i;
export const INSIST_RX = /\b(?:just|only)\s+(?:want|need)\s+(?:a|the|to\s+(?:get|know)(?:\s+(?:a|the))?)\s+(?:price|quote|number|cost|estimate)\b|\b(?:give|tell|send|text)\s+me\s+(?:a|the|your)\s+(?:price|number|quote|ballpark|figure|estimate)\b/i;
// "how much a month" asks for a figure; "do you offer financing?" does not.
const MONEY_FIGURE_ASK_RX = /\bhow\s+much\b[^?]{0,30}\b(?:a|per)\s+month\b|\bmonthly\s+payments?\s+(?:be|run)\b/i;
const FINANCING_ONLY_RX = /\b(?:financ\w*|payment\s+plans?)\b/i;

export const DECLINE_RX = /\b(?:no\s+thanks?|no\s+thank\s+you|not\s+interested|leave\s+me\s+alone|good\s*bye|bye|never\s*mind|nevermind|(?:don'?t|do\s+not|dont)\s+(?:come|need|want|bother|call|text)|not\s+buying|waste\s+(?:your|my)\s+time|won'?t\s+be\s+allowed|stop\s+(?:texting|messaging|contacting)|not\s+for\s+me|no\s+time)\b/i;
// 2026-10-02 break test: "f*** off" got two appointment times. Abuse closes.
const CLOSE_RX = /\b(?:good\s*bye|bye|leave\s+me\s+alone|never\s*mind|nevermind|go\s+away|get\s+lost|piss\s+off|shut\s+up)\b|\bf[\W_]*(?:u|\*)[\W_]*(?:c|\*)[\W_]*(?:k|\*)\w*\s+(?:off|you|u)\b|\bf\*+\s*(?:off|you)\b/i;
const BARE_NO_RX = /^\s*(?:no|nope|nah|no\s+thanks?|not\s+really|not\s+now|no\s+sir|no\s+ma'?am|neither)\s*[.!]*\s*$/i;

// 2026-10-02 (ymnwp): "someone was supposed to come to my house today" is a
// missed visit and goes to a person; the bot pitched a measurement instead.
// 2026-10-02 break test: "a storm broke my window and water is coming in"
// got a probing question. Damage happening now goes straight to a person.
const EMERGENCY_RX = /\bwater\s+(?:is\s+)?(?:coming|pouring|leaking|getting)\s+in\b|\b(?:broke|broken|shattered|smashed|cracked)\s+(?:my\s+|the\s+|a\s+)?(?:window|glass|door|slider)s?\b|\b(?:window|glass|door)\s+(?:is\s+|got\s+)?(?:broken|shattered|smashed)\b|\bemergency\b/i;
// An existing customer's problem with OUR install is service, not a sale.
// 2026-10-02 live chat (SX5uWUrpn2m8mCjkF5SJ): "I have not received my referral
// fee that was promised" is an existing customer owed money: a person, not a pitch.
const SERVICE_RX = /\b(?:you|you\s+guys|reece|your\s+(?:team|crew|company|installers?))\s+(?:installed|put\s+in|replaced|did)\b[^.?!]{0,80}\b(?:leak\w*|broken|crack\w*|won'?t|doesn'?t|not\s+(?:working|closing|opening|locking|sealing)|problem|issue|stuck|draft\w*|fogg\w*)\b|\bwarranty\s+(?:claim|issue|repair|work)\b|\b(?:needs?|need\s+a)\s+(?:a\s+)?(?:repair|service\s+call)\b|\b(?:referral|refund|rebate|reward|bonus|deposit)\b[^.?!]{0,80}\b(?:not\s+(?:been\s+)?(?:received|gotten|paid)|never\s+(?:received|got|paid|came)|haven'?t\s+(?:received|gotten|been\s+paid|seen))\b|\b(?:have\s+not|has\s+not|haven'?t|hasn'?t|never|did\s+not|didn'?t)\s+(?:received?|gotten|got|been\s+paid)\b[^.?!]{0,60}\b(?:referral|refund|rebate|reward|bonus|deposit)\b/i;
// "Just call me at 5pm" is a call request, not a visit (2026-10-02 break test:
// it got two visit times on another day).
const CALLBACK_RX = /\b(?:call|ring|phone)\s+(?:me|us)\b[^.?!]{0,30}\b(?:at|around|after|before|tomorrow|today|tonight|this\s+(?:morning|afternoon|evening)|in\s+the\s+(?:morning|afternoon|evening)|anytime|any\s+time)\b|\b(?:call\s+me\s+back|give\s+me\s+a\s+call|have\s+someone\s+call\s+me)\b/i;
const COMPLAINT_RX = /\b(?:supposed\s+to\s+(?:come|show|be\s+(?:here|there)|call|arrive)|never\s+(?:came|showed(?:\s+up)?|arrived|called(?:\s+(?:me\s+)?back)?)|(?:didn'?t|did\s+not)\s+(?:come|show(?:\s+up)?|arrive|call(?:\s+(?:me\s+)?back)?)|stood\s+(?:me|us)\s+up|waited\s+all\s+(?:day|morning|afternoon)|(?:nobody|no\s+one|no-one)\s+(?:showed|came|called|answered)|complain\w*|ripped\s+off|rip[-\s]?off|scam\w*|refund|lawyer|attorney|sue\b|bbb|better\s+business|manager|supervisor|no[-\s]?show(?:ed)?|never\s+showed|(?:nobody|no\s+one)\s+(?:came|showed|called|answered)|unprofessional|rude|terrible\s+service|worst)\b/i;

const SPOUSE_RX = /\b(?:wife|husband|spouse|partner|fianc[ée]e?)\b/i;
const SPOUSE_OBJECTION_RX = /\b(?:talk|check|ask|discuss|run\s+(?:it|this))\b[^.?!]{0,40}\b(?:wife|husband|spouse|partner)\b|\b(?:wife|husband|spouse|partner)\b[^.?!]{0,40}\b(?:decides?|has\s+to|needs?\s+to|wants?\s+to|would\s+have\s+to|isn'?t\s+(?:here|home|sure))\b/i;
const SHOPPING_RX = /\b(?:(?:\d|two|three|four|few|couple(?:\s+of)?|multiple|other|more)\s+(?:quotes|estimates|bids|companies|contractors)|shopping\s+around|comparing|getting\s+(?:other\s+)?(?:quotes|estimates|bids))\b/i;
const THINK_RX = /\b(?:think\s+(?:it\s+over|about\s+it|on\s+it)|sleep\s+on\s+it|get\s+back\s+to\s+you|let\s+me\s+(?:think|see|check)|maybe\s+later|not\s+(?:right\s+)?now|need\s+(?:some\s+)?time)\b/i;
const YES_RX = /^\s*(?:y(?:es|eah|ep|up)|sure|ok(?:ay)?|sounds\s+good|that\s+works|please|absolutely|definitely|why\s+not|let'?s\s+do\s+it|i'?d\s+like\s+that)\b/i;
// "A team member will call you to set up a time" — wrong next to two real times.
const CALL_TO_SET_RX = /\b(?:a\s+(?:team\s+)?member(?:\s+of\s+our\s+team)?|someone(?:\s+from\s+our\s+team)?|our\s+team|we)(?:'ll|\s+will)\s+(?:give\s+you\s+a\s+)?call(?:\s+you)?\s+to\s+(?:set\s+(?:up\s+)?|schedule|book|find|pick|line\s+up)\b/i;
// A non-answer to a discovery question. "no" is not here: it is counted as a no.
const VAGUE_ANSWER_RX = /^\s*(?:idk|i\s+(?:don'?t|dont)\s+know|not\s+(?:sure|really)|dunno|no\s+idea|maybe|i\s+guess|possibly|eh+|hm+|meh|ok(?:ay)?|k|yes|yeah|yep|sure|nothing(?:\s+really)?|whatever|first|\?+)\s*[.!?]*\s*$/i;
const MAYBE_RX = /^\s*(?:maybe|i\s+guess|possibly|probably|not\s+sure|perhaps|could\s+be)\b[^?]*$/i;
/** How many of the newest inbound messages, in a row, are non-answers. Pure. */
function vagueRun(inbound = []) {
  let n = 0;
  for (let i = inbound.length - 1; i >= 0 && VAGUE_ANSWER_RX.test(String(inbound[i]?.text || '')); i--) n++;
  return n;
}
// A bare pick: "first", "2nd", "the earlier one", "either".
const BARE_PICK_RX = /^\s*(?:ok(?:ay)?,?\s+|yes,?\s+|sure,?\s+)?(?:the\s+)?(?:first|second|1st|2nd|earlier|later|either)(?:\s+one)?(?:\s+(?:works|please|is\s+good))?\s*[.!]*\s*$/i;
const NEITHER_RX = /\b(?:neither|none\s+of\s+(?:those|them)|(?:those|that)\s+(?:times?\s+)?(?:don'?t|won'?t|doesn'?t)\s+work|can'?t\s+do\s+(?:either|those|that)|not\s+(?:those|that)\s+(?:days?|times?))\b/i;
// "Wednesdays" too (Oct 2 6:12 PM chat: the plural missed this and the day ask was not read as answered).
const DAY_OR_TIME_RX = /\b(?:mon|tues?|wed(?:nes)?|thurs?|fri|sat(?:ur)?|sun)(?:day)?s?\b|\bweekends?\b|\btomorrow\b|\btoday\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)\b|\b(?:morning|afternoon|evening)\b|\bthe\s+(?:first|second|earlier|later)\s+one\b|\beither\b/i;

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
export const CONSEQUENCE_RX = /\bwhat\s+happens\s+if\b|\bif\s+you\s+(?:wait|hold\s+off|held\s+off|put\s+(?:it|this)\s+off)\b|\banother\s+(?:hurricane\s+)?season\b|\bpush\s+(?:it|this)\s+(?:off|down\s+the\s+road)\b|\bsitting\s+with\s+you\b|\bif\s+(?:those|they|it|that|this|nothing|things)\s+(?:stays?|changes?|keeps?|goes|go|gets?\s+worse)\b|\bthrough\s+(?:this|another|the)\s+(?:hurricane\s+|storm\s+)?season\b|\baffecting\s+you\b|\bwhat\s+would\s+(?:it|that)\s+mean\s+for\s+you\b|\bif\s+another\s+(?:one|storm|hurricane)\b|\banother\s+year\s+(?:with|of)\b|\bwhat'?s\s+another\s+year\b|\bwhat\s+does\s+that\s+(?:end\s+up\s+)?cost(?:ing)?\s+you\b|\bsit\s+as[- ]is\b/i;
// Every bridge variant (bridgeLine) names "the next step" and must match here.
const BRIDGE_RX = /\bbased\s+on\s+what\s+you\s+(?:told|said|mentioned)\b|\bthis\s+could\s+work\s+for\s+you\b|\b(?:the\s+)?(?:easiest\s+|best\s+)?next\s+step\s+(?:would\s+be|is)\b/i;
// A vague opener: a greeting, or "I need new windows" with nothing else to go on.
const OPENER_RX = /^\s*(?:(?:hi|hello|hey|howdy|good\s+(?:morning|afternoon|evening))(?:\s+there)?[\s!.,]*|(?:hi|hello|hey)?[\s,!.]*(?:i\s+(?:need|want|am\s+looking\s+for|'m\s+looking\s+for)|looking\s+(?:for|into)|interested\s+in)\s+(?:some\s+|new\s+|a\s+few\s+)*(?:impact\s+)?(?:windows?|doors?|windows?\s+and\s+doors?)[\s!.]*)$/i;
// Part 7: the bot words its own day ask now, so any day/time question counts.
const ASK_DAY_RX = /\bwhat\s+day\s+(?:works\s+best|would\s+be\s+easiest)\b|\bwhich\s+day\s+is\s+best\b|\b(?:what|which)\s+(?:day|days|time\s+of\s+day)\b[^.?!]*\?|\bwhen\s+(?:works|would\s+work|is\s+(?:a\s+)?good)\b[^.?!]*\?/i;
const STATUS_FRAME_RX = /\bpretty\s+simple\b|\bsee\s+what\s+you\s+have\s+now\b|\bif\s+it\s+might\s+be\s+a\s+fit\b/i;
const REVEAL_RX = /\banything\s+you'?re\s+wondering\s+about\b|\bbefore\s+your\s+visit\b/i;
const SLOT_OFFER_RX = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b[^?]{0,80}\bor\b|\bI\s+have\s+[^?]{0,80}\bor\b[^?]*\?/i;
const CONTACT_ASK_RX = /\b(?:phone|number|first\s+name|your\s+name|email|e-mail|zip|address)\b/i;
const DM_ASK_RX = /\b(?:decision|anyone\s+else|both\s+(?:of\s+you|home|there)|weigh\s+in|spouse|wife|husband|partner)\b/i;

// ── the owner's lines (Mark, 2026-10-02), run through the voice rules ────

export const LINES = Object.freeze({
  status_frame: "This is pretty simple. I just want to see what you have now and what you're hoping for, and if it might be a fit we can talk about next steps. Would that help?",
  price_play: "Totally fair. Every home is different, so any number I gave you now would be a guess. What are you hoping to see, so the estimate actually fits your home?",
  // Mark, 2026-10-02 (5i59G): a quote or price request goes straight to booking.
  // The old price play asked "what are you hoping to see?" and, with the bot's
  // memory lost, repeated it three times without ever offering a visit.
  // Mark, 2026-10-02 (second ruling): still engage. Say why there is no price
  // on the spot, ask ONE question about them, and put the two real times
  // beside it (no second question mark: the times are an offer, not a quiz).
  // 2026-10-02 (Mark): "way too long … too quick to ask for an appointment
  // time". A quote ask is a reason to talk, not to book: one short line and
  // the NEPQ connection question; the times come after discovery.
  quote_first: (what) => (what ? `Happy to help with the ${what}. What's got you looking into them now?` : "Happy to help with that. What's got you looking into it now?"),
  price_again_slots: (slots) => `Fair question. Every home is different, so a number now would just be a guess. I have ${slotPair(slots)} to measure. Which works better?`,
  price_again_no_slots: 'Fair question. Every home is different, so a number now would just be a guess. A team member will call to set up a free measure.',
  // "You just said that": no more questions, the next step.
  repeat_slots: (slots) => `You're right, sorry about that. Let's get you a time instead. I have ${slotPair(slots)}. Which works better?`,
  repeat_no_slots: "You're right, sorry about that. A team member will call to set a time for the visit.",
  callback: (when) => `Got it. I'll have someone from our team call you${when ? ` ${when}` : ''}.`,
  spouse_1: 'Makes sense. How does your spouse feel about getting this done?',
  spouse_2_slots: (slots) => `Would it be easier to pick a time when you're both home? I have ${slotPair(slots)}.`,
  spouse_2_no_slots: "Would it be easier to pick a time when you're both home? What day works best for you both?",
  shopping: "Smart move. Let's say everyone checks every box, price included. How would you decide?",
  think_slots: (slots) => `No problem at all. Want to grab a time now so you don't have to chase us down later? I have ${slotPair(slots)}.`,
  think_no_slots: "No problem at all. What day would work best if you did want someone to come out, so you don't have to chase us down later?",
  not_interested: (name) => `No problem${name ? `, ${name}` : ''}. What changed?`,
  ask_day: 'No problem. What day works best for you?',
  close: "Understood. Take care, and if anything changes, we're here.",
  // 2026-10-02 (Mark): "We shouldn't be repeating the same message." Lines
  // that recur in one thread come in variants (pickFresh); every offer keeps
  // "I have … or …?" because SLOT_OFFER_RX, offeredSlots and heldSlot read it.
  offer_slots: (slots, v = 0) => [
    `I have ${slotPair(slots)}. Which works better?`,
    `I have ${slotPair(slots)} open. Which one works for you?`,
    `I have ${slotPair(slots)}. Which would you like?`,
  ][v % 3],
  which: (slots) => `Great. Which works better, ${slotPair(slots)}?`,
  // A typed time we do not have (2026-10-03 replay). Keeps "I have … or …?".
  same_time_other_days: (label, slots) => `Sure. For ${label || 'that time'}, I have ${slotPair(slots)}. Which works better?`,
  not_open: (label, slots) => `${label ? `${label} isn't open` : "That time isn't open"}, but I have ${slotPair(slots)}. Which works better?`,
  financing_yes: 'Yes, we offer financing. The details depend on your home, and our team walks you through them.',
  reveal: "Before your visit, is there anything you're wondering about that I can pass along?",
  // 2026-10-02 (Mark): nothing sounds final. The visit is booked as a new,
  // unconfirmed appointment, and a team member confirms it.
  // 2026-10-02 (Mark, later ruling): book in real time and tell them they are
  // all set, with the team reaching out to confirm the details.
  confirm: (slot, tz, name) => `You're all set for ${slot.day} at ${slot.time}${tz ? ` ${tz}` : ''}${name ? `, ${name}` : ''}. Our team will reach out to confirm the details.`,
  handoff: {
    complaint: "I'm sorry about that. I'm getting someone from our team on this now.",
    emergency: "That's urgent. I'm getting someone from our team on this right now.",
    service: "Sorry about that. I'm getting our service team on this now.",
    price_insist: "Understood. I'll have someone from our team call you to talk it through.",
    two_nos: "No problem, I'll stop here. Someone from our team will check in with you directly.",
    repeat_objection: "Understood. I'll have someone from our team call you so you get a straight answer.",
  },
  // 2026-10-02 (Mark): "right now" only while the team is in (team-hours.js).
  // After hours the same hand-off names when someone will call.
  handoff_closed: {
    complaint: (when) => `I'm sorry about that. I've passed this to our team, and someone will call you ${when}.`,
    emergency: (when) => `That's urgent. I've flagged it for our team, and someone will call you ${when}.`,
    service: (when) => `Sorry about that. I've passed this to our service team, and someone will call you ${when}.`,
  },
  callback_outside_hours: (when) => `Got it. That's outside our team's hours, so I'll have someone call you ${when}.`,
});

// Second wordings for lines that can come up twice in one thread (Mark,
// 2026-10-02: "There needs to be variation in each comment"). Variant 0 is
// always the LINES wording; `vary` in planNepqTurn picks one not yet sent.
// Each keeps the phrase other code reads ("every home is different",
// "I have … or …", the "?").
export const ALT_LINES = Object.freeze({
  ask_day: ['Sure thing. What day would be easiest for you?', 'Okay. Which day is best for you?'],
  which: (slots) => [`Sounds good. Which one works for you, ${slotPair(slots)}?`, `Thanks. Should I hold ${slotPair(slots)} for you?`],
  price_again_slots: (slots) => [`I hear you. Since every home is different, any number now would be a guess. I have ${slotPair(slots)} open to measure. Which one works for you?`],
  price_again_no_slots: ['I hear you. Since every home is different, any number now would be a guess. A team member will call to set up a free measure.'],
  think_slots: (slots) => [`Totally fine. If it helps, I can hold a time so you don't have to chase us later. I have ${slotPair(slots)}. Which works better?`],
});

function slotPair(slots = []) {
  // "tomorrow at 10:00 AM ET or Mon, Oct 5 at 6:00 PM ET" (Mark, 2026-10-02).
  const s = slots.slice(0, 2).map(x => `${x.rel || x.day} at ${x.time}${x.tz ? ` ${x.tz}` : ''}`);
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
  if (SCHEDULE_ASK_RX.test(t) && !/\b(?:how\s+much|cost|price|pricing|ballpark)\b/i.test(t)) return false;
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
// The bot's own quote line (see LINES.quote_*).
// Every price reply says why there is no number yet; the next turn counts
// these to decide quote → times → a person (Part 7: the model words them).
const PRICE_PLAY_RX = /\bevery\s+(?:home|house)(?:'s|’s|\s+is)\s+(?:a\s+little\s+)?different\b|\bany\s+number\s+i\s+gave\b|\ba\s+number\s+(?:right\s+)?now\s+would\s+(?:just\s+)?be\s+a\s+guess\b/i;
const QUOTE_LINE_RX = /\bhappy\s+to\s+get\s+you\s+a\s+quote\b|\bexact\s+pricing\s+comes\s+from\s+a\s+quick\s+visit\b|\bcan'?t\s+give\s+a\s+fair\s+price\s+on\s+the\s+spot\b|\bhappy\s+to\s+help\s+with\b[^.?!]*\.\s+what'?s\s+got\s+you\s+looking\s+into\s+(?:them|it|this)\s+now\?|\ba\s+number\s+now\s+would\s+(?:just\s+)?be\s+a\s+guess\b/i;
// The visitor says the bot is repeating itself (2026-10-02, 5i59G).
export const REPEAT_COMPLAINT_RX = /\byou\s+(?:just|already)\s+(?:said|asked)(?:\s+(?:that|this))?\b|\bi\s+(?:just|already)\s+(?:said|told\s+you|answered)\b|\bstop\s+asking\b|\byou(?:'re|\s+are)\s+repeating\b|\bsame\s+(?:thing|question)\s+again\b/i;

/** A price ask that also asks other things, or sits inside a long message. Pure. */
export function isComplexPriceAsk(text) {
  const t = String(text || '');
  if (t.length > 220) return true;
  if ((t.match(/\?/g) || []).length >= 2) return true;
  return /\b(?:how\s+long|price\s*match|match\s+(?:a|their|the)\s+(?:price|quote)|beat\s+(?:that|their|it)|discounts?|deals?|warranty|financ\w*|do\s+you\s+(?:do|offer|have|sell|install|work))\b/i.test(t);
}

/** "at 5pm today" from a call request, for the confirm line. Pure. */
export function callbackWhen(text) {
  const m = String(text || '').match(/\b(?:at|around)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)(?:\s+(today|tomorrow|tonight))?/i);
  if (m) return `around ${m[1].replace(/\s+/g, ' ').trim()}${m[2] ? ` ${m[2].toLowerCase()}` : ''}`;
  const d = String(text || '').match(/\b(tomorrow|today|tonight)(?:\s+(morning|afternoon|evening))?\b/i);
  return d ? `${d[1].toLowerCase()}${d[2] ? ` ${d[2].toLowerCase()}` : ''}` : null;
}

/** What they want quoted, from their own words ("12 windows and 2 sliding glass doors"), or null. Pure. */
export function quoteItems(text) {
  const items = [...String(text || '').matchAll(/\b(\d{1,3})\s+((?:sliding\s+glass\s+|sliding\s+|french\s+|entry\s+|front\s+|patio\s+|impact\s+)?(?:windows?|doors?|sliders?))\b/gi)]
    .map(m => `${m[1]} ${m[2].toLowerCase().replace(/\s+/g, ' ')}`);
  const unique = [...new Set(items)].slice(0, 3);
  if (!unique.length) return null;
  return unique.length === 1 ? unique[0] : `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`;
}

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
  hasAppointment = false, nextStepLabel = 'a free visit at your home', discipline = null, nowMs = Date.now(),
  allSlots = null,
} = {}) {
  const turns = normalizeThread(conversation, trigger);
  const inbound = turns.filter(t => t.direction === 'inbound');
  const outbound = turns.filter(t => t.direction === 'outbound');
  const lastOut = outbound[outbound.length - 1]?.text || '';
  // The times we offered most recently (this turn or the one before): "the
  // first one" often comes after one more line from us (2026-10-02 audit).
  // 2026-10-02 replay: a pick came two messages after the offer (a phone
  // re-check in between) and was not read as a pick. The offer stays open for
  // four of our messages, until a time is held or booked.
  const lastOfferOut = (() => {
    for (const m of outbound.slice(-4).reverse()) {
      if (/\bI'm\s+holding\b|\bI\s+have\s+you\s+down\s+for\b|\byou'?re\s+all\s+set\s+for\b/i.test(m.text)) return '';
      if (SLOT_OFFER_RX.test(m.text)) return m.text;
    }
    return '';
  })();
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
  const pricePlayed = outbound.some(m => PRICE_PLAY_RX.test(m.text));
  // How many price/quote lines the bot already sent (quote → again → a person).
  const priceLines = outbound.filter(m => QUOTE_LINE_RX.test(m.text) || PRICE_PLAY_RX.test(m.text)).length;
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
  const timeRequest = !SLOT_OFFER_RX.test(lastOut) ? (pending.find(t => TIME_REQUEST_RX.test(t) || SCHEDULE_ASK_RX.test(t)) || null) : null;

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
    // For pickFresh: what we already said, so a line is never sent twice.
    recent_outbound: outbound.slice(-8).map(m => m.text),
    variant_seed: outbound.length,
  };
  plan.echo.phrase = problemPhrase(echoWord);
  const vary = (primary, alts = []) => pickFresh([primary, ...alts], plan.recent_outbound, 0);
  const fixed = (move, line, extra = {}) => Object.assign(plan, { required_move: move, fixed_line: line }, extra);
  const teamOpen = isTeamOpen(nowMs);
  const handoffLine = (reason) => (!teamOpen && LINES.handoff_closed[reason]) ? LINES.handoff_closed[reason](nextTeamOpenLabel(nowMs)) : LINES.handoff[reason];
  const handoff = (reason) => { const line = handoffLine(reason); return fixed('handoff', line, { step: 'handoff', handoff: { reason, line }, booking: { allowed: false, reason: `nepq:handoff_${reason}` } }); };
  const withSlots = (line) => { plan.slots_to_offer = offerSlots; plan.allowed.slot_offer = true; plan.booking = { allowed: true, reason: 'nepq:slot_offer' }; return line; };

  // 1. A person takes over: complaint, price insisted after the play, two no's.
  if (EMERGENCY_RX.test(now)) return handoff('emergency');
  if (SERVICE_RX.test(now)) return handoff('service');
  if (COMPLAINT_RX.test(now)) return handoff('complaint');
  if (CALLBACK_RX.test(now) && !isNotInterested(now)) {
    // A call asked for outside team hours gets the next opening instead, and
    // after hours "call me back" names when (2026-10-02, Mark).
    const asked = requestedCallTime(now, nowMs);
    let line;
    if (asked && !asked.ok && !asked.past) line = LINES.callback_outside_hours(nextTeamOpenLabel(nowMs, { fromDow: asked.dow, fromHour: asked.hour, dayOffset: asked.dayOffset }));
    else if (asked?.ok) line = LINES.callback(callbackWhen(now));
    else line = LINES.callback(teamOpen ? (asked ? null : callbackWhen(now)) : nextTeamOpenLabel(nowMs));
    return fixed('handoff', line, { step: 'handoff', handoff: { reason: 'callback_request', line }, booking: { allowed: false, reason: 'nepq:callback_request' } });
  }
  if (objType === 'price' && priceLines >= 2) return handoff('price_insist');
  if (nos >= 2) return handoff('two_nos');
  if ((objType === 'shopping') && attempt >= 2) return handoff('repeat_objection');

  // 2. A first "no". To our two times → ask for a day. A goodbye → a warm
  // close with no question. Not interested / don't come → ONE question.
  if (nos === 1 && SLOT_OFFER_RX.test(lastOut) && !isNotInterested(now)) {
    return fixed('ask_day', vary(LINES.ask_day, ALT_LINES.ask_day), { step: 'ask_day', booking: { allowed: true, reason: 'nepq:ask_day' } });
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

  // 3a. A price ask wrapped in a story or with other questions ("how much,
  // how long does install take, and do you do doors?"; a 600-character
  // message about cost worries): the canned line would ignore them. They get
  // a real answer that says why there is no price on the spot, then the times.
  // 2026-10-02 (Mark): no times on the first ask; the answer ends on the NEPQ
  // connection question instead.
  if (objType === 'price' && priceLines === 0 && isComplexPriceAsk(now)) {
    plan.price_note = true;
    plan.objection = { type: 'price', attempt, line: null };
    return Object.assign(plan, { step: 'discover', required_move: 'answer', booking: { allowed: false, reason: 'nepq:discover_first' } });
  }

  // 3a. A picked time is held while we collect what the booking needs
  // (booking-collect.js, Mark 2026-10-02: ask first, then book). Their reply
  // is the detail we asked for; a question in between is answered, then the
  // same ask again.
  const held = heldSlot(turns);
  if (held && !isNotInterested(now) && !NEITHER_RX.test(now)) {
    if (isLeadQuestion(now) && held.asked) {
      return Object.assign(plan, { step: 'collect', required_move: 'answer', held_slot: held, reask_line: COLLECT_ASK[held.asked], booking: { allowed: true, reason: 'nepq:collect' } });
    }
    return Object.assign(plan, { step: 'collect', required_move: 'collect', held_slot: held, booking: { allowed: true, reason: 'nepq:collect' } });
  }

  // 3b. "You just said that": stop asking, offer the next step.
  if (REPEAT_COMPLAINT_RX.test(now) && !hasAppointment) {
    const line = offerSlots.length === 2 ? withSlots(LINES.repeat_slots(offerSlots)) : LINES.repeat_no_slots;
    return fixed('objection_play', line, { step: 'offer_slots', objection: { type: 'repeat', attempt: 1, line }, ask_contact: offerSlots.length !== 2, booking: { allowed: true, reason: 'nepq:repeat_complaint' } });
  }

  // 4. Objection plays (Mark's wording).
  if (objType === 'price') {
    // First ask: the short line and one question, no times (discovery first).
    if (priceLines === 0) {
      const line = LINES.quote_first(quoteItems(inbound.map(m => m.text).join(' \n ')));
      return fixed('objection_play', line, { step: 'discover', objection: { type: 'price', attempt, line }, booking: { allowed: false, reason: 'nepq:discover_first' } });
    }
    // Asked again: why there is no number, then two real times.
    const line = offerSlots.length === 2 ? withSlots(vary(LINES.price_again_slots(offerSlots), ALT_LINES.price_again_slots(offerSlots))) : vary(LINES.price_again_no_slots, ALT_LINES.price_again_no_slots);
    return fixed('objection_play', line, {
      step: 'offer_slots', objection: { type: 'price', attempt, line },
      ask_contact: offerSlots.length !== 2,
      booking: { allowed: true, reason: 'nepq:price_again' },
    });
  }
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
    const line = offerSlots.length === 2 ? withSlots(vary(LINES.think_slots(offerSlots), ALT_LINES.think_slots(offerSlots))) : LINES.think_no_slots;
    return fixed('objection_play', line, { objection: { type: 'think', attempt, line } });
  }

  // 4a0. A clock time that names exactly one of our real openings is the
  // pick, whatever we asked last (Part 7 SMS replay: "Fine lets book for
  // 2 PM" after "what day works best for you both?" got two times back).
  // "after 2", "before noon" and "around 2" are preferences, not picks.
  const PREF_WORD_RX = /\b(?:after|before|until|around|by|usually|earliest|latest)\b/i;
  if (offerSlots.length && !isLeadQuestion(now) && !PREF_WORD_RX.test(now) && !SLOT_OFFER_RX.test(lastOut)) {
    const exactPick = exactSlotFor(now, offerSlots);
    if (exactPick) {
      plan.slots_to_offer = offerSlots;
      return Object.assign(plan, { step: 'confirm', required_move: 'confirm', last_offer: LINES.offer_slots(offerSlots), booking: { allowed: true, reason: 'nepq:typed_time' } });
    }
  }
  // 4a0b. A clock time that names NONE of the times on the table (2026-10-03
  // replay: "Fine lets book for 2 PM" with 6 PM and Sun 10 AM offered). The
  // live chat took it as a pick, asked for a name, an email, and never
  // booked. Say it is not open and offer the two real openings nearest it.
  // Only with the whole calendar in hand: two offerable times alone cannot
  // say a time is not open.
  // Checked against the times actually OFFERED in the thread, not the two
  // the caller loaded near the typed time (2026-10-03 replay: the live chat
  // loads slots near "2 PM", found a 2 PM among them, and took it as a pick
  // of an offer that never named it).
  const allPool = Array.isArray(allSlots) ? allSlots.map(s => ({ ...s, tz: s.tz || tzLabel || '' })) : [];
  const offeredInThread = lastOfferOut ? allPool.filter(s => slotMentionIndex(lastOfferOut, s) >= 0) : offerSlots;
  if (offerSlots.length && allPool.length >= 2 && !isLeadQuestion(now) && !PREF_WORD_RX.test(now) && !/\b(?:can'?t|cannot|not|won'?t|busy|except)\b/i.test(now) && typedClock(now) != null && !exactSlotFor(now, offeredInThread)) {
    const all = allPool;
    // A day AND time they typed that is open ("Sunday at 2 PM") is the pick.
    const named = all.filter(s => slotMentionIndex(now, s) >= 0);
    if (named.length === 1) {
      const other = nearestToClock(all.filter(s => s !== named[0]), typedClock(now), '', nowMs)[0];
      plan.slots_to_offer = other ? [named[0], other] : [named[0]];
      return Object.assign(plan, { step: 'confirm', required_move: 'confirm', last_offer: LINES.offer_slots(plan.slots_to_offer), booking: { allowed: true, reason: 'nepq:typed_time' } });
    }
    const near = nearestToClock(all, typedClock(now), now, nowMs);
    if (near.length === 2) {
      plan.slots_to_offer = near;
      plan.allowed.slot_offer = true;
      // 2 PM open on other days: those, plainly. Not open at all: say so.
      const sameClock = near.every(sl => slotClock(sl) === typedClock(now));
      const line = sameClock ? LINES.same_time_other_days(typedClockLabel(now), near) : LINES.not_open(typedClockLabel(now), near);
      return fixed('offer_slots', line, { step: 'offer_slots', booking: { allowed: true, reason: 'nepq:typed_time_not_offered' } });
    }
  }

  // 4a. A day or part of the day is a filter, not a pick (Mark, Oct 2 6:12 PM
  // chat: "Usually on Wednesdays" got "We have Wednesdays blocked for you").
  // Two real openings that match, the next matching day first; none in two
  // weeks → say so and offer the nearest two (day-preference.js). Only in a
  // scheduling moment, and never over a pick of a time already offered.
  const pref = parseDayPreference(now);
  const pool = (Array.isArray(allSlots) && allSlots.length ? allSlots : []).map(s => ({ ...s, tz: s.tz || tzLabel || '' }));
  // A short message that is only a day ("Usually on Wednesdays") is their
  // availability whatever we asked (2026-10-03 SMS replay: it got the bridge,
  // then "we don't have a Wednesday slot", which was not true).
  const bareDay = !!pref?.days && String(now).trim().split(/\s+/).length <= 6 && !isLeadQuestion(now);
  const prefScheduling = !!pref && (ASK_DAY_RX.test(lastOut) || /\b(?:what|which)\s+day\b|\bwhen\s+(?:works|would|is\s+good)\b/i.test(lastOut)
    || !!lastOfferOut || BRIDGE_RX.test(lastOut) || counters.bridge_used || SCHEDULE_ASK_RX.test(now) || bareDay);
  // The caller loads the calendar for this (wantsSlots) and plans again.
  if (prefScheduling && pool.length < 2) plan.day_preference_pending = true;
  if (prefScheduling && pool.length >= 2) {
    const offeredNow = lastOfferOut ? pool.filter(s => lastOfferOut.includes(`${s.day} at ${s.time}`) || (s.rel && lastOfferOut.includes(`${s.rel} at ${s.time}`))) : [];
    if (!offeredNow.some(s => slotMatches(s, pref))) {
      const picked = slotsForPreference(pool, pref, { nowMs });
      const line = preferenceOfferLine(pref, picked, tzLabel);
      if (line) {
        plan.slots_to_offer = picked.slots;
        plan.allowed.slot_offer = true;
        plan.day_preference = { label: pref.label, matched: picked.matched };
        return fixed('offer_slots', line, { step: 'offer_slots', booking: { allowed: true, reason: 'nepq:day_preference' } });
      }
    }
  }

  // 4b. They typed a day and a time with no offer on the table: two real
  // times near it. A question in the same burst is answered first.
  if (timeRequest) {
    const asked = isLeadQuestion(now) && !TIME_REQUEST_RX.test(now);
    // 2026-10-02 (Mark's 5:22 PM chat, SMS replay): "Fine lets book for 2 PM"
    // got two times back instead of the 2 PM it asked for. A typed time that
    // IS one of the real openings is the pick.
    const exact = !asked && offerSlots.length ? exactSlotFor(timeRequest, offerSlots) : null;
    if (exact) {
      plan.slots_to_offer = offerSlots;
      return Object.assign(plan, { step: 'confirm', required_move: 'confirm', last_offer: LINES.offer_slots(offerSlots), booking: { allowed: true, reason: 'nepq:typed_time' } });
    }
    if (offerSlots.length === 2 && !asked) return fixed('offer_slots', withSlots(LINES.offer_slots(offerSlots, counters.slot_offers)), { step: 'offer_slots' });
    if (offerSlots.length === 2) {
      withSlots(null);
      return Object.assign(plan, { step: 'offer_slots', required_move: 'offer_slots', answer_first: true, offer_line: LINES.offer_slots(offerSlots, counters.slot_offers) });
    }
    return Object.assign(plan, { step: 'offer_slots', required_move: asked ? 'answer' : 'offer_slots', booking: { allowed: true, reason: 'nepq:time_request' } });
  }
  // 4c. They answered "how would you decide?": speak to it, then the bridge.
  if (plan.criteria_reply) {
    return Object.assign(plan, { step: 'bridge', required_move: 'answer', booking: { allowed: false, reason: 'nepq:criteria' } });
  }

  // 5. Answering our slot offer.
  if (lastOfferOut) {
    if (NEITHER_RX.test(now)) return fixed('ask_day', vary(LINES.ask_day, ALT_LINES.ask_day), { step: 'ask_day', booking: { allowed: true, reason: 'nepq:ask_day' } });
    const picked = DAY_OR_TIME_RX.test(now) || BARE_PICK_RX.test(now);
    // "Sure" / "yes" to two times picks neither: ask which, with the times.
    if (!picked && YES_RX.test(now) && offerSlots.length === 2) return fixed('offer_slots', withSlots(vary(LINES.which(offerSlots), ALT_LINES.which(offerSlots))), { step: 'offer_slots' });
    if (picked || YES_RX.test(now)) return Object.assign(plan, { step: 'confirm', required_move: 'confirm', last_offer: lastOfferOut, booking: { allowed: true, reason: 'nepq:confirm' } });
    // Something else came between (a corrected phone, a name), or they
    // answered the offer with a detail instead of a pick (2026-10-03 SMS
    // replay: an address after the offer got "Good news, 12 Main St is in our
    // service area." and no question). Back to the times, in other words.
    // Asked three times with no pick: ask the day instead of a fourth time.
    if (!isLeadQuestion(now) && !objType && offerSlots.length === 2) {
      const offersInARow = outbound.slice(-3).filter(t => SLOT_OFFER_RX.test(t.text || '')).length;
      if (offersInARow >= 3) return fixed('ask_day', vary(LINES.ask_day, ALT_LINES.ask_day), { step: 'ask_day', booking: { allowed: true, reason: 'nepq:ask_day' } });
      // The same two times we just offered, not a fresh pair (2026-10-03
      // replay: "Sun 2 PM or Mon 2 PM", then "Sun 10 AM or Sun 2 PM").
      const pair = offeredInThread.length >= 2 ? offeredInThread.slice(0, 2) : offerSlots;
      const line = withSlots(vary(LINES.which(pair), ALT_LINES.which(pair)));
      plan.slots_to_offer = pair;
      return fixed('offer_slots', line, { step: 'offer_slots' });
    }
  }
  // "ok" / "sure" to "what day works best?": the two real times, not more questions.
  if (ASK_DAY_RX.test(lastOut) && !DAY_OR_TIME_RX.test(now) && (YES_RX.test(now) || MAYBE_RX.test(now) || VAGUE_ANSWER_RX.test(now))) {
    if (offerSlots.length === 2) return fixed('offer_slots', withSlots(LINES.offer_slots(offerSlots, counters.slot_offers)), { step: 'offer_slots' });
    return Object.assign(plan, { step: 'offer_slots', required_move: 'offer_slots', booking: { allowed: true, reason: 'nepq:offer_slots' } });
  }
  // They named a day after "what day works best?": offer two times that day.
  if (ASK_DAY_RX.test(lastOut) && DAY_OR_TIME_RX.test(now)) {
    if (offerSlots.length === 2) return fixed('offer_slots', withSlots(LINES.offer_slots(offerSlots, counters.slot_offers)), { step: 'offer_slots' });
    return Object.assign(plan, { step: 'offer_slots', required_move: 'offer_slots', booking: { allowed: true, reason: 'nepq:offer_slots' } });
  }

  // 5b. They are ready (asked to schedule, answered a prerequisite or the
  // decision-maker question, stated a deadline): no more discovery. NEPQ
  // stops asking once the lead has done their own convincing.
  const READY = /^(?:lead_asked_about_scheduling|lead_answered_booking_prerequisite|lead_answered_decision_maker_ask|urgent_deadline_stated|recommended_action:)/;
  if (discipline?.booking?.allowed && READY.test(String(discipline.booking.reason || ''))) {
    if (offerSlots.length === 2 && !isLeadQuestion(now)) return fixed('offer_slots', withSlots(LINES.offer_slots(offerSlots, counters.slot_offers)), { step: 'offer_slots' });
    return Object.assign(plan, { step: 'offer_slots', required_move: isLeadQuestion(now) ? 'answer' : 'offer_slots', booking: { allowed: true, reason: discipline.booking.reason } });
  }

  // 6a. Yes to the bridge with a question in the same message ("Yeah, how
  // long does that take?"): answer it in one sentence, then the two times.
  // Mark's test chat (2026-10-02) got "a team member will call you" here.
  if (BRIDGE_RX.test(lastOut) && YES_RX.test(now) && isLeadQuestion(now)) {
    if (offerSlots.length === 2) {
      withSlots(null);
      return Object.assign(plan, { step: 'offer_slots', required_move: 'offer_slots', answer_first: true, offer_line: LINES.offer_slots(offerSlots, counters.slot_offers) });
    }
    // No real times to hand (a calendar read that failed): answer, then the
    // day, never the bridge again (2026-10-02, Mark's 4:16 PM chat).
    return Object.assign(plan, { step: 'ask_day', required_move: 'answer', reask_line: vary(LINES.ask_day, ALT_LINES.ask_day), booking: { allowed: true, reason: 'nepq:ask_day' } });
  }

  // 6. They asked us something: answer it first (one question after, at most).
  if (isLeadQuestion(now)) {
    plan.required_move = 'answer';
    plan.allowed.consequence = false;
    return plan;
  }

  // 7. Said yes to the bridge → two real times.
  if (BRIDGE_RX.test(lastOut) && YES_RX.test(now)) {
    if (offerSlots.length === 2) return fixed('offer_slots', withSlots(LINES.offer_slots(offerSlots, counters.slot_offers)), { step: 'offer_slots' });
    // 2026-10-02 (Mark's 4:16 PM chat): with the calendar read timed out, the
    // model asked for a name and number and the guard re-sent the bridge.
    // A yes with no times in hand gets the day question, varied.
    return fixed('ask_day', vary(LINES.ask_day, ALT_LINES.ask_day), { step: 'ask_day', booking: { allowed: true, reason: 'nepq:ask_day' } });
  }

  // 7b. A soft "maybe" / "I guess" to the bridge: two real times, no pressure
  // (2026-10-02 funnel re-test: a vague lead stalled for five turns on SMS).
  if (BRIDGE_RX.test(lastOut) && MAYBE_RX.test(now)) {
    if (offerSlots.length === 2) return fixed('offer_slots', withSlots(LINES.offer_slots(offerSlots, counters.slot_offers)), { step: 'offer_slots' });
    return Object.assign(plan, { step: 'offer_slots', required_move: 'offer_slots', booking: { allowed: true, reason: 'nepq:offer_slots' } });
  }

  // 7c. The Status Frame (Mark's NEPQ spec, 2026-10-02): a visitor who opens
  // vaguely ("hi", "I need new windows") hears, once, that this is simple and
  // low-pressure before any discovery. Live chat only: the SMS first touch
  // comes from the GHL workflow. A question, an objection or a detail skips it.
  if (channel === 'livechat' && !counters.status_frame_used && !counters.bridge_used && !counters.slot_offers
    && inbound.length <= 2 && counters.discovery_questions_asked === 0 && OPENER_RX.test(now)) {
    return fixed('status_frame', LINES.status_frame, { step: 'open', booking: { allowed: false, reason: 'nepq:status_frame' } });
  }

  // 8. Discovery, short: probe in their words, one consequence question, then bridge.
  // Two non-answers in a row ("idk", "maybe") end discovery early: more
  // questions only stall a lead who has nothing more to say (Mark, 2026-10-02).
  if (!counters.bridge_used && counters.discovery_questions_asked >= 1 && vagueRun(inbound) >= 2) {
    Object.assign(plan, { step: 'bridge', required_move: 'bridge', vague_lead: true, booking: { allowed: false, reason: 'nepq:bridge_vague' } }); plan.bridge_line = bridgeLine(plan); return plan;
  }
  // Times are already on the table (an objection play offered them): never
  // back to the bridge; ask which, or for a day (2026-10-02 SMS replay: the
  // bot re-asked "Would that help?" after offering two times). Checked before
  // the discovery cap: the Part 7 replay bridged again after times were offered.
  if (!counters.bridge_used && counters.slot_offers > 0) {
    if (offerSlots.length === 2) return fixed('offer_slots', withSlots(vary(LINES.which(offerSlots), ALT_LINES.which(offerSlots))), { step: 'offer_slots' });
    return fixed('ask_day', vary(LINES.ask_day, ALT_LINES.ask_day), { step: 'ask_day', booking: { allowed: true, reason: 'nepq:ask_day' } });
  }
  if (counters.discovery_questions_asked >= cap && !counters.bridge_used) {
    Object.assign(plan, { step: 'bridge', required_move: 'bridge', booking: { allowed: false, reason: 'nepq:bridge_first' } }); plan.bridge_line = bridgeLine(plan); return plan;
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
const URGENCY_RX = /\bonly\s+\d+\s+(?:spots?|slots?|openings?)\s+left\b|\bspots?\s+(?:are\s+)?filling\b|\bprices?\s+(?:are\s+)?going\s+up\b|\bact\s+(?:now|fast)\b|\blimited\s+time\b|\bbefore\s+(?:it'?s|its)\s+too\s+late\b|\bdon'?t\s+miss\b|\b(?:calendar|schedule|calls?)(?:'s|\s+is|\s+are)?\s+(?:tight|packed|full|filling(?:\s+up)?|booking\s+up(?:\s+fast)?|moving\s+fast)\b|\bpeak\s+season\b|\bspeeding\s+up\s+these\s+decisions\b/i;
// 2026-10-02 funnel audit: the SMS bot leaned on "our calendar's tight right
// now" / "calls are booking up fast" in most booking turns. Invented scarcity.
// Claims nobody approved (2026-10-02 simulation: "that's right at the edge of
// when Florida code tightened up", "with us at the peak of hurricane season").
// Code history and season-peak talk are pressure dressed as fact.
const CLAIMS_RX = /\bcode\s+(?:changed|tightened|got\s+(?:stricter|tighter)|was\s+(?:updated|changed))\b|\b(?:after|since|before)\s+(?:the\s+)?(?:19|20)\d\d\b[^.?!]{0,40}\bcode\b|\bcode\b[^.?!]{0,40}\b(?:after|since|before)\s+(?:19|20)\d\d\b|\bpeak\s+(?:of\s+)?(?:the\s+)?(?:hurricane|storm)\s+season\b|\bmost\s+active\s+(?:stretch|part|time)\b|\b(?:storm\s+season|we)\s+(?:has|have)\s+(?:us\s+)?(?:slammed|swamped)\b|\bcalendar\s+(?:is\s+)?(?:tight|filling|full)\b|\b(?:andersen|renewal|pgt|pella|lowe'?s|home\s+depot|es\s+windows|cgi)\b[^.?!]{0,60}\b(?:uses?|only|standard|cheap\w*|worse|inferior|lower|basic)\b/i;
const SEE_YOU_RX = /\bsee\s+you\s+(?:then|soon|there)\b/i;
const SIGNOFF_RX = /(?:^|\s)([—–-]\s*[A-Z][A-Za-z.'’ ]{0,40})\s*$/;
const FIXED_MOVES = new Set(['handoff', 'objection_play', 'ask_day', 'close', 'reveal', 'offer_slots', 'status_frame']);

// ── Part 7 (Mark, 2026-10-02): "I don't think we need any static messages
// sent by the bot. Each message should be custom." A fixed line is now a
// REFERENCE the model writes its own version of, and the BACKUP that ships
// only when the model's version fails these checks twice. The checks are
// read from the reference itself, so every line in LINES is covered without
// a per-move table: its real times, whether it ends on a question, whether
// it promises a person, and which clock times it may name.
const TEAM_RX = /\b(?:someone|somebody|a\s+(?:team\s+)?member|(?:our|the)\s+(?:service\s+)?team|one\s+of\s+(?:our|us)|a\s+person|specialist)\b/i;
const CLOCK_RX = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/gi;
const clockMinutes = (text) => [...String(text || '').matchAll(CLOCK_RX)].map(m => (Number(m[1]) % 12 + (/p/i.test(m[3]) ? 12 : 0)) * 60 + Number(m[2] || 0));

/**
 * What a reply for this move has to keep, read from the reference line. Pure.
 * @returns {{ slots: string[], endsWithQuestion: boolean, noQuestion: boolean, promisesTeam: boolean, times: number[] }}
 */
// Phrases the planner reads back from our own messages next turn. A reply
// for a move whose reference carries one must carry it too.
const MARKERS = [
  { rx: STATUS_FRAME_RX, say: 'say this is pretty simple' },
  { rx: REVEAL_RX, say: "ask if there's anything they're wondering about before the visit" },
  { rx: ASK_DAY_RX, say: 'ask what day works best' },
  { rx: PRICE_PLAY_RX, say: 'say every home is different, so a number now would just be a guess' },
  { rx: BRIDGE_RX, say: 'name "the next step"' },
  { rx: RECHECK_RX, say: 'kindly ask them to double-check it and send it again' },
  // The objection plays keep their point, whatever the words.
  // "How does she feel about…" speaks to the spouse too (2026-10-03 logs).
  { rx: /\b(?:spouse|wife|husband|partner|both\s+home)\b|\bhow\s+(?:does|do|would)\s+(?:she|he)\b|\b(?:she|he)\s+(?:feels?|thinks?)\b/i, say: 'speak to their spouse or partner' },
  { rx: /\bdecide\b/i, say: 'ask how they will decide' },
  { rx: /\bchase\b/i, say: "say a time now saves them chasing us down later" },
];

export function referenceRules(line, slots = [], plan = null) {
  const ref = String(line || '').trim();
  const markers = [...MARKERS.filter(m => m.rx.test(ref)), ...(Array.isArray(plan?.reference_markers) ? plan.reference_markers : [])];
  // A price reply always says why there is no number (the quote → times →
  // person count reads it), even where the reference words it differently.
  if (plan?.objection?.type === 'price' && !markers.some(m => m.rx === PRICE_PLAY_RX)) markers.push(MARKERS.find(m => m.rx === PRICE_PLAY_RX));
  // The real times, written as offered: offeredSlots/heldSlot read them back.
  const labels = (Array.isArray(slots) ? slots : [])
    .map(s => [s.rel ? `${s.rel} at ${s.time}` : null, `${s.day} at ${s.time}`].filter(Boolean))
    .filter(forms => forms.some(f => ref.includes(f)))
    .map(forms => forms.find(f => ref.includes(f)));
  return {
    slots: labels,
    endsWithQuestion: /\?\s*$/.test(ref),
    noQuestion: !ref.includes('?'),
    promisesTeam: TEAM_RX.test(ref),
    times: clockMinutes(ref),
    markers,
  };
}

/** The rules as one line of prompt text (rendered under the reference). Pure. */
export function referenceRulesText(rules) {
  const out = [];
  if (rules.slots.length) out.push(`name these times exactly as written: ${rules.slots.join(' or ')} (no other times)`);
  else if (!rules.times.length) out.push('name no day or clock time');
  if (rules.promisesTeam) out.push('say someone from our team will reach out');
  for (const m of rules.markers || []) out.push(m.say);
  if (rules.endsWithQuestion) out.push('end with exactly one question');
  if (rules.noQuestion) out.push('ask no question');
  return out.join('; ');
}

/** The re-write instruction after a draft missed its reference's job (Part 7). Pure. */
export function referenceRetryNote(plan, failed = []) {
  const line = plan?.reference_line || plan?.fixed_line || '';
  const keep = referenceRulesText(referenceRules(line, plan?.reference_slots || plan?.slots_to_offer || [], plan));
  return `Your previous draft did not do this turn's job (${failed.join(', ')}). Write it again, in your own words for this lead, ` +
    `using the reference only as a guide: "${line}". It must ${keep || 'do what the reference does'}.`;
}

/**
 * Problems with a model draft for a move that has a reference line, or [].
 * Pure. An empty list means the draft does the reference's job.
 */
export function checkAgainstReference(draft, line, slots = [], plan = null) {
  const text = String(draft || '').trim();
  if (!text) return ['empty'];
  const r = referenceRules(line, slots, plan);
  const problems = [];
  for (const m of r.markers) if (!m.rx.test(text)) problems.push(`missing:${m.say}`);
  // A real time counts however it is written ("Sun, Oct 4 at 10:00 AM" or
  // "Sunday at 10 AM"): offeredSlots reads both back (Part 7 replay).
  const refSlots = (Array.isArray(slots) ? slots : []).filter(s => r.slots.some(l => l === `${s.day} at ${s.time}` || (s.rel && l === `${s.rel} at ${s.time}`)));
  for (const s of refSlots) if (slotMentionIndex(text, s) < 0) problems.push(`missing_time:${s.day} at ${s.time}`);
  const allowed = new Set([...r.times, ...clockMinutes(r.slots.join(' '))]);
  if (clockMinutes(text).some(t => !allowed.has(t))) problems.push('other_time');
  if (r.endsWithQuestion && !/\?\s*$/.test(text)) problems.push('no_question');
  if (r.noQuestion && text.includes('?')) problems.push('asks_a_question');
  if (r.promisesTeam && !TEAM_RX.test(text)) problems.push('no_team_follow_up');
  return problems;
}

/**
 * A draft that does part of the job, with the reference's ask put after it:
 * the reference from its first sentence that holds a time or a question
 * ("Which works better, X or Y?", "What day works best for you?"). Only for
 * a draft that asks nothing and names no clock time of its own, and only when
 * what failed is the times, the question or a read-back phrase. Pure.
 * @returns {string|null}
 */
export function appendReferenceAsk(draft, refLine, failed = []) {
  const body = String(draft || '').trim();
  if (!body || body.includes('?') || /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)/i.test(body)) return null;
  if (!failed.every(f => /^(?:missing_time:|missing:|no_question$)/.test(f))) return null;
  const parts = splitSentences(refLine);
  const at = parts.findIndex(p => p.includes('?') || /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i.test(p));
  if (at < 0) return null;
  const tail = parts.slice(at).join(' ').trim();
  return `${/[.!]$/.test(body) ? body : `${body}.`} ${tail}`;
}

/**
 * True when the plan's move has a reference line (Part 7: the model writes
 * its own version; the line is the backup when that version fails
 * checkAgainstReference). Pure.
 */
export function nepqFixedLineWins(plan) {
  return !!(plan?.fixed_line && FIXED_MOVES.has(plan.required_move));
}
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

const FILLER_ONLY_RX = /^(?:no\s+problem|sure(?:\s+thing)?|okay|ok|got\s+it|great|perfect|sounds\s+good)[.!]?$/i;
/** A re-ask after an answer: its filler opener ("No problem.") dropped. Pure. */
export function reaskAfterAnswer(line) {
  const parts = splitSentences(line);
  return parts.length > 1 && FILLER_ONLY_RX.test(parts[0]) ? parts.slice(1).join(' ') : String(line || '');
}

const TYPED_CLOCK_RX = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i;
/** Minutes after midnight of the first clock time typed, or null. Pure. */
export function typedClock(text) {
  const m = String(text || '').match(TYPED_CLOCK_RX);
  if (!m) return null;
  return (Number(m[1]) % 12 + (/p/i.test(m[3]) ? 12 : 0)) * 60 + Number(m[2] || 0);
}
/** "2 PM" / "2:30 PM", as the lead typed it. Pure. */
export function typedClockLabel(text) {
  const m = String(text || '').match(TYPED_CLOCK_RX);
  return m ? `${Number(m[1])}${m[2] && m[2] !== '00' ? `:${m[2]}` : ''} ${m[3].replace(/\./g, '').toUpperCase()}` : '';
}
const slotClock = (s) => {
  const m = String(s?.time || '').match(/^(\d{1,2})(?::(\d{2}))?\s*([AP])M/i);
  return m ? (Number(m[1]) % 12 + (/p/i.test(m[3]) ? 12 : 0)) * 60 + Number(m[2] || 0) : null;
};
/**
 * The two openings nearest a typed clock time: that time on another day
 * first (soonest first), then the closest times of day. A day they typed
 * ("Sunday at 2 PM") narrows the pool to that day when it has openings. Pure.
 */
export function nearestToClock(slots, minutes, text = '', nowMs = Date.now()) {
  const list = (Array.isArray(slots) ? slots : []).filter(s => slotClock(s) != null && (!s.iso || Date.parse(s.iso) >= nowMs));
  const t = String(text || '').toLowerCase();
  const dayHit = list.filter(s => [s.dayOfWeek, s.rel].filter(Boolean).some(d => new RegExp(`\\b${String(d).toLowerCase()}\\b`).test(t)));
  const pool = dayHit.length >= 2 ? dayHit : list;
  const when = (s) => (s.iso ? Date.parse(s.iso) : 0);
  return [...pool]
    .sort((a, b) => Math.abs(slotClock(a) - minutes) - Math.abs(slotClock(b) - minutes) || when(a) - when(b))
    .slice(0, 2)
    .sort((a, b) => when(a) - when(b));
}

/** The one real opening a typed time names ("2 PM", "tomorrow at 10"), or null. Pure. */
export function exactSlotFor(text, slots = []) {
  const m = String(text || '').match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i);
  if (!m) return null;
  const want = `${Number(m[1])}:${m[2] || '00'} ${m[3].replace(/\./g, '').toUpperCase()}`;
  const hits = slots.filter(s => String(s.time || '').replace(/^0/, '').toUpperCase() === want);
  return hits.length === 1 ? hits[0] : null;
}

/** The bridge in their words, when the draft skipped it. Pure. */
export function bridgeLine(plan) {
  const phrase = plan.echo?.phrase || problemPhrase(plan.echo?.word);
  const since = phrase ? `, since you mentioned ${phrase}` : '';
  // Mark's spec: "a free visit at your home".
  const label = plan.next_step_label || 'a free visit at your home';
  // 2026-10-02 (Mark): the same bridge word for word in every chat read as a
  // script. Variants, chosen so none repeats one already sent (pickFresh).
  const variants = [
    `Based on what you told me, this could work for you${since}. The next step would be ${label}. Would that help?`,
    `Thanks for walking me through that. It sounds like we could help${since}. The next step would be ${label}. Would that work for you?`,
    `From what you've shared, I think we can help${since}. The easiest next step is ${label}. Would that help?`,
    `Got it. We can likely help${since}. The best next step is ${label}. Would that be useful?`,
  ];
  return pickFresh(variants, plan.recent_outbound || [], plan.variant_seed || 0);
}

/**
 * One of `variants`, never one whose opening words we already sent in this
 * thread (Mark, 2026-10-02: "There needs to be variation in each comment").
 * The seed spreads the choice across conversations; it is the outbound count,
 * so a test is deterministic. Pure.
 */
export function pickFresh(variants, recentOutbound = [], seed = 0) {
  const sent = recentOutbound.map(t => norm(t));
  const opener = (v) => norm(v).split(' ').slice(0, 4).join(' ');
  // The closing question too: the opener and the bridge both ended "Would
  // that help?" (Mark, 2026-10-02: "asked 'Would that help?' twice").
  const closing = (v) => norm((String(v).match(/[^.!?]*\?\s*$/) || [''])[0]);
  const freshOpen = variants.filter(v => !sent.some(t => t.includes(opener(v))));
  const fresh = freshOpen.filter(v => !closing(v) || !sent.some(t => t.endsWith(closing(v)) || t.includes(`${closing(v)} `)));
  const pool = fresh.length ? fresh : freshOpen.length ? freshOpen : variants;
  return pool[Math.abs(seed) % pool.length];
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

  // 1. A fixed move: the model wrote its own version of the reference line
  // (Part 7). It goes through every step below and is checked against the
  // reference at the end; the reference is the backup.
  // `reference_line` is a caller's own reference for this turn (the live
  // chat's booking and hand-off lines); it wins over the planner's.
  const referenceMove = !!plan.reference_line || !!(plan.fixed_line && FIXED_MOVES.has(plan.required_move));
  const refLine = plan.reference_line || plan.fixed_line;
  const refSlots = plan.reference_slots || plan.slots_to_offer || [];

  let sentences = splitSentences(body);
  const drop = (pred, tag) => {
    const before = sentences.length;
    sentences = sentences.filter(s => !pred(s));
    if (sentences.length !== before) changes.push(tag);
  };
  // 2. No money, no pressure.
  if (!allowFigures) drop(s => MONEY_RX.test(s), 'money_figures');
  // 2026-10-02 re-run: "Our calendar's tight right now, so the quickest way
  // to grab a day is here: <link>" was the whole reply, so dropping it left
  // nothing and the original shipped. Cut the pressure clause and keep the rest.
  sentences = sentences.map(s => {
    if (!URGENCY_RX.test(s)) return s;
    const rest = s.replace(/^[^,;]*?,\s*(?:so\s+|and\s+)?/, '');
    if (rest === s || URGENCY_RX.test(rest) || rest.split(/\s+/).length < 4) return s;
    changes.push('fake_urgency');
    return rest.charAt(0).toUpperCase() + rest.slice(1);
  });
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
  // 4c. Never the same sentence twice in one conversation (Mark, 2026-10-02:
  // "We shouldn't be repeating the same message"). Only when something else
  // is left; the required lines below are put back by their own steps.
  const sentBefore = new Set((plan.recent_outbound || []).flatMap(t => splitSentences(t)).map(norm).filter(x => x.split(' ').length >= 4));
  if (sentBefore.size && sentences.length > 1) {
    const kept = sentences.filter(s => !sentBefore.has(norm(s)));
    // Never strip a reply down to an acknowledgement: when the repeat was the
    // only question, it stays (2026-10-02 replay: "Got it." was all that went).
    const lostQuestion = sentences.some(s => s.includes('?')) && !kept.some(s => s.includes('?'));
    if (kept.length && kept.length !== sentences.length && !lostQuestion) { sentences = kept; changes.push('repeat_sentence'); }
  }
  // 5. One ask, ending the message (one-ask.js, Mark 2026-10-02): a statement
  // that asks ("I'll need your first name and a phone number") counts, a
  // day/time comes before any detail, and the plan's ask wins.
  const questions = sentences.filter(s => s.includes('?'));
  const planAsk = plan.booking_facts?.ask || (plan.step === 'ask_day' ? 'day' : null);
  const timePicked = !!(plan.held_slot || plan.step === 'collect' || plan.required_move === 'confirm');
  // After an answer, a re-ask's own opener ("No problem.") is filler (Mark's
  // example: "Yes, it's completely free. What day works best for you?").
  const reask = plan.reask_line ? reaskAfterAnswer(plan.reask_line) : null;
  const protect = [plan.booking_facts?.ask_line, reask, plan.reask_line, plan.offer_line, COLLECT_ASK.dm];
  // The cancel flow asks for the name AND phone the appointment is under in
  // one question (Mark's cancel ruling), so its plan allows that one ask.
  const oneAsk = plan.allow_multi_ask ? { changed: false } : enforceOneAsk(sentences.join(' '), { ask: planAsk, timePicked, protect });
  if (oneAsk.changed) {
    sentences = splitSentences(oneAsk.text);
    changes.push('multi_ask_trimmed');
    if (questions.length > 1) changes.push('one_question');
  }
  body = sentences.join(' ').trim();

  // 5a. Holding a time: their question answered, then the same ask again.
  if (plan.reask_line && !body.includes(plan.reask_line)) {
    const answer = splitSentences(body).filter(s => !s.includes('?') && !FILLER_ONLY_RX.test(s));
    const line = answer.length ? reaskAfterAnswer(plan.reask_line) : plan.reask_line;
    if (!body.endsWith(line)) {
      body = [...answer, line].join(' ').trim();
      changes.push('reask_line');
    }
  }

  // 5b. A time they typed, with a question in the same burst: the answer, then
  // the two real times verbatim (the model's own times never survive).
  // 2026-10-02 break test: "A team member will call you to set up a time that
  // works. I have Sat 10 AM or Sat 2 PM." The times ARE the time; the
  // call-to-set-a-time promise goes when they are offered.
  if (plan.required_move === 'offer_slots' && plan.offer_line && !body.includes(plan.offer_line)) {
    body = [...sentences.filter(s => !s.includes('?') && !SLOT_OFFER_RX.test(s) && !/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i.test(s) && !CALL_TO_SET_RX.test(s)), plan.offer_line].join(' ').trim();
    changes.push('offer_line');
  }

  // 6. The required move, when the draft skipped it.
  if (plan.required_move === 'bridge' && !BRIDGE_RX.test(body)) {
    body = plan.bridge_line || bridgeLine(plan);
    changes.push('bridge');
  }
  if (referenceMove) {
    let failed = checkAgainstReference(body, refLine, refSlots, plan);
    // The model often writes a good acknowledgment and stops ("Good to hear
    // she can make it."), so the times and the question are missing (2026-10-03
    // logs). Its words stay, the reference's ask goes after them, and no
    // re-write is needed: a re-write cost 10-35s on SMS and often missed too.
    if (failed.length) {
      const repaired = appendReferenceAsk(body, refLine, failed);
      if (repaired && !checkAgainstReference(repaired, refLine, refSlots, plan).length) {
        changes.push('reference_ask_appended');
        return { text: withSignOff(repaired), changes, failed: [] };
      }
    }
    if (failed.length) {
      changes.push('backup_line');
      return { text: withSignOff(refLine), changes, failed };
    }
    return { text: changes.length ? withSignOff(body) : original, changes, failed: [] };
  }
  if (!body) {
    body = changes.includes('money_figures') ? NO_FIGURES_LINE
      : (changes.includes('consequence_repeat') || changes.includes('unapproved_claim')) ? bridgeLine(plan)
        : (original.trim() || NO_FIGURES_LINE);
  }
  return { text: changes.length ? withSignOff(body) : original, changes, failed: [] };
}
