/**
 * Conversation Repetition — src/agentic/conversation-repetition.js
 *
 * Two disciplines the responder had in its prompt and nowhere in its code:
 * do not send the same close twice, and do not pitch spouse attendance more
 * than once.
 *
 * WHY THIS EXISTS (2026-09-22, chatbot QA thread — GHL hZOcPk6XmMvWVvjZJ7mz)
 * ──────────────────────────────────────────────────────────────────────────
 * Seven consecutive outbound turns ended with the same ask. Verbatim from the
 * thread, in order:
 *
 *   1. "...want to just do the 15 minute call with Paloma on speaker, or find
 *       a day this week you're both around?"
 *   2. "...would a day this week with both of you work, or is the 15 minute
 *       call with Paloma on speaker easier?"
 *   3. "...would a day this week work for both you and Paloma, or is the 15
 *       minute call with her on speaker easier?"
 *   4. "That same call can also sort a time that works for both you and
 *       Paloma. What's a good time for a quick call?"
 *   5. "For the verification visit, what day this week works for both you and
 *       Paloma?"
 *   6. "...is there a day this week that works for both of you, or would the
 *       15 minute call with her on speaker be easier?"
 *   7. "...would the 15 minute call with her on speaker work this week?"
 *
 * Every one of those answered the lead's actual question correctly first. The
 * defect is entirely in the close. Two prompt rules were already written and
 * neither was enforceable:
 *
 *   - system-core.js:103 — "ONE advocacy attempt maximum, ever." Nothing
 *     recorded that the attempt had been spent, so "once" meant "every turn."
 *   - nepq-layer.js TONALITY — "ONE question per message. ONE question mark.
 *     Never two." Six of the seven closes are double-barrelled either/or asks.
 *
 * LOOP_ESCALATION_UNCLEAR fired on five of those seven turns and correctly
 * filed the loop. It did not and must not stop the reply: standing policy is
 * always-respond (PR #486) and `stop-bot` remains the only takeover switch.
 * So the escalation has to change what the reply SAYS, which is what
 * loopBreakState() below is for.
 *
 * WHY THEME MATCHING AND NOT STRING MATCHING
 * ──────────────────────────────────────────
 * No two of those seven closes share a sentence. A literal or near-literal
 * comparison catches none of them. What repeats is the ASK — scheduling, with
 * both owners, via the 15-minute call — reworded each turn. So a close is
 * reduced to its theme(s) and themes are compared. Token similarity runs
 * alongside it to catch a reworded ask whose theme set is thin.
 *
 * PURE. No I/O, no writes, no env reads, no clock. Every input arrives as an
 * argument so scripts/test-conversation-repetition.js can drive it directly.
 */

/** Words carrying no theme signal. Stripped before similarity. */
const STOPWORDS = new Set([
  'a', 'about', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'both',
  'but', 'by', 'can', 'could', 'did', 'do', 'does', 'for', 'from', 'get',
  'got', 'had', 'has', 'have', 'he', 'her', 'here', 'hers', 'him', 'his',
  'how', 'i', 'if', 'in', 'is', 'it', 'its', 'just', 'me', 'my', 'of', 'on',
  'or', 'our', 'ours', 'out', 'she', 'so', 'some', 'that', 'the',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'to',
  'up', 'us', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who',
  'will', 'with', 'would', 'you', 'your', 'yours',
]);

/**
 * Close themes. Each is a recurring ASK the responder makes; the repetition
 * that got flagged is the same theme set turn after turn.
 *
 * Order matters only for readability — a close may carry several themes and
 * all of them are returned.
 */
