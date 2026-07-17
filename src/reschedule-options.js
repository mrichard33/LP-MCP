/**
 * Time-aware reschedule options — src/reschedule-options.js
 *
 * Pilot v2 addendum v1.5: "the bot phrases, the server computes." The SMS
 * bot NEVER does calendar math — this module computes the two nearest
 * valid reschedule options for a canvass confirmation dm-no flow, and the
 * messaging layer injects the phrases as {option_a} / {option_b}.
 *
 * Validity rules:
 *   - never the declined slot (same ET day + same category bucket)
 *   - within business hours: Mon–Fri 8:30 AM–8 PM, Sat 8:30 AM–6:30 PM,
 *     Sun 9 AM–3:30 PM (encoded — Sunday evening falls out naturally,
 *     Saturday 6 PM evening remains valid)
 *   - same-day only when the mapped slot is ≥ 2 hours from now
 *     (same-day is preferred — iteration order offers it first)
 *
 * Category → slot map: morning = 10:00, afternoon = 14:00, evening = 18:00.
 *
 * Phrasing (satisfies every row of the spec's test table): a slot on the
 * SAME ET day as the declined appointment (when that day isn't today) is
 * named by weekday ("Saturday afternoon" — natural when countering within
 * the declined day); otherwise today → "this X", tomorrow → "tomorrow X",
 * later → weekday name.
 *
 * All comparisons are ET wall-clock, DST-safe (Intl-derived parts + the
 * wall-clock→instant refine from canvassing-time.js).
 */

import { etOffsetMinutes, APPOINTMENT_TZ } from './appointment-dates.js';
import { etWallClockToInstant } from './canvassing-time.js';

// Minutes-from-midnight open/close per ET weekday (0 = Sunday).
export const BUSINESS_HOURS = {
  0: { open: 9 * 60, close: 15 * 60 + 30 },      // Sun 9:00 AM – 3:30 PM
  1: { open: 8 * 60 + 30, close: 20 * 60 },      // Mon 8:30 AM – 8:00 PM
  2: { open: 8 * 60 + 30, close: 20 * 60 },
  3: { open: 8 * 60 + 30, close: 20 * 60 },
  4: { open: 8 * 60 + 30, close: 20 * 60 },
  5: { open: 8 * 60 + 30, close: 20 * 60 },      // Fri
  6: { open: 8 * 60 + 30, close: 18 * 60 + 30 }, // Sat 8:30 AM – 6:30 PM
};

export const CATEGORY_SLOTS = {
  morning: { hour: 10, minute: 0 },
  afternoon: { hour: 14, minute: 0 },
  evening: { hour: 18, minute: 0 },
};

const CATEGORY_ORDER = ['morning', 'afternoon', 'evening'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SAME_DAY_MIN_NOTICE_MS = 2 * 3600000;

// ET calendar+clock parts for an instant.
function etDateTimeParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: APPOINTMENT_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24, // Intl can render midnight as '24'
    minute: Number(get('minute')),
  };
}

const dayKey = (p) => `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;

// Hour → category bucket for classifying the declined appointment.
function categoryOfHour(hour) {
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

// ISO string carrying the correct ET offset for a slot instant.
function toEtIso(instant) {
  const off = etOffsetMinutes(instant);
  const p = etDateTimeParts(instant);
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  const offStr = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}` +
    `T${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:00${offStr}`;
}

/**
 * Compute the two nearest valid reschedule options.
 *
 * @param {Date|string} currentApptEt — the declined appointment instant
 * @param {Date|string} [nowEt] — reference instant (default: now)
 * @returns {Array<{dayOffset:number, weekday:string, category:string, phrase:string, slotEtIso:string}>}
 *   Exactly the first two valid options in chronological order (same-day
 *   first when valid). Empty/short array only if nothing is valid within
 *   8 days — practically unreachable given the business-hours grid.
 */
export function computeRescheduleOptions(currentApptEt, nowEt = new Date()) {
  // Explicit null/undefined check — new Date(null) is the (valid) epoch.
  if (currentApptEt === null || currentApptEt === undefined) return [];
  const now = new Date(nowEt);
  const declined = new Date(currentApptEt);
  if (Number.isNaN(declined.getTime()) || Number.isNaN(now.getTime())) return [];

  const nowParts = etDateTimeParts(now);
  const declinedParts = etDateTimeParts(declined);
  const declinedDayKey = dayKey(declinedParts);
  const declinedCategory = categoryOfHour(declinedParts.hour);
  const todayKey = dayKey(nowParts);

  const options = [];

  for (let dayOffset = 0; dayOffset <= 7 && options.length < 2; dayOffset++) {
    // ET calendar date `dayOffset` days from today — pure calendar math on
    // a UTC anchor (immune to server-local tz and DST).
    const anchor = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + dayOffset));
    const candidate = {
      year: anchor.getUTCFullYear(),
      month: anchor.getUTCMonth() + 1,
      day: anchor.getUTCDate(),
    };
    const weekdayIndex = anchor.getUTCDay();
    const hours = BUSINESS_HOURS[weekdayIndex];
    const candidateKey = dayKey(candidate);

    for (const category of CATEGORY_ORDER) {
      if (options.length >= 2) break;

      const slot = CATEGORY_SLOTS[category];
      const slotMinutes = slot.hour * 60 + slot.minute;
      if (slotMinutes < hours.open || slotMinutes > hours.close) continue; // outside business hours (kills Sunday evening)
      if (candidateKey === declinedDayKey && category === declinedCategory) continue; // never re-offer the declined slot

      const slotInstant = etWallClockToInstant({ ...candidate, hour: slot.hour, minute: slot.minute });
      if (dayOffset === 0 && slotInstant.getTime() - now.getTime() < SAME_DAY_MIN_NOTICE_MS) continue;

      const weekday = WEEKDAY_NAMES[weekdayIndex];
      let phrase;
      if (candidateKey === declinedDayKey && candidateKey !== todayKey) {
        phrase = `${weekday} ${category}`;
      } else if (dayOffset === 0) {
        phrase = `this ${category}`;
      } else if (dayOffset === 1) {
        phrase = `tomorrow ${category}`;
      } else {
        phrase = `${weekday} ${category}`;
      }

      options.push({ dayOffset, weekday, category, phrase, slotEtIso: toEtIso(slotInstant) });
    }
  }

  return options;
}
