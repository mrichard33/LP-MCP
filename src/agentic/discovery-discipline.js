/**
 * Discovery discipline — src/agentic/discovery-discipline.js
 *
 * The state a reply turn needs in order to ANSWER, then DISCOVER — instead of
 * answer, then book. Pure: no I/O, no env reads, no clock (nowMs is an
 * argument). scripts/test-discovery-discipline.js drives it directly.
 *
 * WHY THIS EXISTS (2026-09-26, fourteen days of live replies)
 * ──────────────────────────────────────────────────────────
 * The NEPQ layer (src/agentic/nepq-layer.js) has said "one question, echo
 * their words, discover before you transition" since 2026-08-29. In live
 * threads the bot still:
 *
 *   - skipped discovery: Carlos (LSZTKuLhNEPfwW2az5Ek) said he did not like
 *     his door's colour and design; the bot asked for his address.
 *   - tacked a booking ask onto every answer: on hZOcPk6XmMvWVvjZJ7mz seven
 *     answers in a row ended "would a day this week work for both of you?".
 *   - re-asked the spouse question six times after "She doesn't need to be
 *     there", and invented a second decision-maker ("whoever else is
 *     deciding") for a man who had named nobody.
 *   - opened "Good question" eight times running, and re-asked the GHL
 *     welcome opener ("What are you hoping to get done…") seconds after a
 *     workflow had already sent it (Sonya, Felix, Ronald).
 *
 * The root cause is ORDER, not wording. buildResponsePrompt renders the NEPQ
 * block at roughly position 18 of 51; the in-home booking gate and the
 * closing PRIORITY ORDER — whose "(5) DEFAULT" was a two-slot booking ask —
 * render ~500 lines later and are the last things the model reads. Later
 * text wins. Rewriting the NEPQ copy a fourth time would not change that, so
 * this module computes the turn's discipline as DATA, the layer renders it,
 * the priority order now defers to it, and the guards below make the old
 * behaviour non-shippable.
 *
 * Fix map (numbers from the 2026-09-26 handoff):
 *   Fix 1  bookingAskAllowed / findBookingAsks — answer, then discover.
 *   Fix 2  problemProbeState — echo and probe before the first booking ask.
 *   Fix 3  decisionMakerState / findPhantomDecisionMaker — ask once, NEPQ,
 *          then a human. Never invent a second decision-maker.
 *   Fix 4  findBannedOpeners / findExclamations — tone.
 *   Fix 5  openerAlreadyAsked / findRepeatedOpener — do not repeat the GHL
 *          workflow's opener.
 *   Fix 6  findInsuranceOutcomeClaims — carrier decides, never a prediction.
 *
 * The established-facts ledger (src/agentic/established-facts.js) stays the
 * record of WHAT is known. This module adds what the ledger does not carry:
 * who was named, whether we have already asked, and what that means for the
 * question about to be asked.
 */

import {
  extractClose,
  closeThemes,
  closesRepeat,
} from './conversation-repetition.js';
import { isSoloOwnerStatement } from './established-facts.js';

export const DISCOVERY_DISCIPLINE_VERSION = '1.0';

/**
 * The one approved insurance sentence (Mark, 2026-09-26 handoff). Rendered in
 * the prompt script AND required by the guard, so there is exactly one shape
 * and no hybrid of two "approved" versions.
 */
export const APPROVED_INSURANCE_LINE =
  'Impact windows can qualify for wind-mitigation credits, and we give you the ' +
  'documentation your insurance company asks for. Your insurance company decides the final number.';

/** The one decision-maker question the layer may ask, once. */
export const APPROVED_DECISION_MAKER_ASK =
  'Is this your call, or is anyone else weighing in on it?';

// ── turn helpers ────────────────────────────────────────────────────────

function normalizeTurn(m) {
  if (!m || typeof m !== 'object') return null;
  const raw = m.direction;
  const direction = raw === 'inbound' || raw === 1 || raw === '1' ? 'inbound' : 'outbound';
  const text = String(m.text ?? m.body ?? m.message ?? '').trim();
  const at = m.timestamp ?? m.at ?? m.dateAdded ?? null;
  const ms = at ? Date.parse(at) : NaN;
  return { direction, text, at, ms: Number.isFinite(ms) ? ms : null };
}

function normalizeTurns(conversation) {
  return (Array.isArray(conversation) ? conversation : [])
    .map(normalizeTurn)
    .filter(t => t && t.text);
}

/**
 * The conversation with the trigger message guaranteed to be its newest
 * inbound. conversation_recent is re-read from GHL after the inbound arrives,
 * so it usually already ends with the trigger; a replay or a buffered turn may
 * not, and the probe/decision-maker readers need it either way.
 */
function withTrigger(turns, triggerMessage) {
  const trigger = String(triggerMessage || '').trim();
  if (!trigger) return turns;
  const lastInbound = [...turns].reverse().find(t => t.direction === 'inbound');
  if (lastInbound && lastInbound.text === trigger) return turns;
  return [...turns, { direction: 'inbound', text: trigger, at: null, ms: null }];
}

function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

