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

/** Sentences that offer a specific appointment time. Pure. */
export function findTimeOffers(text) {
  return splitSentences(text).filter((s) => CLOCK_RX.test(s) || SLOT_RX.test(s));
}

/** The next step the bot CAN promise: a person calls to set the time. */
export function bookingHandoffLine({ hasPhone = false } = {}) {
  return hasPhone
    ? "A team member will call you to set up a time that works for you."
    : "A team member will call you to set up a time that works. What's the best phone number to reach you?";
}

export const TIME_OFFER_NOTE =
  'Your previous draft offered specific appointment days or times. You cannot see the calendar in this chat, so any time you name is invented. ' +
  'Do not name a day or a time. Say a team member will call to set a time that works, and (if we have no phone number yet) ask for the best number.';

/**
 * Remove invented time offers from a draft. Returns the regeneration note and
 * a deterministic fix (offers stripped, the call-to-schedule line appended).
 * Pure.
 */
export function guardTimeOffers(draft, { hasPhone = false } = {}) {
  const offers = findTimeOffers(draft);
  if (!offers.length) return { notes: [], fixed: String(draft || '') };
  const kept = splitSentences(draft).filter((s) => !offers.includes(s));
  // Drop a dangling question that only made sense with the times ("Which works better for you?").
  const cleaned = kept.filter((s) => !/\b(?:which|what)\s+(?:one\s+)?(?:works|time|day)\b/i.test(s));
  return { notes: [TIME_OFFER_NOTE], fixed: [...cleaned.filter((s) => !s.includes('?')), bookingHandoffLine({ hasPhone })].join(' ').trim() };
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
