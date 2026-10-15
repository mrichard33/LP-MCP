// ─── Post-demo turn helpers — src/agentic/post-demo-turn.js ──────────────────
//
// WHY (Mark, 2026-10-09: five live threads on the 727-800-4578 rehash line,
// replies signed "— John")
//   planNepqTurn never learned the lead was post-demo, so a lead who already
//   had the full in-home visit and holds a proposal was planned as a brand-new
//   lead (`probe`), and enforceNepqPlan's step 7 appended a stock first-contact
//   question:
//     - "Thank you I will."            → "What's bothering you most about your windows…?"
//     - "Follow up in November please." → two slot offers, twice
//     - "I'll know by next Friday"     → "…Enjoy your week. Is it more how they look, or how they work?"
//     - "I signed the contract with other company." → "Congratulations" + the same question
//   These helpers let the planner tell those turns apart: a dated deferral, a
//   pure thank-you, a sign-off sentence, and the proposal questions a post-demo
//   lead may be asked instead of the pre-demo discovery set.
//
// PURE. No I/O; dates are read in the office zone (America/New_York).

export const POST_DEMO_MODES = Object.freeze(['off', 'shadow', 'live']);

/** POST_DEMO_PLANNER_MODE off|shadow|live, default shadow; a typo is shadow. */
export function postDemoPlannerMode(env = process.env) {
  const raw = String(env.POST_DEMO_PLANNER_MODE ?? '').trim().toLowerCase();
  return POST_DEMO_MODES.includes(raw) ? raw : 'shadow';
}

/** Questions about the proposal, never the pre-demo discovery set. */
export const POST_DEMO_QUESTIONS = Object.freeze([
  'Where are you landing on the proposal?',
  "Is there any part of the proposal you're still weighing?",
  'What would make this an easy decision for you two?',
]);

const DAY_MS = 86_400_000;
const DEFAULT_TZ = 'America/New_York';
const CHECK_BACK_HOUR = 9;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_NAMES = MONTHS.map(m => m[0].toUpperCase() + m.slice(1));
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "may" alone is a verb far more often than a month: it needs a qualifier
// ("in May", "early May"), which every pattern below requires anyway.
const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY_NAMES = WEEKDAYS.map(w => w[0].toUpperCase() + w.slice(1));
const WEEKDAY = String.raw`(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)`;
const COUNT = String.raw`(\d{1,2}|a|an|one|two|three|four|five|six|a\s+couple(?:\s+of)?|couple(?:\s+of)?|a\s+few|few)`;
const COUNT_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

const monthIndex = (w) => MONTHS.findIndex(m => m.startsWith(String(w).toLowerCase().slice(0, 3)));
const weekdayIndex = (w) => WEEKDAYS.findIndex(d => d.startsWith(String(w).toLowerCase().slice(0, 3)));
const countOf = (w) => {
  const s = String(w || '').toLowerCase().replace(/\s+of$/, '').trim();
  if (/^\d+$/.test(s)) return Number(s);
  if (/couple/.test(s)) return 2;
  if (/few/.test(s)) return 3;
  return COUNT_WORDS[s] || null;
};

/** The civil date in `tz` at `ms`: { y, m (1-12), d, dow (0 = Sunday) }. Pure. */
export function civilDate(ms, tz = DEFAULT_TZ) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short',
  }).formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), dow: weekdayIndex(parts.weekday) };
}

// Day arithmetic on a civil date, through UTC noon (no DST edge).
const ymd = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d, 12)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay() }; };
const addDays = (c, n) => ymd(c.y, c.m, c.d + n);
const cmp = (a, b) => (a.y - b.y) || (a.m - b.m) || (a.d - b.d);
const nextBusinessDay = (c) => (c.dow === 6 ? addDays(c, 2) : c.dow === 0 ? addDays(c, 1) : c);

/** `hour`:00 wall clock in `tz` on a civil date, as an ISO instant. Pure. */
export function wallClockIso(c, hour = CHECK_BACK_HOUR, tz = DEFAULT_TZ) {
  const guess = Date.UTC(c.y, c.m - 1, c.d, hour);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  }).formatToParts(new Date(guess)).map(x => [x.type, x.value]));
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  return new Date(guess - (wall - guess)).toISOString();
}

const dayLabel = (c) => `${WEEKDAY_NAMES[c.dow]}, ${MONTH_SHORT[c.m - 1]} ${c.d}`;

