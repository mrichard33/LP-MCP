/**
 * The call time a rehash lead names — src/agentic/rehash-time.js
 *
 * WHY (2026-10-21, rehash booking handoff). Two live threads of 2026-10-20:
 *  - kS2AJk85fv7Lfyl3iZcm: we offered "Tomorrow at 9:30 AM ET or 10:30 AM ET",
 *    the lead answered "9:30", and nothing read it (pickSlot / mentionedMinutes
 *    read a bare time only after "at" or a weekday; typedClock needs am/pm). The
 *    turn fell to a plain post-demo reply, nothing was booked, and the model said
 *    "I'll call you at 9:30" anyway.
 *  - YgAD0NmDXBbyHDF82Ban: "I can do 930am" (no colon) read as nothing either,
 *    and "Thursday at 2pm" missed because exactSlotFor ignores the day and wants
 *    one hit across 14 days. Each miss offered a fresh pair; she opted out.
 *
 * This reads the time the way a person texts it ("9:30", "930", "930am", "9.30",
 * "at 2", "2pm", "Thursday at 2pm", "no 930am tomorrow? I can do Thursday at 6pm"
 * → the LAST time named, with its own day) and resolves it against the Rehash
 * Call calendar's real openings. Rehash only (planRehashCall with
 * REHASH_BOOKING_FIX_ENABLED); cancel-flow.js and the pre-demo bot are untouched.
 * Pure.
 */

import { mentionedMinutes } from '../live-chat/cancel-flow.js';

const DOW_FULL = { sun: 'sunday', mon: 'monday', tue: 'tuesday', wed: 'wednesday', thu: 'thursday', fri: 'friday', sat: 'saturday' };
const DAY_WORD_RX = /\b(?:(sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday|sday)?|(today|tonight|tomorrow|tmrw|tmr))\b/gi;
// "930am", "9:30 am", "2pm", "10.30 a.m."
const MERIDIEM_CLOCK_RX = /\b(\d{1,2})(?:[:.]?(\d{2}))?\s*([ap])\.?\s?m\b\.?/gi;
// "9:30", "9.30" with no am/pm (never "$9.30").
const SEPARATED_CLOCK_RX = /(^|[^$\d.])(\d{1,2})[:.](\d{2})(?![\d.]|\s*(?:[ap]\.?\s?m\b|%))/gi;
// "930" / "1030" with no am/pm: only the whole message, or after "at / do / around".
const COMPACT_CLOCK_RX = /(?:^\s*(?:(?:i\s+)?can\s+do|how\s+about|maybe|ok(?:ay)?,?|yes,?|sure,?)?\s*|\b(?:at|@|do|around|about|by)\s+)(\d{1,2})(\d{2})\b(?!\s*(?:[ap]\.?\s?m\b|windows?|doors?|sq|sf|dollars|k\b|%|\/))/gi;

const toMinutes = (h, m, mer, hint) => {
  const hour = Number(h);
  const min = Number(m || 0);
  if (!(hour >= 1 && hour <= 12) || !(min >= 0 && min <= 59)) return null;
  if (mer) return (hour % 12 + (mer === 'p' ? 12 : 0)) * 60 + min;
  if (hint === 'a') return (hour % 12) * 60 + min;
  if (hint === 'p') return (hour === 12 ? 12 : hour + 12) * 60 + min;
  // The way a call is booked: 8-11 morning, 12 noon, 1-7 afternoon/evening.
  const h24 = hour === 12 ? 12 : hour <= 7 ? hour + 12 : hour;
  return h24 * 60 + min;
};

const dayKey = (m) => (m[1] ? DOW_FULL[m[1].toLowerCase().slice(0, 3)] : ({ tonight: 'today', tmrw: 'tomorrow', tmr: 'tomorrow' })[m[2].toLowerCase()] || m[2].toLowerCase());

/**
 * The call time a message names: { minutes, day } (day: 'thursday', 'tomorrow',
 * 'today' or null), or null. The LAST time in the message wins ("no 930am
 * tomorrow? I can do Thursday at 6pm" → 6 PM Thursday), with the day word
 * nearest before it in its sentence, else right after it. Pure.
 */
