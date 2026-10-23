/**
 * An owned rehash lead gets an answer to a direct question, and nothing else —
 * src/agentic/rehash-owned-answer.js (Mark, 2026-10-23; Kim Turko review)
 *
 * Pure. Kim Turko (fnGjYEvok31f46ZmnZQW) booked a Rehash Call with the bot
 * (action 629976). The bot then sent the post-booking email ask (629977) and,
 * after she replied with only her email, "Got it… Where are you at with it?"
 * (630021). The ownership gate saw both (`rehash.owned_would_skip`, tag
 * rehash-owned) but REHASH_OWNED_MODE was shadow.
 *
 * Mark's ruling: once John owns the lead (rehash-owned.js), the bot sends
 * nothing proactive. When the lead's own message asks a DIRECT QUESTION the bot
 * answers it briefly and stops; a cancel or move request gets one line and a
 * #contact-rehash card (John owns cancellations); anything else gets no reply.
 * John's 15-minute manual-text pause still applies on top.
 *
 * This module is the ONE home of that reply's rules (the prompt lines and the
 * post-pass read the same constants). REHASH_OWNED_ANSWER_MODE off|shadow|live,
 * default shadow: only live answers; shadow logs what live would do and the
 * owned lead still gets nothing (REHASH_OWNED_MODE=live decides that).
 */
import { simModeOverrides } from '../simulator/sim-overrides.js';
import { humanizeReply } from './human-voice.js';
import { enforceTeamVoice } from './team-voice.js';
import { checkReply, SMS_MAX_CHARS } from '../eval/reply-invariants.js';

export const OWNED_ANSWER_MODES = Object.freeze(['off', 'shadow', 'live']);
export const OWNED_ANSWER_MAX_SENTENCES = 2;

const lower = (v) => String(v ?? '').trim().toLowerCase();

/** REHASH_OWNED_ANSWER_MODE (default shadow; a bot-gate run may force it). */
export function rehashOwnedAnswerMode(env = process.env) {
  const v = lower(simModeOverrides().rehashOwnedAnswerMode ?? env?.REHASH_OWNED_ANSWER_MODE);
  return OWNED_ANSWER_MODES.includes(v) ? v : 'shadow';
}

// ── What did the lead send? ────────────────────────────────────────