const QUESTION_OPENER_RX = /^\s*(?:who|what|when|where|why|how|do|does|did|can|could|is|are|will|would|should|any\s+chance|what'?s)\b/i;

/** Is the lead asking us something (as opposed to telling us something)? */
export function isLeadQuestion(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  return s.includes('?') || QUESTION_OPENER_RX.test(s);
}

// ── Fix 1: answer, then discover ────────────────────────────────────────

// The lead asking about NEXT STEPS or TIMING in their own words. Tight on
// purpose: kb-retriever's detectSchedulingSignal is a substring list that
// reads "what about the warranty?" as scheduling, which is the failure this
// module exists to stop.
const SCHEDULING_INTENT_RX = new RegExp([
  String.raw`\bwhat(?:'s|\s+is|\s+are)\s+(?:the\s+)?next(?:\s+steps?)?\b`,
  String.raw`\bnext\s+steps?\b`,
  String.raw`\bwhen\s+can\s+(?:you|someone|somebody|we|they)\b`,
  String.raw`\bhow\s+soon\b`,
  String.raw`\bsooner\b`,
  String.raw`\bschedul(?:e|ing)\b`,
  String.raw`\bbook(?:ing)?\s+(?:it|an?|the|something|me)\b`,
  String.raw`\bset\s+(?:it|something|that)\s+up\b`,
  String.raw`\bget\s+(?:someone|somebody|you)\s+out\b`,
  String.raw`\bcome\s+(?:out|by|over)\b`,
  String.raw`\bavailab(?:le|ility)\b`,
  String.raw`\bappointment\b`,
  String.raw`\bget\s+started\b`,
  String.raw`\blet'?s\s+do\s+it\b`,
  String.raw`\bsign\s+me\s+up\b`,
  String.raw`\bhow\s+do\s+(?:i|we)\s+(?:proceed|move\s+forward|get\s+going)\b`,
  String.raw`\bwhat\s+(?:day|time)s?\s+(?:do\s+you\s+have|are\s+open|work)\b`,
].join('|'), 'i');

// A day or time being PICKED. Only counts when our last message put times on
// the table — "Saturday" in "Saturday the kids broke the window" is not a pick.
const DAY_TIME_PICK_RX = /\b(?:mon|tues?|wed(?:nes)?|thurs?|fri|sat(?:ur)?|sun)(?:day)?\b|\btomorrow\b|\btonight\b|\bthis\s+(?:week|weekend|afternoon|morning|evening)\b|\bnext\s+week\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)\b|\b(?:morning|afternoon|evening)s?\b|\bthe\s+(?:first|second|earlier|later)\s+one\b|\b(?:either|both)\s+works?\b/i;

/**
 * Did the lead just ask about scheduling, timing or next steps — or pick a
 * time we offered?
 *
 * @param {string} triggerMessage
 * @param {string|null} lastOutboundText  our previous message, if any
 */
export function schedulingIntent(triggerMessage, lastOutboundText = null) {
  const s = String(triggerMessage || '');
  if (!s.trim()) return false;
  if (SCHEDULING_INTENT_RX.test(s)) return true;
  if (lastOutboundText) {
    const close = extractClose(lastOutboundText);
    const themes = closeThemes(close);
    // An offer is on the table when our close asked for a time, or listed
    // concrete slots ("Tuesday at 10 or Thursday at 2?").
    const offered = themes.includes('scheduling') || themes.includes('call_15min')
      || (close.includes('?') && DAY_TIME_PICK_RX.test(close));
    if (offered && DAY_TIME_PICK_RX.test(s)) return true;
  }
  return false;
}

// A time/day ask in shapes closeThemes does not cover: "what's a time that
// could work for both of you?", "Tuesday at 10 or 2 PM, which works better?"
// (the slot-menu close on hZOcPk6XmMvWVvjZJ7mz that the replay missed).
const BOOKING_ASK_RX = /\bwhat'?s\s+a\s+(?:good\s+)?(?:time|day)\b|\bwhat\s+(?:day|time)s?\b|\bwhich\s+(?:works|one\s+works|fits|day|time)\b|\bwork(?:s)?\s+(?:better\s+)?for\s+(?:you|both|everyone)\b|\b(?:day|time|slot)\s+(?:that\s+)?(?:could\s+|would\s+|might\s+)?work\b|\bwhen'?s\s+good\b|\bget\s+(?:you|that|it)\s+(?:on\s+the\s+)?(?:schedule|calendar|booked)\b/i;

/** Is this sentence / close a booking, time, or call ask? */
function isBookingAskSentence(s) {
  if (!s || !s.includes('?')) return false;
  const themes = closeThemes(s);
  if (themes.includes('scheduling') || themes.includes('call_15min')) return true;
  if (BOOKING_ASK_RX.test(s)) return true;
  // A question that puts concrete slots on the table.
  return /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i.test(s) && DAY_TIME_PICK_RX.test(s);
}

/** Is this outbound's close a booking / time / call ask? */
function isBookingAsk(text) {
  return isBookingAskSentence(extractClose(text));
}

// Our own ask for a booking prerequisite. A lead answering it ("31700 Cannon
// Rush Drive") is cooperating with a booking, and the next step in that flow
// — the one decision-maker question, a time — must not be blocked by the
// three-turn cap that their own earlier "the visit has to be tomorrow" started.
const PREREQ_ASK_RX = /\b(?:the\s+)?(?:property\s+|home\s+|street\s+|full\s+)?address\b|\bzip(?:\s*code)?\b|\b(?:best\s+|phone\s+)?number\s+to\s+reach\b|\byour\s+name\b|\bwho\s+do\s+i\s+have\b|\bbest\s+email\b/i;

/**
 * How many of our last `lookback` messages closed with a booking ask.
 * @param {Array} conversation  turns, oldest first
 */
export function recentBookingAsks(conversation, lookback = 3) {
  const outbound = normalizeTurns(conversation).filter(t => t.direction === 'outbound');
  return outbound.slice(-Math.max(1, lookback)).filter(t => isBookingAsk(t.text)).length;
}