/** The first civil date of a month on or after today (this year, else next). */
function monthDate(today, mIdx, day) {
  let c = ymd(today.y, mIdx + 1, day);
  if (cmp(c, today) < 0) c = ymd(today.y + 1, mIdx + 1, day);
  return c;
}

// The check-back moves off a weekend; the label keeps the lead's own words.
// `marker` is what a reworded confirmation must still name (the planner's
// reference check): the weekday, the month, or the span.
const result = (c, label, raw, marker) => {
  const b = nextBusinessDay(c);
  return { untilIso: wallClockIso(b), date: `${b.y}-${String(b.m).padStart(2, '0')}-${String(b.d).padStart(2, '0')}`, label, raw, marker };
};
const monthMarker = (mi) => String.raw`\b(?:${MONTH_NAMES[mi]}|${MONTH_SHORT[mi]})\b`;
const weekdayMarker = (c) => String.raw`\b(?:${WEEKDAY_NAMES[c.dow]}|${WEEKDAY_NAMES[c.dow].slice(0, 3)})\b`;

/**
 * A dated "follow up later" in the lead's words, or null. Pure.
 *   "Please follow up with me early November" → the first business day of
 *   November, "the first week of November"; "I'll know by next Friday" → the
 *   Friday of next week; "check back in 2 weeks" → 14 days out.
 * "not right now" / "maybe later" carry no date and stay the think-it-over play.
 * @returns {{ untilIso: string, date: string, label: string, raw: string } | null}
 */
