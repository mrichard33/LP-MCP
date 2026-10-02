/**
 * one-ask — src/agentic/one-ask.js
 *
 * 2026-10-02 (Mark): every message asks for ONE thing and ends on it. Two
 * real replies broke it:
 *   "Yes, it's completely free. We just need your first name, best phone
 *    number, and email so we can get everything set up. No problem. What day
 *    works best for you?"                                   (4 asks + filler)
 *   "Perfect. We have Wednesdays blocked for you. To get you scheduled, I'll
 *    need your first name and a phone number we can reach you at."
 *                                       (2 asks, no "?", details before a time)
 * The old guard counted "?" only, so an ask written as a statement ("I'll need
 * your first name and a phone number") was invisible to it.
 *
 * Order (skip what we have): day/time → name → phone → address → decision
 * maker → email. A time is picked before any detail is asked. The plan's ask
 * wins when the draft carries it. Filler that answers nothing ("No problem.")
 * goes unless it opens the message. Pure and dependency-free.
 */

export const ASK_ORDER = ['day', 'name', 'phone', 'address', 'address_confirm', 'dm', 'email'];

const ITEM_RX = {
  name: /\b(?:first|full|your)\s+name\b|\bwho\s+should\s+i\s+put\b/i,
  phone: /\b(?:phone|cell)(?:\s+number)?\b|\bbest\s+number\b|\bnumber\s+(?:to|we\s+can|i\s+can)\s+(?:reach|call|text)\b/i,
  email: /\be-?mail\b/i,
  // "email address" is the email (2026-10-02 test: "Could you check the email
  // address?" read as two asks and became the street-address question).
  address: /(?<!e-?mail\s)\b(?:street\s+)?address\b|\bzip(?:\s*code)?\b/i,
  address_confirm: /\bis\s+the\s+visit\s+(?:still\s+)?at\b/i,
  dm: /\bpart\s+of\s+the\s+decision\b|\banyone\s+else\b|\bbe\s+able\s+to\s+be\s+there\b/i,
  // A question offering two clock times ("how about 10 AM or 6 PM?") is a day ask (Part 7).
  day: /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b[^?]{0,80}\bor\b|\b(?:what|which)\s+(?:day|time|one)\b|\bwhich\s+(?:works|would)\b|\bwhen\s+(?:works|would|is\s+(?:a\s+)?good)\b|\b(?:day|time)\s+(?:works|would\s+work)\b|\bgood\s+(?:day|time)\b/i,
};
// A statement that asks: "I'll need…", "we just need…", "can you send…".
const REQUEST_RX = /\b(?:i|we)(?:'ll|’ll|\s+will)?\s+(?:just\s+|also\s+|still\s+)?need\b|\b(?:can|could)\s+(?:you|i\s+(?:get|grab|have))\b|\bplease\s+(?:send|share|provide|reply|text|let)\b|\b(?:send|share|text)\s+(?:me|us)\s+(?:your|the)\b|\bif\s+you\s+(?:can\s+)?(?:send|share)\b/i;
const FILLER_RX = /^(?:no\s+problem|sounds\s+good|perfect|great|got\s+it|okay|ok|sure(?:\s+thing)?|absolutely|of\s+course|awesome|wonderful)[.!]?$/i;

export const CANON_ASK = Object.freeze({
  day: 'What day works best for you?',
  name: "What's your first name?",
  phone: "What's the best phone number to reach you?",
  address: "What's the street address for the visit, including the zip code?",
  dm: 'Will anyone else be part of the decision?',
  email: "What's the best email for you?",
});

function split(text) {
  return String(text || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
}

/** The items one sentence asks for, and whether it asks at all. Pure. */
export function asksIn(sentence) {
  const s = String(sentence || '');
  const isQuestion = s.trim().endsWith('?');
  const items = Object.entries(ITEM_RX).filter(([, rx]) => rx.test(s)).map(([k]) => k);
  // A question naming a detail asks for the detail, not a day ("What's the best time to call?" is a day ask).
  const detail = items.filter(k => k !== 'day');
  const request = !isQuestion && REQUEST_RX.test(s) && detail.length > 0;
  if (!isQuestion && !request) return { ask: false, items: [] };
  const list = detail.length ? detail : (items.includes('day') ? ['day'] : ['other']);
  return { ask: true, items: list, question: isQuestion };
}

/**
 * Keep one ask, as a question, at the end. Returns the text unchanged when it
 * already asks for at most one thing with a "?". Pure.
 * @param {string} text
 * @param {object} [o]
 * @param {string|null} [o.ask]   the plan's ask for this turn ('day','name',…)
 * @param {boolean} [o.timePicked] a time is held or picked: detail asks may lead
 * @param {Function} [o.canon]    (item) => the question for an item (plan wording)
 */
export function enforceOneAsk(text, { ask = null, timePicked = false, canon = null, protect = [] } = {}) {
  const original = String(text || '');
  // An approved line in the draft (the decision-maker ask with its reason, a
  // re-ask, an offer) IS the ask: kept word for word, last, and every other
  // ask goes. Never trimmed or reordered inside.
  const keepLine = (protect || []).filter(Boolean).find(l => original.includes(l));
  if (keepLine) {
    const rest = split(original.replace(keepLine, ' ')).map((s, i) => ({ s, i, ...asksIn(s) }));
    const kept = rest.filter(t => !t.ask && !(t.i > 0 && FILLER_RX.test(t.s))).map(t => t.s);
    const out = [...kept, keepLine].join(' ').trim();
    const same = out === original.replace(/\s+/g, ' ').trim();
    return same ? { text: original, changed: false, trimmed: [] } : { text: out, changed: true, trimmed: rest.filter(t => t.ask).map(t => t.s), kept: 'protected' };
  }
  const parts = split(original);
  if (!parts.length) return { text: original, changed: false, trimmed: [] };
  const tagged = parts.map((s, i) => ({ s, i, ...asksIn(s) }));
  const asks = tagged.filter(t => t.ask);
  const itemCount = asks.reduce((n, t) => n + t.items.length, 0);
  const statementAsk = asks.some(t => !t.question);
  // Filler in the middle answers nothing (the first sentence acknowledges them).
  const filler = tagged.filter(t => t.i > 0 && !t.ask && FILLER_RX.test(t.s));
  // One question-shaped ask and no filler: nothing to fix. (An offer after the
  // question, as in Mark's "…when you're both home? I have X or Y.", stays.)
  if (itemCount <= 1 && !statementAsk && !filler.length) return { text: original, changed: false, trimmed: [] };

  const all = [...new Set(asks.flatMap(t => t.items))];
  const order = (k) => { const i = ASK_ORDER.indexOf(k); return i < 0 ? ASK_ORDER.length : i; };
  let keep = null;
  if (ask && all.includes(ask)) keep = ask;
  else if (!timePicked && all.includes('day')) keep = 'day';
  else if (all.includes('other') && !(timePicked && all.some(k => k !== 'other' && k !== 'day'))) keep = 'other';
  else keep = all.filter(k => k !== 'other').sort((a, b) => order(a) - order(b))[0] || all[0] || null;

  // The sentence that carries the kept ask: verbatim when it asks for that one
  // thing as a question, else the plain question for it.
  let askSentence = null;
  if (keep === 'other') askSentence = [...asks].reverse().find(t => t.items.includes('other'))?.s || null;
  else if (keep) {
    const own = asks.find(t => t.question && t.items.length === 1 && t.items[0] === keep);
    askSentence = own ? own.s : ((canon && canon(keep)) || CANON_ASK[keep] || null);
  }
  const fillerSet = new Set(filler.map(t => t.i));
  const body = tagged.filter(t => !t.ask && !fillerSet.has(t.i)).map(t => t.s);
  const out = [...body, ...(askSentence ? [askSentence] : [])].join(' ').trim();
  if (!out || out === original.replace(/\s+/g, ' ').trim()) return { text: original, changed: false, trimmed: [] };
  const trimmed = [...asks.filter(t => t.s !== askSentence).map(t => t.s), ...filler.map(t => t.s)];
  return { text: out, changed: true, trimmed, kept: keep };
}