const BOOKING_UNLOCK_ACTIONS = new Set(['fast_track_booking', 'busy_callback']);

/**
 * May THIS reply ask for a day, a time, or a call?
 *
 * The order of the checks is the policy:
 *   1. a person is already on the way → never (it would contradict a promise
 *      made one turn ago; see handoffPending in response-generator.js)
 *   2. they asked about scheduling / next steps, or picked a time → yes
 *   3. the analyzer says fast-track / busy-callback → yes
 *   4. they asked us a question → no (answer it; one discovery question at most)
 *   5. we asked for a time in any of the last three turns → no (hard cap)
 *   6. otherwise → yes
 *
 * @returns {{allowed: boolean, reason: string, recent_asks: number}}
 */
export function bookingAskAllowed({
  triggerMessage = '',
  conversation = [],
  recommendedAction = null,
  handoffPending = false,
} = {}) {
  const turns = normalizeTurns(conversation);
  const lastOutbound = [...turns].reverse().find(t => t.direction === 'outbound');
  const recent = recentBookingAsks(turns, 3);

  if (handoffPending) return { allowed: false, reason: 'handoff_pending', recent_asks: recent };
  if (schedulingIntent(triggerMessage, lastOutbound?.text || null)) {
    return { allowed: true, reason: 'lead_asked_about_scheduling', recent_asks: recent };
  }
  if (lastOutbound && !isLeadQuestion(triggerMessage)) {
    const lastClose = extractClose(lastOutbound.text);
    if (lastClose.includes('?') && PREREQ_ASK_RX.test(lastClose)) {
      return { allowed: true, reason: 'lead_answered_booking_prerequisite', recent_asks: recent };
    }
    // They just answered the decision-maker question ("Don't worry, I'm the
    // owner") — the thing that was holding the booking is resolved.
    if (lastClose.includes('?') && DM_ASK_RX.test(lastClose)) {
      return { allowed: true, reason: 'lead_answered_decision_maker_ask', recent_asks: recent };
    }
  }
  // A stated deadline ("before September 24th") means the lead has done their
  // own discovery; the PROBE FIRST block already yields to scheduling
  // logistics, and the cap must not contradict it.
  if (withTrigger(turns, triggerMessage).some(t => t.direction === 'inbound' && URGENT_RX.test(t.text))) {
    return { allowed: true, reason: 'urgent_deadline_stated', recent_asks: recent };
  }
  if (recommendedAction && BOOKING_UNLOCK_ACTIONS.has(String(recommendedAction))) {
    return { allowed: true, reason: `recommended_action:${recommendedAction}`, recent_asks: recent };
  }
  if (isLeadQuestion(triggerMessage)) return { allowed: false, reason: 'lead_asked_a_question', recent_asks: recent };
  if (recent >= 1) return { allowed: false, reason: 'booking_ask_in_last_3_turns', recent_asks: recent };
  return { allowed: true, reason: 'default', recent_asks: recent };
}

// ── Fix 2: echo and probe before the first booking ask ──────────────────

