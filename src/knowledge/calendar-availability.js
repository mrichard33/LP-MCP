/**
 * Calendar Availability — src/knowledge/calendar-availability.js
 *
 * v1.0 — 2026-04-29. Live GHL calendar free-slots lookup for the agentic
 *   responder (response-generator v2.7+).
 *
 *   Replaces the prior pattern of having the model invent plausible-
 *   sounding times — which produced past dates ("this Saturday April 26"
 *   when April 26 was 2 days ago, surfaced 2026-04-28 on contact
 *   15Z6TaUK4WHBK1R4H64S actions #28066/#28071) and slots that were
 *   not actually open. Now the bot picks from real available openings.
 *
 *   Called from response-generator.js BEFORE callClaude() when the kb
 *   pack has a booking_context with a calendar_id. Slots are formatted
 *   into the user prompt as ground truth; the model picks 1-2 that
 *   match the lead's stated preference and proposes them in the message.
 *
 *   GHL endpoint:
 *     GET https://services.leadconnectorhq.com/calendars/{calendarId}/free-slots
 *     query: startDate, endDate (epoch ms), timezone
 *     headers: Authorization: Bearer <key>, Version: 2021-04-15
 *     response: { _dates_: [...], "YYYY-MM-DD": { slots: [iso, ...] }, ... }
 *
 *   Failure mode: returns null. response-generator handles null by
 *   falling back to the "no availability data" prompt branch which
 *   acknowledges tight scheduling and sends the booking link instead
 *   of inventing a date.
 *
 *   Knobs (env vars):
 *     CAL_AVAIL_WINDOW_DAYS  (default 14)
 *     CAL_AVAIL_MAX_SLOTS    (default 12)
 *     REECE_TIMEZONE         (default America/New_York)
 */

import { acquireToken, report429 } from '../ghl-rate-limiter.js';

const GHL_API_KEY = process.env.GHL_API_KEY || '';
const GHL_API_VERSION = '2021-04-15';
const DEFAULT_TIMEZONE = process.env.REECE_TIMEZONE || 'America/New_York';
const DEFAULT_WINDOW_DAYS = parseInt(process.env.CAL_AVAIL_WINDOW_DAYS || '14', 10);
const MAX_SLOTS_RETURNED = parseInt(process.env.CAL_AVAIL_MAX_SLOTS || '12', 10);
const FETCH_TIMEOUT_MS = 10_000;

// ─── Offer-window selection knobs (v1.1 — 2026-07-24 Engelke incident) ───
// The FETCH stays wide (CAL_AVAIL_WINDOW_DAYS, so a lead-requested far date can
// still be matched); the OFFER is narrowed to the next 48 hours unless the lead
// named a specific day. See selectOfferableSlots below.
const OFFER_WINDOW_HOURS = parseInt(process.env.BOOKING_OFFER_WINDOW_HOURS || '48', 10);
const MIN_NOTICE_HOURS = parseInt(process.env.BOOKING_MIN_NOTICE_HOURS || '4', 10);
const ESCALATION_LADDER = (process.env.BOOKING_ESCALATION_LADDER || '48,72,96,168')
  .split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0)
  .sort((a, b) => a - b);
// Cap on how many slots the bot puts in front of the lead, matching the
// current outbound copy ("two openings").
const MAX_OFFER_SLOTS = 2;

/**
 * Fetch available booking slots for a GHL calendar.
 *
 * @param {string} calendarId — GHL calendar ID (e.g. zEdPmkNccR2ovo3rQAd3 for MV)
 * @param {Object} [opts]
 * @param {number} [opts.windowDays=14]
 * @param {string} [opts.timezone='America/New_York']
 * @param {number} [opts.maxSlots=12] — cap on returned slots
 * @returns {Promise<Object|null>}
 *   { slots: [{iso, day, time, dayOfWeek}], calendar_id, timezone, slots_total_count }
 *   or null on any failure (no API key, network error, non-2xx, 429, parse error).
 */
