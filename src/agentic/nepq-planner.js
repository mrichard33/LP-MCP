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

import { isWarrantyRequest, warrantyReference, WARRANTY_MARKERS } from './warranty-request.js';
import { isNotInterested } from './not-interested.js';
import { isLeadQuestion, findBookingAsks } from './discovery-discipline.js';
import { isTeamOpen, nextTeamOpenLabel, requestedCallTime, promisedCallback } from './team-hours.js';
import { heldSlot, COLLECT_ASK, dmAnswerFromThread } from './booking-collect.js';
import { RECHECK_RX } from './contact-check.js';
import { slotMentionIndex, offeredSlots as offeredIn, pickSlot } from '../live-chat/cancel-flow.js';
import { parseDayPreference, slotsForPreference, slotMatches, preferenceOfferLine } from './day-preference.js';
import { enforceOneAsk } from './one-ask.js';
import { isKnockComplaint } from './do-not-knock.js';
import { detectDeferral, pendingDeferral, isAcknowledgment, isSignOffLine, askedForSpace, POST_DEMO_QUESTIONS } from './post-demo-turn.js';
import { PURCHASED_ELSEWHERE_RX } from './purchased-elsewhere.js';
import { bestDealHintUsed } from './rehash.js';
import { rehashNepqTurn, bridgedRecently, rehashObjection, BEST_DEAL_RX, PRE_BRIDGE_STAGES, REHASH_STAGES, REHASH_BRIDGE_RX } from './rehash-nepq.js';
import { homeownerFromThread, OWNER_ASK_RX } from './homeowner.js';
import { jobScopeFromThread, openingsKnown, COUNT_ASK_RX } from './job-scope.js';
import { decisionMakersFromThread, dmSettled } from './qualifying.js';
import { extractZip } from './service-area-turn.js';
import { isLeadSignOff, leadWillReachOut } from './sign-off.js';

export { isKnockComplaint };

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
/** Did the lead ask for a phone call, or turn the visit down, anywhere in this conversation? Pure. */
export function leadWantsCall(conversation = [], trigger = '') {
  const texts = (Array.isArray(conversation) ? conversation : [])
    .filter(m => String(m?.direction || '').toLowerCase() !== 'outbound').map(m => String(m?.text ?? m?.body ?? ''));
  return [...texts, String(trigger || '')].some(t => VISIT_DECLINE_RX.test(t) || CALLBACK_RX.test(t));
}

/**
 * A phone call the lead did not ask for goes (2026-10-03 replay: "A quick call
 * would let us figure out what's happening" beside "What day works best for
 * the visit?"; on SMS "Want someone to give you a call and go over it?" became
 * a promised call nobody filed). The visit is the next step for everyone; the
 * call is the backup only when the lead asks for one (Mark, 2026-10-02).
 * Sentence by sentence; a promise WE already made stays (a hand-off line).
 * Pure. @returns {{ text, changed }}
 */