// A problem named in the lead's own words. Each family is a thing a homeowner
// says about a window or door that is wrong. The storm family needs a worry
// word — "do you do hurricane windows?" is a product question, not a problem.
const PROBLEM_FAMILIES = Object.freeze([
  ['colour and design', /\b(?:colou?r|design|look(?:s)?|style|ugly|dated|outdated|match)\b/i],
  ['rot', /\brot(?:ting|ten|ted)?\b|\bwood\s+(?:is\s+)?(?:soft|gone|damaged)\b|\btermites?\b/i],
  ['draft', /\bdraft[ys]?\b|\bdrafts\b|\bair\s+(?:leak|coming|gets)\b/i],
  ['leak', /\bleak(?:s|ing|y|ed)?\b|\bwater\s+(?:coming|gets|got)\s+in\b/i],
  ['fogging', /\bfog(?:gy|ged|ging|s)?\b|\bcondensation\b|\bcloudy\b|\bseals?\s+(?:failed|broken|gone|shot)\b|\bmoisture\s+between\b/i],
  ['noise', /\bnois[ey]\b|\bloud\b|\bhear\s+(?:everything|the\s+(?:traffic|road|neighbou?rs))\b/i],
  ['age', /\b(?:so\s+)?old\b|\boriginal\s+(?:windows|to\s+the\s+house)\b|\bfrom\s+the\s+(?:\d0s|\d{4})\b|\bworn\s+out\b/i],
  ['damage', /\bbroken\b|\bcrack(?:ed|s)?\b|\bshattered\b|\bdamaged\b|\bwon'?t\s+(?:open|close|lock|stay)\b|\bhard\s+to\s+(?:open|close)\b|\bstuck\b|\bfalling\s+apart\b/i],
  ['energy bills', /\b(?:electric|energy|power|cooling|ac|a\/c)\s+bills?\b|\bbills?\s+(?:is|are)\s+(?:high|crazy|through\s+the\s+roof)\b|\b(?:house|room)\s+(?:gets|is)\s+(?:so\s+)?hot\b/i],
  ['storm worry', /\b(?:worried|scared|nervous|afraid|concerned)\b[^.?!]{0,60}\b(?:hurricane|storm|season)\b/i],
]);

// An outbound that PROBES the problem rather than moving past it.
const PROBE_RX = /\bhow\s+long\b|\bwhat\s+(?:don'?t|do)\s+you\s+(?:like|mean)\b|\bwhich\s+(?:room|windows?|doors?|ones?)\b|\bhow\s+(?:bad|much|often)\b|\bsay\s+more\b|\bwhat'?s\s+(?:going\s+on|bothering|the\s+worst)\b|\bwhat\s+about\s+(?:it|them|the)\b|\bhow\s+(?:does|has|is)\s+that\b|\btell\s+me\s+(?:more|about)\b/i;

// The lead stated a deadline. This skips the probe and goes straight to
// scheduling logistics — someone who needs it before the 24th has already done
// their own discovery.
const URGENT_RX = /\bbefore\s+(?:the\s+)?(?:\d{1,2}(?:st|nd|rd|th)?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|(?:hurricane\s+)?season|the\s+(?:holidays|storm))\b|\bby\s+(?:the\s+)?(?:\d{1,2}(?:st|nd|rd|th)|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|end\s+of\s+(?:the\s+)?(?:month|week|year)|next\s+(?:week|month)|(?:mon|tues?|wed(?:nes)?|thurs?|fri|sat(?:ur)?|sun)day)\b|\basap\b|\bas\s+soon\s+as\s+possible\b|\bright\s+away\b|\bdeadline\b|\bclosing\s+(?:on|date|in)\b|\bneed\s+(?:it|this|them|these)\s+(?:done|in|installed|replaced)\s+(?:by|before|fast|quick)\b|\bin\s+a\s+hurry\b|\btime[- ]sensitive\b/i;

/**
 * Has the lead named a problem in their own words, and have we probed it?
 *
 * @returns {{problem_named: string|null, family: string|null, probe_done: boolean, urgent: boolean}}
 */
export function problemProbeState({ triggerMessage = '', conversation = [] } = {}) {
  const turns = withTrigger(normalizeTurns(conversation), triggerMessage);

  // The LATEST inbound statement that names a problem. A question about a
  // product ("do you do coloured frames?") is not a problem statement.
  let problemIdx = -1;
  let named = null;
  let family = null;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const t = turns[i];
    if (t.direction !== 'inbound') continue;
    for (const sentence of splitSentences(t.text)) {
      if (sentence.includes('?')) continue;
      const hit = PROBLEM_FAMILIES.find(([, rx]) => rx.test(sentence));
      if (hit) {
        problemIdx = i;
        named = sentence.replace(/\s+/g, ' ').slice(0, 160);
        family = hit[0];
        break;
      }
    }
    if (problemIdx >= 0) break;
  }

  let probeDone = false;
  if (problemIdx >= 0) {
    const rx = PROBLEM_FAMILIES.find(([name]) => name === family)?.[1];
    for (let j = problemIdx + 1; j < turns.length; j += 1) {
      const t = turns[j];
      if (t.direction !== 'outbound' || !t.text.includes('?')) continue;
      // A question that asks for contact details or a time is not a probe,
      // whatever else it mentions ("to see colour options, what's your
      // phone number?" — Carlos, 2026-09-21).
      const questions = splitSentences(t.text).filter(s => s.includes('?'))
        .filter(s => !PREREQ_ASK_RX.test(s) && !isBookingAskSentence(s) && !DM_ASK_RX.test(s));
      if (!questions.length) continue;
      if (questions.some(s => PROBE_RX.test(s))) { probeDone = true; break; }
      // Or the question quotes their problem back: shares the family's words.
      if (rx && questions.some(s => rx.test(s))) { probeDone = true; break; }
    }
  }

  // A deadline is a thread-level fact: "before September 24th" said three
  // messages ago still governs this turn.
  const urgent = turns.some(t => t.direction === 'inbound' && URGENT_RX.test(t.text));

  return { problem_named: named, family, probe_done: probeDone, urgent };
}

// ── Fix 3: decision-makers — ask once, NEPQ, then a human ───────────────

// Who they named. The name is captured only when it is capitalised and
// follows the relationship word ("my wife Paloma", "my husband, Dan").
const NAMED_PERSON_RX = /\b(?:[Mm]y|[Oo]ur)\s+([Ww]ife|[Hh]usband|[Ss]pouse|[Pp]artner|[Ff]ianc[ée]e?|[Bb]oyfriend|[Gg]irlfriend|[Mm]om|[Mm]other|[Dd]ad|[Ff]ather|[Ss]on|[Dd]aughter|[Bb]rother|[Ss]ister|[Rr]oommate)\b(?:,?\s+(?:is\s+)?([A-Z][a-z]{1,20}))?/;
const NAME_AND_I_RX = /\b([A-Z][a-z]{1,20})\s+and\s+(?:I|me)\b/;

// The named person will not be part of this.
const ABSENT_RX = /\b(?:doesn'?t|don'?t|won'?t|will\s+not|does\s+not|do\s+not|didn'?t)\s+(?:need|have|want)\s+to\s+be\s+(?:there|here|home|present|involved|part\s+of|on\s+the\s+call)\b|\b(?:she|he|they)\s+(?:won'?t|can'?t|cannot|will\s+not|isn'?t\s+going\s+to|is\s+not\s+going\s+to)\s+be\s+(?:there|here|home|present|available|around|involved)\b|\bnot\s+(?:involved|part\s+of\s+(?:this|it|that))\b|\bleave\s+(?:her|him|them)\s+out\b|\b(?:she|he|they)\s+(?:doesn'?t|don'?t)\s+(?:care|need\s+to|have\s+to)\b|\bjust\s+(?:deal|talk)\s+with\s+me\b|\b(?:i|i'?ll|i\s+will)\s+(?:handle|make|decide|take\s+care\s+of)\s+(?:it|this|that|the\s+decision)\b/i;

// The named person is on board / will attend.
const PRESENT_RX = /\bwe'?ll\s+both\b|\bboth\s+of\s+us\b|\bwe\s+both\b|\bus\s+both\b|\b(?:she|he|they)\s+(?:can|will|would|could)\s+be\s+(?:there|here|home|on\s+the\s+call|around)\b|\b(?:she|he|they)(?:'s|\s+is|\s+are)\s+(?:on\s+board|fine\s+with|good\s+with|open\s+to|okay\s+with|ok\s+with|all\s+for)\b|\b(?:she|he|they)\s+(?:wants?|would\s+like)\b|\bworks\s+for\s+(?:us|both)\b|\byes,?\s+both\b/i;

