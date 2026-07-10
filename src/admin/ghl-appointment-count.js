/**
 * Live GHL appointment count — src/admin/ghl-appointment-count.js
 *
 * The Reece dashboard's "appointments today" card reads the HL Supabase
 * `appointments` CACHE, which false-tombstones ~30% of live appointments →
 * phantom gaps vs Lead Perfection. This endpoint returns the count straight
 * from the LIVE GHL calendar API (the estimate pool WE+MV+HPA for one ET day),
 * so the dashboard can read truth without embedding a GHL client or GHL secrets
 * of its own.
 *
 *   GET /admin/ghl-appointment-count?date=YYYY-MM-DD   (default: today ET)
 *     → { ok, date, active_count, by_calendar: { <calendarId>: n, … } }
 */

import { etOffsetMinutes } from '../appointment-dates.js';
import { listEstimatePoolEvents, isActiveStatus } from '../services/ghl-calendar-read.js';

function etTodayString() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/**
 * Epoch-ms window [start, end) for an ET calendar day 'YYYY-MM-DD'.
 * Uses the DST-correct ET offset at that day's noon (avoids the DST-edge hour).
 * Exported for testing.
 */
export function etDayWindowMs(dateStr) {
  const offMin = etOffsetMinutes(new Date(`${dateStr}T12:00:00Z`));
  const sign = offMin <= 0 ? '-' : '+';
  const abs = Math.abs(offMin);
  const off = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  const startMs = Date.parse(`${dateStr}T00:00:00${off}`);
  const endMs = startMs + 24 * 3600 * 1000;
  return { startMs, endMs, offset: off };
}

export async function getEstimateAppointmentCount(dateStr) {
  const { startMs, endMs } = etDayWindowMs(dateStr);
  const events = await listEstimatePoolEvents({ startMs, endMs, activeOnly: true });
  const byCalendar = {};
  for (const e of events) {
    if (!isActiveStatus(e.status)) continue;
    byCalendar[e.calendar_id] = (byCalendar[e.calendar_id] || 0) + 1;
  }
  return { date: dateStr, active_count: events.length, by_calendar: byCalendar };
}

export function registerGhlAppointmentCountRoutes(app) {
  app.get('/admin/ghl-appointment-count', async (req, res) => {
    const date = (req.query?.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)) ? req.query.date : etTodayString();
    try {
      const result = await getEstimateAppointmentCount(date);
      return res.json({ ok: true, ...result });
    } catch (err) {
      return res.status(502).json({ ok: false, error: String(err.message || err).slice(0, 300) });
    }
  });

  console.log('[GhlApptCount] Registered: GET /admin/ghl-appointment-count');
}
