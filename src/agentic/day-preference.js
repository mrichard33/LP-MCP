/**
 * day-preference — src/agentic/day-preference.js
 *
 * 2026-10-02 (Mark, Oct 2 6:12 PM chat): asked "what day works best?", the
 * lead said "Usually on Wednesdays" and got "We have Wednesdays blocked for
 * you", with no real time and nothing held. A day or a part of the day is a
 * FILTER, not a pick: the reply is two real open times that match it, the
 * next matching day first ("Wednesdays work. I have Wed, Oct 7 at 10:00 AM ET
 * or Wed, Oct 7 at 2:00 PM ET. Which is better for you?"). With nothing
 * matching in the next 14 days, it says so and offers the two nearest.
 *
 * Every line keeps "I have … or …" so SLOT_OFFER_RX, offeredSlots and
 * pickSlot read the offer back on the next turn. Pure and dependency-free.
 */

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_RX = /\b(sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday|sday)?(s)?\b/gi;
const ABBR = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, weds: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const CLOCK_RX = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i;
const AFTER_RX = /\b(?:after|past|later\s+than)\s+(\d{1,2})(?::\d{2})?\s*(a\.?m\.?|p\.?m\.?)?/i;
const BEFORE_RX = /\b(?:before|by|earlier\s+than)\s+(\d{1,2})(?::\d{2})?\s*(a\.?m\.?|p\.?m\.?)?|\bbefore\s+noon\b/i;
// 2026-10-15 (Guest Visitor pkjiz): "spouse and were available Saturday 11am - 2pm"
// read as an exact 11 AM pick (CLOCK_RX) and returned null, so the window was
// lost and the bot offered 10 AM on two Saturdays a week apart. A RANGE is a
// window: start inclusive, end exclusive (like `before`). Needs a meridian on
// either end, or a "between"/"from" lead-in, so "10-24" (a date) is not one.
const RANGE_RX = /\b(?:(between|from)\s+)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:-|–|—|to|and|till|til|until|thru|through)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|noon)?/i;

/** A clock range ("11am - 2pm", "between 11 and 2") as wall-clock hours, or null. Pure. */
export function parseTimeRange(text) {
  const m = String(text || '').match(RANGE_RX);
  if (!m) return null;
  const [, lead, h1s, m1s, mer1, h2s, m2s, mer2] = m;
  if (!lead && !mer1 && !mer2) return null;
  const merOf = (x) => (x ? String(x).toLowerCase().replace(/\./g, '') : '');
  let a = Number(h1s); let b = Number(h2s);
  if (a > 12 || b > 12 || a < 1 || b < 1) return null;
  const ma = merOf(mer1); let mb = merOf(mer2);
  if (mb === 'noon') { b = 12; mb = 'pm'; }
  const to24 = (h, mer) => (mer === 'pm' ? (h % 12) + 12 : mer === 'am' ? h % 12 : null);
  let end = to24(b, mb);
  if (end == null) end = b <= 7 || b === 12 ? (b % 12) + 12 : b; // "until 2" is 2 PM; "until 11" is 11 AM
  let start = to24(a, ma);
  if (start == null) {
    // "11 - 2pm": 11 is AM (later than 2 on the clock); "1 - 4pm": 1 is PM.
    start = a % 12 + ((a % 12) + 12 <= end ? 12 : 0);
    if (start > end) start -= 12;
  }
  const after = start + (Number(m1s || 0) / 60);
  const before = end + (Number(m2s || 0) / 60);
  return before > after ? { after, before } : null;
}

/** "11", "2:30", "noon" for a label. */
function clockLabel(h) {
  const whole = Math.floor(h); const min = Math.round((h - whole) * 60);
  if (whole === 12 && !min) return 'noon';
  const h12 = whole % 12 === 0 ? 12 : whole % 12;
  return min ? `${h12}:${String(min).padStart(2, '0')}` : String(h12);
}

const plural = (d) => `${DAYS[d][0].toUpperCase()}${DAYS[d].slice(1)}s`;

/**
 * What the lead prefers, or null when the text names no day or part of the
 * day, or names an exact clock time (that is a pick, handled elsewhere). Pure.
 * @returns {{days: number[]|null, part: 'morning'|'afternoon'|'evening'|null, after: number|null, before: number|null, label: string}|null}
 */
