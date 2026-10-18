/**
 * src/agentic/team-hours.js
 *
 * 2026-10-02 (Mark): the bots may promise a call "today", "right now" or "in the
 * next few minutes" only while the team is in: 9 AM to 8 PM Monday through
 * Friday, 9 to 5 Saturday, 9 to 3 Sunday (ET; office hours stay ET). Outside
 * them, a promise of a same-day call is a promise nobody keeps. The simulator
 * caught both bots doing it: "someone will call you in the next few minutes"
 * for an emergency and "will call you today" for a repair.
 *
 * Pure: every function takes the clock as an argument.
 */

export const TEAM_TIMEZONE = 'America/New_York';

/** Open/close hour (24h, ET) per weekday, 0 = Sunday. Change them here and nowhere else. */
export const TEAM_HOURS = Object.freeze({
  0: Object.freeze({ open: 9, close: 15 }),
  1: Object.freeze({ open: 9, close: 20 }),
  2: Object.freeze({ open: 9, close: 20 }),
  3: Object.freeze({ open: 9, close: 20 }),
  4: Object.freeze({ open: 9, close: 20 }),
  5: Object.freeze({ open: 9, close: 20 }),
  6: Object.freeze({ open: 9, close: 17 }),
});

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TEAM_TIMEZONE, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit',
});
const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** ET weekday (0 = Sunday) and fractional hour for an instant. */
export function etClock(nowMs = Date.now()) {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(nowMs)).map(x => [x.type, x.value]));
  return { dow: WEEKDAY[p.weekday], hour: Number(p.hour) + Number(p.minute) / 60 };
}

/** True while the team is in. */
export function isTeamOpen(nowMs = Date.now()) {
  const { dow, hour } = etClock(nowMs);
  const h = TEAM_HOURS[dow];
  return hour >= h.open && hour < h.close;
}

/**
 * Minutes the team has been open AND this item has been waiting: the smaller of
 * "since today's opening" and "since it arrived". 0 while the team is closed.
 * A row that arrived overnight starts counting at opening; one that arrived at
 * 11 AM starts counting at 11 AM. (2026-10-05, the user: a held-row card should
 * go out only after we have been open about an hour and the row is still not
 * imported — not the moment the doors open.)
 */
export function openMinutesSince(receivedMs, nowMs = Date.now()) {
  if (!isTeamOpen(nowMs)) return 0;
  const { dow, hour } = etClock(nowMs);
  const sinceOpen = (hour - TEAM_HOURS[dow].open) * 60;
  const sinceArrival = Number.isFinite(receivedMs) ? (nowMs - receivedMs) / 60000 : sinceOpen;
  return Math.max(0, Math.floor(Math.min(sinceOpen, sinceArrival)));
}

const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TEAM_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const etDate = (ms) => dateFmt.format(new Date(ms));
function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Is this home visit too early to book while the team is closed?
 *
 * 2026-10-06 (the user): LP lead 581084 was booked by the live chat at 7:36 PM
 * Sunday for 2 PM Monday. LP already had his web row, so the visit waited on a
 * person to import it (9:58 AM), and nothing could put him on a Five9 Conf list
 * in time: he was never called before the visit. A visit booked after hours for
 * the next MORNING cannot be imported and confirmed first. So while the team is
 * closed, the next open day's visits start at `earliestHour` ET (2 PM: the 10 AM
 * slot goes, 2 PM and 6 PM stay). Later days and open-hours bookings are
 * untouched. `earliestHour` 0 turns it off. Pure.
 */
export function visitTooEarlyAfterHours(slotMs, nowMs = Date.now(), earliestHour = 14) {
  if (!Number.isFinite(slotMs) || !(earliestHour > 0) || isTeamOpen(nowMs)) return false;
  const { dow, hour } = etClock(nowMs);
  const today = etDate(nowMs);
  // Closed before today's opening → the next open day is today; after closing → tomorrow.
  const nextOpenDay = hour < TEAM_HOURS[dow].open ? today : addDays(today, 1);
  if (etDate(slotMs) > nextOpenDay) return false;
  return etClock(slotMs).hour < earliestHour;
}

function hourLabel(h) {
  const hh = Math.floor(h);
  return `${hh % 12 || 12} ${hh < 12 ? 'AM' : 'PM'}`;
}

/**
 * When the team next opens, as words: "today at 9 AM ET", "tomorrow at 9 AM ET",
 * "Monday at 9 AM ET". `fromDow`/`fromHour` let a caller ask from a requested
 * time instead of now (a call asked for at 9 PM tonight).
 */
export function nextTeamOpenLabel(nowMs = Date.now(), { fromDow = null, fromHour = null, dayOffset = 0 } = {}) {
  const clock = etClock(nowMs);
  const startDow = fromDow ?? clock.dow;
  const startHour = fromHour ?? clock.hour;
  for (let add = 0; add < 8; add++) {
    const dow = (startDow + add) % 7;
    const h = TEAM_HOURS[dow];
    if (add === 0 && startHour >= h.open) continue;
    const daysFromToday = dayOffset + add;
    const when = daysFromToday === 0 ? 'today' : daysFromToday === 1 ? 'tomorrow' : DAY_NAMES[dow];
    return `${when} at ${hourLabel(h.open)} ET`;
  }
  return 'when we open';
}

