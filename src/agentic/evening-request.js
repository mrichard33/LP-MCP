/**
 * Evening request — src/agentic/evening-request.js  (pure)
 *
 * Mark, 2026-10-15 (handoff v3, rule R5). Visits start at 10 AM, 2 PM or 6 PM
 * only (IN_HOME_START_HOURS), so the bot never books 6:30 or 7:00. A lead who
 * asks for a time after 6 PM ("6:30", "7pm", "can you do 7", "after 6") is
 * booked at 6:00 PM that day, when 6:00 is open and the market's capacity
 * takes it, and is told the team will confirm and move it:
 *
 *   "I'm putting you for 6:00, with a note that you would like the
 *    appointment for {requested_time}. Our team will be reaching out to
 *    confirm the details and make that adjustment for you."
 *
 * That sentence is the REFERENCE: the model words the reply (the user's
 * ruling, 2026-10-15: AI-worded, same meaning) and checkEveningReply holds it
 * to the facts; a draft that fails ships the sentence as written. "confirm the
 * details" is kept on purpose: NOT_A_CALLBACK_RX reads it, so the line never
 * files a Five9 callback or a promised call.
 *
 * Side effects (send handler, after the booking landed): a GHL note, the
 * "Requested Appointment Time" field OVERWRITTEN with requestedLabel, one
 * appt_time_change_requests row (the LP note for the confirming agent is
 * written from it, src/services/time-change-lp-note.js) and one
 * #contact-center card. No tag, no task.
 */

import { extractPreferredTime } from '../services/preferred-time.js';

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function label(h24, min) {
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${String(min).padStart(2, '0')} ${h24 >= 12 ? 'PM' : 'AM'}`;
}

// A clock time with a cue that it is a TIME: "6:30", "7pm", "7 pm", "at 7",
// "do 7", "for 7", "around 7", "7 o'clock". A bare "7" ("7 windows") is not.
const TIME_RX = /\b(after|at|do|for|around|about|by|like|maybe|say|or)?\s*(\d{1,2})(?::(\d{2})|\.(30|15|45))?\s*(a\.?m\.?|p\.?m\.?|o['’]?clock)?(?![\d:])/gi;

/**
 * The evening time a message asks for, or null. Pure.
 * @returns {null|{ requested_time: string, minutes: number, after: boolean }}
 *   minutes is the wall-clock minute of the day asked for ("after 6" = 18:00).
 */
export function detectEveningRequest(text) {
  const s = String(text || '');
  if (!s.trim()) return null;
  for (const m of s.matchAll(TIME_RX)) {
    const cue = (m[1] || '').toLowerCase();
    const h = Number(m[2]);
    const min = Number(m[3] || m[4] || 0);
    const mer = (m[5] || '').toLowerCase().replace(/[.\s]/g, '');
    const hasColon = m[3] != null || m[4] != null;
    if (mer.startsWith('a')) continue;                        // "7 am" is not an evening ask
    if (!cue && !hasColon && !mer) continue;                  // "7 windows", "3 doors"
    if (cue === 'or' && !hasColon && !mer) continue;          // "2 or 3 windows"
    if (h < 1 || h > 12 || min > 59) continue;
    // 1–5 with no "pm" is an afternoon guess, never ours to read as evening.
    const h24 = mer.startsWith('p') ? (h === 12 ? 12 : h + 12) : (h >= 6 && h <= 9 ? h + 12 : null);
    if (h24 == null) continue;
    const mins = h24 * 60 + min;
    const after = cue === 'after';
    // "after 6" / "after 6pm": anything past 6:00. A plain 6:00 is our own time.
    if (after && mins >= 18 * 60 && mins < 22 * 60) return { requested_time: `after ${label(h24, min)}`, minutes: mins, after: true };
    if (mins > 18 * 60 && mins < 22 * 60) return { requested_time: label(h24, min), minutes: mins, after: false };
  }
  return null;
}

function localParts(iso, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(iso)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour}:${p.minute}` };
}

/** "Thu Oct 16" for an instant in a zone. Pure. */
export function shortDayLabel(iso, tz = 'America/New_York') {
  const { date } = localParts(iso, tz);
  const [y, mo, d] = date.split('-').map(Number);
  const dow = new Date(Date.UTC(y, mo - 1, d, 12)).getUTCDay();
  return `${DAY_SHORT[dow]} ${MON_SHORT[mo - 1]} ${d}`;
}

