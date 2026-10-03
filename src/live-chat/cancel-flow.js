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
 *   4. Every outcome posts one card to #dispatch: LP has no cancel or
 *      reschedule API, so a person makes the change in LP.
 *   5. "Yes, a different day" (Mark, 2026-10-02): the bot offers two real open
 *      times from that appointment's own GHL calendar, books the one the
 *      visitor picks (reschedule_appointment: book the new one, then cancel
 *      the old), and #dispatch moves it in LP. No open time, an unclear pick,
 *      or a failed booking → a person calls to set the time.
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
export const SLOTS_MARK = 'Which one works better for you?';
export const ONE_SLOT_MARK = 'Does that time work for you?';
const MOVED_MARK = "You're now set for";

// ── Part 8 (Mark, 2026-10-02: "Each message should be custom") ────────────
// The model words every cancel-flow reply now; the lines above are its
// reference and backup. So each step is read back from what the line MEANS,
// and the model's version must keep the phrase its step is read by
// (CANCEL_MARKERS, checked by checkAgainstReference).
export const ID_ASK_RX = /\bname\b[^?]*\b(?:phone|number)\b[^?]*\bappointment\s+is\s+(?:under|booked\s+under|in)\b[^?]*\?/i;
export const PHONE_ASK_RX = /\b(?:phone|number)\b[^?]*\bappointment\s+is\s+(?:under|booked\s+under|in)\b[^?]*\?/i;
export const OFFER_RX = /\b(?:different|another|other|new)\s+(?:day|time|date)\b[^?]*\binstead\s+of\s+cancel+ing\b[^?]*\?/i;
export const SLOTS_RX = /\bmove\s+(?:it|your\s+(?:appointment|visit))\s+to\b|\b(?:which\s+one\s+works\s+better|does\s+that\s+time\s+work)\b/i;
export const DONE_RX = /\bis\s+(?:now\s+)?cancel+ed\b|\bhave\s+cancel+ed\b/i;
export const MOVED_RX = /\byou(?:'|’)?re\s+now\s+set\s+for\b|\bmoved\s+(?:it|your\s+(?:appointment|visit))\s+to\b/i;
export const RESCHEDULE_RX = /\bset\s+up\s+a\s+new\s+time\b/i;
export const HANDOFF_RX = /\bscheduling\s+team\b/i;

/** Which CANCEL_MARKERS entry a runCancelFlow outcome needs. Pure. */
export function cancelMarkerKey(record = {}) {
  const outcome = record?.outcome || null;
  if (!outcome) return record?.step === 'ask_phone' ? 'ask_phone' : 'ask_identity';
  if (outcome === 'offered_reschedule' || outcome === 'offered_slots' || outcome === 'handoff') return outcome;
  if (outcome === 'rescheduled' || outcome === 'would_reschedule') return 'rescheduled';
  if (outcome === 'cancelled' || outcome === 'would_cancel') return 'cancelled';
  return 'reschedule';
}

/** What each step's reply must keep, for the model's version of it. */
export const CANCEL_MARKERS = Object.freeze({
  ask_identity: [{ rx: ID_ASK_RX, say: 'ask for the full name and phone number the appointment is under, in one question' }],
  ask_phone: [{ rx: PHONE_ASK_RX, say: 'ask for the phone number the appointment is under' }],
  offered_reschedule: [{ rx: OFFER_RX, say: 'ask if a different day would work instead of cancelling' }],
  offered_slots: [{ rx: SLOTS_RX, say: 'offer to move it to these times and ask which one works better' }],
  cancelled: [{ rx: DONE_RX, say: 'say the appointment is cancelled' }],
  rescheduled: [{ rx: MOVED_RX, say: "say they're now set for the new time" }],
  reschedule: [{ rx: RESCHEDULE_RX, say: 'say a team member will call to set up a new time' }],
  handoff: [{ rx: HANDOFF_RX, say: 'say the scheduling team has it and will confirm with them' }],
});

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
  const isFinish = (text) => DONE_RX.test(text) || HANDOFF_RX.test(text) || RESCHEDULE_RX.test(text) || MOVED_RX.test(text);
  const isFinishLine = (m) => m?.direction === 'outbound' && isFinish(String(m.text || ''));
  const lastFinish = lastIndexWhere(all, isFinishLine);
  const flowStart = all.findIndex((m, i) => i > lastFinish && m?.direction === 'inbound' && isCancelRequest(m.text));
  const flowInbound = (flowStart >= 0 ? all.slice(flowStart) : all).filter((m) => m?.direction === 'inbound').map((m) => String(m.text || ''));
  const phone = known.phone ? String(known.phone).replace(/\D/g, '').slice(-10) : (flowInbound.map(phoneDigits).filter(Boolean).pop() || null);
  const words = nameWords(flowInbound);

  // 0. Picking one of the open times we offered.
  if (SLOTS_RX.test(lastOutText) && !MOVED_RX.test(lastOutText)) {
    return { step: 'pick_slot', offerText: lastOutText, phone, words };
  }
  // 1. Answering our reschedule offer.
  if (OFFER_RX.test(lastOutText)) {
    return { step: 'after_offer', answer: classifyOfferAnswer(body), phone, words };
  }
  // 2. Answering our name/phone ask.
  const askedId = ID_ASK_RX.test(lastOutText);
  const askedPhone = !askedId && PHONE_ASK_RX.test(lastOutText);
  if (askedId || askedPhone) {
    if (phone) return { step: 'lookup', phone, words };
    // Asked twice and still no number: a person takes it from here.
    if (askedPhone) return { step: 'handoff', phone: null, words };
    return { step: 'ask_phone', reply: ASK_PHONE_LINE };
  }
  // 3. A fresh cancel request. A flow that already finished does not restart
  //    on the visitor's next "do not come" — they were answered.
  if (!isCancelRequest(body)) return null;
  const finished = outs.some(isFinish);
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
const slotText = (s) => `${s.day} at ${s.time}`;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Where a real opening is named in a text, or -1. The exact label first
 * ("Sun, Oct 4 at 10:00 AM", "tomorrow at 10:00 AM"), then the way people and
 * the model write it: the weekday, "tomorrow"/"today" or "Oct 4" within a few
 * words before the clock time ("Sunday at 10 AM", "Sun the 4th, 10am"). Part 7
 * (2026-10-02 replay): the model's own wording of real times failed the exact
 * check and cost a 15-35s re-write per text. Pure.
 */
export function slotMentionIndex(text, s) {
  const t = String(text || '');
  const exact = [slotText(s), s?.rel ? `${s.rel} at ${s.time}` : null].filter(Boolean)
    .map((form) => t.indexOf(form)).filter((i) => i >= 0);
  if (exact.length) return Math.min(...exact);
  const hm = String(s?.time || '').match(/^(\d{1,2})(?::(\d{2}))?\s*([AP])M/i);
  if (!hm) return -1;
  const mins = hm[2] && hm[2] !== '00' ? `:${hm[2]}` : '(?::00)?';
  const clock = `\\b${hm[1]}${mins}\\s*${hm[3]}\\.?\\s?m\\.?(?![a-z])`;
  const dow = String(s?.dayOfWeek || '').toLowerCase();
  const [, mon, dd] = String(s?.day || '').toLowerCase().match(/(\w{3})\s+(\d{1,2})$/) || [];
  const dayWords = [
    dow ? `${esc(dow)}|${esc(dow.slice(0, 3))}` : null,
    s?.rel ? esc(String(s.rel).toLowerCase()) : null,
    mon && dd && MONTHS.includes(mon) ? `${mon}[a-z]*\\.?\\s+${dd}(?:st|nd|rd|th)?` : null,
  ].filter(Boolean).join('|');
  if (!dayWords) return -1;
  // The day word must be the nearest one before THIS time: no other clock
  // time in between ("Sunday at 10 AM or tomorrow at 2 PM" is not Sunday 2 PM).
  const gap = '(?:(?!\\d{1,2}(?::\\d{2})?\\s*[ap]\\.?\\s?m)[^.?!]){0,30}?';
  const rx = new RegExp(`\\b(?:${dayWords})\\b${gap}(${clock})`, 'i');
  const m = t.match(rx);
  // Ordered by where the time itself sits, so "the first one" is the first time named.
  return m ? m.index + m[0].length - m[1].length : -1;
}

/** Two (or one) real open times, one question. Pure. */
export function slotsOfferLine(slots, tzLabelText = 'ET') {
  const [a, b] = slots;
  if (!b) return `Sure. I can move it to ${slotText(a)} ${tzLabelText}. ${ONE_SLOT_MARK}`;
  return `Sure. I have ${slotText(a)} or ${slotText(b)} ${tzLabelText} open. ${SLOTS_MARK}`;
}

/** The slots that our own offer line named, in the order we named them. Pure. */
export function offeredSlots(offerText, freeSlots) {
  const text = String(offerText || '');
  // 2026-10-02: the NEPQ offer reads "tomorrow at 10:00 AM" (slot.rel), not
  // "Sat, Oct 3 at 10:00 AM". Matching only the date form found one of the two
  // times, and "the first one" booked the SECOND (simulator, never live).
  // Part 7 replay: the model writes "Sunday at 10 AM", so a mention counts too.
  const at = (s) => slotMentionIndex(text, s);
  return (Array.isArray(freeSlots) ? freeSlots : [])
    .filter((s) => at(s) >= 0)
    .sort((x, y) => at(x) - at(y));
}

/**
 * Which offered slot the visitor picked, or null. Pure.
 * "the first one", "2", "Tuesday", "Oct 6", "10am", and for a single offer
 * "yes" / "that works".
 */
export function pickSlot(text, offered) {
  const s = String(text || '').toLowerCase();
  const list = Array.isArray(offered) ? offered : [];
  if (!list.length) return null;
  if (/\b(?:neither|none|no(?:pe)?|not\s+(?:those|that|either))\b/.test(s)) return null;
  if (list.length === 1 && /\b(?:yes|yeah|yep|sure|ok(?:ay)?|works|perfect|that\s+one|sounds\s+good)\b/.test(s)) return list[0];
  // "first" / "second" only mean something with both times in hand: with one
  // matched, "the first one" may be the time that did not match.
  const ordinalFirst = /\b(?:first|1st|earlier|former)\b|^\s*(?:#?\s*1|one)\s*[.!]?\s*$/.test(s);
  const ordinalSecond = /\b(?:second|2nd|later|latter|last)\b|^\s*(?:#?\s*2|two)\s*[.!]?\s*$/.test(s);
  if ((ordinalFirst || ordinalSecond) && list.length < 2) return null;
  if (ordinalFirst) return list[0];
  if (ordinalSecond) return list[1] || null;
  // "tomorrow" / "today" pick the offered time labelled so (2026-10-02 offers
  // read "tomorrow at 10:00 AM ET or Mon, Oct 5 at 6:00 PM ET").
  const rel = list.filter((slot) => slot.rel && new RegExp(`\\b${slot.rel}\\b`).test(s));
  if (rel.length === 1) return rel[0];
  const hits = list.filter((slot) => {
    const dow = String(slot.dayOfWeek || '').toLowerCase();
    const [, mon, day] = String(slot.day || '').toLowerCase().match(/(\w{3})\s+(\d{1,2})$/) || [];
    const hour = String(slot.time || '').toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])m/);
    return (dow && s.includes(dow))
      || (dow && s.includes(dow.slice(0, 3)) && /\b(?:mon|tue|wed|thu|fri|sat|sun)\b/.test(s))
      || (mon && day && new RegExp(`\\b${mon}\\w*\\s+${day}\\b`).test(s))
      || (hour && new RegExp(`\\b${hour[1]}(?::${hour[2] || '00'})?\\s*${hour[3]}\\.?m?\\b|\\b${hour[1]}\\s*o'?clock\\b`).test(s));
  });
  return hits.length === 1 ? hits[0] : null;
}