/** "9 AM to 8 PM ET" for one day. */
export function teamHoursFor(dow) {
  const h = TEAM_HOURS[dow];
  return `${hourLabel(h.open)} to ${hourLabel(h.close)} ET`;
}

/**
 * A call asked for at a time ("at 9pm", "tomorrow at 7am", "tonight"): is it
 * inside team hours? Returns { ok, past, dow, hour, dayOffset } or null when no time
 * can be read. An hour with no am/pm reads as afternoon for 1–7 ("at 5").
 */
export function requestedCallTime(text, nowMs = Date.now()) {
  const t = String(text || '');
  const clock = etClock(nowMs);
  const dayOffset = /\btomorrow\b/i.test(t) ? 1 : 0;
  const m = t.match(/\b(?:at|around|after|by)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/i);
  let hour = null;
  if (m) {
    let h = Number(m[1]) % 12;
    const ap = (m[3] || '').toLowerCase().replace(/\./g, '');
    if (ap === 'pm' || (!ap && h >= 1 && h <= 7)) h += 12;
    hour = h + (m[2] ? Number(m[2]) / 60 : 0);
  } else if (/\btonight\b|\bthis\s+evening\b/i.test(t)) {
    hour = 19;
  } else if (/\bthis\s+morning\b|\btomorrow\s+morning\b/i.test(t)) {
    hour = 10;
  } else if (/\bthis\s+afternoon\b|\btomorrow\s+afternoon\b/i.test(t)) {
    hour = 14;
  }
  if (hour == null) return null;
  const dow = (clock.dow + dayOffset) % 7;
  const h = TEAM_HOURS[dow];
  // Today, a time already past: the team cannot call into the past.
  const past = dayOffset === 0 && hour < clock.hour;
  return { ok: !past && hour >= h.open && hour < h.close, past, dow, hour, dayOffset };
}