// Our decision-maker ask, in any of the shapes we actually use.
const DM_ASK_RX = /\b(?:anyone|anybody|someone|somebody)\s+else\b|\bwho\s+else\b|\byour\s+call\b|\bjust\s+(?:you|yourself)\b|\bonly\s+you\b|\bdecision[-\s]?makers?\b|\bweigh(?:s|ing)?\s+in\b|\bboth\s+of\s+you\b|\bboth\s+(?:be\s+)?(?:home|there|present|available)\b|\bon\s+the\s+(?:home|deed)\s+with\s+you\b|\bcan\s+(?:they|she|he)\s+(?:join|be\s+there|make\s+it)\b/i;

// Our NEPQ follow-up about the named person.
// Our own outbound, so a plain word stands in for the name.
const FEEL_ASK_RX = /\bhow\s+(?:does|do|would)\s+(?:\w+|your\s+(?:wife|husband|spouse|partner))\s+feel\b|\bwhere\s+(?:does|do)\s+\w+\s+(?:stand|land)\b|\bwhat\s+(?:does|do)\s+\w+\s+think\b/i;

// A second refusal after the feel-ask.
const REFUSAL_RX = /^\s*(?:no|nope|nah)\b|\bnot\s+(?:happening|necessary|needed|required)\b|\bjust\s+(?:book|schedule|set)\s+(?:it|me|something)\b|\bi\s+(?:already\s+)?(?:said|told\s+you)\b|\bstop\s+asking\b|\bdon'?t\s+(?:worry|ask)\s+about\s+(?:her|him|them|that)\b|\bdoesn'?t\s+matter\b|\bit'?s\s+(?:just\s+)?me\b/i;

function readName(text) {
  const m = String(text || '').match(NAMED_PERSON_RX);
  if (m) return { relation: m[1].toLowerCase(), name: m[2] || null };
  const n = String(text || '').match(NAME_AND_I_RX);
  if (n) return { relation: null, name: n[1] };
  return null;
}

/**
 * Where this conversation stands on who decides.
 *
 * status:
 *   unknown        nobody named, never asked
 *   asked          we asked, no answer yet
 *   sole           one decision-maker; never mention another person again
 *   named_present  another person exists and is on board / attending
 *   named_absent   another person exists and the lead says they need not be there
 *   handoff        named_absent, we asked how that person feels once, and the
 *                  lead refused again — a human sorts the visit out
 *
 * @param {object} args
 * @param {Array}  args.conversation  turns, oldest first (trigger included or not)
 * @param {string} [args.triggerMessage]
 * @param {object} [args.established] buildEstablishedFacts() output
 */
export function decisionMakerState({ conversation = [], triggerMessage = '', established = null } = {}) {
  const turns = withTrigger(normalizeTurns(conversation), triggerMessage);
  const fact = (established?.facts || []).find(f => f.key === 'decision_makers') || null;

  let name = null;
  let relation = null;
  let namedAt = -1;
  let askCount = 0;
  let feelAskCount = 0;
  let lastFeelAskIdx = -1;
  let absentIdx = -1;
  let presentIdx = -1;
  let soleIdx = -1;

  for (let i = 0; i < turns.length; i += 1) {
    const t = turns[i];
    if (t.direction === 'outbound') {
      if (t.text.includes('?')) {
        if (FEEL_ASK_RX.test(t.text)) { feelAskCount += 1; lastFeelAskIdx = i; }
        else if (DM_ASK_RX.test(t.text)) askCount += 1;
      }
      continue;
    }
    const person = readName(t.text);
    if (person && (person.name || !name)) {
      name = person.name || name;
      relation = person.relation || relation;
      if (namedAt < 0) namedAt = i;
    }
    if (ABSENT_RX.test(t.text)) absentIdx = i;
    if (PRESENT_RX.test(t.text)) presentIdx = i;
    if (isSoloOwnerStatement(t.text) && !readName(t.text)) soleIdx = i;
  }

  const newestInbound = [...turns].reverse().find(t => t.direction === 'inbound') || null;
  const newestIdx = newestInbound ? turns.lastIndexOf(newestInbound) : -1;

  const base = { name, relation, ask_count: askCount, feel_ask_count: feelAskCount };

  // A CRM value is authoritative for booking; the transcript decides the tone.
  const fieldValue = fact?.source === 'field' ? fact.value : null;

  if (fieldValue === 'Solo Owner' || (soleIdx >= 0 && namedAt < 0)) {
    return { status: 'sole', ...base, name: null, relation: null };
  }

  if (namedAt >= 0 || fieldValue === 'Yes' || fieldValue === 'No') {
    const absent = absentIdx >= 0 && absentIdx >= presentIdx;
    if (absent || fieldValue === 'No') {
      const refusedAgain = feelAskCount >= 1 && newestIdx > lastFeelAskIdx
        && (ABSENT_RX.test(newestInbound.text) || REFUSAL_RX.test(newestInbound.text) || isSoloOwnerStatement(newestInbound.text));
      return { status: refusedAgain ? 'handoff' : 'named_absent', ...base };
    }
    return { status: 'named_present', ...base };
  }

  if (fact && fact.value === 'Solo Owner') return { status: 'sole', ...base };
  if (fact && fact.value === 'Yes') return { status: 'named_present', ...base };
  if (fact && fact.value === 'No') return { status: 'named_absent', ...base };
  if (askCount > 0) return { status: 'asked', ...base };
  return { status: 'unknown', ...base };
}

