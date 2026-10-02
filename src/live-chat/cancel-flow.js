/**
 * Live chat cancel requests — src/live-chat/cancel-flow.js
 *
 * WHY (2026-10-01, "Guest Visitor tzuzq", Ng329AzYVAT7wBlpNagS)
 *   "cancel my appt please. not buying anything" got "I don't see an
 *   appointment on file for you right now" — from a guest visitor whose name
 *   and phone the bot had never asked for, so nothing could ever have been
 *   found. The visitor gave "tomorrow evening 6 pm Rick fox", then "do not
 *   come", "you won't be allowed in", and was pitched a free in-home
 *   measurement three times.
 *
 * WHAT (Mark, 2026-10-02)
 *   1. Ask for the name and phone the appointment is under (skipped when the
 *      contact is already known).
 *   2. Look them up: phone (last-10 match) AND name must agree — a phone number
 *      alone must never be enough to cancel a stranger's appointment.
 *   3. Offer a different day ONCE. Still cancel → cancel it in GHL
 *      (cancel_appointment, the existing handler) and say "Done" only after
 *      GHL confirms.
 *   4. Every outcome posts one card to the market's sales channel: LP has no
 *      cancel API, so a person cancels it in LP.
 *   Anything that cannot be matched goes to the team; the bot never says
 *   "no appointment on file".
 *
 * Stateless, like planLanguageHandoff: the step is read from the bot's own
 * fixed lines in the thread. Pure; the lane does the I/O through its deps.
 */

export const ASK_IDENTITY_LINE = "I can help with that. What's the full name and phone number the appointment is under?";
export const ASK_PHONE_LINE = "Thanks. What's the phone number the appointment is under?";
export const OFFER_MARK = 'Would a different day work better instead of cancelling?';
export const HANDOFF_LINE = "Thanks. I've passed this to our scheduling team to cancel, and they'll confirm with you.";
const DONE_MARK = 'is cancelled. If anything changes';
const RESCHEDULE_MARK = 'to set up a new time.';

// "cancel", "call it off", and the ways the tzuzq visitor actually said it.
const CANCEL_RX = /\bcancel(?:l?ing|l?ed)?\b|\bcall\s+(?:it|this|the\s+(?:visit|appointment))\s+off\b|\b(?:don'?t|do\s+not|dont)\s+(?:come|bother\s+coming|send\s+(?:anyone|someone|anybody))\b|\bwaste\s+your\s+time\s+coming\b|\bwon'?t\s+be\s+allowed\s+in\b/i;

/** Is this a request to cancel a visit? Pure. */
export function isCancelRequest(text) {
  return CANCEL_RX.test(String(text || ''));
}

const PHONE_RX = /(?:\+?1[\s.-]*)?\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}\b/;
export function phoneDigits(text) {
  const m = String(text || '').match(PHONE_RX);
  if (!m) return null;
  const d = m[0].replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
}
export function formatPhone(d10) {
  const d = String(d10 || '').replace(/\D/g, '').slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(d10 || '');
}

// Words in a visitor's message that are never a name.
const NOT_A_NAME = new Set(('cancel cancelled canceling appointment appt please thanks thank you my the and for is its it\'s under name names phone number '
  + 'tomorrow today tonight morning afternoon evening night noon at on am pm this next week weekend monday tuesday wednesday thursday friday saturday sunday '
  + 'not buying anything need new windows window doors door slick sales people dont don\'t do come coming waste your time allowed won\'t wont visit '
  + 'yes yeah yep no nope sure okay hello hi hey just call off sorry').split(/\s+/));