// A move or a cancel of the call. Checked before the question test: "can we
// move it to 2?" is a request for John, not a question for the bot.
const CHANGE_RX = /\b(cancel\w*|re-?schedul\w*|move (?:it|the call|our call|this|that|the appointment)|push (?:it|the call|our call) (?:back|out|up)|change (?:the |our )?(?:time|day|date|call|appointment)|different (?:time|day|date)|another (?:time|day|date)|can'?t make (?:it|the call|that)|won'?t be able to make|need to move)\b/i;
// A question or a request for information at the start of a clause.
const QUESTION_FORM_RX = /(?:^|[.!;,\n]\s*|\b(?:and|but|so|also|ok|okay)\s+)(?:what|what's|whats|how|when|where|why|who|which|can you|could you|would you|do you|does|did you|is it|is there|is that|is this|are you|are there|are they|will (?:you|it|he|she|john|that|this|there|the|i|we)|should (?:i|we)|please (?:explain|tell|send|let me know)|tell me|send me|explain)\b/i;
// Nothing to answer: a thank-you, an okay, a yes, an emoji.
const ACK_RX = /^(?:(?:ok(?:ay)?|k|kk|thanks?|thank you|thx|ty|great|sounds good|perfect|cool|got it|will do|yes|yep|yeah|yup|sure|no|nope|awesome|appreciate it|see you then|talk then|talk to you then|good|great thanks|you too|same to you|bye|have a good (?:one|day|night|weekend))[\s.!,]*)+[\s👍🙏😊🙂👌✅.!]*$/i;
const EMAIL_RX = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/;
const PHONE_RX = /\+?1?[\s.(-]*\d{3}[\s.)-]*\d{3}[\s.-]*\d{4}\b/;

/**
 * What the owned lead's inbound asks of the bot. Pure.
 * @returns {{ kind: 'question'|'change_request'|'none'|'ambiguous', reason: string }}
 */
export function classifyOwnedInbound(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { kind: 'none', reason: 'empty' };
  if (CHANGE_RX.test(raw)) return { kind: 'change_request', reason: 'move_or_cancel' };
  // Their email, their phone, or both, and nothing else (Kim: "Turkokim@gmail.com").
  const rest = raw.replace(EMAIL_RX, ' ').replace(PHONE_RX, ' ').replace(/\b(?:it'?s|my|email|e-mail|number|phone|is|here|this|use)\b/gi, ' ').replace(/[\s.,:;!-]+/g, '');
  if ((EMAIL_RX.test(raw) || PHONE_RX.test(raw)) && !rest && !raw.includes('?')) return { kind: 'none', reason: 'contact_details_only' };
  if (ACK_RX.test(raw)) return { kind: 'none', reason: 'acknowledgment' };
  if (raw.includes('?')) return { kind: 'question', reason: 'question_mark' };
  if (QUESTION_FORM_RX.test(raw)) return { kind: 'question', reason: 'question_form' };
  return { kind: 'ambiguous', reason: 'words_decide_nothing' };
}

/** The model's yes/no when the words decide nothing. Pure. */
export const DIRECT_QUESTION_SYSTEM = [
  'You read ONE text message a homeowner sent to Reece Windows & Doors.',
  'Decide whether it asks us a direct question or asks for information we should answer now.',
  'A statement, an update, a thank-you, a contact detail or small talk is NOT a direct question.',
  'Return JSON only: {"direct_question": true|false}',
].join('\n');

export function directQuestionPrompt(text) {
  return `MESSAGE:\n${String(text ?? '').slice(0, 600)}`;
}

/** true / false from the model's JSON; null when it said nothing usable (fail closed: no reply). */
export function readDirectQuestion(data) {
  const v = data?.direct_question;
  return typeof v === 'boolean' ? v : null;
}

// ── The reply ──────────────────────────────────────────────────────

/** A rep first name we may print, or null ("Reece Team" is no name). */
export function repShortName(rep) {
  const n = String(rep || '').trim().split(/\s+/)[0] || '';
  return /^[A-Za-z][A-Za-z'’-]{1,30}$/.test(n) && !/^(reece|team|our)$/i.test(n) ? n : null;
}

/** The one line for a move or a cancel request. Pure. */
export function changeRequestLine(rep) {
  const name = repShortName(rep);
  return `Got it, I'll let ${name || 'our team'} know.`;
}

/** The close an answer may end on. Pure. */
export function coverTheRestLine(rep) {
  const name = repShortName(rep);
  return `${name || 'Our team'} will cover the rest on your call.`;
}

/** The backup when no good answer could be written. Pure. */
export function ownedAnswerFallback(rep) {
  const name = repShortName(rep);
  return `Good question. ${name || 'Our team'} will cover that on your call.`;
}

/**
 * The rules every answer-only reply follows, in the prompt AND in the post-pass
 * below (one home: change them here).
 */
export const OWNED_ANSWER_RULES = Object.freeze([
  'Answer the question in 1 or 2 short sentences, plainly, like a person texting.',
  'Ask nothing back: no question mark anywhere.',
  'No call to action, no pitch, no offer, no new times or days, no booking, rescheduling or cancelling.',
  'No prices, discounts, financing terms or amounts.',
  'If the facts below do not answer it, say the rep will cover it on the call. Never guess.',
  'No em dashes, no exclamation points, no sign-off, never say you are an AI.',
]);

export function ownedAnswerSystem(rep) {
  const name = repShortName(rep) || 'our team';
  return [
    'You write ONE text message for the Reece Team (Reece Windows & Doors, impact windows and doors).',
    `This homeowner already has a call booked with ${name}, who now owns the conversation. They just asked a direct question.`,
    'Rules:',
    ...OWNED_ANSWER_RULES.map((r) => `- ${r}`),
    `- You may end with: "${coverTheRestLine(rep)}"`,
    'Return only the text of the message.',
  ].join('\n');
}

/** The model's user prompt. Pure. */
export function ownedAnswerPrompt({ question, faqs = [], thread = [] } = {}) {
  const turns = (thread || []).slice(-8).map((m) => {
    const who = m?.direction === 'inbound' ? 'Lead' : 'Us';
    return `${who}: ${String(m?.text || m?.body || '').replace(/\s+/g, ' ').trim().slice(0, 300)}`;
  }).filter((l) => !/:\s*$/.test(l));
  const facts = (faqs || []).slice(0, 3).map((f) => `- Q: ${String(f?.question_pattern || '').slice(0, 160)}\n  A: ${String(f?.answer_short || f?.canonical_answer || f?.answer || '').replace(/\s+/g, ' ').slice(0, 600)}`);
  return [
    `THEIR QUESTION: ${String(question || '').slice(0, 600)}`,
    '',
    'FACTS YOU MAY USE (our approved answers):',
    ...(facts.length ? facts : ['(none matched: say the rep will cover it on the call)']),
    '',
    'THE CONVERSATION SO FAR (oldest first):',
    ...(turns.length ? turns : ['(not read)']),
  ].join('\n');
}

const SENTENCE_RX = /[^.!?]+[.!?]*/g;
const CLOCK_RX = /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b|\b\d{1,2}:\d{2}\b/i;
const DAY_RX = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|next week)\b/i;
const CTA_RX = /\b(?:let me know|feel free|reach out|text (?:me|us)|call (?:me|us)|give (?:us|me) a call|book|schedul\w*|reschedul\w*|cancel\w*|set up|would you like|want to|happy to (?:set|book|help you)|don'?t hesitate|click|link)\b/i;

/**
 * The model's draft held to the rules: no question, no time or day, no call to
 * action, at most two sentences, then the voice passes and the hard checks.
 * Pure. @returns {{ text: string, used_fallback: boolean, reason: string|null, dropped: string[] }}
 */
export function finishOwnedAnswer(draft, { rep = null, channel = 'sms', thread = [], inbound = '', nowMs = Date.now() } = {}) {
  const dropped = [];
  const backup = (reason) => ({ text: ownedAnswerFallback(rep), used_fallback: true, reason, dropped });
  let text = String(draft || '').trim().replace(/^["“']+|["”']+$/g, '').trim();
  if (!text) return backup('empty_draft');
  const kept = [];
  for (const s of (text.match(SENTENCE_RX) || []).map((x) => x.trim()).filter(Boolean)) {
    if (s.includes('?')) { dropped.push('question'); continue; }
    if (CLOCK_RX.test(s) || DAY_RX.test(s)) { dropped.push('time_or_day'); continue; }
    if (CTA_RX.test(s)) { dropped.push('call_to_action'); continue; }
    kept.push(s.replace(/!+/g, '.'));
  }
  if (!kept.length) return backup('nothing_left');
  // The close counts as a sentence; the answer keeps the first slots.
  const close = coverTheRestLine(rep);
  const closeIdx = kept.findIndex((s) => s.toLowerCase() === close.toLowerCase());
  const answer = kept.filter((_, i) => i !== closeIdx);
  if (!answer.length) return backup('no_answer');
  if (answer.length > OWNED_ANSWER_MAX_SENTENCES) dropped.push('extra_sentences');
  const body = answer.slice(0, OWNED_ANSWER_MAX_SENTENCES);
  if (closeIdx >= 0 && body.length < OWNED_ANSWER_MAX_SENTENCES + 1) body.push(close);
  text = body.join(' ').replace(/\s+/g, ' ').trim();
  text = humanizeReply(text).text;
  text = enforceTeamVoice(text, { allowName: repShortName(rep) }).text;
  if (text.includes('?')) return backup('question_after_voice');
  if (channel === 'sms' && text.length > SMS_MAX_CHARS) return backup('too_long');
  const check = checkReply(text, { channel, conversation: thread, inbound, nowMs });
  if (!check.pass) return backup(`check_${check.violations[0]?.code || 'failed'}`);
  return { text, used_fallback: false, reason: null, dropped };
}
