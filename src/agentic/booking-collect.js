/**
 * src/agentic/booking-collect.js
 *
 * 2026-10-02 (Mark): "The bot should only route to a human if it's not able
 * to handle the person's request. It should book the time right now." In his
 * test chat the visitor said yes to a visit and was told "a team member will
 * call you to set up a time". Behind that, the in-home booking gate
 * (evaluateInHomePrerequisites, src/actions/handlers/appointments.js) refuses
 * a Window Estimate / Measurement Verification visit without a real name, a
 * phone, the street address with zip, and the decision-maker question asked,
 * and chat visitors rarely have the address on file, so a pick was handed to
 * a person. Mark ruled: ask for what is missing first, one question at a
 * time, then book.
 *
 * The picked time is held in our own message ("Great, I'm holding Sat, Oct 3
 * at 10:00 AM ET for you."), so the next turns find it in the thread the same
 * way offeredSlots finds an offer. Pure: no I/O.
 */

export const COLLECT_ASK = Object.freeze({
  name: "What's your first name?",
  phone: "What's the best phone number to reach you?",
  address: "What's the street address for the visit, including the zip code?",
  dm: 'Will anyone else be part of the decision, like a spouse or partner?',
});

// The hold line. The phrase "I'm holding … for you." is what heldSlotText reads back.
export function holdLine(slot, tz, ask) {
  return `Great, I'm holding ${slotLabel(slot, tz)} for you. ${ask}`;
}

/** "Sat, Oct 3 at 10:00 AM ET" (the date form, never "tomorrow": it must read back the same later). */
export function slotLabel(slot, tz) {
  return `${slot.day} at ${slot.time}${tz ? ` ${tz}` : ''}`;
}

const HOLD_RX = /\bI'm holding (.+?) for you\./i;
const ASK_KEYS = Object.entries(COLLECT_ASK);

/**
 * The time we are holding, and which detail we asked for last, from the
 * thread (newest bot message first). Null when nothing is held, or when a
 * booking line or a new offer came after the hold. Pure.
 */
export function heldSlot(thread = []) {
  const outbound = (Array.isArray(thread) ? thread : [])
    .filter((m) => String(m?.direction || '').toLowerCase() === 'outbound')
    .map((m) => String(m?.text ?? m?.body ?? ''));
  for (let i = outbound.length - 1; i >= 0 && i >= outbound.length - 6; i--) {
    const text = outbound[i];
    // A booking line, or a new offer of two times (the spouse-conflict and
    // "that time just filled up" re-offers). "PM." inside an offer is not a
    // sentence end, so the offer is read up to its "?" (2026-10-02 test).
    if (/\bI have you down for\b|\bI have\b[^?]{0,140}\bor\b[^?]*\?/i.test(text) && !HOLD_RX.test(text)) return null;
    const m = text.match(HOLD_RX);
    if (m) {
      const last = outbound[outbound.length - 1];
      const asked = (ASK_KEYS.find(([, q]) => last.includes(q)) || [null])[0];
      return { text: m[1], asked };
    }
  }
  return null;
}

/** What the gate still needs, in the order we ask for it. Pure. */
export function missingItems({ hasName = false, hasPhone = false, hasAddress = false, dmKnown = false, channel = 'livechat' } = {}) {
  const out = [];
  if (!hasName) out.push('name');
  if (!hasPhone && channel === 'livechat') out.push('phone');
  if (!hasAddress) out.push('address');
  if (!dmKnown) out.push('dm');
  return out;
}

const SPOUSE = String.raw`(?:wife|husband|spouse|partner|fianc[eé]e?|boyfriend|girlfriend|mom|mother|dad|father|son|daughter|they|he|she)`;
// "My husband works then", "she can't make Saturday".
const DM_CONFLICT_RX = new RegExp(String.raw`\b${SPOUSE}\b[^.?!]{0,40}\b(?:can'?t|cannot|won'?t|isn'?t|is\s+not|not\s+(?:able|available|home|free)|works?|working|busy|out\s+of\s+town|away)\b|\b(?:can'?t|cannot|won'?t)\s+(?:make|do)\s+(?:it|that|then)\b`, 'i');
const DM_SOLO_RX = /^\s*(?:no(?:pe|t\s+really)?|nobody|no\s*one|none|just\s+me|only\s+me|me|myself|i\s+(?:do|decide|am|make)|i'?m\s+(?:the\s+only|single|on\s+my\s+own|it)|it'?s\s+(?:just\s+)?(?:me|my\s+(?:call|decision))|just\s+myself|i\s+live\s+alone)\b/i;
const DM_YES_RX = new RegExp(String.raw`^\s*(?:y(?:es|eah|ep|up)|sure|both\s+of\s+us|we\s+(?:both|will)|my\s+${SPOUSE})\b|\b(?:my|her|his)\s+${SPOUSE}\b|\bboth\s+of\s+us\b`, 'i');

/**
 * The answer to "will anyone else be part of the decision?":
 *   'Solo Owner' | 'Yes' | 'conflict' (they cannot make that time) | null. Pure.
 */
export function parseDecisionMakers(text) {
  const t = String(text || '');
  if (DM_CONFLICT_RX.test(t)) return 'conflict';
  if (DM_SOLO_RX.test(t)) return 'Solo Owner';
  if (DM_YES_RX.test(t)) return 'Yes';
  return null;
}

// 2026-10-02 post-merge simulator run: a guest typed "Mark" to "What's your
// first name?" and was asked again four times. The identity heuristics need
// two capitalised words for a bare name (rightly, unprompted: "never mind"),
// and a single "My name is Mark, and…" fails the same test. When WE asked
// for the name, one or two plain words are the answer.
const NAME_WORD = "[A-Za-z][A-Za-z'’-]{1,20}";
const STATED_ONE_RX = new RegExp(String.raw`\bmy\s+name(?:\s+is|'?s)\s+(${NAME_WORD})`, 'i');
const ASKED_NAME_RX = new RegExp(String.raw`^\s*(?:(?:it'?s|my\s+name\s+is|my\s+name'?s|name'?s|this\s+is|i'?m)\s+)?(${NAME_WORD})(?:\s+(${NAME_WORD}))?\s*[.!]?\s*$`, 'i');
const NOT_A_NAME = new Set(['yes', 'no', 'yeah', 'yep', 'nope', 'ok', 'okay', 'sure', 'thanks', 'thank', 'hi', 'hello', 'hey', 'idk', 'maybe', 'fine', 'good', 'great', 'the', 'first', 'second', 'one', 'just', 'me', 'and', 'not', 'why', 'what', 'who', 'guest', 'visitor']);
const capName = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

/** A first name from "my name is X" anywhere, or from a bare reply to our name question. Pure. */
export function nameFromReply(text, { asked = false } = {}) {
  const t = String(text || '');
  const stated = t.match(STATED_ONE_RX);
  if (stated && !NOT_A_NAME.has(stated[1].toLowerCase())) return capName(stated[1]);
  if (!asked) return null;
  const m = t.match(ASKED_NAME_RX);
  if (!m || /\d/.test(t)) return null;
  if ([m[1], m[2]].filter(Boolean).some(w => NOT_A_NAME.has(w.toLowerCase()))) return null;
  return capName(m[1]);
}
