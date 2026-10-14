/**
 * What a post-demo (rehash) lead's reply is asking for — src/agentic/rehash-intent.js
 *
 * WHY (John Manieri, rehash team, 2026-10-14)
 *   #contact-rehash got "📞 REHASH CALL REQUEST — <name> said yes to a call" for
 *   leads who never agreed to a call: "there are no answers on any of these bot
 *   call backs… most of these are not actual call backs, they're looking for
 *   emailed quotes the salespeople promised and never delivered… Koger is
 *   already sold and set." 14 cards, 10-10 → 10-14: 0 agreed to a call. The
 *   analyzer labels almost every post-demo reply `callback_request` (the rehash
 *   bot's goal is always a call), so rule 324 and BOT_CALLBACK both queued an
 *   `lp_callback_requeue`, and its rehash branch posted the call card with a
 *   hard-coded "agreed". What the leads actually texted:
 *     thanks / no questions / "Melody did a great job"   → ack
 *     "Thinking" / "We're thinking through it"            → not_now
 *     "Where is my guote?" / "I only got one page of it"  → quote_request
 *     "…that is fraud" / "Bill did not receive a call"    → complaint
 *
 * PURE and regex-first, so the rehash team's card is decided the same way every
 * time and the 14 real messages are a test (scripts/test-rehash-intent.js).
 * Order matters: complaint → quote_request → call_request → not_now → ack.
 * A complaint that also mentions a call ("I never got a call") is a concern
 * first; a bare "yes" counts as a call only when OUR last message offered one.
 */

export const REHASH_INTENTS = Object.freeze(['call_request', 'quote_request', 'not_now', 'complaint', 'ack']);

// Upset, accusing, or a call we promised and did not make.
const COMPLAINT_RX = new RegExp([
  String.raw`\bfraud\w*`, String.raw`\bscam\w*`, String.raw`\brip(?:ped)?[\s-]?off\b`, String.raw`\blie[ds]?\b`, String.raw`\blying\b`,
  String.raw`\bmisle(?:d|ad)\w*`, String.raw`\bbait\s+and\s+switch\b`, String.raw`\bunprofessional\b`, String.raw`\brude\b`,
  String.raw`\bridiculous\b`, String.raw`\bdisappoint\w*`, String.raw`\bupset\b`, String.raw`\bangry\b`, String.raw`\bfurious\b`,
  String.raw`\bterrible\b`, String.raw`\bhorrible\b`, String.raw`\bawful\b`, String.raw`\bwaste\s+of\s+(?:my\s+|our\s+)?time\b`,
  String.raw`\bcheaper\s+(?:company|companies|option|price|quote|deal)\b`, String.raw`\b(?:attorney|lawyer|bbb|better\s+business\s+bureau)\b`,
  String.raw`\b(?:no\s*one|nobody|no\s+body)\s+(?:has\s+|ever\s+)?(?:called|reached\s+out|got\s+back)\b`,
  String.raw`\b(?:did\s*n[o']?t|didnt|never|have\s*n[o']?t|haven'?t|has\s*n[o']?t|hasn'?t)\s+(?:get|got|gotten|receive[d]?|hear[d]?)(?:\s+back)?(?:\s+(?:a|any|my|the|your))?\s+(?:call|call\s*back|callback|phone\s+call|response)\b`,
  String.raw`\bstill\s+waiting\s+(?:on|for)\s+(?:a\s+|the\s+|my\s+)?(?:call|callback|call\s*back)\b`,
].join('|'), 'i');

// The proposal itself: they want the quote, a copy, or its detail.
// 2026-10-14: "I didn't receive a bid" (the first live reply after the deploy)
// read as thanks, because "bid" was not a quote word.
const QUOTE_WORD_RX = /\b[qg]uot(?:e|es|ed|ation|ations)\b|\bbids?\b|\bestimates?\b|\bproposals?\b|\bpric(?:e|ing)\s+sheet\b|\bcontract\b|\bpaperwork\b|\bbreak\s*down\b|\bitemi[sz]\w*/i;
const QUOTE_ASK_RX = /\b(?:where|e-?mail\w*|send|sent|resend|re-send|copy|copies|provide|get|got|receive[d]?|see|look\s+at|double[\s-]?check|itemi[sz]\w*|in\s+writing|written|forward|attach\w*|pdf|pages?|full|whole|complete)\b/i;
const QUOTE_ALONE_RX = /\bis\s+there\s+an?\s+e-?mail\b|\bonly\s+(?:got|received|have|saw)\s+(?:one|1|the\s+first)\s+page\b|\bone\s+page\s+of\s+it\b|\bonly\s+the\s+price\b/i;