// ── Fix 5: the GHL workflow opener ──────────────────────────────────────

const OPENER_RX = /\bhoping\s+to\s+get\s+done\b|\bgoing\s+on\s+with\s+(?:your|the|them|those)\b|\bwhat\s+got\s+you\s+looking\b|\bwhat\s+prompted\b|\bmade\s+you\s+reach\s+out\b|\bwhat\s+(?:are|were)\s+you\s+looking\s+(?:to|for)\b|\bhow\s+can\s+(?:we|i)\s+help\b|\bwhat\s+brings\s+you\b|\bwhat\s+can\s+(?:we|i)\s+help\s+(?:you\s+)?with\b|\bwhat\s+(?:are\s+you\s+)?(?:hoping|looking)\s+to\s+(?:do|accomplish|fix|get)\b/i;

export const OPENER_WINDOW_MS = 10 * 60 * 1000;

/**
 * Did an OUTBOUND from any source (a GHL workflow's welcome text included)
 * already ask the opening discovery question inside the window?
 *
 * A turn without a usable timestamp counts only when it is our most recent
 * message — the conservative reading, since re-asking is the defect.
 *
 * @returns {{asked: boolean, text: string|null, age_sec: number|null}}
 */
export function openerAlreadyAsked({ conversation = [], nowMs = null, windowMs = OPENER_WINDOW_MS } = {}) {
  const turns = normalizeTurns(conversation);
  const outbound = turns.filter(t => t.direction === 'outbound');
  const newest = outbound[outbound.length - 1] || null;
  for (let i = outbound.length - 1; i >= 0; i -= 1) {
    const t = outbound[i];
    if (!OPENER_RX.test(t.text)) continue;
    if (t.ms !== null && Number.isFinite(nowMs)) {
      const age = nowMs - t.ms;
      if (age >= 0 && age <= windowMs) {
        return { asked: true, text: t.text.slice(0, 200), age_sec: Math.round(age / 1000) };
      }
      continue;
    }
    if (t === newest) return { asked: true, text: t.text.slice(0, 200), age_sec: null };
  }
  return { asked: false, text: null, age_sec: null };
}

// ── the bundle ──────────────────────────────────────────────────────────

/**
 * Everything the prompt and the guards need for one turn.
 *
 * @param {object} args
 * @param {string} args.triggerMessage
 * @param {Array}  args.conversation      context.conversation_recent
 * @param {object} [args.established]     buildEstablishedFacts() output
 * @param {string} [args.recommendedAction]
 * @param {boolean} [args.handoffPending]
 * @param {number} [args.nowMs]
 */
export function buildDiscipline({
  triggerMessage = '',
  conversation = [],
  established = null,
  recommendedAction = null,
  handoffPending = false,
  nowMs = null,
} = {}) {
  const booking = bookingAskAllowed({ triggerMessage, conversation, recommendedAction, handoffPending });
  const probe = problemProbeState({ triggerMessage, conversation });
  const decisionMakers = decisionMakerState({ conversation, triggerMessage, established });
  const opener = openerAlreadyAsked({ conversation, nowMs });
  // The DM question is a booking-relevant question. It may be asked only when
  // a booking ask is allowed and it has never been asked (Fix 3, items 1 and 5).
  const dmAskAllowed = booking.allowed && decisionMakers.status === 'unknown';
  return {
    version: DISCOVERY_DISCIPLINE_VERSION,
    booking,
    probe,
    decision_makers: { ...decisionMakers, ask_allowed: dmAskAllowed },
    opener,
  };
}

// ── guards (pure findX + xNote, the carrier-risk shape) ─────────────────

/** Question sentences that ask for a day, a time, or a call. */
export function findBookingAsks(message) {
  return splitSentences(message).filter(isBookingAskSentence);
}

export function bookingAskNote(reason) {
  const why = reason === 'lead_asked_a_question'
    ? 'they asked you a question and did not ask about scheduling'
    : reason === 'booking_ask_in_last_3_turns'
      ? 'you already asked for a time within the last three messages and it was not taken up'
      : 'a person from the team is already reaching out';
  return (
    `Your previous draft asked for a day, a time, or a call, and this turn a booking ask is not allowed: ${why}. ` +
    `Keep the part that answered them — that was right. Rewrite only the ending: either ONE question about ` +
    `THEIR situation in their own words (what made them start looking, what is going on with the windows), ` +
    `or no question at all. Do not ask for a day, a time, a call, an address, or who will be home.`
  );
}

// Enthusiasm openers. "Perfect," with a comma is deliberately NOT here — the
// in-home upgrade path and PATH A copy open with it — and neither is "Fair
// question —", the owner-approved disclosure line.
const BANNED_OPENER_PATTERNS = Object.freeze([
  ['a "good question" opener', /^\s*(?:good|great|excellent|awesome)\s+question\b/i],
  ['a "happy to help" opener', /^\s*happy\s+to\s+help\b/i],
  ['an enthusiasm opener with an exclamation mark', /^\s*(?:great|perfect|awesome|absolutely|wonderful|fantastic)!/i],
]);

/** Banned openers present, by label. */
export function findBannedOpeners(message) {
  const s = String(message || '');
  return BANNED_OPENER_PATTERNS.filter(([, rx]) => rx.test(s)).map(([label]) => label);
}