export function detectDeferral(text, nowMs = Date.now(), tz = DEFAULT_TZ) {
  const t = String(text || '').toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ');
  if (!t.trim()) return null;
  const today = civilDate(nowMs, tz);
  let m;

  // "after November 10" / "by Oct 20" / "until the 20th of November" (a day named).
  if ((m = t.match(new RegExp(String.raw`\b(after|by|until|til+|on|around)\s+${MONTH}\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b`)))) {
    const mi = monthIndex(m[2]);
    const c = monthDate(today, mi, Number(m[3]));
    const target = m[1] === 'after' ? addDays(c, 1) : c;
    return result(target, `${m[1] === 'after' ? 'after' : 'on'} ${MONTH_NAMES[mi]} ${c.d}`, m[0], monthMarker(mi));
  }
  // "early / mid / late / end of / beginning of November".
  if ((m = t.match(new RegExp(String.raw`\b(early|beginning\s+of|start\s+of|first\s+(?:week|part)\s+of|mid(?:dle\s+of)?|late|end\s+of|last\s+week\s+of)\s*-?\s*${MONTH}\b`)))) {
    const mi = monthIndex(m[2]);
    const q = m[1];
    if (/^(early|beginning|start|first)/.test(q)) return result(monthDate(today, mi, 1), `the first week of ${MONTH_NAMES[mi]}`, m[0], monthMarker(mi));
    if (/^mid/.test(q)) return result(monthDate(today, mi, 15), `in mid-${MONTH_NAMES[mi]}`, m[0], monthMarker(mi));
    return result(monthDate(today, mi, 22), `in late ${MONTH_NAMES[mi]}`, m[0], monthMarker(mi));
  }
  // "follow up in November", "after November", "until December" (no day).
  if ((m = t.match(new RegExp(String.raw`\b(in|around|until|til+|after|sometime\s+in)\s+${MONTH}\b(?!\s+\d)`)))) {
    const mi = monthIndex(m[2]);
    // "may" right after "in" is still the month; "after may" too. A month the
    // lead is IN today names this month only with "after" (next one then).
    if (m[1] === 'after') {
      const c = monthDate(today, (mi + 1) % 12, 1);
      return result(c, `after ${MONTH_NAMES[mi]}`, m[0], monthMarker(mi));
    }
    return result(monthDate(today, mi, 1), `in ${MONTH_NAMES[mi]}`, m[0], monthMarker(mi));
  }
  // "after the holidays".
  if ((m = t.match(/\bafter\s+(?:the\s+)?holidays\b/))) {
    const c = ymd(today.m === 1 && today.d < 10 ? today.y : today.y + 1, 1, 2);
    return result(c, 'after the holidays', m[0], String.raw`\bholidays?\b`);
  }
  // "first of the year", "after the new year", "next year".
  if ((m = t.match(/\b(?:(?:after\s+)?(?:the\s+)?first\s+of\s+(?:the\s+)?year|after\s+(?:the\s+)?new\s+year|beginning\s+of\s+(?:next|the)\s+year|next\s+year)\b/))) {
    return result(ymd(today.y + 1, 1, 2), 'after the first of the year', m[0], String.raw`\b(?:year|january|jan)\b`);
  }
  // "next Friday" / "by next Friday": that weekday in NEXT week (Mon–Sun).
  if ((m = t.match(new RegExp(String.raw`\bnext\s+${WEEKDAY}\b`)))) {
    const wd = weekdayIndex(m[1]);
    const mondayNext = addDays(today, ((8 - today.dow) % 7) || 7);
    const c = addDays(mondayNext, (wd + 6) % 7);
    return result(c, `on ${dayLabel(c)}`, m[0], weekdayMarker(c));
  }
  // "by Friday", "I'll know by Tuesday", "until Monday": the next such day.
  if ((m = t.match(new RegExp(String.raw`\b(?:by|until|til+|after|know\s+(?:on|by))\s+(?:this\s+)?${WEEKDAY}\b`)))) {
    const wd = weekdayIndex(m[1]);
    const c = addDays(today, ((wd - today.dow + 7) % 7) || 7);
    return result(c, `on ${dayLabel(c)}`, m[0], weekdayMarker(c));
  }
  // "check back in 2 weeks", "give me a couple of weeks", "I'll know in a few days".
  if ((m = t.match(new RegExp(String.raw`\b(?:check\s+back|follow\s*-?\s*up|reach\s+out|touch\s+base|get\s+back|circle\s+back|text|call|contact|hit\s+me\s+up|try\s+(?:me\s+)?again|know|decide|talk)\b[^.?!]{0,40}?\bin\s+${COUNT}\s+(days?|weeks?|months?)\b`)))
    || (m = t.match(new RegExp(String.raw`\bgive\s+(?:me|us)\s+${COUNT}\s+(days?|weeks?|months?)\b`)))) {
    const n = countOf(m[1]);
    if (!n) return null;
    const unit = m[2].replace(/s$/, '');
    const c = unit === 'month' ? ymd(today.y, today.m + n, today.d) : addDays(today, unit === 'week' ? 7 * n : n);
    const word = n === 1 ? `a ${unit}` : `${n} ${unit}s`;
    return result(c, `in ${word}`, m[0], String.raw`\b(?:${n}|${Object.keys(COUNT_WORDS).find(k => COUNT_WORDS[k] === n && k.length > 2) || n}|a|couple|few)\s+${unit}s?\b`);
  }
  // "next week" / "next month".
  if ((m = t.match(/\bnext\s+(week|month)\b/))) {
    const c = m[1] === 'week' ? addDays(today, ((8 - today.dow) % 7) || 7) : ymd(today.y, today.m + 1, 1);
    return result(c, `next ${m[1]}`, m[0], String.raw`\bnext\s+${m[1]}\b`);
  }
  return null;
}

/**
 * The newest dated deferral in the lead's EARLIER messages that is not due yet,
 * or null. `inbound` is oldest first: strings, or { text, atMs } so a relative
 * date ("by Friday") is read against the day it was sent. Pure.
 */
export function pendingDeferral(inbound = [], nowMs = Date.now(), tz = DEFAULT_TZ) {
  for (let i = inbound.length - 1; i >= 0; i--) {
    const item = inbound[i];
    const text = typeof item === 'string' ? item : item?.text;
    const at = typeof item === 'object' && Number.isFinite(item?.atMs) ? item.atMs : nowMs;
    const d = detectDeferral(text, at, tz);
    if (d && Date.parse(d.untilIso) > nowMs) return d;
  }
  return null;
}

// A thank-you and nothing of substance: "Thank you I will.", "Thanks John!",
// "Appreciate it", "ok sounds good".
const ACK_PHRASES = [
  /\bthank\s*(?:you|u)\b/g, /\bthanks\b/g, /\bthx\b/g, /\bty\b/g, /\b(?:i\s+)?appreciate\s+(?:it|you|that|the\s+info)\b/g,
  /\bi\s+will\b/g, /\bwill\s+do\b/g, /\bsounds\s+(?:good|great)\b/g, /\bok(?:ay)?\b/g, /\bk\b/g, /\bgot\s+it\b/g,
  /\b(?:great|perfect|cool|awesome|wonderful)\b/g, /\byou\s+too\b/g, /\bsame\s+to\s+you\b/g, /\bhave\s+a\s+(?:good|great|nice)\s+(?:one|day|night|evening|weekend)\b/g,
];
const ACK_FILLER = new Set(['so', 'much', 'very', 'a', 'lot', 'again', 'and', 'you', 'sir', 'maam', 'for', 'everything', 'all', 'the', 'help', 'too', 'yes', 'yeah', 'oh']);