// A sentence that promises a call or a person reaching out.
const CALL_PROMISE_RX = /\b(?:call|calls|calling|phone|reach\s+out|reach\s+you|get\s+back\s+to\s+you|be\s+in\s+touch|contact\s+you|on\s+the\s+phone|on\s+this)\b/i;
// …made BY US. 2026-10-03 replay: "What made you reach out today?" read as a
// promised call and went out as "…made you reach out tomorrow at 9 AM ET?".
// The call has to come from us, someone on the team, or to the lead.
// 2026-10-09 (Monica): "We're having someone call you back right now." read
// as no promise at all ("we're" was not a doer), so no timing guard saw it.
const FROM_US_RX = /\b(?:we|i|our\s+(?:\w+\s+)?(?:team|rep|office|specialist)|someone|somebody|a\s+(?:team\s+member|rep|specialist|member\s+of\s+(?:our|the)\s+team)|they|he|she)(?:'ll|’ll|'m|’m|\s+will|(?:\s+(?:is|are|am)|'re|’re|'s|’s)\s+(?:going\s+to|getting|having|arranging|sending)|\s+can|\s+should|\s+would|\s+have)\b|\byou(?:'ll|’ll|\s+will|\s+should)\s+(?:get|receive|hear)\b|\bexpect\s+(?:a\s+call|to\s+hear)\b|\b(?:i'?ve|we'?ve)\s+(?:passed|flagged)\b/i;
const promisesCall = (s) => CALL_PROMISE_RX.test(s) && FROM_US_RX.test(s);

// A phone call from us, promised as a statement (2026-10-03, Mark's shutters
// thread: "someone from our team will call you shortly" with nothing filed).
// Narrower than promisesCall: a CALL verb, said by us, not a question, and not
// the booking confirm ("…give you a call to confirm the details", LINES.confirm):
// that call is the phone room's confirmation, not a Five9 Callback Request.
const CALL_VERB_RX = /\b(?:call|calls|calling|ring|phone)\s+(?:you|you\s+back)\b|\bgive\s+you\s+a\s+(?:call|ring)\b|\bget\s+a\s+call\b|\bexpect\s+a\s+call\b|\bcall\s+(?:to\s+)?(?:set|schedule|go\s+over|talk|walk|follow\s+up|confirm)/i;
const NOT_A_CALLBACK_RX = /\b(?:confirm\s+(?:the\s+|your\s+)?(?:details|appointment|visit|time))\b|\ball\s+set\b/i;
/** Does this reply promise that we will phone the lead? Pure. */
export function promisedCallback(text) {
  return String(text || '').split(/(?<=[.!?])\s+/).some(s =>
    !s.trim().endsWith('?') && CALL_VERB_RX.test(s) && FROM_US_RX.test(s) && !NOT_A_CALLBACK_RX.test(s));
}
// The same-day / immediate part of that promise. "now" alone is left out: it
// reads as "I'm passing this on now", which stays true after hours.
const IMMEDIATE = String.raw`\b(?:right\s+now|right\s+away|immediately|in\s+the\s+next\s+(?:few|couple(?:\s+of)?|\d+|several)\s+(?:minutes|hours?)|within\s+the\s+(?:next\s+)?(?:hour|few\s+minutes|\d+\s+minutes)|in\s+a\s+few\s+minutes|shortly|today|tonight|this\s+(?:morning|afternoon|evening))\b`;
// The immediacy plus a clock time right beside it, before or after ("today at
// 9 AM ET", "at 9 AM ET today"), replaced as one. 2026-10-18 (bot gate,
// complaint scenario): the planner's after-hours line already reads "someone
// will call you today at 9 AM ET", and swapping only "today" for the label
// made "today at 9 AM ET at 9 AM ET". On SMS the model wrote "I'm flagging
// this to our team today, and someone will call you at 9 AM ET today", and the
// FIRST "today" (the flagging, not the call) got the label. So the immediacy
// that carries a clock time is the one replaced; with none, the first.
const CLOCK_AT = String.raw`at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?(?:\s+[ECMP]T\b)?`;
const IMMEDIATE_WITH_TIME = String.raw`(?:\b${CLOCK_AT}\s+)?${IMMEDIATE}(?:\s+${CLOCK_AT})?`;
function replaceTiming(sentence, replacement) {
  const matches = [...sentence.matchAll(new RegExp(IMMEDIATE_WITH_TIME, 'gi'))];
  if (!matches.length) return sentence;
  const m = matches.find(x => /\d/.test(x[0])) || matches[0];
  return sentence.slice(0, m.index) + replacement + sentence.slice(m.index + m[0].length);
}

/**
 * Outside team hours, a promised call "today" / "right now" / "in the next few
 * minutes" becomes the next opening ("tomorrow at 9 AM ET"). Inside hours the
 * text is untouched. Pure.
 *
 * @returns {{ text: string, changed: boolean }}
 */
export function enforceCallTiming(text, nowMs = Date.now()) {
  const body = String(text || '');
  if (!body || isTeamOpen(nowMs)) return { text: body, changed: false };
  const label = nextTeamOpenLabel(nowMs);
  const hasImmediate = new RegExp(IMMEDIATE, 'i');
  // Sentence by sentence, in place, so line breaks (a sign-off) survive.
  let out = body;
  for (const s of body.split(/(?<=[.!?])\s+/)) {
    if (!promisesCall(s) || !hasImmediate.test(s)) continue;
    out = out.replace(s, replaceTiming(s, label));
  }
  return { text: out, changed: out !== body };
}

/**
 * The immediacy taken out of a promised call ("will call you right now" →
 * "will call you soon"), whatever the hour. For the phone room closing
 * earlier than the team (Part 6, 2026-10-02: rewritten instead of a whole
 * new draft). Pure.
 */
export function softenCallTiming(text) {
  return replaceCallImmediacy(text, 'soon');
}

/**
 * The immediacy in every promised call replaced with `replacement` ("right
 * now" → "on Monday"). softenCallTiming is this with "soon". Pure.
 */
export function replaceCallImmediacy(text, replacement) {
  const body = String(text || '');
  let out = body;
  for (const s of body.split(/(?<=[.!?])\s+/)) {
    if (!promisesCall(s)) continue;
    out = out.replace(s, replaceTiming(s, replacement));
  }
  return out;
}

/**
 * When the rep is next free, as words that fit "call you back ___": "on
 * Monday", "tomorrow", or null (no opening read, or the opening is today,
 * which stays "soon"). The DAY only: no clock time is promised for a call
 * nobody booked. Pure.
 */
export function rehashOpeningDay(slot) {
  if (!slot) return null;
  if (slot.rel === 'today') return null;
  if (slot.rel === 'tomorrow') return 'tomorrow';
  const dow = slot.dayOfWeek || (String(slot.day || '').match(/^[A-Za-z]+/) || [])[0];
  return dow ? `on ${dow}` : null;
}

/**
 * A post-demo lead is never promised a call "right now" (2026-10-09, Monica).
 * The rehash rep calls, and only when the Rehash Call calendar shows them
 * free: the team being open says nothing about the rep. Every promised call
 * with an immediacy ("right now", "shortly", "today", "in the next few
 * minutes") names the day of the rep's first real opening instead ("on
 * Monday"), or "soon" when no opening was read. Pure.
 *
 * @param {string} text
 * @param {{ nextOpening?: object|null }} [opts]  the first Rehash Call slot read
 * @returns {{ text: string, changed: boolean }}
 */
export function enforceRehashCallTiming(text, { nextOpening = null } = {}) {
  const body = String(text || '');
  const day = rehashOpeningDay(nextOpening);
  const out = day ? replaceCallImmediacy(body, day) : softenCallTiming(body);
  return { text: out, changed: out !== body };
}
