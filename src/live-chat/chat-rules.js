/**
 * Live-chat-only reply rules — src/live-chat/chat-rules.js
 *
 * 2026-10-01 go-live check (22 shadow drafts), two failures the shared
 * guards do not cover. Both are pure functions so they unit-test without the
 * lane.
 *
 * 1. INVENTED APPOINTMENT TIMES. "I'd like someone to come out and give me a
 *    quote" drew "I have two openings this weekend — Saturday at 10 AM or
 *    Sunday at 2 PM." The live-chat lane passes NO calendar to the prompt
 *    (availability is null), so every specific time it offers is made up, and
 *    a visitor who accepts one is booked into nothing. Until the lane reads a
 *    real calendar, a chat never offers a time: a person calls to set it.
 *
 * 2. SPANISH. "hola dime que debo de haser" (a real visitor, 06:57 ET) got an
 *    English reply. The system prompt already says a language the bot cannot
 *    sustain at native quality goes to a human; the lane never acted on it.
 *    Now a Spanish message gets a fixed Spanish hand-off line and #ops-alerts
 *    is told, and the model is not called at all.
 */

// ── 1. no invented times ────────────────────────────────────────────────────

// A clock time ("10 AM", "2:30pm", "10 a.m.") or a "slot"/"opening" offer.
const CLOCK_RX = /\b(?:[1-9]|1[0-2])(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?)(?![a-z])/i;
const SLOT_RX = /\b(?:openings?|time\s*slots?|slots?\s+(?:open|available|left)|availability\s+(?:on|for|this|next)|i\s+(?:have|can\s+do|can\s+offer)\s+(?:[a-z]+\s+){0,3}(?:at|on)\s+(?:mon|tue|wed|thu|fri|sat|sun))/i;