/** A thank-you with nothing else of substance. Pure. */
export function isAcknowledgment(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.includes('?')) return false;
  let t = raw.toLowerCase().replace(/[’']/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ');
  let hit = false;
  for (const rx of ACK_PHRASES) t = t.replace(rx, () => { hit = true; return ' '; });
  if (!hit) return false;
  const rest = t.split(/\s+/).filter(Boolean).filter(w => !ACK_FILLER.has(w));
  if (!rest.length) return true;
  // One name left over ("Thanks John") is still a thank-you.
  if (rest.length !== 1) return false;
  const word = raw.split(/[^\p{L}]+/u).find(w => w.toLowerCase() === rest[0]);
  return !!word && /^\p{Lu}/u.test(word);
}

// The lead asked for room: more time, time to think, or a hard stretch at
// home (Jose Perez, 2026-10-14: "Had a traumatic event with my small dog …
// I would need more time to think about this thank you", then "Appreciate it,
// thank you again" got "What would you need to see to feel good moving
// forward?"). No date in it, so detectDeferral misses it; it still means stop
// asking for now. A bare "need to think about it" is NOT this: the rehash
// track asks it back (rehashObjection 'think'). A question in the message ("can I have more time?") is not
// this: it gets an answer.
const SPACE_RX = new RegExp([
  String.raw`\b(?:need|needs|want|wants|take|taking|give\s+(?:me|us))\s+(?:a\s+(?:bit|little)\s+)?(?:more|some|extra)(?:\s+more)?\s+time\b`,
  String.raw`\bmore\s+time\s+to\s+(?:think|decide|consider|talk|discuss|process|look)\b`,
  String.raw`\b(?:not|isn'?t|isnt)\s+(?:a\s+)?(?:good|right|the\s+right)\s+time\b`,
  String.raw`\b(?:a\s+)?(?:tough|rough|hard|difficult|crazy)\s+(?:few\s+)?(?:days?|weeks?|time|stretch|couple\s+(?:of\s+)?(?:days|weeks))\b`,
  String.raw`\b(?:traumatic|trauma|passed\s+away|funeral|hospital(?:i[sz]ed)?|surgery|family\s+emergency|lost\s+my|in\s+the\s+er\b|bad\s+news|going\s+through\s+(?:a\s+lot|something))\b`,
].join('|'), 'i');

/** The lead asked for space with no date and no question. Pure. */
export function askedForSpace(text) {
  const t = String(text || '').replace(/[’]/g, "'").trim();
  return !!t && !t.includes('?') && SPACE_RX.test(t);
}

// A sentence that closes the conversation; nothing should come after it.
const SIGN_OFF_RX = /\benjoy\s+(?:your|the)\s+(?:week|weekend|day|evening|night|holidays?|time)\b|\bwe(?:'|’)?re\s+here\b|\bwe\s+are\s+here\b|\bi(?:'|’)?m\s+here\s+(?:if|when|whenever)\b|\bcongrat(?:ulation)?s\b|\btake\s+care\b|\b(?:i|we)(?:'|’)?ll\s+check\s+back\b|\b(?:i|we)\s+will\s+check\s+back\b|\btalk\s+soon\b|\bgood\s+luck\s+with\b|\bhave\s+a\s+(?:great|good|nice|wonderful|blessed)\s+(?:day|week|weekend|evening|night|one)\b|\breach\s+out\s+(?:whenever|anytime|any\s+time)\b|^\s*enjoy(?:\s+it)?[.!]*\s*$/i;

/**
 * True for "Enjoy your week.", "Take care.", "I'll check back in November."
 * A bare "Enjoy." counts too (Erica Hilts, 2026-10-13: the layer3 "Enjoy!"
 * after stripExclamations, with the visit times glued on after it). Pure.
 */
export function isSignOffLine(sentence) {
  const s = String(sentence || '').trim();
  return !!s && !s.endsWith('?') && SIGN_OFF_RX.test(s);
}
