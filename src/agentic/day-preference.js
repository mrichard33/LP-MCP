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

const plural = (d) => `${DAYS[d][0].toUpperCase()}${DAYS[d].slice(1)}s`;

/**
 * What the lead prefers, or null when the text names no day or part of the
 * day, or names an exact clock time (that is a pick, handled elsewhere). Pure.
 * @returns {{days: number[]|null, part: 'morning'|'afternoon'|'evening'|null, after: number|null, before: number|null, label: string}|null}
 */
export function parseDayPreference(text) {
  const s = String(text || '').toLowerCase();
  if (!s.trim()) return null;
  const after = s.match(AFTER_RX);
  const before = s.match(BEFORE_RX);
  // An exact time not framed as after/before is a pick ("Wed at 2 PM").
  const clock = s.match(CLOCK_RX);
  if (clock && !after && !before) return null;
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
  const afterH = hour(after);
  const beforeH = hour(before);
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
  if (afterH != null) label = `${label ? `${label} ` : ''}after ${afterH > 12 ? afterH - 12 : afterH}`;
  else if (beforeH != null) label = `${label ? `${label} ` : ''}before ${beforeH === 12 ? 'noon' : beforeH > 12 ? beforeH - 12 : beforeH}`;
  label = label.charAt(0).toUpperCase() + label.slice(1);
  return { days: dayList.length ? dayList : null, part, after: afterH, before: beforeH, label };
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
  return { matched: false, slots: two(list) };
}

const pair = (slots, tz) => slots.slice(0, 2).map(s => `${s.day} at ${s.time}${(s.tz || tz) ? ` ${s.tz || tz}` : ''}`).join(' or ');

/** The reply for a preference, with the two real times. Null without two. Pure. */
export function preferenceOfferLine(pref, picked, tz = 'ET') {
  if (!pref || !picked?.slots || picked.slots.length < 2) return null;
  const verb = !/\b(?:after|before)\b/i.test(pref.label) && /s$/i.test(pref.label.split(' ').pop()) ? 'work' : 'works';
  if (picked.matched) return `${pref.label} ${verb}. I have ${pair(picked.slots, tz)}. Which is better for you?`;
  const what = /^(?:sun|mon|tue|wed|thu|fri|sat)/i.test(pref.label) ? pref.label : pref.label.charAt(0).toLowerCase() + pref.label.slice(1);
  return `I don't have anything open for ${what} in the next two weeks. The nearest I have are ${pair(picked.slots, tz)}. Would either of those work?`;
}