export function parseDayPreference(text) {
  const s = String(text || '').toLowerCase();
  if (!s.trim()) return null;
  const range = parseTimeRange(s);
  const after = range ? null : s.match(AFTER_RX);
  const before = range ? null : s.match(BEFORE_RX);
  // An exact time not framed as after/before (or a range) is a pick ("Wed at 2 PM").
  const clock = s.match(CLOCK_RX);
  if (clock && !after && !before && !range) return null;
  const days = new Set();
  let pluralDays = false;
  for (const m of s.matchAll(DAY_RX)) {
    const k = m[1].toLowerCase();
    if (k in ABBR) { days.add(ABBR[k]); if (m[2]) pluralDays = true; }
  }
  if (/\bweekends?\b/.test(s)) { days.add(0); days.add(6); }
  if (/\bweekdays?\b/.test(s)) [1, 2, 3, 4, 5].forEach(d => days.add(d));
  const part = /\bmornings?\b/.test(s) ? 'morning' : /\bafternoons?\b/.test(s) ? 'afternoon' : /\b(?:evenings?|nights?|after\s+work)\b/.test(s) ? 'evening' : null;
  const hour = (m) => {
    if (!m) return null;
    if (/noon/.test(m[0])) return 12;
    let h = Number(m[1]);
    const mer = String(m[2] || '').replace(/\./g, '');
    if (mer === 'pm' && h < 12) h += 12;
    else if (!mer && h >= 1 && h <= 7) h += 12; // "after 5" means 5 PM
    return h;
  };
  const afterH = range ? range.after : hour(after);
  const beforeH = range ? range.before : hour(before);
  if (!days.size && !part && afterH == null && beforeH == null) return null;

  // The words the reply echoes: "Wednesdays work.", "Weekend mornings work."
  let label;
  const dayList = [...days].sort();
  if (/\bweekends?\b/.test(s) && dayList.length === 2) label = 'Weekends';
  else if (/\bweekdays?\b/.test(s) && dayList.length === 5) label = 'Weekdays';
  else if (dayList.length === 1) label = pluralDays || /\b(?:usually|any|most|on)\b/.test(s) ? plural(dayList[0]) : `${plural(dayList[0]).slice(0, -1)}`;
  else if (dayList.length) label = dayList.map(plural).join(' or ');
  const partWord = part ? `${part}s` : null;
  if (label && partWord) label = `${label} ${partWord}`;
  else if (!label && partWord) label = partWord[0].toUpperCase() + partWord.slice(1);
  if (range) label = `${label ? `${label} ` : ''}between ${clockLabel(afterH)} and ${clockLabel(beforeH)}`;
  else if (afterH != null) label = `${label ? `${label} ` : ''}after ${afterH > 12 ? afterH - 12 : afterH}`;
  else if (beforeH != null) label = `${label ? `${label} ` : ''}before ${beforeH === 12 ? 'noon' : beforeH > 12 ? beforeH - 12 : beforeH}`;
  label = label.charAt(0).toUpperCase() + label.slice(1);
  return { days: dayList.length ? dayList : null, part, after: afterH, before: beforeH, range: !!range, label };
}