/** "6:30 PM on Thu Oct 16": the Requested Appointment Time value. Pure. */
export function requestedLabel(requestedTime, slotIso, tz = 'America/New_York') {
  return `${requestedTime} on ${shortDayLabel(slotIso, tz)}`;
}

/** The R5 reference line, word for word. Pure. */
export function eveningReplyLine(requestedTime) {
  return `I'm putting you for 6:00, with a note that you would like the appointment for ${requestedTime}. Our team will be reaching out to confirm the details and make that adjustment for you.`;
}

/**
 * The 6:00 PM opening for an evening request. The day is the one the lead
 * named; with none named, the day of an offered time (our open offer). Null
 * when that day has no 6:00 PM opening the market can take (the normal flow
 * then offers the nearest open times). Pure.
 * @param {object} a
 * @param {string} a.text          the lead's message
 * @param {Array}  a.slots         real openings (already through the capacity gate)
 * @param {Array}  [a.offered]     the slots our last offer named
 * @param {string} [a.timeZone]    the lead's zone (the slot labels' zone)
 */
export function findSixPmSlot({ text, slots = [], offered = [], timeZone = 'America/New_York', nowMs = Date.now() }) {
  const req = detectEveningRequest(text);
  if (!req) return null;
  const pref = extractPreferredTime([{ direction: 'inbound', text: String(text || '') }], { timeZone, now: nowMs });
  const six = (list) => (Array.isArray(list) ? list : []).filter(s => s?.iso && localParts(s.iso, timeZone).hhmm === '18:00');
  let date = pref?.date_iso || null;
  if (!date) {
    const fromOffer = (Array.isArray(offered) ? offered : []).find(s => s?.iso);
    date = fromOffer ? localParts(fromOffer.iso, timeZone).date : null;
  }
  if (!date) return null;
  const slot = six(slots).find(s => localParts(s.iso, timeZone).date === date) || null;
  if (!slot) return null;
  return { slot, requested_time: req.requested_time, requested_minutes: req.minutes, requested_label: requestedLabel(req.requested_time, slot.iso, timeZone) };
}

/**
 * The newest evening ask in the lead's own messages since our last time offer
 * (a held 6:00 is booked on a later turn, after the name or address arrives). Pure.
 * @param {Array<{direction, text}>} thread  oldest first
 */
export function eveningRequestFromThread(thread = []) {
  const list = Array.isArray(thread) ? thread : [];
  for (let i = list.length - 1; i >= 0 && i >= list.length - 10; i--) {
    const m = list[i];
    if (m?.direction !== 'outbound') {
      const r = detectEveningRequest(m?.text);
      if (r) return { ...r, text: m.text };
    }
  }
  return null;
}

const SIX_RX = /\b6(?::00)?\s*(?:p\.?m\.?)?\b/i;
/**
 * The model's version of the R5 reply, checked against the facts. It must say
 * 6:00, the time they asked for, that it is noted, and that the team will
 * reach out to confirm the details. No question, no other time. Pure.
 */
export function checkEveningReply(draft, { requested_time }) {
  const text = String(draft || '').trim();
  const problems = [];
  if (!text) return { ok: false, problems: ['empty'] };
  if (!SIX_RX.test(text)) problems.push('no_six');
  // The time they asked for, as written ("7:00 PM" may read "7", "7 PM" or "7:00").
  const after = /^after\s+/i.test(requested_time);
  const [hm] = String(requested_time).replace(/^after\s+/i, '').split(' ');
  const [h, mm] = hm.split(':');
  const named = after
    ? new RegExp(`\\bafter\\s+${h}(?::${mm})?\\b`, 'i').test(text)
    : mm !== '00'
      ? new RegExp(`\\b${h}:${mm}\\b`).test(text)
      : new RegExp(`\\b${h}(?::00)?\\b`).test(text);
  if (!named) problems.push('no_requested_time');
  if (!/\bnote/i.test(text)) problems.push('no_note');
  if (!/\bconfirm\s+(?:the\s+|your\s+)?details\b/i.test(text)) problems.push('no_confirm_details');
  if (!/\breach(?:ing)?\s+out\b|\bcall\b/i.test(text)) problems.push('no_team_contact');
  if (text.includes('?')) problems.push('asks_a_question');
  return { ok: problems.length === 0, problems };
}