const CLOSE_THEMES = Object.freeze([
  // The Tier-1 booking CTA. "15 minute call", "quick call", "on speaker".
  ['call_15min', /\b(?:15|fifteen)[\s-]*(?:minute|min)\b|\bon speaker\b|\bquick (?:call|chat)\b/i],
  // Any ask for a day or time.
  ['scheduling', /\b(?:what|which) (?:day|time)\b|\bday this week\b|\bwork(?:s)? for you\b|\bgood time\b|\bschedule|\bbook (?:a|the|something)\b|\bfind a time\b|\bsort a time\b/i],
  // The both-decision-makers ask, by pronoun or by partner noun.
  ['both_present', /\bboth of (?:you|us)\b|\bboth you and\b|\byou(?:'| a)?re both\b|\bwith both\b|\bfor both\b|\bwife|husband|spouse|partner\b/i],
  // A handoff to a human.
  ['human_handoff', /\b(?:someone|somebody) (?:from )?(?:our|the) team\b|\bspecialist\b|\bconnect(?:ed)? you\b/i],
  // An offer to send information.
  ['send_info', /\bsend (?:you )?(?:some )?(?:info|information|details|a link)\b|\bemail (?:you|it|that) over\b/i],
]);

/**
 * The both-present PITCH, as opposed to a bare scheduling ask that happens to
 * name two people. The pitch ARGUES for joint attendance; that is the thing
 * capped at one per conversation. "Does Saturday work for you and Dana?" is
 * not a pitch and stays allowed forever.
 */
const SPOUSE_PITCH_RX = [
  // Advocacy: the visit is better / more useful / easier when both are there.
  //
  // 2026-09-23 — "works best" and "best when" were added after the live thread
  // on hZOcPk6XmMvWVvjZJ7mz got "it works best when both you and Paloma are
  // there" past the v1.0 list, which only looked for better/easier/more useful.
  // The pitch is a VALUE CLAIM about joint attendance however it is worded, so
  // the verb side of the pattern has to cover the ordinary ways of saying
  // "this goes better" — not just the three the first incident happened to use.
  /\b(?:more useful|a lot more useful|better|easier|smoother|best|works best|goes better|most helpful)\b[^.?!]{0,60}\bboth\b/i,
  /\bboth\b[^.?!]{0,60}\b(?:more useful|a lot more useful|works best|goes better|ask questions on the spot|nothing to relay)\b/i,
  // "it works best when both of you are there" — value claim BEFORE the
  // when-clause, which the two patterns above (verb near "both") can miss when
  // the gap runs longer than 60 characters.
  /\b(?:works best|goes better|is (?:a lot )?(?:better|easier|more useful))\b[^.?!]{0,40}\bwhen\b[^.?!]{0,60}\b(?:both|you and|and you)\b/i,
  // The explicit preference being planted or defended.
  /\bif there'?s any way both of you\b/i,
  /\b(?:she|he|they) (?:doesn'?t|don'?t) have to\b/i,
  /\b(?:weigh in|hear(?:ing)? (?:this|that) too|should be (?:there|part of))\b/i,
  /\bnothing to relay\b/i,
  /\banswers everyone'?s questions on the spot\b/i,
];

/** Normalize a chunk of outbound copy to comparable content tokens. */
export function contentTokens(text, { drop = [] } = {}) {
  if (!text || typeof text !== 'string') return [];
  const dropSet = new Set(drop.filter(Boolean).map(d => String(d).toLowerCase()));
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(w => !STOPWORDS.has(w))
    .filter(w => !dropSet.has(w));
}

/**
 * The CLOSE of an outbound message: the part that asks for the next step.
 *
 * Defined as the last sentence containing a question mark, falling back to the
 * final sentence when the message asks nothing. Trailing signatures
 * ("— Reece Team") are dropped: they are constant and would inflate every
 * similarity score.
 */
export function extractClose(message) {
  if (!message || typeof message !== 'string') return '';
  const body = message
    .replace(/[—-]\s*(?:the\s+)?reece\s+team\s*$/i, '')
    .trim();
  if (!body) return '';

  const sentences = body
    .split(/(?<=[.?!])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
  if (!sentences.length) return body;

  for (let i = sentences.length - 1; i >= 0; i--) {
    if (sentences[i].includes('?')) return sentences[i];
  }
  return sentences[sentences.length - 1];
}

/** Every theme a close carries. Empty when it asks for nothing recognisable. */
export function closeThemes(close) {
  if (!close || typeof close !== 'string') return [];
  const out = [];
  for (const [name, rx] of CLOSE_THEMES) {
    if (rx.test(close)) out.push(name);
  }
  return out;
}

/**
 * Containment similarity: |A ∩ B| / min(|A|,|B|).
 *
 * Deliberately not Jaccard. A short close ("What day works for both of you?")
 * fully contained in a longer one is the same ask padded with context, and
 * Jaccard scores that pair low precisely when it matters most.
 */
export function tokenSimilarity(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  if (!setA.size || !setB.size) return 0;
  let shared = 0;
  for (const t of setA) if (setB.has(t)) shared++;
  return shared / Math.min(setA.size, setB.size);
}

/** Two closes are "the same ask" by theme overlap or by wording overlap. */
export function closesRepeat(closeA, closeB, { drop = [], similarityFloor = 0.6 } = {}) {
  if (!closeA || !closeB) return false;

  const themesA = closeThemes(closeA);
  const themesB = closeThemes(closeB);
  if (themesA.length && themesB.length) {
    const shared = themesA.filter(t => themesB.includes(t));
    // A shared ACTIONABLE theme is a repeat. human_handoff and send_info are
    // legitimate to restate, so they only count alongside something else.
    const actionable = shared.filter(t => t !== 'human_handoff' && t !== 'send_info');
    if (actionable.length) return true;
  }

  return tokenSimilarity(
    contentTokens(closeA, { drop }),
    contentTokens(closeB, { drop }),
  ) >= similarityFloor;
}

/** Outbound turns, newest last, normalized to plain strings. */
function outboundBodies(conversation) {
  return (Array.isArray(conversation) ? conversation : [])
    .filter(t => t && String(t.direction || '').toLowerCase() === 'outbound')
    .map(t => String(t.body ?? t.message ?? t.text ?? ''))
    .filter(Boolean);
}

/**
 * How stuck is this conversation's close?
 *
 * @param {object}   args
 * @param {Array}    args.conversation  turns with {direction, body}, oldest first
 * @param {string}   [args.leadName]    dropped from tokens — a name in every close is noise
 * @param {number}   [args.lookback=4]  outbound turns considered
 * @param {boolean}  [args.escalated]   LOOP_ESCALATION_UNCLEAR has fired (loop-escalation tag)
 * @returns {{looping:boolean, repeats:number, recentCloses:string[], themes:string[]}}
 */
export function loopBreakState({
  conversation = [],
  leadName = null,
  lookback = 4,
  escalated = false,
} = {}) {
  const drop = leadName ? String(leadName).toLowerCase().split(/\s+/).filter(Boolean) : [];
  const closes = outboundBodies(conversation)
    .slice(-Math.max(1, lookback))
    .map(extractClose)
    .filter(Boolean);

  // Count how many of the most recent closes repeat the newest one.
  let repeats = 0;
  if (closes.length >= 2) {
    const newest = closes[closes.length - 1];
    for (let i = closes.length - 2; i >= 0; i--) {
      if (closesRepeat(newest, closes[i], { drop })) repeats++;
      else break; // only a CONSECUTIVE run counts
    }
  }

  const themes = closes.length ? closeThemes(closes[closes.length - 1]) : [];

  // Escalation alone is enough: the analyzer could not classify three turns in
  // a row, which is a loop whether or not the close wording gives it away.
  return {
    looping: escalated || repeats >= 1,
    repeats,
    recentCloses: closes,
    themes,
  };
}

/**
 * Has the both-decision-makers pitch already been spent in this conversation?
 *
 * Three tiers, highest first — the same shape as established-facts.js:
 *   1. A CRM marker (tag or field) written when the pitch went out.
 *   2. Our own outbound words in the transcript.
 *   3. Nothing; the pitch is still available.
 *
 * @returns {{used:boolean, source:('field'|'transcript'|null), our_words:string|null}}
 */
export function spouseAdvocacyState({
  conversation = [],
  tags = [],
  advocacyField = null,
} = {}) {
  const tagList = (Array.isArray(tags) ? tags : []).map(t => String(t).toLowerCase());
  if (advocacyField || tagList.includes('spouse-advocacy-used')) {
    return { used: true, source: 'field', our_words: null };
  }

  for (const body of outboundBodies(conversation).slice().reverse()) {
    if (SPOUSE_PITCH_RX.some(rx => rx.test(body))) {
      return { used: true, source: 'transcript', our_words: body.slice(0, 200) };
    }
  }
  return { used: false, source: null, our_words: null };
}

/** Does this draft make the both-present PITCH (not merely name two people)? */
export function isSpousePitch(message) {
  if (!message || typeof message !== 'string') return false;
  return SPOUSE_PITCH_RX.some(rx => rx.test(message));
}

/**
 * Question marks in a draft. The NEPQ cap is ONE.
 *
 * "?!" and "??" are one question, not two or three — the cap is on how many
 * things the lead is asked, not on punctuation.
 */
export function countQuestions(message) {
  if (!message || typeof message !== 'string') return 0;
  return (message.replace(/[?!]*\?[?!]*/g, '?').match(/\?/g) || []).length;
}

/**
 * A close is "double-barrelled" when it offers two asks joined by `or` inside
 * a single question. One question mark is not enough on its own: "would a day
 * this week work, or is the 15 minute call easier?" passes the mark count and
 * is exactly the pattern that got flagged.
 *
 * The test is what FOLLOWS `or`. A second clause opens with a verb — an
 * auxiliary ("or is the call easier") or a bare action ("or find a day"). A
 * second NOUN is one ask offering two values ("morning or afternoon?") and
 * stays legal forever; banning it would make the bot stilted for no gain.
 */
const SECOND_CLAUSE_RX = /\bor\s+(?:just\s+)?(?:is|are|was|were|am|would|will|can|could|should|shall|may|might|do|does|did|have|has|had|if|find|pick|grab|book|schedule|set|go|try|start|take|use|want|prefer|we|you|i)\b/i;

export function isDoubleBarrelled(message) {
  const close = extractClose(message);
  if (!close || !close.includes('?')) return false;
  return SECOND_CLAUSE_RX.test(close);
}

export const CONVERSATION_REPETITION_VERSION = '1.0';
