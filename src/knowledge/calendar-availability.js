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
