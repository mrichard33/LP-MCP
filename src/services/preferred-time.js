/**
 * Preferred Appointment Time — src/services/preferred-time.js
 *
 * The lead's OWN stated day/time, captured deterministically from inbound
 * turns and from any outbound turn in which the bot ACCEPTED a time.
 * Exists because the 2026-07-24 Engelke incident had the bot say "Monday at
 * 3 PM works great" and then, one turn later, offer Aug 2 / Aug 5 with no
 * acknowledgment — nothing in the system remembered the commitment.
 *
 * Also the sole unlock for offering outside the 48-hour window (see
 * calendar-availability.js selectOfferableSlots §3): only a lead who named a
 * specific day (day_and_time / day_only) may be offered a slot beyond 48h.
 *
 * No LLM. Pure heuristics + native Intl (the repo has no date library).
 * Weekday/date resolution is done on the tz-local CIVIL date anchored at
 * noon, so a ±1h DST shift never crosses a date boundary (DST-safe).
 */

import { updateGHLContactFields } from '../ghl.js';
import { getContactCached } from '../actions/contact-cache.js';

const TZ = process.env.REECE_TIMEZONE || 'America/New_York';

// The "Preferred Estimate Time" field already exists in GHL; default to it so
// this write works on ship. The two "Last Requested…" fields do not exist yet
// — they stay env-gated (inert) until Mark creates them and sets the IDs.
const PREFERRED_ESTIMATE_TIME_FIELD_ID =
  process.env.PREFERRED_ESTIMATE_TIME_FIELD_ID || '7lpRWFDM8DZbLd3viHEG';
const LAST_REQUESTED_DATE_FIELD_ID = process.env.LAST_REQUESTED_DATE_FIELD_ID || '';
const LAST_REQUESTED_TIME_WINDOW_FIELD_ID =
  process.env.LAST_REQUESTED_TIME_WINDOW_FIELD_ID || '';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY_ABBR = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, weds: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const MONTHS = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9,
  sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};

// Outbound acceptance markers — an outbound turn only counts as a captured
// commitment when one of these co-occurs with a day/time token.
const ACCEPTANCE_RE = /\b(works great|works for me|that works|works\b|perfect|got you down|locked in|lock it in|see you|sounds good|book(ed)? you|you're (all )?set)\b/i;

// Vague timeframe markers that must NEVER unlock the far-date path.
const VAGUE_RE = /\b(sometime|some time|whenever|any ?day|any ?time|no rush|flexible|next week|this week|next month|in a (few|couple)|soon|later)\b/i;

/**
 * @param {string} tz
 * @returns {{y:number,m:number,d:number,dow:number}} today's civil date + weekday index in tz
 */
function civilTodayInTz(tz, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const y = parseInt(get('year'), 10);
  const m = parseInt(get('month'), 10);
  const d = parseInt(get('day'), 10);
  const dowShort = String(get('weekday') || '').toLowerCase().slice(0, 3);
  const dow = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }[dowShort] ?? 0;
  return { y, m, d, dow };
}

/**
 * Return the YYYY-MM-DD civil date that is `addDays` after `base`, computed at
 * a UTC-noon anchor so DST can't roll it to the wrong day.
 */