/** Candidate name words from what the visitor typed. Pure. */
export function nameWords(texts) {
  const out = [];
  for (const t of (Array.isArray(texts) ? texts : [texts])) {
    const clean = String(t || '').replace(PHONE_RX, ' ').toLowerCase();
    for (const w of clean.match(/[a-z][a-z'’-]{2,}/g) || []) {
      const word = w.replace(/['’]s$/, '');
      if (!NOT_A_NAME.has(word) && !out.includes(word)) out.push(word);
    }
  }
  return out;
}

/** Do the visitor's words name this contact (first or last name)? Pure. */
export function nameMatches(words, contact) {
  const names = [contact?.firstName, contact?.lastName, contact?.first_name, contact?.last_name, ...(String(contact?.name || contact?.contactName || '').split(/\s+/))]
    .map((n) => String(n || '').trim().toLowerCase()).filter((n) => n.length >= 3);
  return (words || []).some((w) => names.includes(w));
}

const outboundTexts = (thread) => (Array.isArray(thread) ? thread : []).filter((m) => m?.direction === 'outbound').map((m) => String(m.text || ''));
const lastIndexWhere = (arr, fn) => { for (let i = arr.length - 1; i >= 0; i--) if (fn(arr[i])) return i; return -1; };

/**
 * Which step of the cancel flow this turn is. Pure.
 *
 * @param {{ body: string, thread: Array<{direction, text}>, known: {phone?: string|null, hasName: boolean} }} args
 *   `thread` includes this message as its last entry (normalizeThread shape).
 * @returns {null | { step: 'ask_identity'|'ask_phone'|'lookup'|'after_offer'|'handoff',
 *                    reply?: string, phone?: string|null, words?: string[], answer?: 'cancel'|'reschedule'|'unclear' }}
 */
export function planCancelTurn({ body, thread = [], known = {} }) {
  const all = Array.isArray(thread) ? thread : [];
  const prior = all.slice(0, -1);
  const lastOut = [...prior].reverse().find((m) => m?.direction === 'outbound');
  const lastOutText = String(lastOut?.text || '');
  const inboundTexts = all.filter((m) => m?.direction === 'inbound').map((m) => String(m.text || ''));
  const outs = outboundTexts(prior);

  // Inbound since the flow began carries the name and phone. The flow begins at
  // the FIRST cancel request after any earlier finished flow — a later
  // "no, just cancel it" is an answer inside the flow, not a new start.
  const isFinishLine = (m) => m?.direction === 'outbound' && (String(m.text || '').includes(DONE_MARK) || m.text === HANDOFF_LINE || String(m.text || '').includes(RESCHEDULE_MARK));
  const lastFinish = lastIndexWhere(all, isFinishLine);
  const flowStart = all.findIndex((m, i) => i > lastFinish && m?.direction === 'inbound' && isCancelRequest(m.text));
  const flowInbound = (flowStart >= 0 ? all.slice(flowStart) : all).filter((m) => m?.direction === 'inbound').map((m) => String(m.text || ''));
  const phone = known.phone ? String(known.phone).replace(/\D/g, '').slice(-10) : (flowInbound.map(phoneDigits).filter(Boolean).pop() || null);
  const words = nameWords(flowInbound);

  // 1. Answering our reschedule offer.
  if (lastOutText.includes(OFFER_MARK)) {
    return { step: 'after_offer', answer: classifyOfferAnswer(body), phone, words };
  }
  // 2. Answering our name/phone ask.
  if (lastOutText === ASK_IDENTITY_LINE || lastOutText === ASK_PHONE_LINE) {
    if (phone) return { step: 'lookup', phone, words };
    // Asked twice and still no number: a person takes it from here.
    if (lastOutText === ASK_PHONE_LINE) return { step: 'handoff', phone: null, words };
    return { step: 'ask_phone', reply: ASK_PHONE_LINE };
  }
  // 3. A fresh cancel request. A flow that already finished does not restart
  //    on the visitor's next "do not come" — they were answered.
  if (!isCancelRequest(body)) return null;
  const finished = outs.some((t) => t.includes(DONE_MARK) || t === HANDOFF_LINE || t.includes(RESCHEDULE_MARK));
  if (finished) return null;
  if (phone && known.hasName) return { step: 'lookup', phone, words, known: true };
  if (phone && words.length) return { step: 'lookup', phone, words };
  return { step: 'ask_identity', reply: ASK_IDENTITY_LINE };
}

/** The answer to "Would a different day work better instead of cancelling?". Pure. */
export function classifyOfferAnswer(text) {
  const s = String(text || '').toLowerCase();
  if (/\bcancel\b|\bno\b|\bnope\b|\bnah\b|\bnot\s+interested\b|\b(?:don'?t|do\s+not)\s+(?:come|want|need)\b|\bjust\s+cancel\b/.test(s)) return 'cancel';
  if (/\b(?:yes|yeah|yep|sure|ok(?:ay)?|please\s+do|different\s+day|another\s+day|reschedule|re-schedule|next\s+week)\b/.test(s)) return 'reschedule';
  return 'unclear';
}

/** The one appointment this request is about: the soonest active one. Pure. */
export function pickAppointment(appointments) {
  const list = (Array.isArray(appointments) ? appointments : [])
    .filter((a) => a?.appointment_id && !/cancel|no.?show|invalid/i.test(String(a.status || '')));
  return list[0] || null;
}

export function offerLine(firstName, apptHuman) {
  return `Thanks${firstName ? `, ${firstName}` : ''}. I found your appointment for ${apptHuman}. ${OFFER_MARK}`;
}
export function doneLine(apptHuman) {
  return `Done. Your ${apptHuman} appointment ${DONE_MARK}, we're here.`;
}
export function rescheduleLine(phone) {
  return `A team member will call you at ${formatPhone(phone)} ${RESCHEDULE_MARK}`;
}

/**
 * The sales-channel card. LP has no cancel API (Mark, 2026-10-02), so every
 * outcome tells a person what to do in LP. Plain English, first name, no
 * pronouns (CLAUDE.md). Pure.
 */
export function formatCancelCard({ kind, name, phone, apptHuman, ghlCancelled, visitorWords, contactUrl, marketNote }) {
  const title = kind === 'reschedule'
    ? '📅 LIVE CHAT RESCHEDULE — call to set a new time'
    : '📅 LIVE CHAT CANCEL — cancel it in LP';
  const who = name || 'A website chat visitor';
  return [
    title,
    `${who} ${kind === 'reschedule' ? 'wants a different day for' : 'asked to cancel'} ${apptHuman ? `the appointment on ${apptHuman}` : 'an appointment (not matched — see below)'}.`,
    `Phone: ${phone ? formatPhone(phone) : 'not given'}`,
    kind === 'reschedule' ? null
      : ghlCancelled ? 'GHL: ✅ cancelled by the bot. → Cancel it in LP.'
        : 'GHL: ❌ NOT cancelled (could not match or the cancel failed). → Cancel it in GHL and LP, and confirm with them.',
    kind === 'reschedule' ? '→ Call them to set a new time; the GHL appointment is still on the calendar.' : null,
    visitorWords ? `They said: "${String(visitorWords).slice(0, 300)}"` : null,
    contactUrl ? `Contact: ${contactUrl}` : null,
    marketNote || null,
  ].filter(Boolean).join('\n');
}