export async function fetchFreeSlots(calendarId, opts = {}) {
  if (!calendarId) return null;
  if (!GHL_API_KEY) {
    console.warn('[CalAvail] GHL_API_KEY not set — skipping availability lookup');
    return null;
  }

  const windowDays = opts.windowDays || DEFAULT_WINDOW_DAYS;
  const tz = opts.timezone || DEFAULT_TIMEZONE;
  const maxSlots = opts.maxSlots || MAX_SLOTS_RETURNED;

  const startMs = Date.now();
  const endMs = startMs + (windowDays * 24 * 60 * 60 * 1000);

  const url = new URL(`https://services.leadconnectorhq.com/calendars/${calendarId}/free-slots`);
  url.searchParams.set('startDate', String(startMs));
  url.searchParams.set('endDate', String(endMs));
  url.searchParams.set('timezone', tz);

  try {
    await acquireToken();
    const res = await fetch(url.toString(), {
      headers: {
        'Authorization': 'Bearer ' + GHL_API_KEY,
        'Version': GHL_API_VERSION,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (res.status === 429) {
      report429();
      console.warn('[CalAvail] ' + calendarId + ' -> 429 rate limited');
      return null;
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.warn('[CalAvail] ' + calendarId + ' -> ' + res.status + ': ' + errBody.slice(0, 200));
      return null;
    }

    const data = await res.json();
    return parseSlots(data, calendarId, tz, maxSlots);
  } catch (err) {
    console.warn('[CalAvail] ' + calendarId + ' threw: ' + err.message);
    return null;
  }
}

/**
 * Parse the GHL free-slots response into a normalized array.
 *
 * GHL response shape:
 *   {
 *     "_dates_": ["2026-04-29", ...],   // optional metadata key
 *     "traceId": "...",                  // optional metadata key
 *     "2026-04-29": { "slots": ["2026-04-29T10:00:00-04:00", ...] },
 *     ...
 *   }
 *
 * Defensive against alternate shapes (slots as bare array, missing keys).
 */
function parseSlots(data, calendarId, timezone, maxSlots) {
  if (!data || typeof data !== 'object') return null;

  const allIso = [];
  for (const [key, value] of Object.entries(data)) {
    if (key === '_dates_' || key === 'traceId') continue;
    if (value && Array.isArray(value.slots)) {
      for (const s of value.slots) {
        if (typeof s === 'string') allIso.push(s);
      }
    } else if (Array.isArray(value)) {
      for (const s of value) {
        if (typeof s === 'string') allIso.push(s);
      }
    }
  }

  if (allIso.length === 0) {
    return { slots: [], calendar_id: calendarId, timezone, slots_total_count: 0 };
  }

  // Defense-in-depth: filter past slots even though GHL should already do this.
  const now = Date.now();
  const future = allIso.filter(iso => {
    const t = new Date(iso).getTime();
    return Number.isFinite(t) && t > now;
  });
  future.sort((a, b) => new Date(a).getTime() - new Date(b).getTime());

  const slots = future.slice(0, maxSlots).map(iso => formatSlot(iso, timezone));
  return {
    slots,
    calendar_id: calendarId,
    timezone,
    slots_total_count: future.length,
  };
}

/**
 * Format an ISO timestamp into human-readable parts in the configured timezone.
 */
function formatSlot(iso, timezone) {
  const d = new Date(iso);
  const dayFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric',
  });
  const timeFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true,
  });
  const dowFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, weekday: 'long',
  });
  return {
    iso,
    day: dayFmt.format(d),         // "Sat, May 3"
    time: timeFmt.format(d),       // "10:00 AM"
    dayOfWeek: dowFmt.format(d),   // "Saturday"
  };
}

/**
 * Format the availability object as a multi-line string for the user prompt.
 * Returns null if the input is null. Returns a "calendar full" instruction
 * when slots is empty.
 */