function civilDatePlus(base, addDays) {
  const anchor = new Date(Date.UTC(base.y, base.m - 1, base.d + addDays, 12, 0, 0));
  const y = anchor.getUTCFullYear();
  const m = String(anchor.getUTCMonth() + 1).padStart(2, '0');
  const d = String(anchor.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Civil YYYY-MM-DD of an ISO instant, evaluated in tz. */
function civilDateOfIso(iso, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(iso));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Minutes-since-midnight of an ISO instant, evaluated in tz. */
function minutesOfIso(iso, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  let h = parseInt(get('hour'), 10);
  if (h === 24) h = 0; // some engines emit 24 for midnight
  return h * 60 + parseInt(get('minute'), 10);
}

function daysBetweenIsoDates(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  const msA = Date.UTC(ay, am - 1, ad);
  const msB = Date.UTC(by, bm - 1, bd);
  return Math.round((msB - msA) / 86400000);
}

/** Parse a clock time to {hh24, label}. Returns null if none found. */
function parseClock(text) {
  // 3:00 pm | 3 pm | 3pm | 10am | at 2
  let m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i);
  if (m) {
    let h = parseInt(m[1], 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    const mer = m[3].toLowerCase().replace(/\./g, '');
    if (mer === 'pm' && h < 12) h += 12;
    if (mer === 'am' && h === 12) h = 0;
    if (h > 23 || min > 59) return null;
    return { hh24: h * 60 + min, label: fmtClock(h, min) };
  }
  // bare "at 2" / "at 10:30" — no meridiem. Business-hours heuristic:
  // 1–6 → PM, 7–11 & 12 → as-is (AM/noon).
  m = text.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\b/i);
  if (m) {
    let h = parseInt(m[1], 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    if (h > 23 || min > 59) return null;
    if (h >= 1 && h <= 6) h += 12;
    return { hh24: h * 60 + min, label: fmtClock(h, min) };
  }
  return null;
}

function fmtClock(h24, min) {
  const mer = h24 >= 12 ? 'PM' : 'AM';
  let h = h24 % 12;
  if (h === 0) h = 12;
  return `${h}:${String(min).padStart(2, '0')} ${mer}`;
}

/**
 * Parse one message's text into date/time components (no source/turn info).
 * Returns null when nothing actionable is found.
 */
function parseTimeExpr(text, todayCivil) {
  if (!text || typeof text !== 'string') return null;
  const lower = text.toLowerCase();

  let date_iso = null;
  let weekday = null;
  let dayLabel = null;

  // 1. Explicit month + day: "august 2nd", "aug 2"
  const monthDay = lower.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i);
  if (monthDay) {
    const mo = MONTHS[monthDay[1].toLowerCase()];
    const dd = parseInt(monthDay[2], 10);
    if (mo && dd >= 1 && dd <= 31) {
      // this year, or next year if the date already passed
      let yr = todayCivil.y;
      const candidate = `${yr}-${String(mo).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
      const todayIso = `${todayCivil.y}-${String(todayCivil.m).padStart(2, '0')}-${String(todayCivil.d).padStart(2, '0')}`;
      if (daysBetweenIsoDates(todayIso, candidate) < 0) yr += 1;
      date_iso = `${yr}-${String(mo).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
      dayLabel = `${cap(monthDay[1])} ${dd}`;
      weekday = weekdayOfIso(date_iso);
    }
  }

  // 2. Weekday: "monday", "next tues", "mon"
  if (!date_iso) {
    const wd = lower.match(/\b(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|weds?|thur?s?|fri|sat)\b/i);
    if (wd) {
      const isNext = !!wd[1];
      const token = wd[2].toLowerCase();
      const target = WEEKDAYS.indexOf(token) >= 0 ? WEEKDAYS.indexOf(token) : WEEKDAY_ABBR[token];
      if (typeof target === 'number') {
        let ahead = (target - todayCivil.dow + 7) % 7;
        if (isNext && ahead < 7) ahead += 7; // "next monday" = following week
        date_iso = civilDatePlus(todayCivil, ahead);
        weekday = WEEKDAYS[target];
        dayLabel = cap(weekday);
      }
    }
  }

  // 3. Bare ordinal day-of-month: "the 27th" (no month named)
  if (!date_iso) {
    const ord = lower.match(/\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/i);
    if (ord) {
      const dd = parseInt(ord[1], 10);
      if (dd >= 1 && dd <= 31) {
        let mo = todayCivil.m;
        let yr = todayCivil.y;
        if (dd < todayCivil.d) { mo += 1; if (mo > 12) { mo = 1; yr += 1; } }
        date_iso = `${yr}-${String(mo).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
        dayLabel = `the ${ord[1]}${ordSuffix(dd)}`;
        weekday = weekdayOfIso(date_iso);
      }
    }
  }

  const clock = parseClock(lower);

  // Time-of-day words contribute a rough window but no hh24.
  const partOfDay = lower.match(/\b(morning|afternoon|evening|midday|noon)\b/i);

  if (!date_iso && !clock && !partOfDay) return null;

  let specificity;
  if (date_iso && clock) specificity = 'day_and_time';
  else if (date_iso) specificity = 'day_only';
  else if (clock || partOfDay) specificity = 'time_only';
  else specificity = 'vague';

  const timeLabel = clock ? clock.label : (partOfDay ? cap(partOfDay[1]) : null);
  const rawParts = [];
  if (dayLabel) rawParts.push(dayLabel);
  if (timeLabel) rawParts.push(timeLabel);
  const raw = rawParts.join(' at ') || text.trim().slice(0, 60);

  return {
    raw,
    weekday,
    date_iso,
    time_24h: clock ? hh24Label(clock.hh24) : null,
    time_window: timeLabel,
    specificity,
  };
}

function hh24Label(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function ordSuffix(n) {
  const s = ['th', 'st', 'nd', 'rd']; const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}
function weekdayOfIso(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay()];
}

/**
 * Extract the lead's stated preferred time from a conversation corpus.
 *
 * Scans newest-first and returns the most recent time-bearing turn:
 *   • an inbound turn that parses a day/time            → source 'inbound'
 *   • an outbound turn with an ACCEPTANCE marker + a
 *     day/time token                                    → source 'bot_accepted'
 * Outbound turns without an acceptance marker are skipped entirely (the bot
 * merely offering alternatives is not a captured preference).
 *
 * Returns null when nothing actionable is found, or when the only signal is a
 * vague timeframe ("sometime next week") — vague never unlocks the far path
 * and is treated by callers as no preference.
 *
 * @param {Array<{direction?:string, text?:string, body?:string}>} messages
 * @param {Object} [opts]
 * @param {Date|number} [opts.now] — reference "now" for weekday/date resolution
 *   (injected in tests; defaults to the real current time).
 * @returns {{raw,weekday,date_iso,time_24h,time_window,specificity,source,turn_index}|null}
 */
export function extractPreferredTime(messages, opts = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const nowDate = opts.now != null ? new Date(opts.now) : new Date();
  const today = civilTodayInTz(TZ, nowDate);

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] || {};
    const dir = String(msg.direction || '').toLowerCase();
    const text = msg.text ?? msg.body ?? msg.message ?? '';
    if (!text) continue;

    const isOutbound = dir === 'outbound' || dir === 'out';
    if (isOutbound && !ACCEPTANCE_RE.test(text)) continue; // only accepted outbounds count

    const parsed = parseTimeExpr(text, today);
    if (!parsed) continue;

    // A bare vague phrase with no concrete day/time is not a preference.
    if (!parsed.date_iso && !parsed.time_24h && !parsed.time_window) continue;
    if (parsed.specificity === 'vague') continue;
    // "next week"/"sometime" with no concrete weekday must not unlock far path.
    if (!parsed.date_iso && VAGUE_RE.test(text) && !parsed.time_24h) continue;

    return {
      ...parsed,
      source: isOutbound ? 'bot_accepted' : 'inbound',
      turn_index: i,
    };
  }
  return null;
}

/**
 * Match a preferred time against fetched availability.
 * @returns {{exact, same_day, nearest, gap_days}} — exact/same_day/nearest are
 *   slot objects or null; gap_days is whole days from the preferred date to the
 *   nearest slot (null when no preferred date or no slots).
 */
export function matchPreferredToSlots(preferred, availability) {
  const empty = { exact: null, same_day: null, nearest: null, gap_days: null };
  if (!preferred || !availability || !Array.isArray(availability.slots) || availability.slots.length === 0) {
    return empty;
  }
  const tz = availability.timezone || TZ;
  const slots = availability.slots;

  let same_day = null;
  let exact = null;
  if (preferred.date_iso) {
    for (const s of slots) {
      if (civilDateOfIso(s.iso, tz) !== preferred.date_iso) continue;
      if (!same_day) same_day = s;
      if (preferred.time_24h) {
        const [ph, pm] = preferred.time_24h.split(':').map(Number);
        const prefMin = ph * 60 + pm;
        if (Math.abs(minutesOfIso(s.iso, tz) - prefMin) <= 60) { exact = s; break; }
      }
    }
  }

  // nearest = chronologically closest slot to the preferred instant (or the
  // earliest slot when we only have a day / nothing precise).
  let nearest = slots[0];
  if (preferred.date_iso) {
    const [py, pmo, pd] = preferred.date_iso.split('-').map(Number);
    const [ph, pm] = (preferred.time_24h ? preferred.time_24h.split(':').map(Number) : [12, 0]);
    const target = Date.UTC(py, pmo - 1, pd, ph, pm);
    let best = Infinity;
    for (const s of slots) {
      const diff = Math.abs(new Date(s.iso).getTime() - target);
      if (diff < best) { best = diff; nearest = s; }
    }
  }

  const gap_days = preferred.date_iso && nearest
    ? Math.abs(daysBetweenIsoDates(preferred.date_iso, civilDateOfIso(nearest.iso, tz)))
    : null;

  return { exact, same_day, nearest, gap_days };
}

/**
 * Build the preferred-time prompt block (§4). Returns null when there is
 * nothing to add (no preferred, or the preferred time is available and the bot
 * never accepted a now-unavailable time).
 */
export function formatPreferredTimeForPrompt(preferred, match) {
  if (!preferred) return null;
  const available = !!(match && (match.exact || match.same_day));
  const lines = [];

  if (!available && preferred.specificity !== 'time_only') {
    const gap = match && typeof match.gap_days === 'number' ? match.gap_days : null;
    if (gap !== null && gap > 2) {
      lines.push(
        `LEAD'S STATED PREFERENCE: ${preferred.raw} — NOT AVAILABLE, nearest is ${gap} days ` +
        `later. Acknowledge their day is not open and state the gap plainly.`,
      );
    } else {
      lines.push(
        `LEAD'S STATED PREFERENCE: ${preferred.raw} — NOT AVAILABLE.`,
        `You MUST acknowledge this before offering anything else. Name their requested`,
        `day, say it is not open, then offer the alternatives. Never present`,
        `alternatives as if they had not asked for something specific.`,
      );
    }
  }

  // bot_accepted walk-back — appended LAST so it is the most recent instruction
  // the model reads. Only when the accepted time is no longer available.
  if (preferred.source === 'bot_accepted' && !available) {
    lines.push(
      `CRITICAL: You already told this lead that ${preferred.raw} works. If you are now offering`,
      `anything else, you are walking back a commitment. Apologize briefly and`,
      `plainly for the mix-up, in one short clause, then offer the alternatives.`,
      `Never silently substitute a different time.`,
    );
  }

  return lines.length ? lines.join('\n') : null;
}

/**
 * Persist the lead's stated preferred time to GHL — fill-if-empty, fail-soft.
 * Never uses the standard-fields path (custom fields only). The payload sent to
 * updateGHLContactFields contains only { customFields }, so tags are never
 * touched (GHL PUT would wholesale-replace them otherwise).
 *
 * @param {string} contactId
 * @param {object} preferred — result of extractPreferredTime
 * @param {object} [opts]
 * @param {object} [opts.contact] — pre-fetched GHL contact (with customFields)
 *   to avoid an extra read; when absent, the contact is fetched (cached).
 * @returns {Promise<number>} count of fields written
 */
export async function persistPreferredTime(contactId, preferred, opts = {}) {
  if (!contactId || !preferred) return 0;
  let contact = opts.contact;
  if (!contact) {
    try {
      contact = await getContactCached(contactId);
    } catch {
      contact = null; // fall through — treat all fields as empty (best-effort)
    }
  }

  const already = (fieldId) => {
    if (!contact) return null;
    const cfs = Array.isArray(contact.customFields) ? contact.customFields : [];
    const f = cfs.find((x) => x?.id === fieldId);
    const v = f?.value ?? f?.field_value ?? null;
    return v == null || String(v).trim() === '' ? null : String(v).trim();
  };

  const fields = [];
  const pushIfEmpty = (fieldId, value) => {
    if (!fieldId || value == null || String(value).trim() === '') return;
    if (already(fieldId)) return; // fill-if-empty: never clobber a prior value
    fields.push({ id: fieldId, field_value: String(value) });
  };

  pushIfEmpty(PREFERRED_ESTIMATE_TIME_FIELD_ID, preferred.raw);
  pushIfEmpty(LAST_REQUESTED_DATE_FIELD_ID, preferred.date_iso);
  pushIfEmpty(LAST_REQUESTED_TIME_WINDOW_FIELD_ID, preferred.time_window || preferred.time_24h);

  if (fields.length === 0) return 0;

  try {
    const result = await updateGHLContactFields(contactId, fields);
    if (result === 'not_found' || !result) {
      console.warn(`[PreferredTime] field write returned ${result} for ${contactId}`);
      return 0;
    }
    console.log(`[PreferredTime] persisted for ${contactId} (${preferred.source}): "${preferred.raw}" (${fields.length} field${fields.length === 1 ? '' : 's'})`);
    return fields.length;
  } catch (err) {
    console.warn(`[PreferredTime] persist threw for ${contactId}: ${err.message}`);
    return 0;
  }
}
