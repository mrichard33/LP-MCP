/**
 * plain.js — the words a person reads on a health result (pure, no I/O).
 *
 * WHY (2026-10-15, the user, after the first look at /system-health): "P1",
 * "20:45 ET", "1125 min", "oldest 2344h", "p90", "SLA" and "HTTP 307" meant
 * nothing to the people the board is for. Every summary, Slack card and digest
 * line is now written with these helpers: Eastern time on a 12-hour clock,
 * durations a person would say out loud, and severity as a word. The codes
 * (P1, check ids) stay in the database and the fingerprints; only the text
 * people read changes.
 */

const TZ = 'America/New_York';

/** P1..P4 as the word people read. Unknown codes pass through. */
export const SEVERITY_WORD = { P1: 'Urgent', P2: 'High', P3: 'Medium', P4: 'Low' };
export const severityWord = (code) => SEVERITY_WORD[code] || String(code ?? '');

/** "20:45" → "8:45 PM"; "08:00" → "8:00 AM"; "12:00" → "12:00 PM"; "00:30" → "12:30 AM". */
export function clock12(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!m) return String(hhmm ?? '');
  const h = Number(m[1]) % 24;
  const suffix = h < 12 ? 'AM' : 'PM';
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${suffix}`;
}

/** A list of "HH:MM" as "7:30 PM and 8:15 PM" / "7 AM, 9 AM and 1 PM". */
export function clockList(times) {
  const words = (times || []).map(clock12);
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** "8:45 PM" for an instant, in Eastern time. */
export function etClock(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
}

/** "Thu, Oct 16, 8:45 PM ET" for an instant, in Eastern time. */
export function etWhen(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const day = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' }).format(d);
  return `${day}, ${etClock(ms)} ET`;
}

/** "Thu, Oct 16" for an ET calendar day "2026-10-16" (no timezone shift). */
export function dayWords(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ''));
  if (!m) return String(ymd ?? '');
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(d);
}

/**
 * Minutes as people say them: "under a minute", "1 minute", "45 minutes",
 * "2 hours 30 minutes", "about 19 hours", "1 day", "57 days".
 */
export function duration(min) {
  const m = Math.round(Number(min));
  if (!Number.isFinite(m) || m < 1) return 'under a minute';
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  if (m < 6 * 60) {
    // Under 6 hours the minutes still matter: "2 hours 30 minutes".
    const hh = Math.floor(m / 60);
    const mm = m % 60;
    return `${hh} hour${hh === 1 ? '' : 's'}${mm ? ` ${mm} minute${mm === 1 ? '' : 's'}` : ''}`;
  }
  const h = Math.round(m / 60);
  if (h < 48) return `about ${h} hours`;
  const d = Math.round(m / 1440);
  return `${d} day${d === 1 ? '' : 's'}`;
}

/** "1 lead" / "13 leads"; a custom plural for irregular words. */
export function count(n, word, plural = `${word}s`) {
  const x = Number(n) || 0;
  return `${x.toLocaleString('en-US')} ${x === 1 ? word : plural}`;
}

/** "$9,141" from a number of dollars. */
export function money(n) {
  return `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
}

/**
 * Safety net for text that came from elsewhere (an old registry string, a job
 * summary): any 24-hour clock time becomes a 12-hour one. "08:00-20:00 ET" →
 * "8:00 AM to 8:00 PM ET", "20:15 and 20:45 ET" → "8:15 PM and 8:45 PM ET".
 * Dates ("2026-10-16"), money and counts are left alone.
 */
export function plainTimes(text) {
  return String(text ?? '')
    .replace(/\b([01]?\d|2[0-3]):([0-5]\d)\s*-\s*([01]?\d|2[0-3]):([0-5]\d)\b/g, (_, a, b, c, d) => `${clock12(`${a}:${b}`)} to ${clock12(`${c}:${d}`)}`)
    .replace(/(^|[^\d:-])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])(?!\s?[AaPp][Mm]\b)/g, (_, pre, h, mm) => `${pre}${clock12(`${h}:${mm}`)}`);
}

/** "8:00 AM to 8:00 PM ET" from an active window "08:00-20:00 ET". */
export function windowWords(activeWindow) {
  return plainTimes(activeWindow).replace(/\bET\b/, 'Eastern').trim();
}

/** A 24-hour clock time anywhere in the text (used by tests and the summary guard). */
export const TWENTY_FOUR_HOUR_TIME = /\b([01]\d|2[0-3]):[0-5]\d\b(?!:)/;