// Wall-clock hour and weekday from the slot's own ISO offset ("…T14:00:00-04:00").
function wallHour(slot) {
  const m = String(slot?.iso || '').match(/T(\d{2}):(\d{2})/);
  return m ? Number(m[1]) + Number(m[2]) / 60 : null;
}
function weekday(slot) {
  const named = DAYS.indexOf(String(slot?.dayOfWeek || '').toLowerCase());
  if (named >= 0) return named;
  const m = String(slot?.iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay() : null;
}
const civilDate = (slot) => String(slot?.iso || '').slice(0, 10);

/** Does this real opening fit the preference? Pure. */
export function slotMatches(slot, pref) {
  if (!pref) return false;
  const h = wallHour(slot);
  if (pref.days && !pref.days.includes(weekday(slot))) return false;
  if (h == null) return !pref.part && pref.after == null && pref.before == null;
  if (pref.part === 'morning' && h >= 12) return false;
  if (pref.part === 'afternoon' && (h < 12 || h >= 17)) return false;
  if (pref.part === 'evening' && h < 17) return false;
  if (pref.after != null && h < pref.after) return false;
  if (pref.before != null && h >= pref.before) return false;
  return true;
}

/**
 * Two real openings for the preference: the next matching day first, its
 * second time when it has one (the time furthest from the first), else the
 * next matching day. None in `days` → the two nearest openings, matched=false.
 * `slots` must already respect the notice floor. Pure.
 */
export function slotsForPreference(slots, pref, { nowMs = Date.now(), days = 14 } = {}) {
  const list = (Array.isArray(slots) ? slots : [])
    .filter(s => Number.isFinite(Date.parse(s.iso)) && Date.parse(s.iso) >= nowMs)
    .sort((a, b) => Date.parse(a.iso) - Date.parse(b.iso));
  const horizon = nowMs + days * 86_400_000;
  const hits = list.filter(s => Date.parse(s.iso) <= horizon && slotMatches(s, pref));
  const two = (pool) => {
    if (!pool.length) return [];
    const first = pool[0];
    const same = pool.filter(s => s !== first && civilDate(s) === civilDate(first));
    if (same.length) {
      const gap = (s) => Math.abs((wallHour(s) ?? 0) - (wallHour(first) ?? 0));
      return [first, same.reduce((a, b) => (gap(b) > gap(a) ? b : a), same[0])];
    }
    const next = pool.find(s => civilDate(s) !== civilDate(first));
    return next ? [first, next] : [first];
  };
  if (hits.length >= 2) return { matched: true, slots: two(hits) };
  // One match: it, and the opening closest to it.
  if (hits.length === 1) {
    const at = Date.parse(hits[0].iso);
    const near = list.filter(s => s !== hits[0]).sort((a, b) => Math.abs(Date.parse(a.iso) - at) - Math.abs(Date.parse(b.iso) - at))[0];
    if (near) return { matched: true, slots: [hits[0], near].sort((a, b) => Date.parse(a.iso) - Date.parse(b.iso)) };
  }
  // 2026-10-15 (Guest Visitor pkjiz, Mark): nothing inside their window must not
  // mean "the two soonest openings anywhere". Offer the openings CLOSEST to what
  // they asked for, on the day(s) they named: "Saturday 11 to 2" with visits at
  // 10, 2 and 6 → "I have Sat at 2:00 PM or Sat at 10:00 AM".
  const near = nearestToPreference(list.filter(s => Date.parse(s.iso) <= horizon), pref);
  if (near.length >= 2) return { matched: false, nearest: true, slots: near };
  return { matched: false, slots: two(list) };
}

/** Hours outside the preferred window (0 = inside). Pure. */
function windowDistance(slot, pref) {
  const h = wallHour(slot);
  if (h == null) return Infinity;
  let lo = pref.after; let hi = pref.before;
  if (pref.part === 'morning') { lo = lo ?? 0; hi = hi ?? 12; }
  if (pref.part === 'afternoon') { lo = lo ?? 12; hi = hi ?? 17; }
  if (pref.part === 'evening') { lo = lo ?? 17; hi = hi ?? 24; }
  if (lo != null && h < lo) return lo - h;
  if (hi != null && h >= hi) return h - hi;
  return 0;
}

/**
 * Two openings nearest the preference, on its days when it names any, on the
 * soonest such date that has two; else the two nearest across those days.
 * Empty when the preference names no window and no day. Pure.
 */
export function nearestToPreference(slots, pref) {
  if (!pref) return [];
  const hasWindow = pref.part || pref.after != null || pref.before != null;
  if (!hasWindow && !pref.days) return [];
  const pool = (Array.isArray(slots) ? slots : []).filter(s => !pref.days || pref.days.includes(weekday(s)));
  if (pool.length < 2) return [];
  const byDate = new Map();
  for (const s of pool) {
    const k = civilDate(s);
    if (!byDate.has(k)) byDate.set(k, []);
    byDate.get(k).push(s);
  }
  const rank = (a, b) => windowDistance(a, pref) - windowDistance(b, pref) || Date.parse(a.iso) - Date.parse(b.iso);
  for (const k of [...byDate.keys()].sort()) {
    const day = byDate.get(k);
    if (day.length >= 2) return [...day].sort(rank).slice(0, 2);
  }
  return [...pool].sort(rank).slice(0, 2);
}

const pair = (slots, tz) => slots.slice(0, 2).map(s => `${s.day} at ${s.time}${(s.tz || tz) ? ` ${s.tz || tz}` : ''}`).join(' or ');

/** The reply for a preference, with the two real times. Null without two. Pure. */
export function preferenceOfferLine(pref, picked, tz = 'ET') {
  if (!pref || !picked?.slots || picked.slots.length < 2) return null;
  const verb = !/\b(?:after|before)\b/i.test(pref.label) && /s$/i.test(pref.label.split(' ').pop()) ? 'work' : 'works';
  if (picked.matched) return `${pref.label} ${verb}. I have ${pair(picked.slots, tz)}. Which is better for you?`;
  const what = /^(?:sun|mon|tue|wed|thu|fri|sat)/i.test(pref.label) ? pref.label : pref.label.charAt(0).toLowerCase() + pref.label.slice(1);
  // Mark, 2026-10-15: "Unfortunately, I do not have that time, but I have a 2:00 or I have a 10:00."
  if (picked.nearest) return `Unfortunately I don't have anything open ${/^between\b/i.test(what) ? what : `for ${what}`}, but I have ${pair(picked.slots, tz)}. Would either of those work?`;
  return `I don't have anything open for ${what} in the next two weeks. The nearest I have are ${pair(picked.slots, tz)}. Would either of those work?`;
}
