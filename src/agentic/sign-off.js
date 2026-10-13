// A lead ending the conversation for now (Erica Hilts, 2026-10-13).
//
// "Thank you for your time … Have a good day." got "I'll have someone from our
// team call you to talk it through." (read as a third price ask), and "I can
// call back when I have more time. Ty" got "I'll check back next week. Enjoy."
// plus the same two visit times for the third time. She texted STOP a minute
// later. Nothing pre-demo read either message as a goodbye: not DECLINE_RX,
// CLOSE_RX, THINK_RX or isNo. The reviewer's rule: on "not now", "I'll call
// back" or "have a good day", a short warm goodbye with no times and no
// question, then stop.
//
// Pure. `isLeadSignOff` is read by the planner (the `sign_off` step, before
// any hand-off a price ask would trigger), by shouldRecordPromise, and by
// checkReply's `times_after_sign_off`.

// "I can call back", "I'll get back to you", "we'll reach out", "I'll be in touch".
const WILL_REACH_OUT_RX = /\b(?:i|we)(?:'|’)?(?:ll|\s+will|\s+can|\s+could|\s+might|\s+may)\s+(?:just\s+)?(?:call\s+(?:you\s+)?back|call\s+(?:you|y'?all)\s+(?:later|another\s+time|when)|reach\s+(?:back\s+)?out|get\s+back\s+(?:to\s+you|with\s+you)|circle\s+back|be\s+in\s+touch|contact\s+(?:you|y'?all)\s+(?:later|when|if))\b/i;

// The lead will come back on their own time: true anywhere in the message.
const DEFER_RXS = [
  WILL_REACH_OUT_RX,
  /\bwhen\s+i\s+(?:have|get|find)\s+(?:more\s+|some\s+)?(?:time|a\s+(?:minute|chance|moment|sec(?:ond)?))\b/i,
  /\bnot\s+(?:right\s+)?now\b|\bnot\s+(?:today|at\s+(?:this|the)\s+(?:time|moment)|this\s+(?:week|time))\b/i,
  /\bmaybe\s+(?:later|another\s+time|some\s+other\s+time|down\s+the\s+road)\b/i,
  /\bi(?:'|’)?m\s+(?:busy|at\s+work|driving|in\s+a\s+meeting)\s+(?:right\s+now|now|at\s+the\s+moment)\b/i,
];

// A closing line: counts when it is the message's LAST sentence.
const GOODBYE_RX = /\bhave\s+a\s+(?:good|great|nice|wonderful|blessed|lovely)\s+(?:one|day|night|evening|weekend|afternoon|morning|week)\b|\bthanks?\s+(?:you\s+)?(?:so\s+much\s+)?for\s+(?:your|the)\s+(?:time|help|info(?:rmation)?)\b|\bgood\s*bye\b|\bbye\b|\btalk\s+(?:to\s+you\s+)?(?:later|soon)\b|\bttyl\b|\btake\s+care\b/i;

// The goodbye must END the message ("Thanks for the info, how long does
// install take" is a question without its "?"); a trailing "ty" may follow.
// One word may follow it: a name ("Thanks, have a great day John").
const GOODBYE_END_RX = new RegExp(`(?:${GOODBYE_RX.source})(?:\\s+\\p{L}+)?$`, 'iu');
const TRAILING_ACK_RX = /(?:\s+(?:ty|thx|thanks|thank\s+you|again|too|you\s+too))+$/i;

// A deferral counts only in a short message: "not right now but my doors are
// terrible, they leak every storm and the bills are up" is a lead talking.
const DEFER_MAX_WORDS = 15;

// Never a goodbye when the same message moves toward a visit ("Not today, but
// tomorrow morning works").
const DAY_WORD = String.raw`(?:tomorrow|(?:mon|tues|wednes|thurs|fri|satur|sun)day|weekend|morning|afternoon|evening)s?`;
const FORWARD_RX = new RegExp(String.raw`\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)\b|\b(?:book|schedule|set\s+(?:it|that|one)\s+up)\b|\bworks?\s+for\s+(?:me|us)\b|\bcome\s+(?:out|by)\b|\b${DAY_WORD}\b[^.!?]*\b(?:works?|good|fine|better|free|available|okay|ok)\b|\b(?:but|how\s+about|what\s+about|instead)\b[^.!?]*\b${DAY_WORD}\b`, 'i');

function sentencesOf(text) {
  return String(text || '').split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);
}

/**
 * The lead is leaving for now: a deferral ("I can call back when I have more
 * time", "not right now", "maybe later") or a message that ends on a goodbye
 * ("… Have a good day.", "Thanks for your time"). Never with a question in it,
 * and never when the same message moves toward a visit ("not today, but
 * Thursday at 2 PM works"). A bare "thanks" or "ok" is not a goodbye. Pure.
 */
export function isLeadSignOff(text) {
  const t = String(text || '').trim();
  if (!t || t.includes('?') || FORWARD_RX.test(t)) return false;
  if (t.split(/\s+/).length <= DEFER_MAX_WORDS && DEFER_RXS.some(rx => rx.test(t))) return true;
  const last = (sentencesOf(t).filter(x => /\p{L}/u.test(x)).slice(-1)[0] || '').replace(/[^\p{L}\p{N}\s']+/gu, ' ').trim().replace(TRAILING_ACK_RX, '');
  return GOODBYE_END_RX.test(last);
}

/**
 * The lead said THEY will reach out ("I can call back when I have more time").
 * Our goodbye then promises no follow-up of our own ("I'll check back next
 * week" answered Erica's "I can call back"). Pure.
 */
export function leadWillReachOut(text) {
  return WILL_REACH_OUT_RX.test(String(text || ''));
}

// "I'll check back next week", "we'll follow up soon": our own chase.
const CHECK_BACK_RX = /\b(?:i|we)(?:'|’)?ll\s+(?:check\s+back|follow\s+up|reach\s+(?:back\s+)?out|be\s+in\s+touch|circle\s+back)\b|\b(?:i|we)\s+will\s+(?:check\s+back|follow\s+up|reach\s+out|be\s+in\s+touch)\b/i;
const CLOCK_RX = /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)/i;
export const SIGN_OFF_FALLBACK = "Sounds good. We're here whenever you're ready. Have a great day.";

/**
 * The last pass on both bots, in every mode (a guard that only works with the
 * NEPQ planner live is half a guard): after a lead's goodbye, the reply keeps
 * no question and no visit time, and no "I'll check back" when they said THEY
 * would reach out. Nothing left → a plain warm goodbye. A lead past its demo is
 * not passed here (its thank-you keeps one proposal question). Pure.
 * @returns {{ text: string, changed: boolean }}
 */
export function enforceSignOff(reply, { inbound = '' } = {}) {
  const text = String(reply || '');
  if (!text.trim() || !isLeadSignOff(inbound)) return { text, changed: false };
  const theyWill = leadWillReachOut(inbound);
  const parts = sentencesOf(text);
  const kept = parts.filter(s => !s.includes('?') && !CLOCK_RX.test(s) && !(theyWill && CHECK_BACK_RX.test(s)));
  if (kept.length === parts.length) return { text, changed: false };
  return { text: kept.length ? kept.join(' ') : SIGN_OFF_FALLBACK, changed: true };
}