export function formatSlotsForPrompt(availability) {
  if (!availability) return null;

  if (!availability.slots || availability.slots.length === 0) {
    return [
      'CALENDAR AVAILABILITY: NO open slots in the configured window.',
      'The calendar is full for the immediate window. In your reply, do NOT propose a specific date — instead acknowledge briefly that timing is tight and send the booking link as the primary CTA so the lead picks the first opening that works.',
    ].join('\n');
  }

  const byDay = new Map();
  for (const s of availability.slots) {
    if (!byDay.has(s.day)) byDay.set(s.day, []);
    byDay.get(s.day).push(s.time);
  }

  const lines = [];
  lines.push('CALENDAR AVAILABILITY (real openings — pick from THIS list, never invent dates):');
  lines.push('  Calendar ID: ' + availability.calendar_id);
  lines.push('  Timezone: ' + availability.timezone);
  for (const [day, times] of byDay) {
    lines.push('  ' + day + ': ' + times.join(', '));
  }
  if (availability.slots_total_count > availability.slots.length) {
    const more = availability.slots_total_count - availability.slots.length;
    lines.push('  (' + more + ' additional later slots not shown — link reveals all)');
  }
  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════
// Offer-window selection (v1.1 — 2026-07-24 Engelke incident)
// ═══════════════════════════════════════════════════════════════════

/** Civil YYYY-MM-DD of an ISO instant, evaluated in tz. */
function isoCivilDate(iso, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(iso));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Narrow a wide availability list to the slots the bot may OFFER this turn.
 *
 * Selection order (§3):
 *   1. FLOOR      — discard anything sooner than now + minNoticeHours.
 *   2. LEAD DAY   — if the lead named a specific day (day_and_time / day_only)
 *                   and that date is open, offer those (the only >48h path).
 *   3. STANDARD   — slots inside [floor, now + offerWindowHours].
 *   4. ESCALATED  — nothing in the standard window but openings exist later:
 *                   offer the nearest, flagged so the bot acknowledges the gap.
 *   5. NONE       — nothing bookable at all after the floor.
 *
 * Returns the window metadata plus an `availability`-shaped object (same
 * { slots, calendar_id, timezone, slots_total_count } contract) that drops
 * straight into formatSlotsForPrompt.
 *
 * @param {Object|null} availability  — result of fetchFreeSlots
 * @param {Object|null} preferred     — result of extractPreferredTime (or null)
 * @param {Object} [opts]
 * @param {number} [opts.minNoticeHours]   — per-call floor override (e.g. shorter for phone calendars)
 * @param {number} [opts.offerWindowHours] — per-call window override
 * @param {number} [opts.maxOffer]         — per-call cap override
 * @returns {{ slots, window, escalated_to_hours, preferred_honored, availability }}
 */
export function selectOfferableSlots(availability, preferred, opts = {}) {
  const none = (av) => ({
    slots: [], window: 'none', escalated_to_hours: null, preferred_honored: false,
    availability: av,
  });
  if (!availability || !Array.isArray(availability.slots)) return none(availability || null);

  const tz = availability.timezone || DEFAULT_TIMEZONE;
  const minNotice = Number.isFinite(opts.minNoticeHours) ? opts.minNoticeHours : MIN_NOTICE_HOURS;
  const offerWindow = Number.isFinite(opts.offerWindowHours) ? opts.offerWindowHours : OFFER_WINDOW_HOURS;
  const maxOffer = Number.isFinite(opts.maxOffer) ? opts.maxOffer : MAX_OFFER_SLOTS;

  const now = Date.now();
  const floorMs = now + minNotice * 3600_000;
  const ms = (s) => new Date(s.iso).getTime();

  // 1. Floor — a 90-min in-home visit cannot be offered for 40 min from now.
  const afterFloor = availability.slots
    .filter((s) => Number.isFinite(ms(s)) && ms(s) >= floorMs)
    .sort((a, b) => ms(a) - ms(b));

  const pack = (slots, window, extra = {}) => ({
    slots: slots.slice(0, maxOffer),
    window,
    escalated_to_hours: null,
    preferred_honored: false,
    availability: {
      slots: slots.slice(0, maxOffer),
      calendar_id: availability.calendar_id,
      timezone: tz,
      slots_total_count: slots.length,
    },
    ...extra,
  });

  if (afterFloor.length === 0) {
    console.log(`[OfferWindow] cal=${availability.calendar_id} window=none (0 slots after ${minNotice}h floor)`);
    return none({
      slots: [], calendar_id: availability.calendar_id, timezone: tz, slots_total_count: 0,
    });
  }

  // 2. Lead-requested day — the only path that may exceed the 48h window.
  const spec = preferred?.specificity;
  if (preferred?.date_iso && (spec === 'day_and_time' || spec === 'day_only')) {
    const daySlots = afterFloor.filter((s) => isoCivilDate(s.iso, tz) === preferred.date_iso);
    if (daySlots.length) {
      console.log(`[OfferWindow] cal=${availability.calendar_id} window=lead_requested date=${preferred.date_iso} n=${daySlots.length}`);
      return pack(daySlots, 'lead_requested', { preferred_honored: true });
    }
  }

  // 3. Standard 48h window.
  const windowEndMs = now + offerWindow * 3600_000;
  const standard = afterFloor.filter((s) => ms(s) <= windowEndMs);
  if (standard.length) {
    console.log(`[OfferWindow] cal=${availability.calendar_id} window=standard_48h n=${standard.length}`);
    return pack(standard, 'standard_48h');
  }

  // 4. Escalated — nothing inside 48h, but real openings exist later. Offer the
  //    nearest, flagged so the bot must acknowledge the gap (never a silent
  //    jump). The escalation ladder documents the acknowledgment thresholds; we
  //    always surface the earliest real openings rather than leave dead air.
  const hoursOut = Math.max(1, Math.round((ms(afterFloor[0]) - now) / 3600_000));
  const rung = ESCALATION_LADDER.find((h) => h >= hoursOut) || ESCALATION_LADDER[ESCALATION_LADDER.length - 1] || offerWindow;
  console.log(`[OfferWindow] cal=${availability.calendar_id} window=escalated nearest=${hoursOut}h rung=${rung}h n=${afterFloor.length}`);
  return pack(afterFloor, 'escalated', { escalated_to_hours: hoursOut });
}

/**
 * Prompt block prepended above the CALENDAR AVAILABILITY block, describing how
 * the offer must be framed for the selected window (§3). Returns null for the
 * 'none' window (the caller routes to the no-availability / booking-link path)
 * or when there is nothing to say.
 *
 * @param {Object} selection — result of selectOfferableSlots
 * @param {Object|null} [preferred] — for the lead_requested {raw}
 */
export function buildOfferWindowPrompt(selection, preferred = null) {
  if (!selection) return null;
  switch (selection.window) {
    case 'standard_48h':
      return [
        'OFFER WINDOW: next 48 hours. Offer exactly two of the slots listed below.',
        'Do NOT offer, mention, or imply any date beyond this window.',
      ].join('\n');
    case 'lead_requested':
      return [
        `OFFER WINDOW: the lead specifically asked for ${preferred?.raw || 'their requested day'}, and it is open.`,
        'Offer that slot first and by name. Do not bury it among alternatives.',
      ].join('\n');
    case 'escalated':
      return [
        `OFFER WINDOW: nothing is open in the next 48 hours; the nearest openings are`,
        `${selection.escalated_to_hours} hours out. Say plainly that the next two days are full`,
        `before you offer anything. Never describe a slot several days out as "soon"`,
        `or as "our soonest opening" without that acknowledgment.`,
      ].join('\n');
    default:
      return null;
  }
}
