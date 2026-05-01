/**
 * Contact Appointments — src/knowledge/contact-appointments.js
 *
 * v1.0 (2026-04-30) — Live GHL appointment lookup for the agentic
 * responder. Used by the cancellation/reschedule flow:
 * before the AI emits a cancel_appointment or reschedule_appointment
 * companion, it needs to know what appointments actually exist on the
 * contact, with appointment_id + calendar + start_time + status.
 *
 * Why live: appointment state changes frequently (auto-bookings, manual
 * ops, GHL workflow bookings) and any cache lags. For a destructive
 * decision like "cancel this appointment", we read GHL directly.
 *
 * Endpoint: GET /contacts/{contactId}/appointments
 * Filtering: future appointments only (endTime > now), excluding any
 * with appointmentStatus 'cancelled'/'noshow'/'no-show'. Cancelled appts
 * are noise for the cancellation flow — the lead doesn't care about them.
 *
 * Returns:
 *   - Array (possibly empty) of upcoming active appointments on success.
 *   - null on any fetch/parse error. Caller treats as "unknown — don't
 *     auto-cancel" and falls through to a clarifying message.
 */

import { CALENDAR_MAP } from '../actions/constants.js';

const GHL_API_KEY = process.env.GHL_API_KEY || '';
const FETCH_TIMEOUT_MS = 8000;
const PROMPT_TIMEZONE = process.env.REECE_TIMEZONE || 'America/New_York';

// Reverse map: calendar_id → human name (for prompt formatting).
// Built once at module load. Falls back to raw ID if unmapped.
const CALENDAR_ID_TO_NAME = Object.fromEntries(
  Object.entries(CALENDAR_MAP).map(([name, id]) => [id, name])
);

function calendarNameForId(calendarId) {
  if (!calendarId) return 'Unknown';
  return CALENDAR_ID_TO_NAME[calendarId] || calendarId;
}

function formatStartTimeForPrompt(iso) {
  if (!iso) return 'unknown time';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const formatted = new Intl.DateTimeFormat('en-US', {
      timeZone: PROMPT_TIMEZONE,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(d);
    return `${formatted} ET`;
  } catch {
    return iso;
  }
}

/**
 * Fetch active future appointments for a GHL contact.
 *
 * @param {string} contactId — GHL contact ID
 * @returns {Promise<Array<{
 *   appointment_id: string,
 *   calendar_id: string,
 *   calendar_name: string,
 *   start_time: string,        // ISO
 *   end_time: string,          // ISO
 *   status: string,            // 'confirmed' | 'new' | 'showed' | etc. (lowercased)
 *   title: string|null,
 *   start_time_human: string,  // formatted for prompt
 * }> | null>}
 */
export async function fetchUpcomingAppointments(contactId) {
  if (!contactId || !GHL_API_KEY) return null;

  try {
    const res = await fetch(
      `https://services.leadconnectorhq.com/contacts/${contactId}/appointments`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Version': '2021-04-15',
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[ContactAppointments] GET ${contactId} → ${res.status}: ${text.slice(0, 150)}`);
      return null;
    }

    const data = await res.json();
    // GHL response shape variations: { events: [...] } or { appointments: [...] }
    const events = Array.isArray(data?.events)
      ? data.events
      : (Array.isArray(data?.appointments) ? data.appointments : []);

    const now = Date.now();
    const out = [];
    for (const e of events) {
      // Filter out cancelled / noshow / past appointments.
      const status = String(e.appointmentStatus || e.status || '').toLowerCase();
      if (status === 'cancelled' || status === 'noshow' || status === 'no-show') continue;

      const startIso = e.startTime || e.start_time || null;
      const endIso = e.endTime || e.end_time || null;
      const endMs = endIso
        ? Date.parse(endIso)
        : (startIso ? Date.parse(startIso) + 90 * 60_000 : NaN);
      if (Number.isNaN(endMs) || endMs < now) continue;

      const calendarId = e.calendarId || e.calendar_id || null;
      out.push({
        appointment_id: e.id || e.appointment_id || null,
        calendar_id: calendarId,
        calendar_name: calendarNameForId(calendarId),
        start_time: startIso,
        end_time: endIso,
        status: status || 'unknown',
        title: e.title || null,
        start_time_human: formatStartTimeForPrompt(startIso),
      });
    }

    // Sort by start_time ascending (soonest first).
    out.sort((a, b) => {
      const aMs = a.start_time ? Date.parse(a.start_time) : Infinity;
      const bMs = b.start_time ? Date.parse(b.start_time) : Infinity;
      return aMs - bMs;
    });

    return out;
  } catch (err) {
    console.warn(`[ContactAppointments] fetch threw for ${contactId}: ${err.message}`);
    return null;
  }
}

/**
 * Format a list of upcoming appointments for inclusion in the AI prompt.
 * Returns null when input is null (fetch failed) or empty (no appts).
 * The caller decides whether to inject the block — typically only when
 * non-null AND non-empty.
 */
export function formatAppointmentsForPrompt(appointments) {
  if (!Array.isArray(appointments) || appointments.length === 0) return null;
  const lines = [];
  appointments.forEach((a, i) => {
    const idx = i + 1;
    lines.push(
      `  [${idx}] appointment_id="${a.appointment_id || '?'}" | ` +
      `calendar="${a.calendar_name}" | ` +
      `start="${a.start_time_human}" (${a.start_time || '?'}) | ` +
      `status="${a.status}"` +
      (a.title ? ` | title="${a.title.slice(0, 60)}"` : '')
    );
  });
  return lines.join('\n');
}