export function dropUnaskedCallOffer(text, { leadWantsCall: wants = false } = {}) {
  const body = String(text || '');
  if (wants || !body) return { text: body, changed: false };
  const sentences = splitSentences(body);
  const kept = sentences.filter(s => !isCallOffer(s));
  if (kept.length === sentences.length) return { text: body, changed: false };
  return { text: kept.join(' ').trim(), changed: true };
}

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
// PRICE_RX without the bare quote / estimate words (LEAD_STAGE_MODE=live).
const PRICE_WORD_RX = /\b(?:how\s+much|price[sd]?|pricing|costs?|ballpark|rough\s+(?:number|idea|figure)|what\s+(?:would|does|will)\s+(?:it|that|this)\s+(?:cost|run))\b/i;
// A plain request for a quote or an estimate.
export const QUOTE_REQUEST_RX = /\b(?:quotes?|estimates?)\b/i;
// 2026-10-12 (batch 3 T4/#5): a lead who went (or is going) with another
// company, before any demo. NEPQ's disarm, then how they would decide.
export const COMPETITOR_RX = /\b(?:went|going|gone|go|decided\s+to\s+go|signed|signing)\s+with\s+(?:another|a\s+different|some\s+other|other|someone\s+else|a\s+competitor)\b|\balready\s+(?:have|got|hired|picked|chose|found)\s+(?:a|another|someone|somebody)\b[^.?!]{0,30}\b(?:company|contractor|installer|guy|someone|somebody)?|\b(?:another|a\s+different)\s+company\s+(?:is|will\s+be|already)\b/i;
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
const CALLBACK_RX = /\b(?:call|ring|phone)\s+(?:me|us)\b[^.?!]{0,30}\b(?:at|around|after|before|tomorrow|today|tonight|this\s+(?:morning|afternoon|evening)|in\s+the\s+(?:morning|afternoon|evening)|anytime|any\s+time)\b|\b(?:call\s+me\s+back|give\s+me\s+a\s+call|have\s+someone\s+call\s+me)\b|\b(?:can|could|would|will)\s+(?:someone|somebody|you|a\s+(?:person|rep|team\s+member))\s+(?:please\s+)?(?:call|ring|phone)\s+me\b|^\s*(?:just\s+)?(?:please\s+)?call\s+me\b|\b(?:i'?d|i\s+would)\s+(?:rather|prefer\s+to)\s+(?:talk|speak|chat)\s+(?:on\s+the\s+phone|by\s+phone|over\s+the\s+phone)\b/i;
// 2026-10-03 (Mark's shutters thread): our own offer of a call ("Want someone
// to give you a call and go over it?"). A yes to it is a callback request.
export const CALL_OFFER_RX = /\b(?:want|would\s+you\s+like|should\s+i\s+have|can\s+(?:i|we)\s+have|shall\s+(?:i|we)\s+have)\s+(?:someone|somebody|us|me|a\s+(?:team\s+member|rep|specialist))\s+(?:to\s+)?(?:give\s+you\s+a\s+(?:call|ring)|call\s+you)\b|\b(?:can|could|may|should)\s+(?:we|i|someone)\s+(?:give\s+you\s+a\s+(?:quick\s+)?(?:call|ring)|call\s+you)\b|\bwhen'?s\s+(?:a\s+)?good\s+(?:time\s+)?for\s+a\s+(?:quick\s+)?call\b/i;
// A sentence that offers a phone call from us (2026-10-03: "A quick call would
// let us figure out what's happening" next to the visit ask). Dropped unless
// the lead asked for a call or turned the visit down (dropUnaskedCallOffer).
const CALL_OFFER_SENTENCE_RX = /\b(?:(?:quick|short|brief|15[\s-]*min(?:ute)?|fifteen[\s-]*min(?:ute)?|phone)\s+(?:call|chat)|give\s+you\s+a\s+(?:call|ring)|(?:call|ring|phone)\s+you\b|hop\s+on\s+(?:a\s+)?(?:call|the\s+phone)|(?:talk|chat|go\s+over\s+it)\s+(?:on|over)\s+the\s+phone)\b/i;
// The booking confirm's own sentence ("Someone from our team will give you a
// call to confirm the details", LINES.confirm, the user 2026-10-06) is our
// confirmation call for a visit just booked, not an offer of a call instead of
// the visit: it never counts as an unasked call offer.
const BOOKING_CONFIRM_CALL_RX = /\b(?:call|ring)\b[^.?!]*\bconfirm\s+(?:the\s+|your\s+)?(?:details|appointment|visit)\b/i;
export function isBookingConfirmCall(sentence) {
  return BOOKING_CONFIRM_CALL_RX.test(String(sentence || '')) && !String(sentence || '').trim().endsWith('?');
}
const isCallOffer = (s) => CALL_OFFER_SENTENCE_RX.test(s) && !isBookingConfirmCall(s);
// A booking line in the thread: the old "You're all set for …" and the new
// "You're on the calendar for …" (LINES.confirm, 2026-10-06).
const BOOKED_LINE_RX = /\byou(?:'|’)?re\s+all\s+set\s+for\b|\byou(?:'|’)?re\s+on\s+the\s+calendar\s+for\b/i;
// 2026-10-03 (Mark): "only sales related callbacks go [to Five9 and
// #contact-center]. Anything related to service should let the lead know a
// team member will reach out and send to the Slack service channel." A call
// asked for about an install, an order, a repair or a warranty is service.
const SERVICE_TOPIC_RX = /\b(?:warrant(?:y|ies)|repairs?|service\s+(?:call|request|visit|appointment|team|department)|my\s+(?:install(?:ation)?|installers?|order|job|project|contract|permit|account)|install(?:ation)?\s+(?:date|day|status|time|schedule|issue|problem)|(?:when|what\s+(?:day|time))\s+(?:are|is|will|do)\s+(?:you|they|y'?all|the\s+(?:crew|installers?|team))\s+(?:coming|come|start|install|be\s+(?:here|there|out))|(?:already|existing)\s+(?:a\s+)?customer|(?:you|reece|y'?all|your\s+(?:team|crew|company))\s+(?:guys\s+)?(?:installed|put\s+in|replaced)|(?:bought|purchased|got)\s+(?:my\s+|our\s+|the\s+)?(?:windows?|doors?)?\s*(?:from|through)\s+(?:you|reece))\b/i;
// A known customer asking about NEW work is a sales call ("more windows").
const SALES_TOPIC_RX = /\b(?:quote|estimate|price|pricing|cost|new\s+(?:windows?|doors?)|more\s+(?:windows?|doors?)|another\s+(?:window|door|room|house|home|project)|additional|replace\s+(?:more|the\s+rest|other)|rest\s+of\s+(?:the\s+)?(?:house|home|windows))\b/i;
/**
 * Is a call request a SERVICE call rather than a sales call? Pure.
 * Service when the lead's own words are about an install, order, repair or
 * warranty, or when a known customer asks without naming new work.
 */
export function isServiceCallback({ conversation = [], trigger = '', isCustomer = false } = {}) {
  const texts = [...(Array.isArray(conversation) ? conversation : [])
    .filter(m => String(m?.direction || '').toLowerCase() !== 'outbound').map(m => String(m?.text ?? m?.body ?? '')).slice(-6), String(trigger || '')];
  if (texts.some(t => SERVICE_TOPIC_RX.test(t) || SERVICE_RX.test(t))) return true;
  return !!isCustomer && !texts.some(t => SALES_TOPIC_RX.test(t));
}

const COMPLAINT_RX = /\b(?:supposed\s+to\s+(?:come|show|be\s+(?:here|there)|call|arrive)|never\s+(?:came|showed(?:\s+up)?|arrived|called(?:\s+(?:me\s+)?back)?)|(?:didn'?t|did\s+not)\s+(?:come|show(?:\s+up)?|arrive|call(?:\s+(?:me\s+)?back)?)|stood\s+(?:me|us)\s+up|waited\s+all\s+(?:day|morning|afternoon)|(?:nobody|no\s+one|no-one)\s+(?:showed|came|called|answered)|complain\w*|ripped\s+off|rip[-\s]?off|scam\w*|refund|lawyer|attorney|sue\b|bbb|better\s+business|manager|supervisor|no[-\s]?show(?:ed)?|never\s+showed|(?:nobody|no\s+one)\s+(?:came|showed|called|answered)|unprofessional|rude|terrible\s+service|worst)\b/i;

// Do-not-knock (2026-10-03): detection lives in do-not-knock.js, shared with
// the opt-out gate (a door complaint is not a text opt-out).
export const DNK_ASK_RX = /\bdo[-\s]not[-\s]knock\s+list\b/i;
const DNK_NAME_ASK_RX = /\bwhat\s+name\b/i;
/** Our do-not-knock address ask (not the name ask, which may mention the address). Pure. */
function isDnkAddressAsk(text) {
  const t = String(text || '');
  return DNK_ASK_RX.test(t) && /\baddress\b[^?]*\?/i.test(t) && !DNK_NAME_ASK_RX.test(t);
}
/** Our closing do-not-knock line: about the list, asking for nothing. Pure. */
function isDnkClose(text) {
  const t = String(text || '');
  return DNK_ASK_RX.test(t) && !isDnkAddressAsk(t) && !DNK_NAME_ASK_RX.test(t);
}
// What the next turn reads back from the model's version (Part 7 check).
const DNK_MARKERS = {
  address: [{ rx: DNK_ASK_RX, say: 'name "our do-not-knock list"' }, { rx: /\baddress\b/i, say: 'ask for the address' }],
  name: [{ rx: /\bwhat\s+name\b/i, say: 'ask "what name" to put with it' }],
  done: [{ rx: DNK_ASK_RX, say: 'say they are on "our do-not-knock list"' }],
};

/** A bare name reply ("Linda", "It's Linda Moore") or null. Pure. */
function nameFromDnkReply(text) {
  const m = String(text || '').trim().match(/^(?:(?:it'?s|this\s+is|my\s+name\s+is|i'?m)\s+)?([A-Za-z][A-Za-z'-]{1,30})(?:\s+[A-Za-z][A-Za-z'-]{1,30})?[.!]?$/i);
  return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase() : null;
}


const SPOUSE_RX = /\b(?:wife|husband|spouse|partner|fianc[ée]e?)\b/i;
const SPOUSE_OBJECTION_RX = /\b(?:talk|check|ask|discuss|run\s+(?:it|this))\b[^.?!]{0,40}\b(?:wife|husband|spouse|partner)\b|\b(?:wife|husband|spouse|partner)\b[^.?!]{0,40}\b(?:decides?|has\s+to|needs?\s+to|wants?\s+to|would\s+have\s+to|isn'?t\s+(?:here|home|sure))\b/i;
const SHOPPING_RX = /\b(?:(?:\d|two|three|four|few|couple(?:\s+of)?|multiple|other|more)\s+(?:quotes|estimates|bids|companies|contractors)|shopping\s+around|comparing|getting\s+(?:other\s+)?(?:quotes|estimates|bids))\b/i;
const THINK_RX = /\b(?:think\s+(?:it\s+over|about\s+it|on\s+it)|sleep\s+on\s+it|get\s+back\s+to\s+you|let\s+me\s+(?:think|see|check)|maybe\s+later|not\s+(?:right\s+)?now|need\s+(?:some\s+)?time)\b/i;
export const YES_RX = /^\s*(?:y(?:es|eah|ep|up)|sure|ok(?:ay)?|sounds\s+good|that\s+works|please|absolutely|definitely|why\s+not|let'?s\s+do\s+it|i'?d\s+like\s+that)\b/i;
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
// 2026-10-15 (Guest Visitor pkjiz): a calendar date is a day too. "24th" and
// "October 24th", answering "Sat, Oct 17 … or Sat, Oct 24 …", matched nothing
// here, so the planner re-offered the same two times, then asked "What day
// works best?", then offered them again. Month + day, an ordinal day, and m/d.
const DATE_MENTION_SRC = String.raw`\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(?:the\s+)?\d{1,2}(?:st|nd|rd|th)?\b|(?:^|[^\d/:$])(?:[4-9]|[12]\d|3[01])(?:st|nd|rd|th)\b|(?:^|[^\d/])(?:0?[1-9]|1[0-2])\s*\/\s*(?:0?[1-9]|[12]\d|3[01])(?![\d/])`;
const DAY_OR_TIME_RX = new RegExp(String.raw`\b(?:mon|tues?|wed(?:nes)?|thurs?|fri|sat(?:ur)?|sun)(?:day)?s?\b|\bweekends?\b|\btomorrow\b|\btoday\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)\b|\b(?:morning|afternoon|evening)\b|\bthe\s+(?:first|second|earlier|later)\s+one\b|\beither\b|${DATE_MENTION_SRC}`, 'i');

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
export const BRIDGE_RX = /\bbased\s+on\s+what\s+you\s+(?:told|said|mentioned)\b|\bthis\s+could\s+work\s+for\s+you\b|\b(?:the\s+)?(?:easiest\s+|best\s+)?next\s+step\s+(?:would\s+be|is)\b/i;
// A vague opener: a greeting, or "I need new windows" with nothing else to go on.
const OPENER_RX = /^\s*(?:(?:hi|hello|hey|howdy|good\s+(?:morning|afternoon|evening))(?:\s+there)?[\s!.,]*|(?:hi|hello|hey)?[\s,!.]*(?:i\s+(?:need|want|am\s+looking\s+for|'m\s+looking\s+for)|looking\s+(?:for|into)|interested\s+in)\s+(?:some\s+|new\s+|a\s+few\s+)*(?:impact\s+)?(?:windows?|doors?|windows?\s+and\s+doors?)[\s!.]*)$/i;
// Part 7: the bot words its own day ask now, so any day/time question counts.
const ASK_DAY_RX = /\bwhat\s+day\s+(?:works\s+best|would\s+be\s+easiest)\b|\bwhich\s+day\s+is\s+best\b|\b(?:what|which)\s+(?:day|days|time\s+of\s+day)\b[^.?!]*\?|\bwhen\s+(?:works|would\s+work|is\s+(?:a\s+)?good)\b[^.?!]*\?/i;
const STATUS_FRAME_RX = /\bpretty\s+simple\b|\bsee\s+what\s+you\s+have\s+now\b|\bif\s+it\s+might\s+be\s+a\s+fit\b/i;
const REVEAL_RX = /\banything\s+you'?re\s+wondering\s+about\b|\bbefore\s+your\s+visit\b/i;
export const SLOT_OFFER_RX = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b[^?]{0,80}\bor\b|\bI\s+have\s+[^?]{0,80}\bor\b[^?]*\?/i;
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
  // 2026-10-13 (the owner's ruling after the Erica Hilts chat): a price ask is
  // answered with questions first, then the visit. Her "what's an average
  // price?" got two visit times, and the next ask a promised call she never
  // wanted. 1st ask: an honest line on what drives the price and ONE scoping
  // question (the count question itself, so the count gate never asks it
  // again; when the count is known, the style and size). 2nd ask: the free
  // measure as a yes/no question, no times (BRIDGE_RX reads it, so a yes gets
  // the times). 3rd ask: a call OFFERED as a question, never promised; Five9
  // hears only after a yes (CALL_OFFER_RX). Every one keeps "every home is
  // different" (PRICE_PLAY_RX counts them) except the call offer.
  price_scope: (countKnown) => (countKnown
    ? 'Fair question. Every home is different: the price depends on the size, the style and the impact glass. What style are you thinking about, and roughly how big is the opening?'
    : 'Fair question. Every home is different: the price depends on how many openings, their size and the impact glass. How many windows are you thinking about, and is it the whole house or a few openings?'),
  price_visit_offer: 'Totally fair. Every home is different, so an exact number comes from measuring. The next step would be a free visit to measure. Would that be helpful?',
  price_call_offer: 'Understood. It might help to talk it through with one of our specialists. Can we give you a quick call?',
  // Asked again after the call offer: no more questions, nothing promised.
  price_rest: "Understood. An exact number has to come from measuring, so I'll leave it there. If you'd like a free measure or a call, just reply here.",
  // 2026-10-13 (Erica Hilts; the reviewer's rule): "not now", "I'll call back",
  // "have a good day" get a short warm goodbye. No times, no question, no
  // promise to follow up, nothing filed.
  sign_off: (name, booked = false) => (booked
    ? `Thanks${name ? `, ${name}` : ''}. Have a great day.`
    : `Sounds good${name ? `, ${name}` : ''}. We're here whenever you're ready. Have a great day.`),
  // "You just said that": no more questions, the next step.
  repeat_slots: (slots) => `You're right, sorry about that. Let's get you a time instead. I have ${slotPair(slots)}. Which works better?`,
  repeat_no_slots: "You're right, sorry about that. A team member will call to set a time for the visit.",
  callback: (when) => `Got it. I'll have someone from our team call you${when ? ` ${when}` : ''}.`,
  spouse_1: 'Makes sense. How does your spouse feel about getting this done?',
  spouse_2_slots: (slots) => `Would it be easier to pick a time when you're both home? I have ${slotPair(slots)}.`,
  spouse_2_no_slots: "Would it be easier to pick a time when you're both home? What day works best for you both?",
  shopping: "Smart move. Let's say everyone checks every box, price included. How would you decide?",
  // 2026-10-12 (handoff PR 3): NEPQ's "maybe nothing" disarm for a lead who
  // went with someone else, then the decision question. Read back by DECIDE_Q_RX.
  competitor: "That's fair, and maybe nothing would change that. Suppose we both meet your criteria, including price. How would you then decide?",
  // 2026-10-12: a plain quote request (NEPQ info request).
  info_request: 'Yes, we can help with that. Just so we get you the right thing, what are you hoping to see?',
  think_slots: (slots) => `No problem at all. Want to grab a time now so you don't have to chase us down later? I have ${slotPair(slots)}.`,
  think_no_slots: "No problem at all. What day would work best if you did want someone to come out, so you don't have to chase us down later?",
  // 2026-10-13: the think play while the qualifying gate is still open (no time).
  think_no_times: "That's fair. What's the main thing you'd want to think over?",
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
  // 2026-10-06 (the user): "You're all set, someone from our team will give
  // you a call to confirm the details and schedule you on the calendar for
  // (requested day/time)". The visit is still booked (unconfirmed) as before;
  // the call is the phone room's confirmation call (the Conf lists), never a
  // Five9 Callback Request: NOT_A_CALLBACK_RX in team-hours.js keeps this line
  // out of promisedCallback, and isBookingConfirmCall keeps it from being
  // dropped as an unasked call offer.
  confirm: (slot, tz, name) => `You're all set${name ? `, ${name}` : ''}. Someone from our team will give you a call to confirm the details. You're on the calendar for ${slot.day} at ${slot.time}${tz ? ` ${tz}` : ''}.`,
  handoff: {
    complaint: "I'm sorry about that. I'm getting someone from our team on this now.",
    emergency: "That's urgent. I'm getting someone from our team on this right now.",
    // 2026-10-03 (Mark): service tells the lead a team member will reach out.
    service: "Sorry about that. I'm passing this to our service team, and a team member will reach out.",
    service_callback: "Got it. I'm passing this to our service team, and a team member will reach out.",
    // 2026-10-03 (review of Part 14): two no's is a card for a person to
    // review, never an auto-dial, so the line promises no contact.
    two_nos: "No problem, I'll stop here. If anything changes, just reply here.",
    repeat_objection: "Understood. I'll have someone from our team call you so you get a straight answer.",
  },
  // 2026-10-02 (Mark): "right now" only while the team is in (team-hours.js).
  // After hours the same hand-off names when someone will call.
  handoff_closed: {
    complaint: (when) => `I'm sorry about that. I've passed this to our team, and someone will call you ${when}.`,
    emergency: (when) => `That's urgent. I've flagged it for our team, and someone will call you ${when}.`,
    service: (when) => `Sorry about that. I've passed this to our service team, and a team member will reach out ${when}.`,
    service_callback: (when) => `Got it. I've passed this to our service team, and a team member will reach out ${when}.`,
  },
  callback_outside_hours: (when) => `Got it. That's outside our team's hours, so I'll have someone call you ${when}.`,
  // 2026-10-03: a complaint about a canvasser at the door. No sales call;
  // collect the address (and a name if we have none) for the do-not-knock list.
  dnk: {
    ask_address: "I'm sorry about that. I'll make sure our team doesn't knock on your door again. What's the address, so I can add it to our do-not-knock list?",
    ask_name: 'Thank you. And what name should I put with it?',
    done: (name) => `Thank you${name ? `, ${name}` : ''}. You're on our do-not-knock list, and our team won't knock on your door again.`,
  },
});

// ── The qualifying gate (Lead Conversation Stage, LEAD_STAGE_MODE=live) ──
// 2026-10-12 (handoff; the user's ruling the same day): no single-leg
// visits. Before any visit time is offered the lead owns the home, we know
// the zip, and every decision maker is the lead alone or named AND able to be
// there. One item per message, only what is unknown, in this order. Each
// line has a second wording (never the same question twice), and each keeps
// the words qualifying.js / homeowner.js / booking-collect.js read back.
export const QUALIFY_LINES = Object.freeze({
  // 2026-10-13 (live eval): no "Happy to set that up." opener. It read as a
  // yes to "let me think about it" and to a third price ask.
  homeowner: ['Just so I point you the right way, do you own the home?', 'Quick question before I pull up times: are you the homeowner?'],
  zip: ["What's the zip code at the home?", 'And what zip code is the home in?'],
  // 2026-10-13 (the user's wording): the count, so a job under the minimum
  // (three windows or doors, or one sliding glass door) is caught before any
  // time is offered (job-scope.js). Asked ONCE: an unknown count never blocks.
  openings: ['How many windows and doors are you looking to get a quote on?', 'How many windows and doors are you looking to have us come measure?'],
  decision_makers: ['Is anyone else part of the decision on this, like a spouse or partner?', 'Will anyone else be weighing in on this decision?'],
  dm_presence: ['Will they be able to make it to the visit too?', 'Would they be able to be there for the visit as well?'],
  dm_absent: ['No problem. What day works best when you can both be there?', 'Got it. Which day would let you both be there?'],
});
const QUALIFY_MARKERS = Object.freeze({
  homeowner: [{ rx: /\bown\b|\bhomeowner\b/i, say: 'ask if they own the home' }],
  zip: [{ rx: /\bzip\b/i, say: 'ask for the zip code' }],
  openings: [{ rx: /\bhow\s+many\s+(?:windows?|doors?|openings?)\b/i, say: 'ask how many windows and doors they want quoted' }],
  decision_makers: [{ rx: /\b(?:anyone|anybody|someone)\s+else\b|\bpart\s+of\s+the\s+decision\b|\bweigh(?:ing)?\s+in\b/i, say: 'ask if anyone else is part of the decision' }],
  dm_presence: [{ rx: /\bable\s+to\s+(?:be\s+there|make\s+it)\b/i, say: 'ask if they will be able to be there (or make it) for the visit' }],
  dm_absent: [{ rx: /\bboth\s+(?:of\s+you\s+)?(?:be\s+there|be\s+home|make\s+it)\b/i, say: 'ask what day works when they can both be there' }],
});
const QUALIFY_ASK_RX = /\bdo\s+you\s+own\b|\bhomeowner\b|\bzip\s+code\b|\bhow\s+many\s+(?:windows?|doors?|openings?)\b|\b(?:anyone|anybody)\s+else\b[^?]*\bdecision\b|\bweigh(?:ing)?\s+in\b|\bable\s+to\s+(?:be\s+there|make\s+it)\b|\bboth\s+be\s+there\b/i;
// A street address the lead typed (a number, then a street word): ready to book.
const STREET_ADDRESS_RX = /\b\d{2,6}\s+(?:[NSEW]\.?\s+)?[A-Za-z0-9'.]+(?:\s+[A-Za-z0-9'.]+){0,3}\s+(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|ct|court|cir|circle|way|pl|place|ter|terrace|pkwy|parkway|hwy|highway|trl|trail|loop)\b/i;

/**
 * What the gate knows THIS turn: the stored facts, updated by the thread (the
 * lead may have just answered). Pure.
 */
export function stageFactsNow(stage, turns = [], knownZip = null, knownOpenings = false) {
  const f = stage?.facts || {};
  const owner = homeownerFromThread(turns);
  const dm = decisionMakersFromThread(turns);
  let zip = f.zip || knownZip || null;
  const inbound = turns.filter(t => t.direction === 'inbound');
  for (let i = inbound.length - 1; i >= 0 && !zip; i--) zip = extractZip(inbound[i].text);
  return {
    ...f,
    homeowner: owner !== 'unknown' ? owner : (f.homeowner || 'unknown'),
    decision_makers: dm !== 'unknown' ? dm : (f.decision_makers || 'unknown'),
    zip,
    openings_known: !!f.openings_known || !!knownOpenings || openingsKnown(turns),
  };
}

/**
 * The gate's next item, or null when nothing blocks the times. An item asked
 * twice and still unclear is not asked a third time (the explicit renter
 * statement is what blocks; homeowner.js reads it). Pure.
 */
export function nextQualifyItem(facts = {}, outbound = []) {
  const asked = (key) => outbound.filter(m => QUALIFY_MARKERS[key].some(k => k.rx.test(String(m.text || '')))).length;
  if (facts.homeowner !== 'yes' && facts.homeowner !== 'no' && asked('homeowner') < 2) return 'homeowner';
  if (!facts.zip && asked('zip') < 2) return 'zip';
  if (!facts.openings_known && asked('openings') < 1) return 'openings';
  const dm = facts.decision_makers;
  if (!dmSettled(dm)) {
    if (dm === 'named' && asked('dm_presence') < 2) return 'dm_presence';
    if (dm === 'named_absent' && asked('dm_absent') < 2) return 'dm_absent';
    if ((dm === 'unknown' || !dm) && asked('decision_makers') < 2) return 'decision_makers';
  }
  return null;
}

// Second wordings for lines that can come up twice in one thread (Mark,
// 2026-10-02: "There needs to be variation in each comment"). Variant 0 is
// always the LINES wording; `vary` in planNepqTurn picks one not yet sent.
// Each keeps the phrase other code reads ("every home is different",
// "I have … or …", the "?").
export const ALT_LINES = Object.freeze({
  ask_day: ['Sure thing. What day would be easiest for you?', 'Okay. Which day is best for you?'],
  which: (slots) => [`Sounds good. Which one works for you, ${slotPair(slots)}?`, `Thanks. Should I hold ${slotPair(slots)} for you?`],
  price_visit_offer: ['I hear you. Since every home is different, an exact number comes from measuring. The next step would be a free visit to measure. Would that help?'],
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
export function isPriceAsk(text, { quoteIsPrice = true } = {}) {
  const t = String(text || '');
  if (MONEY_FIGURE_ASK_RX.test(t)) return true;
  if (FINANCING_ONLY_RX.test(t) && !/\bhow\s+much\b/i.test(t)) return false;
  if (SCHEDULE_ASK_RX.test(t) && !/\b(?:how\s+much|cost|price|pricing|ballpark)\b/i.test(t)) return false;
  // 2026-10-12 (LEAD_STAGE_MODE=live; batch 3 #2): "can I get a quote?" asks
  // for the thing we do (a written quote at the visit), not for a number.
  // Only "how much", a price word or an insist ("just need a quote") is a
  // price ask then; a plain quote request gets the info-request play.
  if (!quoteIsPrice) return PRICE_WORD_RX.test(t) || INSIST_RX.test(t);
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

// ── Post-demo objections and no's (Shawn Eastman 39JdHrmdeQQtlJdDyS2r, 2026-10-15) ──
// A post-demo OPPFDN lead wrote "We like your product the best, but … it is
// roughly twice the cost of our other estimates." The bot argued three times
// ("The cheaper bids we see usually cut something … folks end up replacing in
// five years", "what actually holds up is what you can prove five years down
// the line"), kept selling after "Not at this time. Thanks", and got "This is
// obviously an AI bot. Stop texting". planPostDemo returned before every
// objection rule, the no counter stopped at the first message that was not a
// no, and the only stop was the rehash track's two no's IN A ROW. Now the
// post-demo ladder is code (CANON.STD.011): one ask-back, one bridge with real
// call times, then a person; two no's in the session stop the selling.
//
// A soft no ("Not at this time", "we're good") counts only as the answer to
// one of our offers or track questions, so a pre-demo "not right now" to a
// discovery question is not a no (DECLINE_RX is unchanged on purpose).
const SOFT_DECLINE_RX = /^\s*(?:no[,.!]?\s+)?(?:not\s+at\s+(?:this|the\s+moment|the\s+present)(?:\s+time)?|not\s+right\s+now|not\s+now|no\s+thank\s+you|no\s+thanks|(?:we|i)(?:'|’)?(?:re|m)\s+(?:good|all\s+set|fine)|(?:we|i)\s+(?:are|am)\s+(?:good|all\s+set|fine)|(?:we|i)(?:'|’)?ll\s+pass|(?:we|i)\s+will\s+pass|not\s+interested)\b/i;
const POST_DEMO_OFFER_RX = /\bwould\s+(?:a\s+)?(?:quick\s+)?call\s+help\b|\bwould\s+that\s+help\b|\bgive\s+you\s+a\s+(?:ring|call)\b/i;

/** A no on the post-demo line: isNo, or a soft no to our offer / track question. Pure. */
export function isPostDemoNo(text, lastOutbound = '') {
  const t = String(text || '');
  if (isNo(t, lastOutbound)) return true;
  if (!SOFT_DECLINE_RX.test(t)) return false;
  const o = String(lastOutbound || '');
  return CALL_OFFER_SENTENCE_RX.test(o) || BRIDGE_RX.test(o) || POST_DEMO_OFFER_RX.test(o) || REHASH_BRIDGE_RX.test(o) || REHASH_STAGES.some(st => st.rx.test(o));
}

// A post-demo price objection: the cost itself, never a question asking what
// the number was ("what was the price again?" is a question to answer).
const POST_DEMO_PRICE_RX = /\b(?:costs?|price[sd]?|pricing|pricey|expensive|budget|afford|cheaper|too\s+(?:much|high|steep))\b/i;
const PRICE_INFO_Q_RX = /\b(?:how\s+much|what(?:'|’)?s\s+the\s+(?:price|cost|total)|what\s+(?:is|was)\s+the\s+(?:price|cost|total))\b[^.!]*\?/i;

/**
 * The post-demo objection in this message: 'price' | 'competitor' | 'think' |
 * 'spouse' | null. A no, a deferral-free "we signed elsewhere" and a plain
 * question about the number are not objections. Price first: after a demo the
 * cost gap is the objection even when they name other estimates. Pure.
 */
export function postDemoObjection(text, lastOutbound = '') {
  const t = String(text || '');
  if (!t.trim() || isPostDemoNo(t, lastOutbound) || PURCHASED_ELSEWHERE_RX.test(t)) return null;
  if (PRICE_INFO_Q_RX.test(t)) return null;
  const r = rehashObjection(t)?.type || null;
  if (r === 'price' || POST_DEMO_PRICE_RX.test(t)) return 'price';
  if (r === 'other_quote' || SHOPPING_RX.test(t) || COMPETITOR_RX.test(t)) return 'competitor';
  if (r === 'think' || THINK_RX.test(t)) return 'think';
  if (r === 'spouse' || SPOUSE_OBJECTION_RX.test(t)) return 'spouse';
  return null;
}

// The ask-back, one question, by objection type (rehash-nepq.js OBJECTIONS).
export const POST_DEMO_ASK_BACK = Object.freeze({
  price: (hi = '') => `Too expensive compared to what you were quoted elsewhere${hi}?`,
  competitor: () => 'How do they compare, out of curiosity?',
  think: () => 'What part do you want to think through?',
  spouse: () => "What do you think they'll want to know?",
});

// Our post-demo stop line, read back (the stop is sticky for the session).
export const POST_DEMO_STOP_RX = /\bi(?:'|’)?m\s+here\s+if\s+anything\s+changes\b/i;

// The shopping play's question. The reply to it names what they decide on
// ("probably price and the warranty"): that is an answer, not a price ask
// (2026-10-02 simulation: it fired the price play, and the next "price"
// would have handed the lead to a person).
// The bot's own quote line (see LINES.quote_*).
// Every price reply says why there is no number yet; the next turn counts
// these to decide quote → times → a person (Part 7: the model words them).
const PRICE_PLAY_RX = /\bevery\s+(?:home|house)(?:'s|’s|\s+is)\s+(?:a\s+little\s+)?different\b|\bany\s+number\s+i\s+gave\b|\ba\s+number\s+(?:right\s+)?now\s+would\s+(?:just\s+)?be\s+a\s+guess\b/i;
// The first price ask's question asks about the job, never for a visit.
const PRICE_SCOPE_MARKERS = Object.freeze([{ rx: /\b(?:how\s+many|style|size|sizes|big|whole\s+house|openings?)\b[^?.!]*\?/i, say: 'end on the scoping question (how many windows, or the style and size), not a visit or calendar ask' }]);
// Our own third-price-ask call offer (LINES.price_call_offer, model-worded).
const PRICE_CALL_OFFER_RX = /\btalk\s+it\s+through\b[^?]*\?|\b(?:give\s+you\s+a\s+(?:quick\s+)?call|call\s+you)\b[^.!]*\?/i;
// A message of ours that ends an open time offer: a hand-off to a person, a
// call we promised, or a stop line (2026-10-13, Erica Hilts).
// A message of ours that ENDS on a goodbye ("… Have a great day.", "Enjoy
// your week.", "I'll check back next week."). Narrower than isSignOffLine:
// "We're here to help." after an answer leaves the offer open.
const CLOSING_LINE_RX = /\bhave\s+a\s+(?:great|good|nice|wonderful)\s+(?:day|week|weekend|evening|night|one)\b|\btake\s+care\b|\b(?:i|we)(?:'|’)?ll\s+check\s+back\b|\bwhenever\s+you(?:'|’)?re\s+ready\b|^\s*enjoy\b[^?]*$/i;
const OFFER_CLOSED_RX = /\bsomeone\s+from\s+our\s+team\s+(?:will\s+)?(?:call|on\s+this)\b|\bhave\s+someone\s+(?:from\s+our\s+team\s+)?call\s+you\b|\bpassing\s+this\s+to\s+our\b|\bI'?ll\s+stop\s+here\b|\bI'?ll\s+leave\s+it\s+there\b/i;
const COMPETITOR_PLAY_RX = /\bmaybe\s+nothing\s+would(?:'ve|\s+have)?\s+change[ds]?\b|\bboth\s+meet\s+your\s+criteria\b/i;
const INFO_PLAY_RX = /\bjust\s+so\s+we\s+get\s+you\s+the\s+right\s+thing\b/i;
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
// 2026-10-13 (live eval): the model words this play, and "what would actually
// decide it for you?" was not read back, so the criteria reply fell into
// discovery and never reached the times.
const DECIDE_Q_RX = /\bhow\s+would\s+you\s+(?:then\s+)?decide\b|\bwhat\s+would\s+(?:actually\s+|really\s+)?(?:decide\s+it|make\s+the\s+(?:call|difference))\b|\bwhat(?:'s|\s+is)\s+(?:actually\s+|really\s+)?going\s+to\s+decide\b/i;
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
  // "We went with another company" again is the competitor objection again (2026-10-12).
  return DECIDE_Q_RX.test(String(lastOutbound || '')) && !SHOPPING_RX.test(t) && !COMPETITOR_RX.test(t) && !INSIST_RX.test(t) && !/\bhow\s+much\b/i.test(t);
}

/** The objection family in this text, or null. Pure. */
export function objectionType(text, lastOutbound = '', { quoteIsPrice = true, competitor = false } = {}) {
  const t = String(text || '');
  if (isCriteriaReply(t, lastOutbound)) return null;
  if (CRITERIA_LIST_RX.test(t) && !INSIST_RX.test(t) && !/\bhow\s+much\b/i.test(t)) return null;
  // Another company already chosen (LEAD_STAGE_MODE=live): its own play.
  if (competitor && COMPETITOR_RX.test(t)) return 'competitor';
  // Shopping before price: "getting 3 quotes" is about deciding, not a price ask.
  if (SHOPPING_RX.test(t)) return 'shopping';
  if (isPriceAsk(t, { quoteIsPrice })) return 'price';
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

// ── Earn the ask (Mark, 2026-10-03) ───────────────────────────────────────
// "I want the bot to earn the ask for the appointment using NEPQ." The bridge
// to the free visit used to come after a COUNT of questions (2 on chat, 3 on
// SMS), whatever the answers were. It now needs the problem in the lead's own
// words AND an answer to one "why it matters / what if you wait" question
// (NEPQ consequence), or the lead volunteering that weight on their own.
// Shortcuts are unchanged (Mark: "keep how we had"): a quote or price ask, a
// request to schedule or come out, a typed day and time, and the objection
// plays still reach times on their own paths. A lead who will not engage
// (two vague answers) is bridged anyway, and nobody is questioned past
// cap + 2 questions.
const WANT_PROBLEM_RX = /\b(?:impact|peeling|hard\s+to\s+(?:open|close|lock)|won'?t\s+(?:open|close|lock|seal)|(?:don'?t|doesn'?t)\s+(?:open|close|lock|seal)|single[-\s]?pane|termites?|water\s+(?:comes|coming|gets|getting)\s+in|let(?:s|ting)?\s+(?:the\s+)?(?:heat|cold|water|air)\s+in)\b/i;
// A "why it matters" question from us, besides CONSEQUENCE_RX (NEPQ's probing
// trio: has it had an impact, in what way, what would fixing it mean). "What's
// got you looking?" and "how long?" ask for the problem, not its weight.
const WHY_ASK_RX = /\b(?:had|having|has\s+(?:that|it|this)\s+had)\s+an\s+impact\b|\bhow\s+(?:is|are|has|have)\s+(?:that|it|this|those|they)\s+(?:been\s+)?(?:affect|impact|bother|feel)\w*\b|\bin\s+what\s+way\b|\bwhat\s+would\s+(?:it|that|fixing\s+\w+|getting\s+\w+(?:\s+\w+)?)\s+(?:mean|do)\b|\bwhat'?s\s+(?:that|it)\s+(?:been\s+)?cost(?:ing)?\b|\bwhy\s+(?:is\s+(?:that|it|this)\s+)?(?:important|a\s+priority)\b/i;
// The lead volunteering why it matters: urgency, a feeling, a cost.
const WEIGHT_RX = /\b(?:getting\s+worse|worse\s+every|worried|worry|scared|afraid|nervous|tired\s+of|sick\s+of|fed\s+up|frustrat\w*|annoy\w*|stress\w*|expensive|costing|through\s+the\s+roof|before\s+(?:the\s+)?(?:next\s+)?(?:storm|hurricane|season|summer|winter)|asap|as\s+soon\s+as|right\s+away|this\s+(?:year|season|month)|insurance\s+(?:wants|requires|dropped|went\s+up)|safety|kids?|baby|elderly|selling\s+(?:the\s+)?house)\b/i;

/** Did the lead earn the visit ask? { problem, consequence, earned }. Pure. */
export function discoveryEarned(conversation = [], trigger = '') {
  const turns = normalizeThread(conversation, trigger);
  const problem = turns.some(t => t.direction === 'inbound' && (new RegExp(PROBLEM_RX.source, 'i').test(t.text) || WANT_PROBLEM_RX.test(t.text)));
  let consequence = false;
  for (let i = 0; i < turns.length && !consequence; i++) {
    const t = turns[i];
    if (t.direction !== 'inbound') continue;
    const text = String(t.text || '');
    if (VAGUE_ANSWER_RX.test(text)) continue;
    if (WEIGHT_RX.test(text)) { consequence = true; break; }
    // An answer to our "why it matters" question counts once the problem was
    // already out: the problem itself, given in reply, is not the reason.
    const problemBefore = turns.slice(0, i).some(x => x.direction === 'inbound' && (new RegExp(PROBLEM_RX.source, 'i').test(x.text) || WANT_PROBLEM_RX.test(x.text)));
    const prevOut = [...turns.slice(0, i)].reverse().find(x => x.direction === 'outbound')?.text || '';
    if (problemBefore && (CONSEQUENCE_RX.test(prevOut) || WHY_ASK_RX.test(prevOut))) consequence = true;
  }
  return { problem, consequence, earned: problem && consequence };
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
function planNepqTurnCore({
  channel = 'sms', trigger = '', conversation = [], slots = [], tzLabel = '', firstName = null,
  hasAppointment = false, nextStepLabel = 'a free visit at your home', discipline = null, nowMs = Date.now(),
  allSlots = null, isCustomer = false, callbackRequested = false,
  // 2026-10-09 (Mark): the lead already had the in-home demo (rehash, or past
  // the appointment). rehashRep is the rep the reply is written as, if named.
  postDemo = false, rehashRep = null,
  // 2026-10-11: a rehash lead (not just past the appointment): the post-demo
  // NEPQ track (rehash-nepq.js) applies. Defaults to "a rep is named".
  rehash = null,
  // 2026-10-09 (the user): the rep's real Rehash Call openings
  // ({ offer: [2], all: [...] }, rehash-slots.js), or null for none.
  callSlots = null,
  // 2026-10-12 (LEAD_STAGE_MODE=live, PR 3): a plain quote request is the
  // info-request play, not a price objection; the competitor play is on.
  stageLive = false,
  // 2026-10-12 (Lead Conversation Stage): the stored stage ({ stage, facts },
  // src/agentic/lead-stage.js), passed ONLY when LEAD_STAGE_MODE=live. Null
  // leaves every step exactly as before. knownZip: the zip on file.
  stage = null, knownZip = null,
  // 2026-10-13: the window/door count is on the contact (the price play's
  // scoping question then asks the style and size instead).
  knownOpenings = false,
  // 2026-10-15 (Jeff Clark): the warranty files are configured
  // (WARRANTY_PDF_URLS), so a copy asked for is sent with this reply.
  warrantyAvailable = false,
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
  // 2026-10-13 (Erica Hilts): a hand-off or a goodbye of ours closes the
  // offer too. "I'll have someone from our team call you" came between her
  // offer and "I can call back when I have more time", and the same two times
  // went out again under "I'll check back next week. Enjoy."
  const lastOfferOut = (() => {
    for (const m of outbound.slice(-4).reverse()) {
      if (/\bI'm\s+holding\b|\bI\s+have\s+you\s+down\s+for\b|\byou'?re\s+all\s+set\s+for\b/i.test(m.text)) return '';
      if (OFFER_CLOSED_RX.test(m.text)) return '';
      if (SLOT_OFFER_RX.test(m.text)) return m.text;
      if (CLOSING_LINE_RX.test(splitSentences(m.text).slice(-1)[0] || '')) return '';
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
    // "No" to "anyone else part of the decision?" answers it (2026-10-13).
    if (isNo(t.text, prevOut) && !DM_GATE_ASK_RX.test(prevOut)) nos++;
    else break;
  }
  // Each inbound read against the bot message before it.
  const prevOutOf = (i) => [...turns.slice(0, i)].reverse().find(x => x.direction === 'outbound')?.text || '';
  const objOpts = { quoteIsPrice: !stageLive, competitor: stageLive };
  const inboundTypes = turns.map((t, i) => (t.direction === 'inbound' ? objectionType(t.text, prevOutOf(i), objOpts) : undefined)).filter(x => x !== undefined);
  const priceAsks = inboundTypes.filter(x => x === 'price').length;
  const pricePlayed = outbound.some(m => PRICE_PLAY_RX.test(m.text));
  // Every money ask the lead made, a quote request included (the hand-off count).
  const moneyAsks = turns.filter(t => t.direction === 'inbound' && isPriceAsk(t.text, { quoteIsPrice: true })).length;
  // How many price/quote lines the bot already sent (quote → again → a person).
  const priceLines = outbound.filter(m => QUOTE_LINE_RX.test(m.text) || PRICE_PLAY_RX.test(m.text)).length;
  const counters = {
    nos_in_a_row: nos,
    price_asks: priceAsks,
    discovery_questions_asked: discoveryQuestions(outbound).length,
    // After the competitor play there is no consequence move (no storm fear,
    // no "what if you wait" at a lead who chose someone else).
    consequence_used: outbound.some(m => CONSEQUENCE_RX.test(m.text) || COMPETITOR_PLAY_RX.test(m.text)),
    bridge_used: outbound.some(m => BRIDGE_RX.test(m.text)),
    slot_offers: outbound.filter(m => SLOT_OFFER_RX.test(m.text)).length,
    status_frame_used: outbound.some(m => STATUS_FRAME_RX.test(m.text)),
    reveal_used: outbound.some(m => REVEAL_RX.test(m.text)),
  };
  const cap = channel === 'livechat' ? 2 : 3;
  const earned = discoveryEarned(conversation, trigger);
  counters.earned = earned.earned;
  const echoWord = problemEcho(inbound);
  const objType = objectionType(now, lastOut, objOpts);
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
    // The lead asked for a phone call, or turned the visit down: our own call
    // wording stays (dropUnaskedCallOffer, 2026-10-03).
    lead_wants_call: leadWantsCall(conversation, trigger),
    // An offer is open but the caller planned without the calendar (live
    // chat's first pass): it must load the times and plan again (2026-10-03
    // replay: "Mark" after the 2 PM offer got a vague answer, no times).
    // A typed clock time ("book for 2 PM") needs the calendar too.
    offer_slots_pending: (!!lastOfferOut || TYPED_CLOCK_RX.test(now)) && offerSlots.length < 2,
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

  // ── Lead Conversation Stage (LEAD_STAGE_MODE=live, 2026-10-12) ──────────
  // The handoff's evidence: "Yes that's fine, book it" got "which time works
  // better?" with a pair from three messages back; SMS sent "free visit, would
  // that help?" twice; live chat never offered times after discovery or a
  // competitor. With the stored stage the planner stops re-guessing: a yes,
  // a schedule ask or an address after the bridge (or at qualifying, offered
  // or held) moves forward whatever our last message was, the bridge goes out
  // once, a pick resolves only against the newest offer, a stated day or part
  // of the day is honored, and planNepqTurn's gate holds the times until the
  // lead owns the home and the decision makers can be there.
  const staged = !!stage?.stage;
  const sFacts = staged ? stageFactsNow(stage, turns, knownZip) : null;
  const sBase = staged ? (/^(?:objection|handoff|reschedule)\b/.test(String(stage.stage)) ? String(stage.facts?.return_to || '') : String(stage.stage)) : '';
  const stageAtCommit = staged && (['qualifying', 'transition', 'commitment_offered', 'slot_held'].includes(sBase) || QUALIFY_ASK_RX.test(lastOut));
  const stagePool = (Array.isArray(allSlots) && allSlots.length ? allSlots : offerSlots).map(s => ({ ...s, tz: s.tz || tzLabel || '' }));
  const latestOfferText = staged ? (lastOfferOut || (sFacts.latest_offered_slots || []).join(' or ')) : '';
  if (staged) {
    plan.stage = { stage: stage.stage, base: sBase };
    // A decision maker settled (alone, or named and able to be there) closes
    // the question for good: the booking collect never asks it again.
    if (dmSettled(sFacts.decision_makers)) plan.dm_known = sFacts.decision_makers === 'sole' ? 'Solo Owner' : 'Yes';
  }
  /** Two real times for the stage: the newest offer if still open, else the stated preference, else the next two. */
  const stagedOffer = (answerFirst = false) => {
    let pair = null;
    let line = null;
    const latest = latestOfferText ? stagePool.filter(sl => slotMentionIndex(latestOfferText, sl) >= 0).slice(0, 2) : [];
    if (latest.length === 2) { pair = latest; line = vary(LINES.which(pair), ALT_LINES.which(pair)); }
    const pref = !pair && sFacts.preference ? parseDayPreference(sFacts.preference) : null;
    if (!pair && pref && stagePool.length >= 2) {
      const picked = slotsForPreference(stagePool, pref, { nowMs });
      const prefLine = preferenceOfferLine(pref, picked, tzLabel);
      if (prefLine) { pair = picked.slots; line = prefLine; plan.day_preference = { label: pref.label, matched: picked.matched }; }
    }
    if (!pair && offerSlots.length === 2) { pair = offerSlots; line = LINES.offer_slots(pair, counters.slot_offers); }
    if (!pair) {
      // No times in hand: the caller loads the calendar and plans again.
      plan.offer_slots_pending = true;
      return Object.assign(plan, { step: 'offer_slots', required_move: answerFirst ? 'answer' : 'offer_slots', booking: { allowed: true, reason: 'nepq:stage_offer' } });
    }
    plan.slots_to_offer = pair;
    plan.allowed.slot_offer = true;
    plan.booking = { allowed: true, reason: 'nepq:stage_offer' };
    if (answerFirst) return Object.assign(plan, { step: 'offer_slots', required_move: 'offer_slots', answer_first: true, offer_line: line });
    return fixed('offer_slots', line, { step: 'offer_slots' });
  };

  // 0. Do-not-knock (2026-10-03): ask for the address once (and a name if we
  //    have none), then the card goes to the canvass team. Never a sales call,
  //    never a visit ask.
  const dnk = (() => {
    // Our own steps, read by meaning (the model words them; post-#1162 replay,
    // 2026-10-04): the address ask, the name ask, and the closing line. A name
    // ask that says "added to our do-not-knock list" or "with that address" is
    // still the name ask, not the address ask and not the close.
    const askIdx = turns.map(t => t.direction === 'outbound' && isDnkAddressAsk(t.text)).lastIndexOf(true);
    if (askIdx < 0 || turns.slice(askIdx + 1).some(t => t.direction === 'outbound' && isDnkClose(t.text))) return null;
    const after = turns.slice(askIdx + 1);
    const complaint = [...turns.slice(0, askIdx)].reverse().find(t => t.direction === 'inbound' && isKnockComplaint(t.text))?.text || '';
    const address = after.find(t => t.direction === 'inbound')?.text || '';
    const nameAskIdx = after.findIndex(t => t.direction === 'outbound' && DNK_NAME_ASK_RX.test(t.text));
    const nameReply = nameAskIdx >= 0 ? (after.slice(nameAskIdx + 1).find(t => t.direction === 'inbound')?.text || '') : '';
    return { complaint, address, askedName: nameAskIdx >= 0, nameReply };
  })();
  if (dnk) {
    const dnkFixed = (step, line) => fixed('dnk', line, { step, booking: { allowed: false, reason: `nepq:${step}` }, reference_markers: DNK_MARKERS.name });
    if (!firstName && !dnk.askedName) return dnkFixed('dnk_ask_name', LINES.dnk.ask_name);
    const name = firstName || nameFromDnkReply(dnk.nameReply);
    const line = LINES.dnk.done(name);
    return fixed('handoff', line, {
      step: 'handoff', booking: { allowed: false, reason: 'nepq:handoff_do_not_knock' }, reference_markers: DNK_MARKERS.done,
      handoff: { reason: 'do_not_knock', line, extra: `Do-not-knock address: ${dnk.address.slice(0, 200) || 'not given'}\nName: ${name || dnk.nameReply.slice(0, 60) || 'not given'}\nTheir complaint: "${dnk.complaint.slice(0, 200)}"\nFive9: NOT added. No sales call.` },
    });
  }
  if (isKnockComplaint(now)) {
    return fixed('dnk', LINES.dnk.ask_address, { step: 'dnk_ask_address', booking: { allowed: false, reason: 'nepq:dnk_ask_address' }, reference_markers: DNK_MARKERS.address });
  }

  // 1. A person takes over: complaint, price insisted after the play, two no's.
  if (EMERGENCY_RX.test(now)) return handoff('emergency');
  // 1. (2026-10-15, Jeff Clark) A copy of the warranty asked for is sent with
  // this reply (src/agentic/warranty-request.js), on every stage, rehash
  // included. Not a hand-off: nothing is filed for it. A call asked for in the
  // same message keeps its callback below (the send handler adds the files).
  if (warrantyAvailable && isWarrantyRequest(now) && !CALLBACK_RX.test(now)) {
    return fixed('warranty', warrantyReference(firstName), { step: 'warranty', warranty: true, booking: { allowed: false, reason: 'nepq:warranty' }, reference_markers: WARRANTY_MARKERS });
  }
  if (SERVICE_RX.test(now)) return handoff('service');
  if (COMPLAINT_RX.test(now)) return handoff('complaint');
  // A call asked for about service (an install, an order, a repair) goes to
  // the service team, never the sales callback list (Mark, 2026-10-03).
  const serviceCall = () => isServiceCallback({ conversation, trigger, isCustomer });
  const serviceHandoff = () => {
    const line = (!teamOpen ? LINES.handoff_closed.service_callback(nextTeamOpenLabel(nowMs)) : LINES.handoff.service_callback);
    return fixed('handoff', line, { step: 'handoff', handoff: { reason: 'service', line }, booking: { allowed: false, reason: 'nepq:handoff_service' } });
  };
  // The intent classifier read a call request the regex missed ("can I talk
  // to a real person on the phone"): same hand-off (2026-10-03).
  // 2026-10-13 (post-merge sim of Erica's thread): the classifier read "I can
  // call back when I have more time" as CALLBACK and the bot promised a call
  // and filed Five9. A lead who says THEY will call has asked for nothing.
  const askedForCall = (CALLBACK_RX.test(now) || (callbackRequested && !leadWillReachOut(now))) && !isNotInterested(now);
  if (askedForCall && serviceCall()) return serviceHandoff();
  // 1a. A rehash call on the Rehash Call calendar (the user, 2026-10-09): two
  // REAL openings when they want the call, the pick booked, never a time the
  // calendar does not show. No openings → the hand-off below, as before.
  // A follow-up date or "we signed elsewhere" from a post-demo lead outranks
  // a call request ("Call me in November"): confirm the date, file it.
  if (postDemo && (PURCHASED_ELSEWHERE_RX.test(now) || detectDeferral(now, nowMs))) return planPostDemo();
  if (postDemo && callSlots) {
    const r = planRehashCall();
    if (r) return r;
  }
  if (askedForCall) {
    // A call asked for outside team hours gets the next opening instead, and
    // after hours "call me back" names when (2026-10-02, Mark).
    const asked = requestedCallTime(now, nowMs);
    let line;
    if (asked && !asked.ok && !asked.past) line = LINES.callback_outside_hours(nextTeamOpenLabel(nowMs, { fromDow: asked.dow, fromHour: asked.hour, dayOffset: asked.dayOffset }));
    else if (asked?.ok) line = LINES.callback(callbackWhen(now));
    else line = LINES.callback(teamOpen ? (asked ? null : callbackWhen(now)) : nextTeamOpenLabel(nowMs));
    return fixed('handoff', line, { step: 'handoff', handoff: { reason: 'callback_request', line }, booking: { allowed: false, reason: 'nepq:callback_request' } });
  }
  // A yes to our own offer of a call (2026-10-03): the call is now promised,
  // so it is a callback request like any other (Five9 + #contact-center).
  if (CALL_OFFER_RX.test(lastOut) && (YES_RX.test(now) || MAYBE_RX.test(now)) && !isNo(now, lastOut)) {
    if (serviceCall()) return serviceHandoff();
    const line = LINES.callback(teamOpen ? callbackWhen('') : nextTeamOpenLabel(nowMs));
    return fixed('handoff', line, { step: 'handoff', handoff: { reason: 'callback_request', line }, booking: { allowed: false, reason: 'nepq:callback_accepted' } });
  }
  // 1b. Post-demo (Mark, 2026-10-09). A lead who already had the full in-home
  // visit and holds a proposal is never planned as a new lead: no discovery
  // question, no visit, no slots. Five live threads on the rehash line got a
  // stock first-contact question, slots offered twice to "Follow up in
  // November please", and "Congratulations" to a lead who signed elsewhere.
  if (postDemo) return planPostDemo();
  // 1c. The lead is leaving for now (Erica Hilts, 2026-10-13: "Thank you for
  // your time … Have a good day." read as a third price ask and got a promised
  // call; "I can call back when I have more time. Ty" got "I'll check back
  // next week. Enjoy." and the same two times). A short warm goodbye: no
  // times, no question, no call, nothing filed. Before every price, objection
  // and offer step below; after a call they asked for and the post-demo plan.
  if (isLeadSignOff(now)) {
    const booked = !!hasAppointment || outbound.some(m => BOOKED_LINE_RX.test(m.text));
    return fixed('close', LINES.sign_off(firstName, booked), { step: 'sign_off', call_offer_ok: false, lead_will_reach_out: leadWillReachOut(now), booking: { allowed: false, reason: 'nepq:sign_off' } });
  }
  // The lead's earlier messages, each with its own time when the thread has
  // one, so "by Friday" said last week is read against last week.
  function earlierInbound() {
    return (Array.isArray(conversation) ? conversation : [])
      .filter(m => String(m?.direction || '').toLowerCase() !== 'outbound')
      .map(m => ({ text: String(m?.text ?? m?.body ?? ''), atMs: Date.parse(m?.timestamp || m?.sent_at || m?.dateAdded || m?.created_at || '') }))
      .filter(m => m.text.trim() && m.text !== now);
  }
  function planRehashCall() {
    // A follow-up date or "we signed elsewhere" is the post-demo plan's job.
    if (PURCHASED_ELSEWHERE_RX.test(now) || detectDeferral(now, nowMs)) return null;
    const scheduleAsk = SCHEDULE_ASK_RX.test(now) || TIME_REQUEST_RX.test(now);
    if (pendingDeferral(earlierInbound(), nowMs) && !scheduleAsk && !askedForCall) return null;
    const all = Array.isArray(callSlots.all) ? callSlots.all : [];
    const offer = Array.isArray(callSlots.offer) ? callSlots.offer : [];
    const hi = firstName ? `, ${firstName}` : '';
    const base = { post_demo: true, call_offer_ok: true, rehash_call_slots: true };
    const offerPlan = (two, line) => Object.assign(plan, base, {
      step: 'rehash_offer', required_move: 'offer_slots', fixed_line: line, slots_to_offer: two,
      allowed: { ...plan.allowed, slot_offer: true }, booking: { allowed: true, reason: 'nepq:rehash_offer' },
    });
    const confirmPlan = (picked) => {
      const label = `${picked.rel || picked.day} at ${picked.time}${picked.tz ? ` ${picked.tz}` : ''}`;
      // 2026-10-11 (rehash NEPQ handoff): name who calls. The team member the
      // call is booked with, in the first person when that is the rep this
      // line speaks as; never a guessed name. "all set" keeps every read-back
      // working (BOOKED_LINE_RX, and it is not a new promised callback).
      const caller = callSlots.repName || null;
      const who = caller && rehashRep && caller.toLowerCase() === String(rehashRep).toLowerCase()
        ? "I'll give you a call then."
        : `${caller || 'Someone from our team'} will give you a call then.`;
      return Object.assign(plan, base, {
        step: 'rehash_confirm', required_move: 'confirm', rehash_pick: picked, rehash_caller: caller,
        reference_line: `You're all set for ${label}. ${who}`,
        reference_slots: [picked], booking: { allowed: true, reason: 'nepq:rehash_confirm' },
      });
    };
    // A pick from the times we offered (the last four of our messages).
    if (lastOfferOut) {
      const offered = offeredIn(lastOfferOut, all);
      const picked = pickSlot(now, offered) || exactSlotFor(now, offered);
      if (picked) return confirmPlan(picked);
    }
    // A time they typed: the one opening it names is the pick; otherwise the
    // two openings nearest it. Never a time the calendar does not show.
    const typed = typedClock(now);
    if (typed != null && all.length) {
      const exact = exactSlotFor(now, all);
      if (exact) return confirmPlan(exact);
      const near = nearestToClock(all, typed, now, nowMs);
      if (near.length === 2) return offerPlan(near, LINES.offer_slots(near, counters.slot_offers));
    }
    // Yes to our call offer, a call asked for, or "can we set up a time".
    // 2026-10-11 live simulation: "Yes that would help" two messages after the
    // "best deal possible" bridge got "I'll have John give you a quick call"
    // and no times. A bridge in either of our last two messages counts.
    const bridged = CALL_OFFER_SENTENCE_RX.test(lastOut) || bridgedRecently(outbound.map(m => m.text));
    const yesToCall = bridged && (YES_RX.test(now) || MAYBE_RX.test(now)) && !isNo(now, lastOut);
    if ((askedForCall || yesToCall || scheduleAsk) && offer.length === 2) {
      return offerPlan(offer, LINES.offer_slots(offer, counters.slot_offers));
    }
    return null;
  }
  function planPostDemo() {
    const hi = firstName ? `, ${firstName}` : '';
    const pd = (extra) => Object.assign(plan, { post_demo: true, booking: { allowed: false, reason: 'nepq:post_demo' }, call_offer_ok: true }, extra);
    // The whole thread, not just this visit: a deferral asked for yesterday
    // still stands today (currentSession drops turns past a 6-hour gap).
    const all = (Array.isArray(conversation) ? conversation : [])
      .map(m => ({ direction: String(m?.direction || '').toLowerCase() === 'outbound' ? 'outbound' : 'inbound', text: String(m?.text ?? m?.body ?? '') }))
      .filter(m => m.text.trim());
    const earlierIn = earlierInbound();
    const lastThreeOut = all.filter(m => m.direction === 'outbound').slice(-3).map(m => m.text);
    // 1. Signed with someone else (the same words rules 173/356 read; they own
    //    the routing and stop-bot). No congratulations, no question, no
    //    rescission or deadline talk (ESC_CONTRACT_CHANGE).
    if (PURCHASED_ELSEWHERE_RX.test(now)) {
      const line = rehashRep
        ? `Thanks for letting me know${hi}. I'll take a look in case there's anything worth comparing side by side.`
        : `Thanks for letting me know${hi}. I'll pass this to our team, in case there's anything worth comparing side by side.`;
      return pd({ step: 'competitor_signed', required_move: 'handoff', fixed_line: line, call_offer_ok: false });
    }
    // 2. A dated follow-up in this message: confirm the date and stop.
    const deferral = detectDeferral(now, nowMs);
    if (deferral) {
      return pd({
        step: 'defer', required_move: 'close', fixed_line: `That works${hi}. I'll check back ${deferral.label}.`,
        deferral: { untilIso: deferral.untilIso, label: deferral.label }, call_offer_ok: false,
        // The model's version must still name the date they gave.
        reference_markers: [{ rx: new RegExp(deferral.marker, 'i'), say: `confirm the follow-up as ${deferral.label}` }],
      });
    }
    // 3. A deferral asked for earlier and not yet due: no times unless they ask
    //    to schedule now (Melissa: the second "November" still got two slots).
    const pending = pendingDeferral(earlierIn, nowMs);
    if (pending && !(SCHEDULE_ASK_RX.test(now) || TIME_REQUEST_RX.test(now))) {
      plan.pending_deferral = { untilIso: pending.untilIso, label: pending.label };
      plan.slots_to_offer = [];
    }
    // 3a. The post-demo NEPQ track (rehash-nepq.js, 2026-10-11): where the
    //     conversation is, for the logs and the stop rule. Two no's in a row
    //     on the rehash line: one short line, no question, no call pitch.
    const track = rehashNepqTurn({ conversation, trigger: now, nowMs });
    const onTrack = rehash ?? !!rehashRep;
    if (onTrack) plan.rehash_stage = track.stage;
    // The track's question for this stage, unless one of our last three asked it.
    const trackQ = onTrack && ['connection', 'situation', 'problem', 'solution'].includes(track.stage) && track.example
      && !lastThreeOut.some(t => norm(t).includes(norm(track.example))) ? track.example : null;
    // 3b. STOP, enforced in code (Shawn Eastman, 2026-10-15). Two no's in this
    //     session, in a row or not (or the track's two in a row): one short
    //     line, no question, no pitch, and a #contact-rehash card (rehash_stop,
    //     never dialed). STICKY: once our stop line went out, every later turn
    //     stays stopped unless the lead asks something, asks to schedule or
    //     asks for a call (those reach planRehashCall / the callback hand-off
    //     first). The bot keeps answering; it only stops selling.
    const stopLine = `Understood${hi}. I'm here if anything changes.`;
    const prevOutAt = (i) => [...turns.slice(0, i)].reverse().find(x => x.direction === 'outbound')?.text || '';
    const noCount = turns.reduce((n, t, i) => n + (t.direction === 'inbound' && isPostDemoNo(t.text, prevOutAt(i)) && !DM_GATE_ASK_RX.test(prevOutAt(i)) ? 1 : 0), 0);
    plan.counters.post_demo_nos = noCount;
    const stopSent = outbound.some(m => POST_DEMO_STOP_RX.test(m.text));
    const releases = now.includes('?') || SCHEDULE_ASK_RX.test(now) || TIME_REQUEST_RX.test(now) || askedForCall;
    const stopPlan = (extra) => pd({ step: 'post_demo_stop', required_move: 'close', call_offer_ok: false, fixed_line: stopLine, rehash_question: null, ...extra });
    if (!stopSent && (noCount >= 2 || track.stage === 'stop')) {
      return stopPlan({ handoff: { reason: 'rehash_stop', line: stopLine } });
    }
    if (stopSent && !releases) return stopPlan({ post_demo_sticky: true });
    // 3b. They asked for room with no date (more time, a hard stretch at home):
    //     warm, no question, no pitch, no time (Jose Perez, 2026-10-14). The
    //     thank-you that usually follows is closed the same way (step 4).
    if (askedForSpace(now)) {
      return pd({ step: 'post_demo_space', required_move: 'close', call_offer_ok: false, fixed_line: `Take all the time you need${hi}. We're here whenever you're ready.` });
    }
    // 3c. The objection ladder (CANON.STD.011): one ask-back, one bridge with
    //     the rep's real Rehash Call times, then a person. Any objection counts
    //     toward the same ladder (Shawn's "estimates", "Cost" and "the price
    //     cut in half" are one objection). Never a rebuttal, a crew or warranty
    //     claim, a price, a discount or "a deal" (enforceNepqPlan, stripOfferTalk).
    //     Only on the rehash line (onTrack): a post-demo lead off it may be a
    //     SOLD customer (lp-demo-completed), who is never bridged to "the best
    //     deal possible". The stop above and the rebuttal guard apply to all.
    const pdObj = onTrack ? postDemoObjection(now, lastOut) : null;
    if (pdObj) {
      const objAttempt = turns.reduce((n, t, i) => n + (t.direction === 'inbound' && postDemoObjection(t.text, prevOutAt(i)) ? 1 : 0), 0);
      const repName = (Array.isArray(callSlots?.offer) && callSlots?.repName) || rehashRep || null;
      const speaksAsRep = !!(repName && rehashRep && String(repName).toLowerCase() === String(rehashRep).toLowerCase());
      plan.objection = { type: pdObj, attempt: objAttempt, line: null };
      if (objAttempt <= 1) {
        const line = POST_DEMO_ASK_BACK[pdObj](hi);
        plan.objection.line = line;
        return pd({ step: 'rehash_objection', required_move: 'objection_play', fixed_line: line, call_offer_ok: false, rehash_ladder: 'ask_back' });
      }
      if (objAttempt === 2) {
        // The bridge. "The best deal possible" is said once per conversation.
        const hintUsed = bestDealHintUsed(conversation);
        const lead = hintUsed ? 'I may be able to do something for you' : "I want to make sure you're getting the best deal possible. I may be able to do something for you";
        const offer = Array.isArray(callSlots?.offer) ? callSlots.offer : [];
        Object.assign(plan, { rehash_stage: 'bridge', rehash_bridged: true, rehash_ladder: 'bridge' });
        plan.objection.line = null;
        if (offer.length === 2) {
          const withRep = repName && !speaksAsRep ? ` with ${repName}` : '';
          const line = `${lead}, it's just easier on a quick call${withRep}. ${LINES.offer_slots(offer, counters.slot_offers)}`;
          plan.objection.line = line;
          return pd({
            step: 'rehash_offer', required_move: 'offer_slots', fixed_line: line, slots_to_offer: offer, rehash_call_slots: true,
            allowed: { ...plan.allowed, slot_offer: true }, booking: { allowed: true, reason: 'nepq:rehash_offer' },
          });
        }
        const line = `${lead}, it's just easier on a quick call. Would that help?`;
        plan.objection.line = line;
        return pd({ step: 'rehash_bridge', required_move: 'objection_play', fixed_line: line });
      }
      const who = speaksAsRep ? "I'll take a look at it and reach out." : `I'll have ${repName || 'our team'} take a look at it and reach out.`;
      const line = `Understood${hi}. ${who}`;
      plan.objection.line = line;
      return pd({ step: 'handoff', required_move: 'handoff', fixed_line: line, call_offer_ok: false, handoff: { reason: 'rehash_repeat_objection', line }, rehash_ladder: 'handoff' });
    }
    // Asked for room in the last 48 hours of this thread.
    const spaceAsked = earlierIn.slice(-4).some(m => askedForSpace(m.text) && (!Number.isFinite(m.atMs) || nowMs - m.atMs < 48 * 3_600_000));
    // 4. A thank-you: thanks back, and at most one question about the
    //    proposal (none if one went out in our last three, or they asked us to wait).
    if (isAcknowledgment(now)) {
      const askedRecently = lastThreeOut.some(t => POST_DEMO_QUESTIONS.some(q => norm(t).includes(norm(q))));
      if (spaceAsked) {
        // They asked for time and then said thanks: that is a goodbye.
        return pd({ step: 'post_demo_space', required_move: 'close', call_offer_ok: false, fixed_line: `Of course${hi}. Thinking of you, and we're here whenever you're ready.` });
      }
      // 2026-10-11: the post-demo track's question for where they are
      // ("Did you get a chance to look over the proposal?") when it has one.
      const question = (askedRecently || plan.pending_deferral) ? null : (trackQ || pickFresh([...POST_DEMO_QUESTIONS], plan.recent_outbound, plan.variant_seed));
      return pd({ step: 'post_demo_ack', required_move: 'answer', post_demo_question: question, ack_line: `Of course${hi}.` });
    }
    // 5. Anything else: answer it. The rehash goal (a call with the rep) and its
    //    rehash_call companion are unchanged.
    return pd({ step: 'post_demo', required_move: 'answer', ...(trackQ && !plan.pending_deferral ? { rehash_question: trackQ } : {}) });
  }

  // The third price ask: a call OFFERED, never promised (the owner, 2026-10-13).
  // A yes files the callback (the CALL_OFFER_RX step above); asked again after
  // the offer, one line that asks nothing and promises nothing.
  const priceCallOffered = outbound.some(m => PRICE_CALL_OFFER_RX.test(m.text));
  const priceThird = () => (priceCallOffered
    ? fixed('close', LINES.price_rest, { step: 'price_rest', objection: { type: 'price', attempt, line: LINES.price_rest }, booking: { allowed: false, reason: 'nepq:price_rest' } })
    : fixed('objection_play', LINES.price_call_offer, { step: 'price_call_offer', call_offer_ok: true, objection: { type: 'price', attempt, line: LINES.price_call_offer }, booking: { allowed: false, reason: 'nepq:price_call_offer' } }));
  if (objType === 'price' && priceLines >= 2) return priceThird();
  // 2026-10-13 (live eval, LEAD_STAGE_MODE=live): the first answer to a quote is
  // the info request, worded by the model, so it is not a "price line" and the
  // count never reached two: a third "how much?" got the ownership question
  // again. Three money asks (a quote counts) after the price play → the call offer.
  if (stageLive && objType === 'price' && pricePlayed && moneyAsks >= 3) return priceThird();
  if (nos >= 2) return handoff('two_nos');
  if ((objType === 'shopping' || objType === 'competitor') && attempt >= 2) return handoff('repeat_objection');

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

  // 3. Already booked: the Reveal once, otherwise just answer. Our own
  // "You're all set for…" counts too, until a later cancel (2026-10-03
  // replay: the appointment had not reached the read yet, and the next two
  // texts offered times again).
  const lastIdx = (rx) => { for (let i = outbound.length - 1; i >= 0; i--) if (rx.test(outbound[i].text || '')) return i; return -1; };
  const bookedInThread = lastIdx(BOOKED_LINE_RX) > lastIdx(/\bis\s+(?:now\s+)?cancel+ed\b|\bhave\s+cancel+ed\b/i);
  if (hasAppointment || bookedInThread) {
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
    // Staged: change the move, never the same offer again (batch 2 #4: "my
    // mistake" + the same two times). Times on the table → ask the day;
    // none yet → the next stage (times, behind the gate).
    if (staged) {
      if (latestOfferText) return fixed('ask_day', vary("You're right, sorry about that. What day works best for you?", ['Fair point, sorry about that. Which day is best for you?']), { step: 'ask_day', objection: { type: 'repeat', attempt: 1, line: null }, booking: { allowed: true, reason: 'nepq:repeat_complaint' } });
      return stagedOffer();
    }
    const line = offerSlots.length === 2 ? withSlots(LINES.repeat_slots(offerSlots)) : LINES.repeat_no_slots;
    return fixed('objection_play', line, { step: 'offer_slots', objection: { type: 'repeat', attempt: 1, line }, ask_contact: offerSlots.length !== 2, booking: { allowed: true, reason: 'nepq:repeat_complaint' } });
  }

  // 3c. A plain quote request (LEAD_STAGE_MODE=live; batch 3 #2: "can renters
  //     get a quote?" and a morning-run opener were read as price objections).
  //     NEPQ's info-request play: yes, then what they are hoping to see, then
  //     discovery as usual. Once per conversation.
  if (stageLive && !objType && QUOTE_REQUEST_RX.test(now) && !SCHEDULE_ASK_RX.test(now) && !outbound.some(m => INFO_PLAY_RX.test(m.text))) {
    const line = LINES.info_request;
    return fixed('objection_play', line, { step: 'discover', info_request: true, booking: { allowed: false, reason: 'nepq:info_request' } });
  }

  // 4. Objection plays (Mark's wording).
  // The competitor play (LEAD_STAGE_MODE=live): disarm, then how they would
  // decide; their answer goes to the bridge and the times (the criteria step).
  // Never a consequence, a storm, or a word about the other company's work.
  if (objType === 'competitor') {
    return fixed('objection_play', LINES.competitor, { objection: { type: 'competitor', attempt, line: LINES.competitor }, booking: { allowed: false, reason: 'nepq:competitor' } });
  }
  if (objType === 'price') {
    // First ask (the owner, 2026-10-13): what drives the price and ONE scoping
    // question, no times. The count question when the count is unknown.
    if (priceLines === 0) {
      const line = LINES.price_scope(!!knownOpenings || openingsKnown(turns));
      // 2026-10-13 (post-merge sim): the live chat's version swapped the scoping
      // question for "Want to get on the calendar for that?". The model's
      // question must be the scoping one.
      return fixed('objection_play', line, { step: 'discover', objection: { type: 'price', attempt, line }, reference_markers: PRICE_SCOPE_MARKERS, booking: { allowed: false, reason: 'nepq:price_scope' } });
    }
    // Asked again: the free measure as a yes/no question. Times only after a yes.
    const line = vary(LINES.price_visit_offer, ALT_LINES.price_visit_offer);
    return fixed('objection_play', line, { step: 'price_visit_offer', objection: { type: 'price', attempt, line }, booking: { allowed: false, reason: 'nepq:price_visit_offer' } });
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
  // The answer to our time-of-day question joins the day they gave just
  // before it ("Wednesdays" … "mornings").
  const PART_ASK_RX = /\bwhat\s+time\s+of\s+(?:the\s+)?day\b/i;
  const prevInbound = inbound.length >= 2 ? (inbound[inbound.length - 2].text || '') : '';
  const pref = parseDayPreference(PART_ASK_RX.test(lastOut) && prevInbound ? `${prevInbound} ${now}` : now);
  const pool = (Array.isArray(allSlots) && allSlots.length ? allSlots : []).map(s => ({ ...s, tz: s.tz || tzLabel || '' }));
  // A short message that is only a day ("Usually on Wednesdays") is their
  // availability whatever we asked (2026-10-03 SMS replay: it got the bridge,
  // then "we don't have a Wednesday slot", which was not true).
  const bareDay = !!pref?.days && String(now).trim().split(/\s+/).length <= 6 && !isLeadQuestion(now);
  const prefScheduling = !!pref && (ASK_DAY_RX.test(lastOut) || /\b(?:what|which)\s+day\b|\bwhen\s+(?:works|would|is\s+good)\b/i.test(lastOut)
    || !!lastOfferOut || BRIDGE_RX.test(lastOut) || counters.bridge_used || SCHEDULE_ASK_RX.test(now) || bareDay);
  // The caller loads the calendar for this (wantsSlots) and plans again.
  if (prefScheduling && pool.length < 2) plan.day_preference_pending = true;
  // The caller read the calendar and got nothing back (a GHL timeout,
  // 2026-10-03 replay): never the bridge over a day they just gave. Their day
  // is taken, and the time of day is asked, so the next turn has both.
  if (prefScheduling && pool.length < 2 && Array.isArray(allSlots) && !pref.part && pref.after == null && pref.before == null && !PART_ASK_RX.test(lastOut)) {
    const verb = /s$/i.test(pref.label) ? 'work' : 'works';
    return fixed('ask_day', `${pref.label} ${verb}. What time of day is best for you?`, { step: 'ask_day', booking: { allowed: true, reason: 'nepq:day_preference_no_slots' } });
  }
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

  // S. The stage moves forward (LEAD_STAGE_MODE=live). A yes to ANY offer of
  //    ours, a schedule ask ("book it"), or an address, whatever our last
  //    message was; and past the bridge (or at qualifying, offered, held, or
  //    back from an objection play) anything that is not a no goes to times.
  //    The bridge is never sent twice. The gate in planNepqTurn may turn the
  //    times into the one missing qualifying question.
  //    Runs before the typed-time and criteria steps (a "book it" or an
  //    answered "how would you decide?" is a forward move here), but a pick of
  //    the offer still on the table is step 5's.
  const pickOfOpenOffer = !!lastOfferOut && (DAY_OR_TIME_RX.test(now) || BARE_PICK_RX.test(now));
  if (staged && !objType && !pickOfOpenOffer && !isNo(now, lastOut) && !NEITHER_RX.test(now) && !isNotInterested(now)) {
    // The Status Frame's "Would that help?" is about talking, not a visit.
    const offerAsk = !STATUS_FRAME_RX.test(lastOut) && (BRIDGE_RX.test(lastOut) || SLOT_OFFER_RX.test(lastOut) || /\b(?:visit|come\s+out|measure|appointment|would\s+that\s+help)\b/i.test(lastOut));
    const ready = (YES_RX.test(now) && offerAsk) || SCHEDULE_ASK_RX.test(now) || STREET_ADDRESS_RX.test(now);
    const pastBridge = counters.bridge_used || stageAtCommit;
    // A pick of the newest offer, after the 4-message window step 5 reads.
    if (!lastOfferOut && latestOfferText && sBase === 'commitment_offered' && (DAY_OR_TIME_RX.test(now) || BARE_PICK_RX.test(now)) && !isLeadQuestion(now)) {
      return Object.assign(plan, { step: 'confirm', required_move: 'confirm', last_offer: latestOfferText, booking: { allowed: true, reason: 'nepq:stage_pick' } });
    }
    if (ready || pastBridge) {
      if (isLeadQuestion(now)) return stagedOffer(true);
      return stagedOffer();
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
      // 2026-10-13 (Erica Hilts): the same two times never go out a third time.
      const offersInARow = outbound.slice(-2).filter(t => SLOT_OFFER_RX.test(t.text || '')).length;
      if (offersInARow >= 2) return fixed('ask_day', vary(LINES.ask_day, ALT_LINES.ask_day), { step: 'ask_day', booking: { allowed: true, reason: 'nepq:ask_day' } });
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
  // Earn the ask (Mark, 2026-10-03): the problem in their words AND why it
  // matters, then the bridge. Not earned yet: keep discovering, up to a
  // ceiling of cap + 2 questions, then bridge anyway.
  plan.earned = earned;
  if (!counters.bridge_used && counters.discovery_questions_asked >= 1
    && (earned.earned || counters.discovery_questions_asked >= cap + 2)) {
    Object.assign(plan, { step: 'bridge', required_move: 'bridge', booking: { allowed: false, reason: earned.earned ? 'nepq:bridge_earned' : 'nepq:bridge_ceiling' } }); plan.bridge_line = bridgeLine(plan); return plan;
  }
  // 2026-10-03 replay: "the kids are cold all winter" right after the bridge
  // is more of the problem, not a yes or a no. A bare `answer` move let the
  // prompt's call canon in ("A quick call would…" next to "What day works
  // best for the visit?"). Their words, then the visit question once more,
  // in a variant not sent yet. Once only: a second non-answer is `answer`.
  const bridgesSent = outbound.filter(m => BRIDGE_RX.test(m.text)).length;
  if (!staged && counters.bridge_used && BRIDGE_RX.test(lastOut) && bridgesSent < 2 && !counters.slot_offers && !isNo(now, lastOut)) {
    Object.assign(plan, { step: 'bridge_followup', required_move: 'bridge', bridge_followup: true, booking: { allowed: false, reason: 'nepq:bridge_followup' } });
    plan.bridge_line = bridgeLine(plan);
    return plan;
  }
  if (counters.bridge_used) {
    // Bridged already and they did not say yes: answer and keep it soft.
    plan.required_move = 'answer';
    return plan;
  }
  if (!outbound.length) plan.step = 'open';
  // The problem is out but not why it matters: the consequence question
  // (once; after that a "why now" probe). No problem yet: a probe for it.
  plan.allowed.consequence = earned.problem && !earned.consequence && !counters.consequence_used && counters.discovery_questions_asked >= 1;
  plan.required_move = plan.allowed.consequence ? 'consequence' : 'probe';
  if (plan.required_move === 'probe') plan.probe_for = earned.problem ? 'why_it_matters' : 'problem';
  plan.booking = { allowed: false, reason: 'nepq:discover_first' };
  return plan;
}

/**
 * Plan this turn. With a stored stage (LEAD_STAGE_MODE=live) the plan then
 * passes the qualifying gate; without one it passes the pre-offer gate (the
 * count, then the decision makers). Parameters: see planNepqTurnCore, plus
 * `directiveNoTimes`: the send's layer3 script says "NO times" (a follow-up
 * hold), so no time offer goes out this turn.
 */
export function planNepqTurn(args = {}) {
  const plan = args?.stage?.stage ? gateForStage(planNepqTurnCore(args), args) : openingsGate(args);
  return args?.directiveNoTimes ? withoutTimeOffer(plan) : plan;
}

// 2026-10-13 (Erica Hilts): the layer3 follow_up_scheduled hint said "NO
// times", the plan block (which the reply writer obeys over the hint) offered
// two. A pick of an offered time still books; only a new offer goes.
function withoutTimeOffer(plan) {
  if (!plan || !['offer_slots', 'ask_day'].includes(plan.step)) return plan;
  plan.slots_to_offer = [];
  plan.allowed = { ...plan.allowed, slot_offer: false };
  plan.offer_line = null;
  plan.answer_first = false;
  plan.offer_slots_pending = false;
  plan.day_preference_pending = false;
  return Object.assign(plan, { step: 'directive_no_times', required_move: 'answer', fixed_line: null, reference_markers: null, booking: { allowed: false, reason: 'nepq:directive_no_times' } });
}

// Our pre-offer questions (the count, the decision makers), read by meaning:
// the model words them.
const DM_GATE_ASK_RX = /(?:\b(?:anyone|anybody|someone)\s+else\b|\bpart\s+of\s+the\s+decision\b|\bweigh(?:ing)?\s+in\b)[^?]*\?/i;
const isGateAsk = (t) => COUNT_ASK_RX.test(String(t || '')) || DM_GATE_ASK_RX.test(String(t || ''));

/**
 * The plan we set aside for the pre-offer questions: the conversation replanned
 * as it stood before the FIRST of them (the count, then the decision makers,
 * each answered in turn). Only a time offer (or the day ask, when the caller
 * has not read the calendar yet) is resumed. Pure.
 */
function resumeBeforeGate(args, turns) {
  let askIdx = turns.map(t => t.direction).lastIndexOf('outbound');
  while (askIdx >= 0) {
    const before = turns.slice(0, askIdx);
    const leadIdx = before.map(t => t.direction).lastIndexOf('inbound');
    if (leadIdx < 0) return null;
    const prevOutIdx = before.slice(0, leadIdx).map(t => t.direction).lastIndexOf('outbound');
    if (prevOutIdx >= 0 && isGateAsk(turns[prevOutIdx].text)) { askIdx = prevOutIdx; continue; }
    const resumed = planNepqTurnCore({ ...args, conversation: before.slice(0, leadIdx), trigger: before[leadIdx].text });
    // offer_slots, or ask_day when the caller has not read the calendar yet
    // (the live chat plans once without times, then again with them).
    return resumed && (resumed.step === 'offer_slots' || resumed.step === 'ask_day') && !resumed.handoff ? resumed : null;
  }
  return null;
}

/**
 * The pre-offer gate, every mode without a stored stage. The count question
 * (the user, 2026-10-13: "Yes, leave the question on") and then the decision
 * maker question (the owner, 2026-10-13, after the Erica Hilts chat: no
 * single-leg visits, asked ONCE, right before the first times; any answer
 * moves on). The planner re-reads the thread each turn, so this gate:
 *  - turns a plan that would offer visit times into the next unasked
 *    question, once each, before the FIRST offer only;
 *  - on the answer, resumes the plan we set aside: the conversation is
 *    replanned as it stood before the first gate question, so "about 10" and
 *    then "just me" get the times the "yes" had earned.
 * The decision-maker answer rides on the plan (`dm_known`), so the booking
 * collect never asks it again. A job we cannot take (job-scope.js) gets no
 * times at all, and a lead past its demo (`postDemoLead`, post-demo-lead.js)
 * is never asked (the user: "assume the lead is already qualified"). Pure.
 */
function openingsGate(args) {
  let plan = planNepqTurnCore(args);
  if (!plan || plan.handoff || plan.post_demo || plan.step === 'booked' || args.postDemoLead) return plan;
  const turns = normalizeThread(args.conversation, args.trigger);
  const js = jobScopeFromThread(turns);
  if (js.block || js.check) return notEligible(plan, js);
  const outbound = turns.filter(t => t.direction === 'outbound');
  const lastOut = outbound[outbound.length - 1]?.text || '';
  const trigger = String(args.trigger || '');
  // The answer to a gate question: replan from before the first one. A
  // question in the answer is answered first (the core plan), never skipped,
  // and a goodbye stays a goodbye. "My wife" to the decision-maker question is
  // an answer, not the spouse objection.
  const objectionOk = !plan.objection || (plan.objection.type === 'spouse' && DM_GATE_ASK_RX.test(lastOut));
  // Never over a held time's own collect ("will anyone else be part of the
  // decision?" after the hold is the collect's question, not this gate's).
  const resumable = !['offer_slots', 'collect', 'confirm', 'sign_off', 'close'].includes(plan.step) && !plan.held_slot && plan.required_move !== 'close';
  // A plain offer the answer earned on its own ("Just me." settles the
  // decision makers, so the core plan books) still loses a day or time of day
  // asked for before the gate (2026-10-13 bot gate, book_it_evening_spouse:
  // "Can someone come out in the evening?" … "Just me." got 2 PM and 10 AM).
  const plainOffer = plan.step === 'offer_slots' && !plan.day_preference && !plan.held_slot && !DAY_OR_TIME_RX.test(trigger);
  if (isGateAsk(lastOut) && (resumable || plainOffer) && objectionOk && !isLeadQuestion(trigger)) {
    const resumed = resumeBeforeGate(args, turns);
    if (resumable) {
      if (!resumed) return plan;
      plan = resumed;
    } else if (resumed?.day_preference) {
      plan = resumed;
    }
  }
  if (plan.step !== 'offer_slots') return plan;
  // Times already on the table are never interrupted ("you just said that"
  // after an offer gets new times).
  if (outbound.some(m => SLOT_OFFER_RX.test(m.text))) return plan;
  const dm = dmAnswerFromThread(turns);
  if (dm && dm !== 'conflict') plan.dm_known = dm;
  let item = null;
  if (!outbound.some(m => COUNT_ASK_RX.test(m.text)) && !args.knownOpenings && !openingsKnown(turns)) item = 'openings';
  else if (!dm && !args.knownDecisionMakers && !outbound.some(m => DM_GATE_ASK_RX.test(m.text) || DM_ASK_RX.test(m.text) && m.text.includes('?'))) item = 'decision_makers';
  if (!item) return plan;
  const ask = pickFresh(QUALIFY_LINES[item], plan.recent_outbound || [], 0);
  // A question in the same message is answered first, then the gate question.
  const answering = plan.required_move === 'answer' || (plan.answer_first && isLeadQuestion(trigger));
  plan.slots_to_offer = [];
  plan.allowed = { ...plan.allowed, slot_offer: false };
  plan.offer_line = null;
  plan.answer_first = false;
  plan.offer_slots_pending = false;
  plan.day_preference_pending = false;
  plan.last_offer = null;
  // One question (2026-10-13 bot gate, "you just said that" on chat): the
  // repeat play with no times asks for a name with its offer, and the chat
  // sent "Is anyone else part of the decision …? What's your first name?".
  plan.ask_contact = false;
  const booking = { allowed: false, reason: `nepq:qualify_${item}` };
  if (answering) return Object.assign(plan, { step: 'qualify', required_move: 'answer', fixed_line: null, reask_line: ask, qualify_item: item, booking });
  return Object.assign(plan, {
    step: 'qualify', required_move: 'qualify', fixed_line: ask, qualify_item: item,
    reference_markers: QUALIFY_MARKERS[item], booking,
  });
}

// A job we do not take, or the minimum not yet checked: no times. The
// job-scope guard words the reply; the model is not asked to match a line, so
// no re-write is spent on it (the wasted SMS redraft, 2026-10-13 sims).
function notEligible(plan, js) {
  const why = js.block || 'minimum_check';
  plan.slots_to_offer = [];
  plan.allowed = { ...plan.allowed, slot_offer: false };
  plan.offer_line = null;
  plan.answer_first = false;
  plan.offer_slots_pending = false;
  plan.day_preference_pending = false;
  plan.last_offer = null;
  plan.stage = { ...(plan.stage || {}), blocked: why };
  return Object.assign(plan, { step: 'not_eligible', required_move: 'answer', fixed_line: null, objection: null, reference_markers: null, booking: { allowed: false, reason: `nepq:job_scope_${why}` } });
}

// Steps that put a visit time in front of the lead (or a pick of one).
const TIME_STEPS = new Set(['offer_slots', 'confirm', 'ask_day', 'collect']);

/**
 * The qualifying gate (2026-10-12; the user's ruling: the handoff's order wins
 * when LEAD_STAGE_MODE=live). A plan that would offer, confirm or hold a time,
 * or bridge to the visit, becomes the ONE missing qualifying question instead
 * (owner → zip → decision makers). An objection play keeps its point in front
 * of the question. A held time's own collect still asks its own items (name,
 * address, decision maker); only ownership holds it. Pure.
 */
function gateForStage(plan, args) {
  // A lead past its demo already meets the requirements (the user, 2026-10-13):
  // no qualifying question and no job-scope block, whatever POST_DEMO_PLANNER_MODE says.
  if (!plan || plan.handoff || plan.post_demo || args?.postDemoLead || plan.step === 'booked') return plan;
  // The second price ask's free-measure question is a bridge to the visit too.
  const offersTimes = !!plan.allowed?.slot_offer || (plan.slots_to_offer || []).length > 0 || TIME_STEPS.has(plan.step) || plan.required_move === 'bridge' || plan.step === 'price_visit_offer' || !!plan.offer_slots_pending;
  if (!offersTimes) return plan;
  const turns = normalizeThread(args.conversation, args.trigger);
  const outbound = turns.filter(t => t.direction === 'outbound');
  const facts = stageFactsNow(args.stage, turns, args.knownZip, args.knownOpenings);
  const clear = () => {
    plan.slots_to_offer = [];
    plan.allowed = { ...plan.allowed, slot_offer: false };
    plan.offer_line = null;
    plan.answer_first = false;
    plan.offer_slots_pending = false;
    plan.day_preference_pending = false;
    plan.last_offer = null;
    // 2026-10-13 (live eval): "…do you own the home? What's your first name?"
    // The price play's contact ask rode along: one question per message.
    plan.ask_contact = false;
  };
  // Not the owner: no times at all (the qualifying guard words the reply).
  if (facts.homeowner === 'no') {
    clear();
    plan.stage = { ...(plan.stage || {}), blocked: 'not_owner' };
    return Object.assign(plan, { step: 'not_owner', required_move: 'answer', fixed_line: null, booking: { allowed: false, reason: 'nepq:not_owner' } });
  }
  // A job we do not take (2026-10-13: a rental, a commercial property, under
  // the minimum, or the minimum not yet checked): no times at all. The
  // job-scope guard words the reply (job-scope.js).
  {
    const js = jobScopeFromThread(turns);
    if (js.block || js.check) return notEligible(plan, js);
  }
  const item = nextQualifyItem(facts, outbound);
  if (!item) return plan;
  // 2026-10-13 (live eval): "Let me think about it" got "do you own the home?".
  // The think play offers a time; with qualifying still open it asks what they
  // want to think over instead, with no time and no qualifying question. The
  // gate asks on the next turn that moves toward a time.
  if (plan.objection?.type === 'think') {
    clear();
    plan.stage = { ...(plan.stage || {}), gate: item };
    return Object.assign(plan, {
      step: 'discover', required_move: 'objection_play', fixed_line: LINES.think_no_times,
      booking: { allowed: false, reason: 'nepq:think_qualify_first' },
    });
  }
  if (plan.step === 'collect' && item !== 'homeowner') return plan;
  const ask = pickFresh(QUALIFY_LINES[item], plan.recent_outbound || [], 0);
  const answering = plan.required_move === 'answer' || (plan.answer_first && isLeadQuestion(args.trigger || ''));
  const booking = { allowed: item === 'dm_absent', reason: `nepq:qualify_${item}` };
  clear();
  plan.stage = { ...(plan.stage || {}), gate: item };
  if (answering) {
    return Object.assign(plan, { step: 'qualify', required_move: 'answer', fixed_line: null, reask_line: ask, qualify_item: item, booking });
  }
  const prefix = plan.objection?.type === 'price' ? 'I hear you. Every home is different, so any number now would just be a guess. '
    : plan.objection?.type === 'repeat' ? "You're right, sorry about that. "
      : plan.step === 'confirm' ? 'Great. ' : '';
  return Object.assign(plan, {
    step: 'qualify', required_move: 'qualify', fixed_line: `${prefix}${ask}`, qualify_item: item,
    reference_markers: QUALIFY_MARKERS[item], booking,
  });
}

// ── the code guard: the plan, enforced on the draft ───────────────────────

// Money in chat (Mark, 2026-10-02: never prices, savings or financing
// figures). The live chat sent "$89–$149 per month, no money down" — that
// sentence goes, whatever its source.
export const MONEY_RX = /\$\s?\d|\b\d[\d,]*\s*(?:dollars|bucks)\b|\bper\s+month\b|\d[\d,.]*\s*(?:a|\/)\s*month\b|\/\s?mo\b|\bmonthly\s+payments?\b|\bno\s+money\s+down\b|\b0\s?%|\bapr\b|\b\d+\s?%\s+off\b|\bsave\s+(?:up\s+to\s+)?\d/i;

// 2026-10-10 (Mark's ruling of 2026-09-25, reconfirmed 2026-10-10): the bot
// may say Reece offers "0% APR" financing, and NO other rate, term, payment or
// financing figure. MONEY_RX matched both "0%" and "APR", so the plan enforcer
// had been deleting "Yes, we offer 0% APR financing" since 2026-10-02 and the
// FINANCING script could not be said. MONEY_RX itself is unchanged: the one
// phrase is lifted out first, and the sentence is judged on what is left.
//   - Not after a digit, a dot or a comma, so "5.0% APR" / "10% APR" are not it.
//   - Once the phrase is gone, ANY digit left in the sentence keeps the whole
//     sentence a figure: "0% APR for 18 months", "0% APR and $99 a month".
//     Conservative on purpose: a false flag only drops a sentence.
//   - "0% interest", "zero percent" and every other spelling are NOT the
//     ruled phrase and stay figures.
const ZERO_APR_RX = /(?<![\d.,])\b0\s?%\s?APR\b/gi;

/**
 * Pure: is this sentence a money / financing figure the bots may not send?
 * MONEY_RX, with exactly one exception: the ruled phrase "0% APR".
 */
export function isMoneyFigure(sentence) {
  const s = String(sentence ?? '');
  if (!MONEY_RX.test(s)) return false;
  const rest = s.replace(ZERO_APR_RX, ' ');
  if (rest === s) return true;
  if (/\d/.test(rest)) return true;
  return MONEY_RX.test(rest);
}
export const URGENCY_RX = /\bonly\s+\d+\s+(?:spots?|slots?|openings?)\s+left\b|\bspots?\s+(?:are\s+)?filling\b|\bprices?\s+(?:are\s+)?going\s+up\b|\bact\s+(?:now|fast)\b|\blimited\s+time\b|\bbefore\s+(?:it'?s|its)\s+too\s+late\b|\bdon'?t\s+miss\b|\b(?:calendar|schedule|calls?)(?:'s|\s+is|\s+are)?\s+(?:tight|packed|full|filling(?:\s+up)?|booking\s+up(?:\s+fast)?|moving\s+fast)\b|\bpeak\s+season\b|\bspeeding\s+up\s+these\s+decisions\b/i;
// 2026-10-02 funnel audit: the SMS bot leaned on "our calendar's tight right
// now" / "calls are booking up fast" in most booking turns. Invented scarcity.
// Claims nobody approved (2026-10-02 simulation: "that's right at the edge of
// when Florida code tightened up", "with us at the peak of hurricane season").
// Code history and season-peak talk are pressure dressed as fact.
export const CLAIMS_RX = /\bcode\s+(?:changed|tightened|got\s+(?:stricter|tighter)|was\s+(?:updated|changed))\b|\b(?:after|since|before)\s+(?:the\s+)?(?:19|20)\d\d\b[^.?!]{0,40}\bcode\b|\bcode\b[^.?!]{0,40}\b(?:after|since|before)\s+(?:19|20)\d\d\b|\bpeak\s+(?:of\s+)?(?:the\s+)?(?:hurricane|storm)\s+season\b|\bmost\s+active\s+(?:stretch|part|time)\b|\b(?:storm\s+season|we)\s+(?:has|have)\s+(?:us\s+)?(?:slammed|swamped)\b|\bcalendar\s+(?:is\s+)?(?:tight|filling|full)\b|\b(?:andersen|renewal|pgt|pella|lowe'?s|home\s+depot|es\s+windows|cgi)\b[^.?!]{0,60}\b(?:uses?|only|standard|cheap\w*|worse|inferior|lower|basic)\b|\b(?:they|their|them|other\s+(?:companies|contractors|installers|guys)|competitors?|those\s+guys|that\s+(?:company|contractor|installer))\b[^.?!]{0,60}\b(?:installed\s+to\s+code|(?:up\s+)?to\s+code|code[-\s]compliant)\b|\b(?:not|never|isn'?t|aren'?t|wasn'?t|weren'?t|might\s+not\s+be|may\s+not\s+be)\s+(?:installed\s+)?(?:up\s+)?to\s+code\b/i;
const SEE_YOU_RX = /\bsee\s+you\s+(?:then|soon|there)\b/i;
const SIGNOFF_RX = /(?:^|\s)([—–-]\s*[A-Z][A-Za-z.'’ ]{0,40})\s*$/;
const FIXED_MOVES = new Set(['handoff', 'objection_play', 'ask_day', 'close', 'reveal', 'offer_slots', 'status_frame', 'dnk', 'qualify', 'warranty']);

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
    // A post-demo follow-up date (2026-10-09): the day or month is the point.
    dated: !!plan?.deferral,
  };
}

/** The rules as one line of prompt text (rendered under the reference). Pure. */
export function referenceRulesText(rules) {
  const out = [];
  if (rules.slots.length) out.push(`name these times exactly as written: ${rules.slots.join(' or ')} (no other times)`);
  else if (rules.dated) out.push('name no clock time');
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
    `using the reference only as a guide: "${line}". It must ${keep || 'do what the reference does'}.` +
    (failed.includes('promises_a_call') ? ' Do not say anyone will call them: say a team member will reach out, as the reference does.' : '');
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
  // A call the reference never promised (post-#1159 replay, 2026-10-03): the
  // service line "a team member will reach out tomorrow morning" came back as
  // "we'll have someone … call you … shortly", at night. Service, two no's and
  // do-not-knock promise no call, and a sent call promise files a Five9 callback.
  if (promisedCallback(text) && !promisedCallback(line)) problems.push('promises_a_call');
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
// A question the model wrote as a statement ("For now, the bay window you
// mentioned is 6 feet wide, right."): it asks without a "?", so the appended
// ask would make it two questions and the first reads as a dangling line.
const TAG_STATEMENT_RX = /,\s*(?:right|correct|yeah|yes|no|is\s+that\s+(?:right|correct))\s*[.!]?$/i;

export function appendReferenceAsk(draft, refLine, failed = []) {
  let body = String(draft || '').trim();
  if (!body || body.includes('?') || /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)/i.test(body)) return null;
  // 2026-10-13 live sim (Erica's thread, chat): "… gives you exact pricing then.
  // For now, the bay window you mentioned is 6 feet wide, right. What style …?"
  const kept = splitSentences(body).filter(s => !TAG_STATEMENT_RX.test(s));
  if (!kept.length) return null;
  body = kept.join(' ');
  // Never after a goodbye (2026-10-13, Erica Hilts): "No problem, Erica. I'll
  // check back next week. Enjoy." went out with "Which works better, …?" glued on.
  if (isSignOffLine(splitSentences(body).slice(-1)[0] || '')) return null;
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
// "I'll check back next week", "we'll follow up soon": a promise to chase a
// lead who just said they would reach out themselves.
const CHECK_BACK_RX = /\b(?:i|we)(?:'|’)?ll\s+(?:check\s+back|follow\s+up|reach\s+(?:back\s+)?out|be\s+in\s+touch|circle\s+back)\b|\b(?:i|we)\s+will\s+(?:check\s+back|follow\s+up|reach\s+out|be\s+in\s+touch)\b/i;
const NO_FIGURES_LINE = 'Exact numbers come from the visit, since every home is different.';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// 2026-10-15 (Shawn Eastman): a rebuttal to a post-demo objection. Each live
// one is here: "The cheaper bids we see usually cut something, subcontracted
// crews or parts-only warranties, and folks end up replacing in five years",
// "what actually holds up is what you can prove five years down the line",
// "cheaper bids usually get there by cutting the crew or the warranty".
export const POST_DEMO_REBUTTAL_RX = /\b(?:cheaper|lower|other)\s+(?:bids?|quotes?|estimates?|companies|guys|options?)\b[^.?!]*\b(?:cut|cutting|skimp|subcontract|parts[\s-]+only|replac|corners?)|\bwhat\s+you\s+can\s+prove\b|\bholds?\s+up\b|\bfive\s+years\b|\b(?:folks|people|homeowners)\s+(?:end\s+up|usually|often)\b|\bget\s+what\s+you\s+pay\s+for\b|\byou\s+get\s+what\b|\bapples\s+to\s+apples\b|\bpeace\s+of\s+mind\b/i;
// "Someone from our team will reach out" on a step that files nothing.
export const UNPROMISED_FOLLOW_UP_RX = /\b(?:someone|a\s+team\s+member|our\s+(?:follow[\s-]*up\s+)?team)\s+(?:from\s+our\s+team\s+)?(?:will|is\s+going\s+to)\s+(?:reach\s+out|get\s+in\s+touch|follow\s+up|call|be\s+in\s+touch)\b/i;

const ASK_FIELD_RX = {
  name: /\b(?:your|first|full)\s+name\b|\bwho\s+(?:am\s+i|i'?m)\s+(?:speaking|talking)\s+(?:to|with)\b/i,
  phone: /\b(?:phone|cell)(?:\s+number)?\b|\bbest\s+number\b|\bnumber\s+to\s+(?:reach|call)\b/i,
  email: /\be-?mail\b/i,
  zip: /\bzip(?:\s*code)?\b/i,
};

/** Does this question ask for a field we already have? Pure. */
export function asksForKnown(sentence, known = {}) {
  // 2026-10-13 (live eval): "What's the street address for the visit, including
  // the zip code?" asks for the ADDRESS. Read as a zip re-ask, it was deleted
  // from the SMS hold, which then said "I'm holding Tue at 6 PM for you." and
  // stopped: no next step, no booking.
  const addressAsk = /\baddress\b/i.test(String(sentence || ''));
  return Object.entries(ASK_FIELD_RX).some(([field, rx]) => known[field] && rx.test(sentence) && !(field === 'zip' && addressAsk));
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
/**
 * A booking ask is already earned in this thread: the lead asked to schedule,
 * said yes to our bridge, or times are on the table / held / booked. Used to
 * fail closed when there is no plan (2026-10-03). Pure.
 */
export function bookingOpenInThread(conversation = [], trigger = '') {
  const turns = normalizeThread(conversation, trigger);
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.direction === 'outbound') {
      if (SLOT_OFFER_RX.test(t.text) || /\bI'm\s+holding\b|\byou'?re\s+all\s+set\s+for\b/i.test(t.text)) return true;
      continue;
    }
    if (SCHEDULE_ASK_RX.test(t.text) || TIME_REQUEST_RX.test(t.text)) return true;
    const prevOut = [...turns.slice(0, i)].reverse().find(x => x.direction === 'outbound')?.text || '';
    if (BRIDGE_RX.test(prevOut) && YES_RX.test(t.text)) return true;
  }
  return false;
}

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
/**
 * The drops every bot reply gets, plan or no plan: money figures, invented
 * urgency, unapproved claims, and a phone call the lead did not ask for.
 *
 * 2026-10-05 (golden replay): these lived only inside enforceNepqPlan, so with
 * NEPQ_BACKBONE_MODE=off (the rollback switch) the live chat sent "$89 to $149
 * per month", "our calendar is filling up" and "a quick call would help"
 * untouched. One copy of the rule, called by enforceNepqPlan and by the
 * live chat's no-plan path. Pure.
 *
 * `keepPromises`: a statement that WE will call ("A team member will call you
 * to set up a time", `promisedCallback`) stays and only offers go. The no-plan
 * live chat's next step IS that promise (bookingHandoffLine), and the call is
 * filed for real; with a plan, enforceNepqPlan decides through `handoff`.
 *
 * @param {string[]} sentences
 * @param {{allowFigures?: boolean, keepCallOffer?: boolean, keepPromises?: boolean}} [opts]
 * @returns {{sentences: string[], changes: string[]}}
 */
export function dropUnsafeSentences(sentences, { allowFigures = false, keepCallOffer = false, keepPromises = false } = {}) {
  const changes = [];
  let out = [...sentences];
  const drop = (pred, tag) => {
    const before = out.length;
    out = out.filter(s => !pred(s));
    if (out.length !== before) changes.push(tag);
  };
  // isMoneyFigure = MONEY_RX minus the one ruled phrase, "0% APR" (Mark, 2026-09-25).
  if (!allowFigures) drop(s => isMoneyFigure(s), 'money_figures');
  // 2026-10-02 re-run: "Our calendar's tight right now, so the quickest way
  // to grab a day is here: <link>" was the whole reply, so dropping it left
  // nothing and the original shipped. Cut the pressure clause and keep the rest.
  out = out.map(s => {
    if (!URGENCY_RX.test(s)) return s;
    const rest = s.replace(/^[^,;]*?,\s*(?:so\s+|and\s+)?/, '');
    if (rest === s || URGENCY_RX.test(rest) || rest.split(/\s+/).length < 4) return s;
    changes.push('fake_urgency');
    return rest.charAt(0).toUpperCase() + rest.slice(1);
  });
  drop(s => URGENCY_RX.test(s), 'fake_urgency');
  drop(s => CLAIMS_RX.test(s), 'unapproved_claim');
  // No phone call the lead did not ask for (2026-10-03).
  if (!keepCallOffer) drop(s => isCallOffer(s) && !(keepPromises && promisedCallback(s)), 'unasked_call_offer_dropped');
  return { sentences: out, changes: [...new Set(changes)] };
}

/** dropUnsafeSentences over a whole reply, keeping a "— Name" sign-off. Pure. @returns {{text: string, changes: string[]}} */
export function dropUnsafeLines(text, opts = {}) {
  const original = String(text || '');
  const signOff = original.match(SIGNOFF_RX);
  const body = signOff ? original.slice(0, signOff.index).trim() : original.trim();
  const { sentences, changes } = dropUnsafeSentences(splitSentences(body), opts);
  if (!changes.length) return { text: original, changes };
  const kept = sentences.join(' ').trim();
  return { text: signOff && kept ? `${kept} ${signOff[1].trim()}` : kept, changes };
}

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
  // 2. No money, no pressure, no call the lead did not ask for (dropUnsafeSentences).
  // A hand-off or callback line is our own promise of a call and stays.
  // A post-demo lead's next step IS a call with the rep (rehash), so the call
  // offer stays (2026-10-09).
  const keepCallOffer = !!plan.lead_wants_call || !!plan.handoff || !!plan.call_offer_ok || !!(referenceMove && CALL_OFFER_SENTENCE_RX.test(refLine || ''));
  const unsafe = dropUnsafeSentences(sentences, { allowFigures, keepCallOffer });
  sentences = unsafe.sentences;
  changes.push(...unsafe.changes);
  // 2a. Post-demo (Mark, 2026-10-09): they already had the visit and hold a
  // proposal. No pre-demo discovery question, even one the model copied from
  // the thread; nothing after a goodbye; and a follow-up date or a "we signed
  // elsewhere" gets no question and no time at all.
  if (plan.post_demo) {
    const stock = Object.values(DISCOVERY_QUESTIONS).flat().map(norm);
    drop(s => { const n = norm(s); return stock.some(q => n === q || (n.split(' ').length >= 4 && (n.includes(q) || q.includes(n)))); }, 'discovery_question_dropped');
    const signOffAt = sentences.findIndex(isSignOffLine);
    if (signOffAt >= 0 && sentences.slice(signOffAt + 1).some(x => x.includes('?'))) {
      sentences = sentences.filter((x, i) => i <= signOffAt || !x.includes('?'));
      changes.push('question_after_sign_off');
    }
    if (plan.step === 'competitor_signed') drop(s => /\bcongrat/i.test(s), 'no_congratulations');
    if (plan.step === 'defer' || plan.step === 'competitor_signed' || plan.step === 'post_demo_stop' || plan.step === 'post_demo_space') {
      drop(s => s.includes('?') || SLOT_OFFER_RX.test(s) || clockMinutes(s).length > 0, 'post_demo_no_question');
    } else if (plan.step === 'post_demo_ack' && !plan.post_demo_question) {
      drop(s => s.includes('?'), 'post_demo_no_question');
    }
    // 2026-10-11 (rehash NEPQ handoff): "the best deal possible" only at the
    // bridge. The live simulation sent it as the answer to "we got another
    // quote", in place of "How do they compare?", and the bridge turn after it
    // then had nothing left to say.
    if (plan.rehash_stage && PRE_BRIDGE_STAGES.has(plan.rehash_stage) && sentences.some(s => !BEST_DEAL_RX.test(s))) {
      drop(s => BEST_DEAL_RX.test(s), 'best_deal_before_bridge');
    }
    // 2026-10-15 (Shawn Eastman, CANON.STD.018): a post-demo lead is asked,
    // never argued with. The three live rebuttals ("cheaper bids … cut
    // something", "what you can prove five years down the line", "cheaper bids
    // usually get there by cutting the crew") go, and so does a promise that
    // someone will reach out on a step that files nothing (only a hand-off
    // files a card). The plan's own line is never dropped.
    const ownLine = new Set(splitSentences(`${plan.fixed_line || ''} ${plan.reference_line || ''}`).map(norm));
    drop(s => !ownLine.has(norm(s)) && POST_DEMO_REBUTTAL_RX.test(s), 'rebuttal_dropped');
    if (!['handoff', 'rehash_confirm', 'rehash_offer'].includes(plan.step)) {
      drop(s => !ownLine.has(norm(s)) && UNPROMISED_FOLLOW_UP_RX.test(s), 'unpromised_follow_up_dropped');
    }
  }
  // 2a'. The lead said goodbye (2026-10-13, Erica Hilts): no question, no
  // time, and no "I'll check back next week" when they said THEY would call.
  if (plan.step === 'sign_off' || plan.step === 'price_rest') {
    drop(s => s.includes('?') || SLOT_OFFER_RX.test(s) || clockMinutes(s).length > 0 || (plan.lead_will_reach_out && (CHECK_BACK_RX.test(s) || promisedCallback(s))), 'sign_off_no_ask');
  }
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
    // 2026-10-11 (rehash NEPQ handoff): a post-demo lead who said yes to the
    // call with no Rehash Call times read gets asked for THEIR time ("What's a
    // good time today or tomorrow for a quick call?"). That is the call, not a
    // visit booking ask, and it was being stripped down to "Good.". Only with
    // no clock time of our own and no visit words.
    const callTimeAsk = (s) => plan.post_demo && plan.call_offer_ok && /\bcall\b/i.test(s) && clockMinutes(s).length === 0
      && !/\b(?:visit|come\s+(?:out|by)|stop\s+by|appointment|measure|estimate|in-?home)\b/i.test(s);
    drop(s => asks.has(s) && !callTimeAsk(s), 'booking_ask');
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
  // A post-demo thank-you that lost everything to the drops: thanks back.
  if (!body && plan.post_demo && plan.ack_line) { body = plan.ack_line; changes.push('ack_line'); }
  // A post-demo reply that was all rebuttal: never the rebuttal itself (the
  // generic fallback below ships the original), never silence.
  if (!body && plan.post_demo && !referenceMove) { body = 'Understood.'; changes.push('post_demo_fallback'); }
  // 2026-10-11 live simulation: "Thanks for checking in" got "Anytime. Talk
  // soon." The planned proposal question goes on; a sign-off in its way goes.
  const trackQuestion = plan.step === 'post_demo_ack' ? plan.post_demo_question : plan.step === 'post_demo' ? plan.rehash_question : null;
  if (trackQuestion && plan.rehash_stage && !body.includes('?')) {
    const kept = splitSentences(body).filter(s => !isSignOffLine(s) && !/^talk\s+soon\b/i.test(s));
    body = [...kept, trackQuestion].join(' ').trim();
    changes.push('post_demo_question_added');
  }
  // The bridge turn asks for the call (the same simulation: "Worth seeing if
  // we can close that difference." and no question).
  if (plan.post_demo && plan.rehash_stage === 'bridge' && plan.step === 'post_demo' && body && !body.includes('?')) {
    body = `${body} Would a quick call help?`;
    changes.push('rehash_bridge_ask_added');
  }

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
  } else if (plan.required_move === 'bridge' && !body.includes('?')) {
    // The bridge asks (2026-10-03 replay: "The next step would be a free look at
    // your home to see what's letting that cold in." and nothing to answer).
    body = `${body.replace(/[.!\s]+$/, '')}. Would that help?`;
    changes.push('bridge_question_added');
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
  if (!body && changes.includes('unasked_call_offer_dropped')) {
    // The call offer was the whole reply: the visit is the next step instead.
    body = plan.counters?.bridge_used ? pickFresh([LINES.ask_day, ...ALT_LINES.ask_day], plan.recent_outbound || [], 0) : bridgeLine(plan);
  }
  if (!body) {
    body = changes.includes('money_figures') ? NO_FIGURES_LINE
      : (changes.includes('consequence_repeat') || changes.includes('unapproved_claim')) ? bridgeLine(plan)
        : (original.trim() || NO_FIGURES_LINE);
  }
  // 7. A discovery turn always ends on a question (2026-10-03 replay after the
  // earned-ask change: "Oh my wife filled out some form" got "That makes
  // sense." and nothing to answer). The planner chose a question this turn;
  // when the draft or a guard lost it, a fresh one goes on the end.
  // Not when the body already gives the lead something to act on: a link, a
  // booking confirmation, or a turn where a booking ask is allowed.
  const actionable = /\{\{|\bhttps?:\/\/|\ball set\b/i.test(body) || plan.booking?.allowed === true;
  // Never on a post-demo plan, a deferral, a close or after a goodbye
  // (2026-10-09: "Enjoy your week. Is it more how they look, or how they work?").
  const endsOnSignOff = isSignOffLine(splitSentences(body).slice(-1)[0] || '');
  const noDiscovery = plan.post_demo || ['defer', 'close', 'competitor_signed', 'post_demo_ack', 'post_demo_stop', 'post_demo_space'].includes(plan.step) || endsOnSignOff;
  if ((plan.required_move === 'probe' || plan.required_move === 'consequence') && !body.includes('?') && !actionable && !noDiscovery) {
    // A discovery turn collects no details: "Let me get your zip code so I can
    // confirm…" next to the question was two asks, and a zip asked twice
    // (2026-10-03 replay). The statement goes; the discovery question stays.
    const kept = splitSentences(body).filter(x => !DETAIL_REQUEST_RX.test(x));
    if (kept.length && kept.length < splitSentences(body).length) { body = kept.join(' '); changes.push('detail_request_dropped'); }
    body = `${body.replace(/\s+$/, '')} ${discoveryQuestion(plan)}`.trim();
    changes.push('discovery_question_added');
  }
  return { text: changes.length ? withSignOff(body) : original, changes, failed: [] };
}

const DETAIL_REQUEST_RX = /\b(?:let\s+me\s+(?:get|grab|have)|(?:i|we)(?:'ll|’ll|\s+will)?\s+(?:just\s+|also\s+)?need|(?:can|could)\s+(?:you|i\s+get))\b[^.?!]*\b(?:zip|address|phone|number|e-?mail|name)\b/i;

const DISCOVERY_QUESTIONS = {
  problem: [
    "What's bothering you most about your windows or doors right now?",
    'Is it more how they look, or how they work?',
    'What would you most like to change about them?',
  ],
  why_it_matters: [
    'How has that been affecting you?',
    'Has that had an impact on you day to day?',
    'What would it mean for you to have that fixed?',
  ],
  consequence: [
    'What happens if you leave them as they are another season?',
    'How has that been affecting you?',
    'What would it mean for you to have that fixed?',
  ],
};

/** A discovery question for this plan, never one already sent. Pure. */
export function discoveryQuestion(plan = {}) {
  const key = plan.required_move === 'consequence' ? 'consequence' : (plan.probe_for === 'why_it_matters' ? 'why_it_matters' : 'problem');
  return pickFresh(DISCOVERY_QUESTIONS[key], plan.recent_outbound || [], plan.variant_seed || 0);
}
