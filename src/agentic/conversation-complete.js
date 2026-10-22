/**
 * Did the rehash rep finish the conversation? — src/agentic/conversation-complete.js
 * (Mark, 2026-10-21)
 *
 * Pure. When the 15-minute pause after a rehash rep's manual message fires
 * (rehash-pause.js), the bot reads the thread once before it says anything:
 *   complete → no send, the turn is answered (`conversation_complete`);
 *   open     → the normal reply, with the rep's texts in the thread.
 * Jim Anderson's thread is the "complete" shape: John set the time, Jim said
 * "No need to call, just show up" and "See you tomorrow". "What time again?"
 * is the "open" shape.
 *
 * Deterministic first; a model call only when the words decide nothing (the
 * I/O passes `ambiguous` to it). Mark's call: a wrong silence costs more than a
 * wrong reply, so anything unclear is OPEN, flagged `completion_ambiguous`.
 *
 * Thread items: { direction: 'inbound'|'outbound', text, manual?: boolean }, oldest first.
 */
import { isAcknowledgment, isLeadCloser, isSignOffLine } from './post-demo-turn.js';
import { isLeadSignOff } from './sign-off.js';

// The lead says nothing more is needed (Jim: "No need to call, just show up ...", "See you tomorrow").
const DONE_WORDS_RX = /\b(?:no\s+need\s+to\s+(?:call|text)|just\s+show\s+up|see\s+(?:you|u|ya)\s+(?:tomorrow|then|soon|there|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\s+week)|sounds\s+(?:good|great|perfect)|will\s+do|that\s+works|works\s+for\s+(?:me|us)|we(?:'|’)?re\s+(?:all\s+)?set|all\s+set|perfect|great|ok(?:ay)?|got\s+it|thanks?|thank\s+you|ty|confirmed|we(?:'|’)?ll\s+be\s+(?:there|home|ready))\b/i;
// Something still waiting on us: a question, a time ask, a new objection or a problem.
const OPEN_WORDS_RX = /\b(?:what\s+time|when\s+(?:is|are|will|do|can)|which\s+day|how\s+(?:much|long|many|do|does|about)|can\s+(?:you|we|someone)|could\s+(?:you|we|someone)|would\s+you|do\s+you|is\s+there|price|cost|expensive|too\s+much|other\s+(?:quote|estimate|proposal|company|companies)|compar\w*|think\s+(?:about|it\s+over)|my\s+(?:wife|husband|spouse|partner)|cancel|reschedul\w*|change\s+(?:the|our)\s+(?:time|day|appointment)|problem|issue|wrong|haven(?:'|’)?t\s+heard|never\s+(?:got|heard))\b/i;

const clean = (s) => String(s ?? '').replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();

/** One lead message, read on its own: 'open' | 'done' | null (the words decide nothing). Pure. */
export function readLeadMessage(text) {
  const t = clean(text);
  if (!t) return null;
  if (t.includes('?') || OPEN_WORDS_RX.test(t)) return 'open';
  if (isLeadCloser(t) || isAcknowledgment(t) || isLeadSignOff(t) || DONE_WORDS_RX.test(t)) return 'done';
  return null;
}

/**
 * @param {{ thread: object[] }} a
 * @returns {{ complete: boolean, reason: string, ambiguous: boolean }}
 */
export function conversationComplete({ thread = [] } = {}) {
  const items = (Array.isArray(thread) ? thread : []).filter((m) => m && clean(m.text));
  if (!items.length) return { complete: false, reason: 'no_thread', ambiguous: true };
  const last = items[items.length - 1];

  // The rep spoke last: the floor is theirs. A question from them waits on the
  // lead, not on the bot, and a sign-off or a confirmed time closes it.
  if (last.direction === 'outbound') {
    if (last.manual) return { complete: true, reason: isSignOffLine(clean(last.text)) ? 'team_signed_off' : 'team_spoke_last', ambiguous: false };
    return { complete: true, reason: 'bot_spoke_last', ambiguous: false };
  }

  // The lead spoke last: read their messages since our side last spoke.
  let i = items.length - 1;
  while (i > 0 && items[i - 1].direction === 'inbound') i--;
  const tail = items.slice(i).map((m) => readLeadMessage(m.text));
  if (tail.includes('open')) return { complete: false, reason: 'lead_left_something_open', ambiguous: false };
  if (tail.length && tail.every((r) => r === 'done')) return { complete: true, reason: 'lead_closed', ambiguous: false };
  if (tail.some((r) => r === 'done') && items.slice(0, i).some((m) => m.direction === 'outbound' && m.manual)) {
    return { complete: true, reason: 'lead_closed_after_team', ambiguous: false };
  }
  return { complete: false, reason: 'completion_ambiguous', ambiguous: true };
}

/** The model's answer, read back. Low confidence or anything unreadable is open. Pure. */
export function readModelVerdict(data, { minConfidence = 0.7 } = {}) {
  const complete = data?.complete === true;
  const confidence = Number(data?.confidence);
  if (!complete) return { complete: false, reason: 'model_open' };
  if (!Number.isFinite(confidence) || confidence < minConfidence) return { complete: false, reason: 'completion_ambiguous' };
  return { complete: true, reason: `model:${String(data?.reason || 'complete').slice(0, 80)}` };
}

export const COMPLETION_SYSTEM = [
  'You read a text thread between a homeowner and a window company after an in-home visit.',
  'A person on the company\'s team has been texting the homeowner by hand.',
  'Decide one thing: is there anything left for the company to answer right now?',
  'complete = true only when the homeowner\'s last messages need no reply: they acknowledged, confirmed, said goodbye,',
  'or said no further contact is needed. complete = false when they asked something, raised a concern or objection,',
  'asked for a time, or said something nobody answered.',
  'Answer JSON only: {"complete": true|false, "confidence": 0..1, "reason": "<five words>"}',
].join(' ');

/** The user message for the model: the last messages, labelled. Pure. */
export function completionPrompt(thread = []) {
  const lines = (Array.isArray(thread) ? thread : []).slice(-12).map((m) => {
    const who = m.direction === 'inbound' ? 'Homeowner' : m.manual ? 'Team member' : 'Company (automated)';
    return `${who}: ${clean(m.text).slice(0, 400)}`;
  });
  return `Thread (oldest first):\n${lines.join('\n')}`;
}
