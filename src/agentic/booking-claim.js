/**
 * booking-claim — src/agentic/booking-claim.js
 *
 * 2026-10-02 simulation (Mark Test, live chat, NEPQ live): the visitor said
 * "Yes, that would help" to the bridge and the bot answered "Perfect. You're
 * all set for a measurement visit at 16828 Crown Bridge Drive." Nothing was
 * booked, and the live chat cannot book from a model reply at all: it books
 * only when a visitor picks one of two real offered times (runNepqFixedMove).
 * The model copied the SMS prompt's booking confirmations (playbooks.js
 * PATH A/B). No guard read the wording, so a false confirmation shipped.
 *
 * Same shape as send-promise.js: a reply may only say a visit is set when
 * this turn actually booked it (or it names the appointment already on file).
 * Pure (one leaf import, appointment-dates.js). Used by src/live-chat/fast-lane.js (rewrite) and
 * src/response-generator.js (regenerate once, then rewrite).
 */

import { lpWallClockToGhlStartTime } from '../appointment-dates.js';

const CLAIM_PATTERNS = [
  /\byou(?:'re|’re|\s+are)\s+(?:all\s+|now\s+)?(?:set|booked|scheduled|confirmed|locked\s+in)\b/i,
  // 2026-10-07 (Nicholas Ferraioli, I5x7zltORikAxdEJ6nyD): the model's own
  // confirm line ("You're on the calendar for …") and the other shapes a
  // booked time takes, none of which the list above read.
  /\byou(?:'re|’re|\s+are)\s+(?:now\s+)?on\s+the\s+(?:schedule|calendar|books)\b/i,
  /\b(?:i|we)(?:'ve|’ve|\s+have)?\s+(?:got\s+)?(?:you|it)\s+(?:down|penciled|pencilled|scheduled|booked|on\s+the\s+(?:schedule|calendar|books))\b/i,
  /\b(?:i|we)(?:'ve|’ve|\s+have)?\s+put\s+you\s+(?:down|on\s+the)\b/i,
  /\bbooked\s+you\b/i,
  /\b(?:is|are|it'?s|that'?s)\s+(?:all\s+)?(?:scheduled|confirmed|booked|set)\s+for\b/i,
  /\b(?:it'?s|that'?s|it\s+is|that\s+is)\s+(?:all\s+)?(?:booked|confirmed|scheduled|locked\s+in|on\s+the\s+(?:schedule|calendar|books))\b/i,
  /\b(?:is|are)\s+(?:now\s+)?on\s+the\s+(?:schedule|calendar|books)\b/i,
  /\b(?:i|we)(?:'ve|\s+have)?\s+(?:booked|scheduled|locked\s+in|confirmed)\s+(?:you|it|that|your|a)\b/i,
  /\bgot\s+you\s+(?:down|booked|scheduled|on\s+the\s+(?:schedule|calendar|books))\b/i,
  /\byour\s+(?:appointment|visit|measurement|consultation|assessment|review)\s+is\s+(?:all\s+)?(?:set|booked|confirmed|scheduled|locked\s+in)\b/i,
];

// 2026-10-02 (Mark, Oct 2 6:12 PM chat): "Usually on Wednesdays" got "We have
// Wednesdays blocked for you." Nothing was held. A hold is a claim too: it
// stands only when this turn's code held a real slot (opts.held).
const HOLD_PATTERNS = [
  /\b(?:we|i)(?:'ve|’ve|\s+have|'re|’re|\s+are|'m|’m|\s+am)?\s+(?:got\s+)?(?:[\w,]+\s+){0,4}?(?:blocked|reserved|held|holding|penciled|pencilled|saved|set\s+aside)\b(?:\s+(?:off|out|in))?\s+(?:for\s+you|for\s+the\s+visit)\b/i,
  /\b(?:blocked|reserved|held|penciled|pencilled|saved|set\s+aside)\s+(?:off\s+|out\s+)?for\s+you\b/i,
  /\b(?:i'?m|we'?re|i\s+am|we\s+are)\s+holding\b/i,
  /\b(?:is|are)\s+(?:now\s+)?(?:blocked|reserved|held)\b/i,
  // 2026-10-07 (Nicholas): "Thursday at 10 AM is holding for you."
  /\b(?:is|are)\s+(?:now\s+)?(?:holding|saved|penciled|pencilled)\s+for\s+you\b/i,
];

// 2026-10-07 (Nicholas): "Thursday, October 8 at 10:00 AM ET works." and "See
// you Thursday at 10." confirm a time only because they name one, so these
// count only in a sentence that names a day or a time, and never inside a
// condition or an ask ("Let me know if Thursday works").
const DAY_TIME_CLAIM_PATTERNS = [
  /\b(?:works|work(?:s)?\s+(?:for\s+(?:us|you|me)|great|perfect|fine)|is\s+(?:good|perfect|great|fine|confirmed))\b/i,
  /\bsee\s+you\s+(?:then|there|on|at|this|next|today|tomorrow|mon|tue|wed|thu|fri|sat|sun)/i,
];
const CONDITIONAL_RX = /\b(?:if|whether|unless|let\s+me\s+know|does|do|would|could|can|which|whichever|what|whatever|either|or)\b/i;

function dayTimeClaim(s) {
  if (!DAY_OR_TIME_RX.test(s)) return false;
  for (const rx of DAY_TIME_CLAIM_PATTERNS) {
    const m = s.match(rx);
    if (m && !CONDITIONAL_RX.test(s.slice(0, m.index))) return true;
  }
  return false;
}

// A day or a time: a claim that names one can be about the appointment on file.
const DAY_OR_TIME_RX = /\b(?:mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?|sun)(?:day)?\b|\btoday\b|\btomorrow\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i;

export const BOOKING_CLAIM_REPLACEMENT = 'Our team will call to set up a time that works for you.';

function sentences(text) {
  return String(text || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
}

/** True when the sentence says (or implies) a time is booked or held. A question never is. */
export function isClaimSentence(s, { held = false } = {}) {
  const t = String(s || '').trim();
  if (!t || t.endsWith('?')) return false;
  // A slot code held this turn may be echoed ("Tuesday at 2 works, I'm holding it").
  return CLAIM_PATTERNS.some(rx => rx.test(t)) || (!held && (dayTimeClaim(t) || HOLD_PATTERNS.some(rx => rx.test(t))));
}

/**
 * The first sentence that says a visit is set when nothing backs it, or null.
 * @param {string} message
 * @param {{booked?: boolean, hasAppointment?: boolean}} [opts]
 *   booked          this turn booked (or carries the action that books)
 *   hasAppointment  an appointment is already on file; a claim that names a
 *                   day or time is then about that one and stands
 */
export function findUnbackedBookingClaim(message, { booked = false, hasAppointment = false, held = false } = {}) {
  if (booked) return null;
  for (const s of sentences(message)) {
    if (s.endsWith('?')) continue;
    if (!isClaimSentence(s, { held })) continue;
    if (hasAppointment && DAY_OR_TIME_RX.test(s)) continue;
    return s;
  }
  return null;
}

/**
 * The reply with every unbacked claim replaced by the truth: the team will
 * call to set the time. The replacement is left out when the reply already
 * says someone will call. Pure.
 */
export function rewriteBookingClaims(message, opts = {}) {
  const parts = sentences(message);
  const claims = new Set();
  let claim;
  let rest = parts;
  while ((claim = findUnbackedBookingClaim(rest.join(' '), opts))) {
    claims.add(claim);
    rest = rest.filter(s => s !== claim);
  }
  if (!claims.size) return { text: String(message || ''), changed: false };
  const saysCall = rest.some(s => /\b(?:team|someone|specialist|we)\b[^.?!]{0,40}\bcall\b/i.test(s));
  // 2026-10-02: the live chat books real times itself, so its replacement is
  // the visit question (opts.replacement), not a promised call.
  const replacement = opts.replacement || BOOKING_CLAIM_REPLACEMENT;
  const out = [];
  let replaced = false;
  for (const s of parts) {
    if (!claims.has(s)) { out.push(s); continue; }
    if (!replaced && (!saysCall || opts.replacement)) out.push(replacement);
    replaced = true;
  }
  return { text: out.join(' ').trim() || replacement, changed: true };
}

/** The regeneration instruction for a draft that claimed a booking. */
export function bookingClaimNote(claim) {
  return (
    `Your previous draft told the lead their visit is set ("${String(claim).slice(0, 160)}"), but nothing was booked. ` +
    'Never say a visit is set, booked, confirmed or on the schedule unless this reply books a real time they picked. ' +
    'Offer the next step instead, or say our team will call to set up a time.'
  );
}

// ═══════════════════════════════════════════════════════════════════
// Booking truth — the LAST check on every outbound bot message (2026-10-07)
// ═══════════════════════════════════════════════════════════════════
//
// Nicholas Ferraioli (GHL I5x7zltORikAxdEJ6nyD, LP lead 581863) was told
// "Thursday, October 8 at 10:00 AM ET works." → "Thursday at 10 AM is holding
// for you." → "You're all set, Nicholas." Nothing was ever booked. The guard
// above ran mid-pipeline, trusted "a book_appointment companion exists" as
// proof, and the NEPQ plan then dropped that companion and kept the text.
// It also let any day/time through when "an appointment is on file", and a
// stale `booking:active` tag had made his cancelled LP visit read as on file.
//
// So the send handler and the live chat run checkBookingTruth right before
// the send, on the OUTCOME, never the intent: a claim stands only with a real
// appointment id from this turn's booking, or an appointment still on the
// calendar (not cancelled, not past) whose day and time the claim matches.
// Anything else is blocked and the reply becomes the no-promise hand-off.
// AI OS CANON.IMP.006 (verify, don't just prompt), CANON.RULE.014 (a typed
// result at the machine boundary).

// LP dispositions that mean the LP visit was cancelled (CXL ours, CCC theirs).
export const LP_CANCEL_DISPOSITIONS = new Set(['CXL', 'CCC']);

/**
 * The typed result of this turn's booking step. Callers build it from the
 * booking action's own result row, never from reply text.
 * @returns {{booked: boolean, appointment_id: string|null, start_time: string|null, calendar_id: string|null, source: string|null}}
 */
export function bookingResult({ booked = false, appointment_id = null, start_time = null, calendar_id = null, source = null } = {}) {
  return {
    booked: booked === true,
    appointment_id: appointment_id ? String(appointment_id) : null,
    start_time: start_time || null,
    calendar_id: calendar_id || null,
    source: source || null,
  };
}

// 2026-10-17 (Melissa, 6U6uceZGMQRz8XEQc9Lk): GHL's contact appointments come
// back as NAIVE Eastern wall clock ("2026-10-18 14:00:00"). Date.parse reads
// that as UTC on the server, so her 2:00 PM visit read as 10:00 AM, her correct
// "You're on the calendar for Sun, Oct 18 at 2:00 PM" failed as
// existing_time_mismatch, and the reply became "a team member will call you
// shortly to confirm a time that works". The same rule as toEpochMsEt
// (contact-appointments.js): a string with Z or an offset passes untouched.
function epochMs(value) {
  const str = String(value || '');
  if (!str) return NaN;
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(str)) return Date.parse(str);
  return Date.parse(lpWallClockToGhlStartTime(str) || str);
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// Wall-clock parts of an ISO time. LP stores Eastern wall clock with a fake
// +00:00 (CLAUDE.md: "LP times are Eastern wall clock"), so `wallClock` reads
// the digits as written; a real offset/Z time is converted to the zone.
function partsOf(iso, { timeZone = 'America/New_York', wallClock = false } = {}) {
  const raw = String(iso || '');
  if (wallClock || /[+-]\d{2}:\d{2}$/.test(raw) && !/[+-]00:00$/.test(raw)) {
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) return null;
    const date = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return { year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5], weekday: date.getUTCDay() };
  }
  const ms = epochMs(raw);
  if (!Number.isFinite(ms)) return null;
  const f = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23', weekday: 'long' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, weekday: WEEKDAYS.indexOf(String(p.weekday).toLowerCase()) };
}

function dayKey(p) { return `${p.year}-${p.month}-${p.day}`; }

/**
 * The appointment still on the calendar, or null. GHL first (a live,
 * not-cancelled appointment with an id and a start still ahead), then the LP
 * row (set, not CXL/CCC, not past). A `booking:active` tag alone is NOT an
 * appointment: it outlived Nicholas's cancel.
 */
export function appointmentOnFile({ upcomingAppointments = null, lp = null, nowMs = Date.now() } = {}) {
  for (const a of Array.isArray(upcomingAppointments) ? upcomingAppointments : []) {
    const status = String(a?.status || '').toLowerCase();
    if (/cancel|no-?show|invalid/.test(status) || a?.already_ended) continue;
    const startMs = epochMs(a?.start_time);
    if (!a?.appointment_id || !Number.isFinite(startMs) || startMs <= nowMs) continue;
    return { appointment_id: String(a.appointment_id), start_time: a.start_time, calendar_id: a.calendar_id || null, source: 'ghl', wall_clock: false };
  }
  if (lp && lp.appointment_set === true && lp.appointment_cancelled !== true && lp.appointment_date
    && !LP_CANCEL_DISPOSITIONS.has(String(lp.disposition || '').toUpperCase())
    && lp.appointment_is_past !== true && lp.appointment_phase !== 'past' && lp.appointment_phase !== 'in_window') {
    return { appointment_id: `lp:${lp.lead_id || 'lead'}`, start_time: lp.appointment_date, calendar_id: null, source: 'lp', wall_clock: true };
  }
  return null;
}

// Every day/time a sentence names, as comparable parts.
function mentionsIn(s, nowParts) {
  const text = String(s || '').toLowerCase();
  const out = { weekdays: [], days: [], hours: [] };
  for (const m of text.matchAll(/\b(sun|mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?)(?:day)?\b/g)) {
    const idx = WEEKDAYS.findIndex(w => w.startsWith(m[1].slice(0, 3)));
    if (idx >= 0) out.weekdays.push(idx);
  }
  if (nowParts) {
    if (/\btoday\b|\btonight\b/.test(text)) out.days.push(dayKey(nowParts));
    if (/\btomorrow\b/.test(text)) {
      const d = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + 1));
      out.days.push(`${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`);
    }
  }
  for (const m of text.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/g)) {
    out.days.push(`md:${MONTHS.indexOf(m[1]) + 1}-${+m[2]}`);
  }
  for (const m of text.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/g)) {
    let h = +m[1] % 12;
    if (m[3].startsWith('p')) h += 12;
    out.hours.push({ h, min: m[2] ? +m[2] : 0 });
  }
  return out;
}

/** True when every day and time the sentence names is the appointment's. */
export function claimMatchesAppointment(sentence, appt, { nowMs = Date.now(), timeZone = 'America/New_York' } = {}) {
  const ap = partsOf(appt?.start_time, { timeZone, wallClock: !!appt?.wall_clock });
  if (!ap) return false;
  const now = partsOf(new Date(nowMs).toISOString(), { timeZone });
  const m = mentionsIn(sentence, now);
  if (m.weekdays.some(w => w !== ap.weekday)) return false;
  for (const d of m.days) {
    if (d.startsWith('md:')) { if (d !== `md:${ap.month}-${ap.day}`) return false; }
    else if (d !== dayKey(ap)) return false;
  }
  if (m.hours.some(t => t.h !== ap.hour || t.min !== ap.minute)) return false;
  return true;
}

/**
 * The final verdict on one outbound message. Pure.
 * @param {string} text
 * @param {{result?: object|null, existing?: object|null, held?: boolean, nowMs?: number, timeZone?: string}} opts
 *   result    bookingResult() of THIS turn's booking step (null = none ran)
 *   existing  appointmentOnFile() (null = nothing on the calendar)
 *   held      code held a real offered slot this turn (the collect flow's
 *             "I'm holding … for you" line); a hold claim then stands
 * @returns {{allowed: boolean, reason: string, sentence: string|null}}
 */
export function checkBookingTruth(text, { result = null, existing = null, held = false, nowMs = Date.now(), timeZone = 'America/New_York' } = {}) {
  const claims = sentences(text).filter(s => isClaimSentence(s, { held }));
  if (!claims.length) return { allowed: true, reason: 'no_claim', sentence: null };
  if (result?.booked && result.appointment_id) return { allowed: true, reason: 'booked', sentence: claims[0] };
  if (existing?.appointment_id) {
    const off = claims.find(s => !claimMatchesAppointment(s, existing, { nowMs, timeZone }));
    if (!off) return { allowed: true, reason: 'existing_appointment', sentence: claims[0] };
    return { allowed: false, reason: 'existing_time_mismatch', sentence: off };
  }
  return { allowed: false, reason: result?.booked ? 'no_appointment_id' : 'no_booking', sentence: claims[0] };
}

/**
 * The no-promise hand-off a blocked claim becomes (handoff §2): no day, no
 * time. "shortly" only while the team is in (Mark, 2026-10-02: no same-day
 * call promise out of hours); otherwise "as soon as we open".
 */
export function noPromiseHandoffLine(firstName, { teamOpen = true } = {}) {
  const name = String(firstName || '').trim().split(/\s+/)[0];
  const who = name && !/^guest$/i.test(name) ? `Thanks, ${name}. ` : 'Thanks. ';
  return `${who}A team member will call you ${teamOpen ? 'shortly' : 'as soon as we open'} to confirm a time that works.`;
}

/**
 * The final pass on one AI-written reply, as the send handler runs it (and the
 * simulator mirrors it). Pure.
 * @param {string} message           what is about to go out
 * @param {object} generated         generateResponse() output (appointment_on_file,
 *                                   booking_hold_backed, slot_timezone_for_truth, lead_first_name)
 * @param {{result?: object|null, teamOpen?: boolean, nowMs?: number}} opts
 * @returns {{message: string, blocked: null | {reason: string, sentence: string|null}}}
 */
export function applyBookingTruth(message, generated, { result = null, teamOpen = true, nowMs = Date.now(), inbound = '' } = {}) {
  const existing = generated?.appointment_on_file || null;
  const timeZone = generated?.slot_timezone_for_truth || 'America/New_York';
  const verdict = checkBookingTruth(message, {
    result,
    existing,
    held: !!generated?.booking_hold_backed,
    nowMs,
    timeZone,
  });
  if (verdict.allowed) return { message: String(message || ''), blocked: null };
  // 2026-10-17 (Melissa): a booked lead who sends only her phone and email is
  // never told we will "confirm a time that works": the time is on file.
  const restated = existing?.appointment_id && isContactDetailsOnly(inbound)
    ? bookedDetailsLine(generated?.lead_first_name || null, existing, { timeZone })
    : null;
  return {
    message: restated || noPromiseHandoffLine(generated?.lead_first_name || null, { teamOpen }),
    blocked: { reason: verdict.reason, sentence: verdict.sentence },
  };
}

const PHONE_IN_TEXT_RX = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const EMAIL_IN_TEXT_RX = /[^\s@]+@[^\s@]+\.[a-z]{2,}/gi;

/** The message is only a phone and/or an email ("3525550188 mel@x.com", "My email is …"). Pure. */
export function isContactDetailsOnly(text) {
  const t = String(text || '').trim();
  if (!t || t.includes('?')) return false;
  const hits = (t.match(PHONE_IN_TEXT_RX) || []).length + (t.match(EMAIL_IN_TEXT_RX) || []).length;
  if (!hits) return false;
  const rest = t.replace(PHONE_IN_TEXT_RX, ' ').replace(EMAIL_IN_TEXT_RX, ' ').replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  return rest.length <= 8;
}

/** "Thanks, Melissa, got it. You're on the calendar for Sun, Oct 18 at 2:00 PM ET." Pure; null when the time cannot be read. */
export function bookedDetailsLine(firstName, appt, { timeZone = 'America/New_York' } = {}) {
  const ms = appt?.wall_clock ? epochMs(String(appt.start_time || '').replace(/[+-]00:00$|Z$/, '')) : epochMs(appt?.start_time);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const day = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(d);
  const zone = timeZone === 'America/Chicago' ? 'CT' : 'ET';
  const name = String(firstName || '').trim().split(/\s+/)[0];
  const who = name && !/^guest$/i.test(name) ? `Thanks, ${name}, got it.` : 'Thanks, got it.';
  return `${who} You're on the calendar for ${day} at ${time} ${zone}.`;
}

/** Reads our own no-promise hand-off back from the thread. */
export const NO_PROMISE_HANDOFF_RX = /\bteam\s+member\s+will\s+call\s+you\b[^.?!]*\bconfirm\s+a\s+time\b/i;