const splitSentences = (t) => String(t || '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);

// A named day paired with a part of the day or a choice: "Friday afternoon or
// Saturday morning", "tomorrow morning", "this weekend". 2026-10-01 browser
// test: the clock-time check above let "which works better, Friday afternoon or
// Saturday morning?" through, and that is the same invented offer in words.
// A bare preference question ("do mornings or afternoons suit you?") names no
// day and is left alone.
const DAY = '(?:mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow|tonight|this\\s+weekend|next\\s+(?:week|weekend)';
const DAY_OFFER_RX = new RegExp(`\\b(?:${DAY})\\b[^.?!]{0,40}?\\b(?:morning|afternoon|evening|night|at\\s+\\d+|or\\s+(?:${DAY}))\\b|\\b(?:morning|afternoon|evening)\\s+(?:on\\s+)?(?:${DAY})\\b|\\b(?:openings?|slots?|availability)\\b[^.?!]{0,30}\\b(?:${DAY})\\b`, 'i');

// The day/time words of a sentence: day names, parts of day, numbers.
const TIME_TOKEN_RX = /\b(?:(?:mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow|tonight|weekend|morning|afternoon|evening|night|\d{1,2})\b/gi;

/**
 * Sentences that offer a specific appointment time. Pure.
 *
 * 2026-10-02 ("Guest Visitor tzuzq"): a sentence that only repeats a time the
 * VISITOR typed ("your appointment tomorrow evening at 6") is an echo, not an
 * invented slot. Stripping it removed the one useful line and appended "a team
 * member will call to set up a time" to someone who was cancelling.
 */
export function findTimeOffers(text, { visitorText = '' } = {}) {
  const said = String(visitorText || '').toLowerCase();
  const echoes = (s) => {
    if (!said) return false;
    const tokens = (s.toLowerCase().match(TIME_TOKEN_RX) || []);
    return tokens.length > 0 && tokens.every((t) => new RegExp(`\\b${t}\\b`).test(said));
  };
  return splitSentences(text).filter((s) => (CLOCK_RX.test(s) || SLOT_RX.test(s) || DAY_OFFER_RX.test(s)) && !echoes(s));
}

/**
 * The next step the bot CAN promise: a person calls to set the time. Before
 * that promise the bot must hold a first name AND a phone (Mark, 2026-10-01),
 * so a missing one is asked for in the same line.
 */
export function bookingHandoffLine({ hasPhone = false, hasName = true } = {}) {
  const ask = contactAskLine({ hasName, hasPhone });
  return ask
    ? `A team member will call you to set up a time that works. ${ask}`
    : "A team member will call you to set up a time that works for you.";
}

export const TIME_OFFER_NOTE =
  'Your previous draft offered specific appointment days or times. You cannot see the calendar in this chat, so any time you name is invented. ' +
  'Do not name a day or a time. Say a team member will call to set a time that works, and (if we have no phone number yet) ask for the best number.';

/**
 * Remove invented time offers from a draft. Returns the regeneration note and
 * a deterministic fix (offers stripped, the call-to-schedule line appended).
 * Pure.
 */
export function guardTimeOffers(draft, { hasPhone = false, hasName = true, visitorText = '', nepqLive = false } = {}) {
  const offers = findTimeOffers(draft, { visitorText });
  if (!offers.length) return { notes: [], fixed: String(draft || '') };
  const kept = splitSentences(draft).filter((s) => !offers.includes(s));
  // Drop a dangling question that only made sense with the times ("Which works better for you?").
  const cleaned = kept.filter((s) => !/\b(?:which|what)\s+(?:one\s+)?(?:works|time|day)\b/i.test(s));
  // 2026-10-02: an existing name/phone ask — with or without its "?" — goes
  // too, or the appended line asks for the number a second time (tzuzq:
  // "...best phone number to reach you on. A team member will call you...
  // What's the best phone number to reach you?").
  const noAsk = cleaned.filter((s) => !s.includes('?') && !asksForPhone(s));
  // NEPQ live: the real times come from the planner after a yes to the bridge.
  return { notes: [TIME_OFFER_NOTE], fixed: [...noAsk, nepqLive ? VISIT_BRIDGE_LINE : bookingHandoffLine({ hasPhone, hasName })].join(' ').trim() };
}

// ── 2. Spanish → a person ───────────────────────────────────────────────────

// Words that are Spanish and essentially never English. Two hits, or one of
// the unmistakable marks (¿ ¡ ñ "español"), makes the message Spanish.
const SPANISH_WORDS = new Set([
  'hola', 'gracias', 'quiero', 'quisiera', 'necesito', 'ventana', 'ventanas', 'puerta', 'puertas', 'precio', 'precios',
  'cuanto', 'cuánto', 'cuesta', 'dime', 'debo', 'hacer', 'haser', 'favor', 'usted', 'ustedes', 'tienen', 'tiene', 'buenos',
  'buenas', 'días', 'dias', 'tardes', 'noches', 'casa', 'mi', 'para', 'por', 'que', 'qué', 'como', 'cómo', 'donde', 'dónde',
  'cuando', 'cuándo', 'estoy', 'somos', 'hablan', 'habla', 'información', 'informacion', 'cotización', 'cotizacion',
  'presupuesto', 'huracán', 'huracan', 'sí', 'pero', 'también', 'tambien', 'nuestra', 'nuestro', 'llamar', 'llamen',
]);
// "mi", "para", "por", "que", "como" are Spanish but short and ambiguous; they
// only count alongside an unambiguous word.
const WEAK = new Set(['mi', 'para', 'por', 'que', 'como', 'casa', 'pero']);

/** Is this message Spanish? Pure. */
export function looksSpanish(text) {
  const s = String(text || '').toLowerCase();
  if (!s.trim()) return false;
  if (/[¿¡ñ]/.test(s) || /\bespa[ñn]ol\b/.test(s)) return true;
  const words = s.match(/[a-záéíóúüñ]+/g) || [];
  let strong = 0;
  let weak = 0;
  for (const w of words) {
    if (!SPANISH_WORDS.has(w)) continue;
    if (WEAK.has(w)) weak++; else strong++;
  }
  return strong >= 2 || (strong >= 1 && weak >= 1);
}

export const SPANISH_HANDOFF_LINE = 'Hola, gracias por escribirnos. Un miembro de nuestro equipo se comunicará con usted. ¿Cuál es el mejor número de teléfono para llamarle?';
export const SPANISH_THANKS_LINE = 'Gracias. Un miembro de nuestro equipo le llamará pronto.';

const PHONE_RX = /(?:\+?1[\s.-]*)?\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}\b/;

/**
 * Should this turn be the Spanish hand-off? A Spanish message, or any reply
 * right after our own Spanish hand-off line (a visitor answering with just a
 * phone number writes no Spanish words). Pure.
 *
 * @returns {null | { language: 'es', reply: string, phone: string|null, first: boolean }}
 */
export function planLanguageHandoff({ body, thread = [] }) {
  const prior = Array.isArray(thread) ? thread.slice(0, -1) : [];
  const lastOut = [...prior].reverse().find((m) => m.direction === 'outbound');
  const afterOurHandoff = !!lastOut && String(lastOut.text || '').includes('se comunicará con usted');
  const phone = (String(body || '').match(PHONE_RX) || [null])[0];
  if (afterOurHandoff && phone) return { language: 'es', reply: SPANISH_THANKS_LINE, phone, first: false };
  if (!looksSpanish(body)) return null; // an English reply after the hand-off goes to the model as usual
  return { language: 'es', reply: SPANISH_HANDOFF_LINE, phone: phone || null, first: !afterOurHandoff };
}

// ── 3. name + phone before any call promise (Mark, 2026-10-01) ─────────────
//
// The first live chat after go-live ("Guest Visitor ljloa", 16:01–16:09 ET)
// ended with "A team member will call you shortly" to a visitor whose name the
// bot never asked. Mark's rule: before the bot says anyone will call, it holds
// the visitor's first name AND phone number, and asks for whichever is missing
// in that same reply. GHL names a widget visitor "Guest Visitor <5 letters>",
// which is a placeholder, not a name.

const PLACEHOLDER_NAME_RX = /^\s*(?:guest(?:\s+visitor)?|visitor|website\s+visitor|unknown|n\/a|none|null|test)\b/i;

/** Is this a real person's name (not GHL's "Guest Visitor abcde", a phone, or blank)? Pure. */
export function isRealName(name) {
  const s = String(name || '').trim();
  if (!s || PLACEHOLDER_NAME_RX.test(s)) return false;
  if (/\d{3}/.test(s) || s.includes('@')) return false;
  return /[a-z]/i.test(s);
}

/** Does any of the visitor's own messages (or this one) carry a phone number? Pure. */
export function phoneInThread(thread = [], body = '') {
  const inbound = (Array.isArray(thread) ? thread : []).filter((m) => m?.direction === 'inbound').map((m) => m.text);
  return [...inbound, body].some((t) => PHONE_RX.test(String(t || '')));
}

/** The one question that collects what is missing, or null when nothing is. Pure. */
export function contactAskLine({ hasName = false, hasPhone = false } = {}) {
  if (!hasName && !hasPhone) return "What's your first name and the best number to reach you?";
  if (!hasPhone) return "What's the best phone number to reach you?";
  if (!hasName) return 'And what is your first name, so the team knows who to ask for?';
  return null;
}

// "A team member will call you", "someone will reach out", "we'll set up the
// visit": any line that commits a person to contacting the visitor.
// 2026-10-02 (ymnwp): "Let me get you connected with our team right away" is a
// next step too; missing it appended the visit pitch to a missed-visit reply.
const HANDOFF_PROMISE_RX = /\b(?:get|getting)\s+(?:you\s+)?(?:connected|in\s+touch)\s+with\s+(?:our|the|a|someone)\b|\bconnect\s+you\s+with\s+(?:our|the|a|someone)\b|\bget(?:ting)?\s+someone\s+(?:from\s+our\s+team\s+)?(?:on\s+this|to\s+(?:call|reach))\b/i;
const CALL_PROMISE_RX = /\b(?:team\s+member|someone|specialist|one\s+of\s+(?:our|us)|our\s+team|we)\b[^.?!]{0,40}?\b(?:will|'ll|can|is\s+going\s+to)\s+(?:call|reach\s+out|give\s+you\s+a\s+call|contact\s+you|be\s+in\s+touch|follow\s+up|set\s+(?:that|it|this|a\s+time|the\s+visit)\s+up|set\s+up)\b/i;

/** Does this draft promise that a person will call or set something up? Pure. */
export function promisesCall(text) {
  return CALL_PROMISE_RX.test(String(text || '')) || HANDOFF_PROMISE_RX.test(String(text || ''));
}

const asksForPhone = (s) => /\b(?:phone|number|reach\s+you|call\s+you\s+at)\b/i.test(s);
const asksForName = (s) => /\bname\b/i.test(s);

/**
 * A draft that promises a call while the name or phone is missing ends with
 * the ask for what is missing. Pure. Returns the regeneration notes and a
 * deterministic fix.
 */
export function guardCallPromise(draft, { hasName = false, hasPhone = false } = {}) {
  const text = String(draft || '');
  const ask = contactAskLine({ hasName, hasPhone });
  if (!ask || !promisesCall(text)) return { notes: [], fixed: text };
  const questions = splitSentences(text).filter((s) => s.includes('?'));
  const covered = questions.length === 1
    && (hasPhone || asksForPhone(questions[0]))
    && (hasName || asksForName(questions[0]));
  if (covered) return { notes: [], fixed: text };
  const missing = [!hasName && 'first name', !hasPhone && 'phone number'].filter(Boolean).join(' and ');
  return {
    notes: [`Your previous draft said a team member will call, but we do not have the visitor's ${missing} yet. Before any call is promised we must have their first name and phone number. End with exactly this one question: "${ask}"`],
    fixed: [...splitSentences(text).filter((s) => !s.includes('?')), ask].join(' ').trim(),
  };
}

// ── 4. a price or quote request goes to the in-home visit (NEPQ ch07/ch13) ──
//
// Same chat: "Can you give me a price on 12 new windows?" was answered with a
// "why now?" question, "I just want to get a price" with a dead end, and
// "Yes, how much?" only on the third ask with the visit. NEPQ: clarify a price
// request ONCE, then use the Transition — exact pricing comes from the free
// in-home measurement — and move to setting that up. A visitor who asks a
// second time, or says they just want a price, gets the Transition as a fixed
// line, with no model call.

const PRICE_RX = /\b(?:how\s+much|price[sd]?|pricing|costs?|quotes?|estimates?|ballpark|rough\s+(?:number|idea|figure)|what\s+(?:would|does|will)\s+(?:it|that|this)\s+(?:cost|run))\b/i;
const FINANCING_RX = /\b(?:financ\w*|monthly|per\s+month|a\s+month|payment\s+plans?|payments?)\b/i;
const INSIST_RX = /\b(?:just|only)\s+(?:want|need)\s+(?:a|the|to\s+(?:get|know)(?:\s+(?:a|the))?)\s+(?:price|quote|number|cost|estimate)\b/i;

/** Is this message asking what it costs? Pure. */
export function isPriceRequest(text) {
  return PRICE_RX.test(String(text || ''));
}

export const PRICE_TRANSITION_LINE = "Understood, you want a real number. The only way to get exact pricing is a free in-home measurement, and you keep written pricing that's good for a full year.";

/**
 * @returns {null | { asks: number, insist: boolean }} null when this message
 *   is not a price request; `insist` when it is the second ask (or an "I just
 *   want a price"), which gets the fixed Transition. Pure.
 */
export function planPriceTurn({ body, thread = [] }) {
  const text = String(body || '');
  // Financing has its own approved answer in the KB; it is not a price ask.
  if (FINANCING_RX.test(text)) return null;
  const insistNow = INSIST_RX.test(text);
  if (!isPriceRequest(text) && !insistNow) return null;
  const prior = (Array.isArray(thread) ? thread.slice(0, -1) : [])
    .filter((m) => m?.direction === 'inbound' && (isPriceRequest(m.text) || INSIST_RX.test(String(m.text || '')))).length;
  const asks = prior + 1;
  return { asks, insist: asks >= 2 || insistNow };
}

/** The fixed Transition for an insisting visitor. Pure. */
export function priceTransitionReply({ hasName = false, hasPhone = false } = {}) {
  return `${PRICE_TRANSITION_LINE} ${bookingHandoffLine({ hasName, hasPhone })}`;
}

/** The prompt instruction for a first price ask. Pure. */
export function priceHint({ hasName = false, hasPhone = false } = {}) {
  const ask = contactAskLine({ hasName, hasPhone });
  return 'PRICE REQUEST: they asked what it costs. Never give a price, a range or a per-window figure. ' +
    "In one sentence say exact pricing comes from a free in-home measurement and they keep written pricing that's good for a full year. " +
    `Then move straight to setting up that visit: say a team member will call to set a time that works${ask ? `, and end with exactly this question: "${ask}"` : ', with no further question'}. ` +
    'Do not ask why they want new windows or what made them look now in this reply.';
}

// ── 5. repeats, frustration, dead ends, "or" questions ──────────────────────
//
// Same chat again: after "My windows are really old" the bot asked "What made
// you decide to replace them now?" — a second "why now" after "What got you
// looking at windows right now?" two messages earlier — and the visitor wrote
// "I just told you they are old." The next reply stacked two questions with
// ", or what bothers you most…?", and the one after that ("Got it—they look
// old and don't feel right to you.") asked nothing and offered nothing.

const FRUSTRATION_RX = /\b(?:i\s+(?:just|already)\s+(?:told|said|answered|gave|explained)|like\s+i\s+(?:said|told\s+you)|as\s+i\s+(?:said|told\s+you)|you\s+(?:already\s+)?asked\s+(?:me\s+)?(?:that|this)|(?:read|look\s+at)\s+(?:my|the)\s+(?:last\s+)?(?:message|chat|text))\b/i;

/** "I just told you…": the visitor says they already answered. Pure. */
export function isFrustratedRepeat(text) {
  return FRUSTRATION_RX.test(String(text || ''));
}

export function frustrationHint({ hasName = false, hasPhone = false } = {}) {
  const ask = contactAskLine({ hasName, hasPhone });
  return 'VISITOR SAYS THEY ALREADY ANSWERED: acknowledge it in a few words (no apology speech), use what they told you, and never ask that question again. ' +
    `Move to the next step: a free in-home measurement, and a team member will call to set it up${ask ? `. End with exactly this question: "${ask}"` : '.'}`;
}

// A "why now" question in any of its wordings. Asking it twice is a repeat
// even when no two words match.
const WHY_NOW_RX = /\b(?:what\s+(?:made|got|brought|prompted|has\s+you|led)|why\s+now|decide\s+to|what'?s\s+(?:going\s+on|making\s+you|got\s+you))\b[^?]*\?/i;
const STOP = new Set(['what', 'that', 'this', 'with', 'your', 'have', 'about', 'they', 'them', 'there', 'would', 'could', 'right', 'just', 'like', 'does', 'into', 'from', 'been', 'were', 'when', 'where', 'which', 'most', 'some', 'more']);
const contentWords = (s) => new Set((String(s || '').toLowerCase().match(/[a-z']{4,}/g) || []).filter((w) => !STOP.has(w)));

/** Questions in this draft the bot already asked earlier in the chat. Pure. */
export function findRepeatedBotQuestions(draft, thread = []) {
  const prior = (Array.isArray(thread) ? thread : []).filter((m) => m?.direction === 'outbound')
    .flatMap((m) => splitSentences(m.text).filter((s) => s.includes('?')));
  if (!prior.length) return [];
  return splitSentences(draft).filter((q) => {
    if (!q.includes('?')) return false;
    if (WHY_NOW_RX.test(q) && prior.some((p) => WHY_NOW_RX.test(p))) return true;
    const a = contentWords(q);
    if (a.size < 2) return false;
    return prior.some((p) => {
      const b = contentWords(p);
      const shared = [...a].filter((w) => b.has(w)).length;
      return shared / Math.min(a.size, b.size || 1) >= 0.6;
    });
  });
}

// ", or what bothers you most…?" — a second question hung on the first.
// conversation-repetition.js isDoubleBarrelled catches the auxiliary-verb
// shape ("or is…"); a question word after "or" escaped it.
// 2026-10-02: ", and is the drafting mostly…?" and ", or is it just something
// you've noticed recently?" are the same shape (the approved "…or is anyone
// else weighing in?" stays).
const OR_SECOND_QUESTION_RX = /,?\s+or\s+(?:what|how|why|when|where|which|who)\b[^?]*\?|,\s*or\s+(?:is|are|was|were|do|does|did|has|have)\s+(?!anyone|anybody|someone|it\s+your\s+call)[^?]*\?|,\s*and\s+(?:is|are|was|were|do|does|did|have|has|what|how|which|where|when|who|why)\b[^?]*\?/i;

export function cutSecondQuestion(text) {
  return String(text || '').replace(OR_SECOND_QUESTION_RX, '?');
}

export const VISIT_NEXT_STEP_LINE = 'The next step is a free in-home measurement, and a team member will call to set it up.';
// 2026-10-02 (Mark: "It should book the time right now"): with NEPQ live the
// chat offers real times itself, so the next step is the bridge question; a
// yes gets two real times from the planner.
export const VISIT_BRIDGE_LINE = 'The next step would be a free visit at your home to measure. Would that help?';

/**
 * The live-chat conversation guards, run after the shared ones. Pure.
 * Order: one question → no repeated question → a call promise has name and
 * phone → never a dead end.
 */
// "No thanks", "not interested", "bye": the dead-end rule never pitches the
// visit after a no (NEPQ: two no's in a row go to a person, never a third ask).
// 2026-10-02 ("Guest Visitor tzuzq"): "don't waste your time coming", "no
// time. do not come", "you won't be allowed in" each got the in-home pitch
// bolted on, because this list did not know them. The model had already
// flagged the chat recommended_action=suppress; that signal counts too
// (`declined` below).
const DECLINE_RX = /\b(?:no\s+thanks?|no\s+thank\s+you|not\s+interested|leave\s+me\s+alone|good\s*bye|bye|never\s*mind|nevermind|(?:don'?t|do\s+not|dont)\s+(?:come|need|want|bother|call|text)|not\s+buying|waste\s+(?:your|my)\s+time|won'?t\s+be\s+allowed|stop\s+(?:texting|messaging|contacting)|not\s+for\s+me|no\s+time)\b/i;

/** Is the visitor saying no / go away? Pure. */
export function isDecline(text) {
  return DECLINE_RX.test(String(text || ''));
}

// What a reply to a "no" must not carry: the visit pitch and the number ask.
const PITCH_RX = /\bin-home\b|\bmeasurement\b|\bteam\s+member\s+will\s+call\b|\bset\s+(?:it|that|a\s+time)\s+up\b|\bset\s+up\s+a\s+time\b|\b(?:phone\s+)?number\b|\bfirst\s+name\b/i;

/** Remove sentences that pitch the visit or ask for contact details. Pure. */
export function stripPitch(text) {
  return splitSentences(text).filter((s) => !PITCH_RX.test(s)).join(' ').trim();
}

/** A reply never says the same thing twice, nor asks for the number twice. Pure. */
export function dedupeSentences(text) {
  const seen = new Set();
  let phoneAsks = 0;
  const out = [];
  for (const s of splitSentences(text).reverse()) {
    const key = s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    if (seen.has(key)) continue;
    if (asksForPhone(s) && /\?|\bwhat'?s\b|\bbest\b/i.test(s)) { if (phoneAsks++) continue; }
    seen.add(key);
    out.unshift(s);
  }
  return out.join(' ');
}

export const DECLINE_CLOSE_LINE = "Understood. Take care, and if anything changes, we're here.";

export function guardChatFlow(draft, { thread = [], hasName = false, hasPhone = false, body = '', bookingAllowed = true, declined = false, serviceTurn = false, nepqLive = false } = {}) {
  const notes = [];
  let fixed = String(draft || '');

  // A "no" gets a polite close: no pitch, no ask, nothing appended.
  if (declined || isDecline(body)) {
    const kept = dedupeSentences(stripPitch(cutSecondQuestion(fixed)));
    if (kept !== fixed.trim()) notes.push('The visitor said no. Acknowledge it in a few words and close politely. Do not pitch the visit or ask for a name or number.');
    return { notes, fixed: kept || DECLINE_CLOSE_LINE };
  }

  if (OR_SECOND_QUESTION_RX.test(fixed)) {
    notes.push('Your previous draft joined two questions with "or". Ask ONE question.');
    fixed = cutSecondQuestion(fixed);
  }
  const repeats = findRepeatedBotQuestions(fixed, thread);
  if (repeats.length) {
    notes.push(`Your previous draft asked again something this chat already asked ("${repeats[0]}"). Do not ask it again; use what the visitor told you and move to the next step.`);
    fixed = splitSentences(fixed).filter((s) => !repeats.includes(s)).join(' ');
  }
  const call = guardCallPromise(fixed, { hasName, hasPhone });
  notes.push(...call.notes);
  fixed = call.fixed;

  // A reply with no question and no next step leaves the visitor nowhere to go.
  // When the discovery discipline holds the booking ask back (a product
  // question was just answered), the fix is a regeneration with one discovery
  // question, never a visit pitch; past the regen window the answer stands.
  if (!fixed.includes('?') && !promisesCall(fixed) && !DECLINE_RX.test(String(body || ''))) {
    const ask = contactAskLine({ hasName, hasPhone });
    if (!bookingAllowed) {
      notes.push('Your previous draft ended with no question. Keep the answer and end with ONE short question about their situation (no booking ask yet).');
    } else if (ask && serviceTurn) {
      // An existing customer's problem (a missed visit, a question about their
      // job) is never answered with a sales pitch (2026-10-02, ymnwp).
      fixed = [fixed, ask].filter(Boolean).join(' ').trim();
    } else if (nepqLive && !serviceTurn) {
      notes.push(`Your previous draft ended with no question and no next step. End with exactly: "${VISIT_BRIDGE_LINE}"`);
      fixed = [fixed, VISIT_BRIDGE_LINE].filter(Boolean).join(' ').trim();
    } else if (ask) {
      notes.push(`Your previous draft ended with no question and no next step. Offer the free in-home measurement and end with exactly this question: "${ask}"`);
      fixed = [fixed, VISIT_NEXT_STEP_LINE, ask].filter(Boolean).join(' ').trim();
    }
  }
  // Everything was a repeat and nothing is missing: the next step itself.
  if (!fixed.trim()) fixed = nepqLive ? VISIT_BRIDGE_LINE : bookingHandoffLine({ hasName, hasPhone });
  return { notes, fixed: dedupeSentences(fixed) };
}