export function movedLine(slot, tzLabelText = 'ET') {
  return `Done. ${MOVED_MARK} ${slotText(slot)} ${tzLabelText} instead. Our team will call to go over the details.`;
}

export function rescheduleLine(phone) {
  return `A team member will call you at ${formatPhone(phone)} ${RESCHEDULE_MARK}`;
}

/**
 * The #dispatch card. LP has no cancel or move API here (Mark, 2026-10-02),
 * so every outcome tells a person what to do in LP. Plain English, first name, no
 * pronouns (CLAUDE.md). Pure.
 */
export function formatCancelCard({ kind, name, phone, apptHuman, newTimeHuman, ghlCancelled, visitorWords, contactUrl, marketNote }) {
  const who = name || 'A website chat visitor';
  const appt = apptHuman ? `the appointment on ${apptHuman}` : 'an appointment (not matched, see below)';
  const lines = {
    rescheduled: [
      `📅 LIVE CHAT RESCHEDULED — change the time in LP to ${newTimeHuman}`,
      `${who} moved ${appt} to ${newTimeHuman}.`,
      'GHL: ✅ the same appointment was moved to the new time (no new booking). LP was NOT changed and no LP lead was created. → Change the appointment time in LP.',
    ],
    reschedule: [
      '📅 LIVE CHAT RESCHEDULE — call to set a new time',
      `${who} wants a different day for ${appt}.`,
      '→ Call them to set a new time; the GHL appointment is still on the calendar.',
    ],
    cancel: [
      '📅 LIVE CHAT CANCEL — cancel it in LP',
      `${who} asked to cancel ${appt}.`,
      ghlCancelled ? 'GHL: ✅ cancelled by the bot. → Cancel it in LP.'
        : 'GHL: ❌ NOT cancelled (could not match or the cancel failed). → Cancel it in GHL and LP, and confirm with them.',
    ],
  }[kind === 'rescheduled' || kind === 'reschedule' ? kind : 'cancel'];
  return [
    ...lines,
    `Phone: ${phone ? formatPhone(phone) : 'not given'}`,
    marketNote || null,
    visitorWords ? `They said: "${String(visitorWords).slice(0, 300)}"` : null,
    contactUrl ? `Contact: ${contactUrl}` : null,
  ].filter(Boolean).join('\n');
}
