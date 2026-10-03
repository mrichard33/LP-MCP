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
const FROM_US_RX = /\b(?:we|i|our\s+(?:\w+\s+)?(?:team|rep|office|specialist)|someone|somebody|a\s+(?:team\s+member|rep|specialist|member\s+of\s+(?:our|the)\s+team)|they|he|she)(?:'ll|’ll|'m|’m|\s+will|\s+(?:is|are|am)\s+(?:going\s+to|getting)|\s+can|\s+should|\s+would|\s+have)\b|\byou(?:'ll|’ll|\s+will|\s+should)\s+(?:get|receive|hear)\b|\bexpect\s+(?:a\s+call|to\s+hear)\b|\b(?:i'?ve|we'?ve)\s+(?:passed|flagged)\b/i;
const promisesCall = (s) => CALL_PROMISE_RX.test(s) && FROM_US_RX.test(s);

// A phone call from us, promised as a statement (2026-10-03, Mark's shutters
// thread: "someone from our team will call you shortly" with nothing filed).
// Narrower than promisesCall: a CALL verb, said by us, not a question, and not
// the booking confirm ("Our team will reach out to confirm the details").
const CALL_VERB_RX = /\b(?:call|calls|calling|ring|phone)\s+(?:you|you\s+back)\b|\bgive\s+you\s+a\s+(?:call|ring)\b|\bget\s+a\s+call\b|\bexpect\s+a\s+call\b|\bcall\s+(?:to\s+)?(?:set|schedule|go\s+over|talk|walk|follow\s+up|confirm)/i;
const NOT_A_CALLBACK_RX = /\b(?:confirm\s+(?:the\s+|your\s+)?(?:details|appointment|visit|time))\b|\ball\s+set\b/i;
/** Does this reply promise that we will phone the lead? Pure. */
export function promisedCallback(text) {
  return String(text || '').split(/(?<=[.!?])\s+/).some(s =>
    !s.trim().endsWith('?') && CALL_VERB_RX.test(s) && FROM_US_RX.test(s) && !NOT_A_CALLBACK_RX.test(s));
}
// The same-day / immediate part of that promise. "now" alone is left out: it
// reads as "I'm passing this on now", which stays true after hours.
const IMMEDIATE = String.raw`\b(?:right\s+now|right\s+away|immediately|in\s+the\s+next\s+(?:few|couple(?:\s+of)?|\d+|several)\s+(?:minutes|hours?)|within\s+the\s+(?:next\s+)?(?:hour|few\s+minutes|\d+\s+minutes)|in\s+a\s+few\s+minutes|today|tonight|this\s+(?:morning|afternoon|evening))\b`;

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
    out = out.replace(s, s.replace(new RegExp(IMMEDIATE, 'i'), label));
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
  const body = String(text || '');
  let out = body;
  for (const s of body.split(/(?<=[.!?])\s+/)) {
    if (!promisesCall(s)) continue;
    out = out.replace(s, s.replace(new RegExp(IMMEDIATE, 'i'), 'soon'));
  }
  return out;
}
