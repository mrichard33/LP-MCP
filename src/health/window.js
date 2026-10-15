/**
 * window.js — Eastern-time helpers for the health checks (pure).
 *
 * A check's `active_window` is text in the registry, e.g. "08:00-20:00 ET".
 * Outside it the check was not asked, so its result is 'skipped' — never a
 * 'pass' (the dialer is quiet at 22:00 because nobody dials, not because it is
 * healthy) and never 'unknown' (that would paint the board yellow every night).
 */

const TZ = 'America/New_York';

/** { day: 'YYYY-MM-DD', hour, minute, weekday: 'Mon'..'Sun', minuteOfDay } in ET. */
export function etParts(nowMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(new Date(nowMs));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    hour,
    minute,
    weekday: get('weekday'),
    minuteOfDay: hour * 60 + minute,
  };
}

const HHMM = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/;

/** Is `nowMs` inside "HH:MM-HH:MM ET"? No window (null/blank) means always. */
export function inActiveWindow(activeWindow, nowMs) {
  if (!activeWindow) return true;
  const m = HHMM.exec(String(activeWindow));
  if (!m) return true;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  const { minuteOfDay } = etParts(nowMs);
  return start <= end ? minuteOfDay >= start && minuteOfDay < end : minuteOfDay >= start || minuteOfDay < end;
}

/**
 * Minutes between runs, read from a free-text cadence ("every 5 min",
 * "hourly", "daily 08:10 ET", "every min", "nightly"). null when the text
 * names no interval. Pure.
 */
export function cadenceMinutes(cadence) {
  const c = String(cadence || '').toLowerCase();
  if (!c || c === 'existing') return null;
  let m = /every\s+(\d+)\s*(min|minute|minutes|m)\b/.exec(c);
  if (m) return Number(m[1]);
  if (/every\s+min/.test(c)) return 1;
  m = /every\s+(\d+)\s*(h|hour|hours)\b/.exec(c);
  if (m) return Number(m[1]) * 60;
  if (/hourly|every hour/.test(c)) return 60;
  if (/monthly/.test(c)) return 31 * 24 * 60;
  if (/weekly|\b(mon|tue|wed|thu|fri|sat|sun)\b/.test(c)) return 7 * 24 * 60;
  if (/daily|nightly|once a day|\d{1,2}:\d{2}\s*et/.test(c)) return 24 * 60;
  return null;
}

/** "hourly 08:00–20:00 ET" → { from: '08:00', to: '20:00' }; null when the text names no range. */
export function cadenceWindow(cadence) {
  const m = /(\d{1,2}:\d{2})\s*[–-]\s*(\d{1,2}:\d{2})/.exec(String(cadence || ''));
  return m ? { from: m[1], to: m[2] } : null;
}