export function bannedOpenerNote(labels) {
  return (
    `Your previous draft opened with ${labels.join(' and ')}. That opener is banned: it reads as a script ` +
    `and it is the same opener this bot has used eight times in a row. Start with the answer itself, or ` +
    `with their own words reflected back. No praise for the question, no enthusiasm, no exclamation marks.`
  );
}

/** Strip a banned opener phrase, leaving the sentence that followed it. */
export function stripBannedOpener(message) {
  return String(message || '')
    .replace(/^\s*(?:good|great|excellent|awesome)\s+question\s*(?:[—–\-,.:!]+\s*)?/i, '')
    .replace(/^\s*happy\s+to\s+help\s*(?:[—–\-,.:!]+\s*)?/i, '')
    .replace(/^\s*(?:great|perfect|awesome|absolutely|wonderful|fantastic)!\s*/i, '')
    .replace(/^([a-z])/, (m) => m.toUpperCase());
}

/** Exclamation marks in a draft. */
export function findExclamations(message) {
  return (String(message || '').match(/!/g) || []).length;
}

/** Deterministic: "Great!" → "Great." No LLM round trip for punctuation. */
export function stripExclamations(message) {
  return String(message || '').replace(/!+/g, '.');
}

// Language that assumes a second decision-maker nobody named.
const PHANTOM_DM_PATTERNS = Object.freeze([
  /\bwhoever\s+else\b/i,
  /\b(?:anyone|anybody|someone|somebody)\s+else\s+(?:who(?:'s|\s+is)?\s+)?(?:deciding|weighing|involved|making|on\s+the\s+(?:home|deed|decision))/i,
  /\bboth\s+of\s+you\b/i,
  /\byou\s+both\b/i,
  /\bthe\s+two\s+of\s+you\b/i,
  /\byour\s+(?:wife|husband|spouse|partner|significant\s+other|better\s+half)\b/i,
  /\b(?:other|all|every)\s+decision[-\s]?makers?\b/i,
  /\beveryone\s+(?:who(?:'s|\s+is)\s+)?(?:deciding|involved|weighing)/i,
  /\bwith\s+(?:her|him|them)\s+on\s+(?:speaker|the\s+line|the\s+call)\b/i,
]);

const APPROVED_DM_ASK_RX = /\byour\s+call\b[^?]*\banyone\s+else\b/i;
// The shapes that ASK who decides (as opposed to assuming a second person, the
// "both of you" family). Only these may pass as the one allowed ask.
const DM_QUESTION_CORE_RX = /\b(?:anyone|anybody|someone|somebody)\s+else\b|\bwho\s+else\b|\byour\s+call\b|\bjust\s+(?:you|yourself)\b|\bonly\s+you\b|\bdecision[-\s]?makers?\b|\bweigh(?:s|ing)?\s+in\b/i;

/**
 * Sentences that refer to a second decision-maker the lead never named or
 * confirmed. When the lead is a sole owner, ANY decision-maker question is a
 * phantom. The one approved ask is exempt exactly once, and only on a turn
 * where a booking ask is allowed.
 *
 * @param {string} message
 * @param {object} dm  decisionMakerState() output, with ask_allowed
 */
export function findPhantomDecisionMaker(message, dm = {}) {
  const status = dm?.status || 'unknown';
  if (status === 'named_present' || status === 'named_absent' || status === 'handoff') return [];
  const hits = [];
  for (const s of splitSentences(message)) {
    const isApprovedAsk = APPROVED_DM_ASK_RX.test(s) || (s.includes('?') && DM_QUESTION_CORE_RX.test(s));
    if (isApprovedAsk && status === 'unknown' && dm.ask_allowed && (dm.ask_count || 0) === 0) continue;
    if (PHANTOM_DM_PATTERNS.some(rx => rx.test(s))) { hits.push(s); continue; }
    if (status === 'sole' && DM_ASK_RX.test(s)) { hits.push(s); continue; }
    if (status !== 'unknown' && s.includes('?') && DM_ASK_RX.test(s)) hits.push(s);
  }
  return hits;
}

export function phantomDecisionMakerNote(dm = {}) {
  const sole = dm?.status === 'sole';
  return (
    `Your previous draft referred to a second decision-maker ${sole ? 'after this customer told you they alone decide' : 'that this customer never named or confirmed'}. ` +
    `Do not write "both of you", "whoever else", "anyone else deciding", or mention a spouse or partner. ` +
    `${sole ? 'Book them as the sole owner and never raise decision-makers again.' : 'Talk to the one person in this conversation.'} ` +
    `Keep the answer; fix only the reference.`
  );
}

// ── Fix 6: insurance ────────────────────────────────────────────────────

const INSURANCE_OUTCOME_PATTERNS = Object.freeze([
  ['a premium reduction', /\bpremium\s+reductions?\b|\breduc(?:e|ed|ing|tion\s+(?:in|of|to))\s+(?:your\s+|their\s+|the\s+)?(?:insurance\s+)?premiums?\b|\bcut\s+(?:your\s+)?premiums?\b/i],
  ['lowering their premium', /\blower(?:ing|s|ed)?\s+(?:your\s+|their\s+|the\s+)?(?:insurance\s+)?(?:premiums?|rates?|bill)\b|\bpremiums?\s+(?:will\s+|would\s+|could\s+|should\s+)?(?:drop|go\s+down|fall|come\s+down)\b/i],
  ['insurance savings', /\bsave\s+(?:\$?\d[\d,]*\s+|money\s+|a\s+lot\s+|hundreds?\s+|thousands?\s+)?on\s+(?:your\s+)?(?:home(?:owners?)?\s+)?insurance\b|\binsurance\s+savings?\b|\bsavings?\s+on\s+(?:your\s+)?(?:home(?:owners?)?\s+)?insurance\b/i],
  ['an insurance discount promise', /\b(?:get|earn|receive|qualify\s+for)\s+(?:an?\s+|the\s+)?(?:\d+%\s+)?discount\s+on\s+(?:your\s+)?(?:home(?:owners?)?\s+)?insurance\b|\binsurance\s+discounts?\s+(?:of|up\s+to|around)\s+\$?\d/i],
]);

// Never named, whatever the sentence around them says.
const CARRIER_NAMES = Object.freeze([
  'Citizens', 'State Farm', 'Allstate', 'Progressive', 'USAA', 'Universal Property', 'Heritage',
  'Security First', 'Florida Peninsula', 'Tower Hill', 'Frontline', 'Slide Insurance', 'HCI',
  'Homeowners Choice', 'Nationwide', 'Liberty Mutual', 'Farmers', 'Travelers', 'GEICO', 'Chubb',
  'American Integrity', 'Kin Insurance', 'Olympus', 'Southern Oak', 'Edison Insurance', 'TypTap',
]);
const CARRIER_RX = new RegExp(`\\b(?:${CARRIER_NAMES.map(n => n.replace(/\s+/g, '\\s+')).join('|')})\\b`, 'i');
const CARRIER_DECIDES_RX = /\binsurance\s+company\s+decides\s+the\s+final\s+number\b/i;

/**
 * Insurance-outcome language in a draft.
 *
 * Outcome phrases are allowed ONLY alongside the approved carrier-decides
 * sentence. A carrier name is never allowed.
 *
 * @returns {{outcomes: string[], carriers: string[], paired: boolean, violations: string[]}}
 */
export function findInsuranceOutcomeClaims(message) {
  const s = String(message || '');
  const outcomes = INSURANCE_OUTCOME_PATTERNS.filter(([, rx]) => rx.test(s)).map(([label]) => label);
  const carriers = [];
  const m = s.match(new RegExp(CARRIER_RX.source, 'gi'));
  if (m) for (const c of m) if (!carriers.includes(c)) carriers.push(c);
  const paired = CARRIER_DECIDES_RX.test(s);
  const violations = [];
  if (outcomes.length && !paired) violations.push(...outcomes);
  if (carriers.length) violations.push('a named insurance carrier');
  return { outcomes, carriers, paired, violations };
}

export function insuranceNote(found) {
  const carrier = found.carriers?.length ? 'It also named an insurance carrier, which is never allowed. ' : '';
  return (
    `Your previous draft predicted an insurance outcome (${found.violations.filter(v => v !== 'a named insurance carrier').join(', ') || 'a premium or savings result'}). ` +
    `${carrier}Compliance forbids predicting a claim or premium result. If insurance comes up, use exactly this shape and nothing more: ` +
    `"${APPROVED_INSURANCE_LINE}" Keep the rest of the answer as it was.`
  );
}

/**
 * Deterministic rewrite for a second draft that still predicts an outcome:
 * every sentence carrying outcome language or a carrier name is replaced by
 * the approved line (once), and the rest of the message is untouched.
 */
export function replaceInsuranceClaims(message) {
  const sentences = splitSentences(message);
  let replaced = false;
  const out = [];
  for (const s of sentences) {
    const bad = INSURANCE_OUTCOME_PATTERNS.some(([, rx]) => rx.test(s)) || CARRIER_RX.test(s);
    if (!bad) { out.push(s); continue; }
    if (!replaced) { out.push(APPROVED_INSURANCE_LINE); replaced = true; }
  }
  return out.join(' ');
}

// ── Fix 5 guard ─────────────────────────────────────────────────────────

/** Question sentences that re-ask the opener an automated message already sent. */
export function findRepeatedOpener(message, openerText) {
  const opener = String(openerText || '');
  return splitSentences(message).filter(s => {
    if (!s.includes('?')) return false;
    if (OPENER_RX.test(s)) return true;
    return opener ? closesRepeat(s, opener, { similarityFloor: 0.6 }) : false;
  });
}

export function repeatedOpenerNote(openerText, ageSec) {
  const when = ageSec != null ? `${ageSec} seconds ago` : 'moments ago';
  return (
    `Your previous draft asked the opening question again. An automated message already asked it ${when}: ` +
    `"${String(openerText || '').slice(0, 160)}". Asking it twice reads as two different bots. If their reply was ` +
    `just a greeting or a yes, respond briefly and wait — a short line with no question is a valid message — ` +
    `or ask ONE different discovery question (which room, how long, what is the worst one).`
  );
}

// A bare sign-off left behind once the sentences around it are gone.
const SIGNATURE_ONLY_RX = /^\s*[—–-]?\s*(?:the\s+)?(?:reece\s+team|mark|reece\s+windows(?:\s*&\s*doors)?)\s*$/i;

/** Drop the sentences a predicate flags; empty result means nothing shippable was left. */
export function stripSentences(message, predicate) {
  const kept = splitSentences(message).filter(s => !predicate(s)).join(' ').trim();
  return SIGNATURE_ONLY_RX.test(kept) ? '' : kept;
}

/** A harmless holding line when a rewrite empties the draft. */
export function holdingLine(firstName) {
  const name = String(firstName || '').trim();
  return name ? `Hi ${name}. I'm here whenever you're ready.` : "Hi. I'm here whenever you're ready.";
}