export function readRehashTime(text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  const low = t.toLowerCase();
  const hint = /\b(?:morning|a\.?m)\b/.test(low) ? 'a' : /\b(?:afternoon|evening|tonight|p\.?m)\b/.test(low) ? 'p' : null;
  const clocks = [];
  for (const m of t.matchAll(MERIDIEM_CLOCK_RX)) {
    const minutes = toMinutes(m[1], m[2], m[3].toLowerCase(), null);
    if (minutes != null) clocks.push({ at: m.index, end: m.index + m[0].length, minutes });
  }
  for (const m of t.matchAll(SEPARATED_CLOCK_RX)) {
    const at = m.index + m[1].length;
    if (clocks.some(c => at >= c.at && at < c.end)) continue;
    const minutes = toMinutes(m[2], m[3], null, hint);
    if (minutes != null) clocks.push({ at, end: m.index + m[0].length, minutes });
  }
  for (const m of t.matchAll(COMPACT_CLOCK_RX)) {
    const digits = m[1] + m[2];
    const at = m.index + m[0].lastIndexOf(digits);
    if (clocks.some(c => at >= c.at && at < c.end)) continue;
    const minutes = toMinutes(m[1], m[2], null, hint);
    if (minutes != null) clocks.push({ at, end: at + digits.length, minutes });
  }
  if (!clocks.length) {
    // A bare hour the shared reader already knows ("at 2", "Thursday 2", "2 o'clock").
    const bare = [...mentionedMinutes(low)];
    if (!bare.length) return null;
    const days = [...t.matchAll(DAY_WORD_RX)];
    return { minutes: bare[bare.length - 1], day: days.length ? dayKey(days[days.length - 1]) : null };
  }
  clocks.sort((a, b) => a.at - b.at);
  const last = clocks[clocks.length - 1];
  // The sentence the time sits in ("9.30" is not a sentence end).
  const bounds = [];
  let from = 0;
  for (const m of t.matchAll(/[?!]+|\.(?=\s|$)/g)) { bounds.push([from, m.index]); from = m.index + m[0].length; }
  bounds.push([from, t.length]);
  const [start, end] = bounds.find(([a, b]) => last.at >= a && last.at < b) || [0, t.length];
  const days = [...t.slice(start, end).matchAll(DAY_WORD_RX)].map(m => ({ at: start + m.index, key: dayKey(m) }));
  const before = days.filter(d => d.at < last.at).pop();
  const after = days.find(d => d.at >= last.end);
  return { minutes: last.minutes, day: (before || after)?.key || null };
}

/** The day keys a slot answers to ('thursday', 'tomorrow', 'today'). Pure. */
export function slotDayKeys(slot) {
  const keys = new Set();
  const dow = String(slot?.dayOfWeek || slot?.day || '').toLowerCase().slice(0, 3);
  if (DOW_FULL[dow]) keys.add(DOW_FULL[dow]);
  const rel = String(slot?.rel || '').toLowerCase();
  if (rel) keys.add(rel);
  return keys;
}

const slotMinutes = (s) => {
  const m = String(s?.time || '').match(/^(\d{1,2})(?::(\d{2}))?\s*([AP])M/i);
  return m ? (Number(m[1]) % 12 + (/p/i.test(m[3]) ? 12 : 0)) * 60 + Number(m[2] || 0) : null;
};
const dateKey = (s) => String(s?.day || s?.iso || '');
const when = (s) => (s?.iso ? Date.parse(s.iso) : 0);

/**
 * The one offered slot a message picks by its time ("9:30", "930am", "Thursday
 * at 2pm"), or null: the time must match, and the day too when one is named. Pure.
 */
export function pickRehashTime(text, offered = []) {
  const t = readRehashTime(text);
  if (!t) return null;
  const hits = (Array.isArray(offered) ? offered : []).filter(s => slotMinutes(s) === t.minutes && (!t.day || slotDayKeys(s).has(t.day)));
  return hits.length === 1 ? hits[0] : null;
}

/**
 * A named time against every real opening:
 *  - exact: the opening at that time on the day they named (no day named: the
 *    day of our open offer, else the soonest day that has it) → book it;
 *  - near: otherwise the two openings closest to it on that same day, filled
 *    from the next days when that day has fewer than two.
 * Returns { time, exact, near } or null when the message names no time. Pure.
 */
export function rehashTimeSlots(text, all = [], { offered = [], nowMs = Date.now() } = {}) {
  const t = readRehashTime(text);
  if (!t) return null;
  const pool = (Array.isArray(all) ? all : []).filter(s => slotMinutes(s) != null && (!s.iso || Date.parse(s.iso) >= nowMs)).sort((a, b) => when(a) - when(b));
  if (!pool.length) return { time: t, exact: null, near: [] };
  const offeredDays = new Set((Array.isArray(offered) ? offered : []).map(dateKey));
  const onDay = (s) => (t.day ? slotDayKeys(s).has(t.day) : offeredDays.size ? offeredDays.has(dateKey(s)) : true);
  const sameTime = pool.filter(s => slotMinutes(s) === t.minutes);
  const exact = sameTime.find(onDay) || (!t.day && !offeredDays.size ? sameTime[0] : null) || null;
  if (exact) return { time: t, exact, near: [] };
  // The day they meant: its openings first, then the days after it.
  const first = pool.find(onDay);
  const from = first ? dateKey(first) : null;
  const groups = [];
  for (const s of pool) {
    const k = dateKey(s);
    let g = groups.find(x => x.key === k);
    if (!g) { g = { key: k, at: when(s), slots: [] }; groups.push(g); }
    g.slots.push(s);
  }
  const startIdx = from ? groups.findIndex(g => g.key === from) : 0;
  const near = [];
  for (const g of groups.slice(Math.max(0, startIdx))) {
    const sorted = [...g.slots].sort((a, b) => Math.abs(slotMinutes(a) - t.minutes) - Math.abs(slotMinutes(b) - t.minutes) || when(a) - when(b));
    for (const s of sorted) { if (near.length < 2) near.push(s); }
    if (near.length === 2) break;
  }
  return { time: t, exact: null, near: near.sort((a, b) => when(a) - when(b)) };
}

/** "9:30 AM" for the minutes a lead named. Pure. */
export function clockLabel(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`.replace(':00 ', ' ');
}