// An explicit ask for, or yes to, a call.
const NO_CALL_RX = /\b(?:don'?t|do\s+not|dont|never|no\s+need\s+to|stop|not)\s+(?:to\s+)?(?:call|calling|phone)\b|\bno\s+(?:more\s+)?calls?\b/i;
const EXPLICIT_CALL_RX = new RegExp([
  String.raw`\bcall\s+me\b`, String.raw`\bgive\s+(?:me|us)\s+a\s+(?:call|ring|buzz)\b`,
  String.raw`\b(?:please|pls|can\s+you|could\s+you|you\s+can|feel\s+free\s+to|go\s+ahead\s+and|have\s+\w+)\s+call\b`,
  String.raw`\byes,?\s+(?:please\s+)?call\b`, String.raw`\b(?:happy|glad|willing)\s+to\s+(?:talk|chat|hop\s+on)\b`,
  String.raw`\blet'?s\s+(?:talk|chat|set\s+up\s+a\s+call)\b`, String.raw`\breach\s+me\s+at\b`,
  String.raw`\b(?:a\s+|the\s+)?(?:phone\s+)?call\s+(?:works|is\s+fine|sounds\s+(?:good|great)|would\s+be\s+(?:great|good|fine|helpful))\b`,
  String.raw`\b(?:i'?m|i\s+am|we'?re|we\s+are)\s+(?:free|available)\s+(?:to\s+talk|for\s+a\s+call)\b`,
].join('|'), 'i');
const TIME_WINDOW_RX = /\b(?:after|before|around|at|by)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?(?!\s*(?:windows?|doors?|days?|weeks?|%))\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)\b|\b(?:tomorrow|today|this)\s+(?:morning|afternoon|evening)\b|\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\s+(?:morning|afternoon|evening|at|after|before)\b|\bany\s*time\b|\b(?:tomorrow|today)\s+(?:works|is\s+(?:good|fine))\b/i;
const AFFIRM_RX = /^\s*(?:yes|yeah|yea|yep|yup|sure|ok(?:ay)?|k|sounds\s+good|that\s+works|absolutely|definitely|please\s+do|go\s+ahead|of\s+course|i'?d\s+like\s+that|that\s+would\s+be\s+(?:great|good|fine))\b/i;
const NOT_NOW_GUARD_RX = /\b(?:not\s+now|not\s+right\s+now|busy|no\s+thanks?|not\s+interested)\b|^\s*no\b/i;
// Our own message offered a call (the rehash bot's goal).
const CALL_OFFER_RX = /\b(?:call|ring|talk|chat|phone)\b[^?]*\?/i;

// Busy, deciding, later.
const NOT_NOW_RX = /\b(?:not\s+now|not\s+right\s+now|not\s+yet|not\s+ready|busy|later|another\s+time|some\s+other\s+time|thinking|think\s+(?:about\s+it|it\s+over|it\s+through)|still\s+deciding|deciding|haven'?t\s+decided|discuss(?:ing)?|talk(?:ing)?\s+(?:it\s+)?over|need\s+(?:some\s+)?(?:more\s+)?time|hold(?:ing)?\s+off|wait(?:ing)?\s+(?:until|till|til|for)|next\s+(?:week|month|year)|after\s+the\s+holidays|in\s+a\s+few\s+(?:days|weeks)|get\s+back\s+to\s+you)\b/i;

const norm = (t) => String(t ?? '').replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();

/** Does our last message offer a call? Pure. */
export function offeredCall(lastOutbound) {
  return CALL_OFFER_RX.test(norm(lastOutbound));
}

/**
 * @param {string} text  the lead's message
 * @param {{ lastOutbound?: string|null }} [o]  our last message to them, when known
 * @returns {'call_request'|'quote_request'|'not_now'|'complaint'|'ack'}
 */
export function classifyRehashReply(text, { lastOutbound = null } = {}) {
  const t = norm(text);
  if (!t) return 'ack';
  if (COMPLAINT_RX.test(t)) return 'complaint';
  if (QUOTE_ALONE_RX.test(t) || (QUOTE_WORD_RX.test(t) && QUOTE_ASK_RX.test(t))) return 'quote_request';
  if (!NO_CALL_RX.test(t)) {
    if (EXPLICIT_CALL_RX.test(t)) return 'call_request';
    const offer = offeredCall(lastOutbound);
    const mentionsCall = /\bcall\b/i.test(t);
    if (!NOT_NOW_GUARD_RX.test(t) && (offer || mentionsCall) && (AFFIRM_RX.test(t) || TIME_WINDOW_RX.test(t))) return 'call_request';
  }
  if (NOT_NOW_RX.test(t)) return 'not_now';
  return 'ack';
}

/**
 * The lead's words from an lp_callback_requeue row's notes. BOT_CALLBACK writes
 * `Bot callback (sms, callback_request, callback_route). They said: "…"`; the
 * card used to print that whole line. Anything else is returned as it is. Pure.
 */
export function leadTextFromNotes(notes) {
  const s = String(notes ?? '').trim();
  if (!s) return '';
  const m = s.match(/They said:\s*"([\s\S]*)"\s*$/);
  return (m ? m[1] : s).trim();
}

/**
 * REHASH_INTENT_ROUTING on|off, default on. `off` is the rollback: every rehash
 * requeue posts the old "said yes to a call" card again.
 */
export function rehashIntentRoutingEnabled(env = process.env) {
  return String(env.REHASH_INTENT_ROUTING ?? 'on').trim().toLowerCase() !== 'off';
}
