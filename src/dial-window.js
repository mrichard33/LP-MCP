/**
 * Five9 Dial Window — src/dial-window.js
 *
 * The one place that answers "is the dialer open right now?".
 *
 * WHY THIS EXISTS
 * ───────────────
 * The Layer 3 `callback_request` prompt told the model: "If they want it NOW
 * and it is business hours, promise a call in the next few minutes." Nothing
 * ever computed business hours. The model inferred them — and the repo gave it
 * six different answers to infer from: agentic-callback-message.js says
 * 08:00-17:00 Mon-Fri, five9-silence-watchdog.js says 09:00-18:00 Mon-Sat,
 * quiet-hours.js says 08:00-21:00 daily, reschedule-options.js and
 * lp-ghl-appointment-reconciler.js carry per-weekday appointment grids, and the
 * knowledge base (sql/013_kb_seed_structured.sql:223) states "Mon-Fri 9am-8pm,
 * Sat 9am-5pm, Sun 9am-3pm" straight into the model's context.
 *
 * So the bot could promise an immediate call at 8:30 PM while believing the
 * office closed at 5, or refuse one at 8:15 AM. That is the Robert Pederson
 * failure (2026-09-04): a promise of a call that the dialer could not keep.
 *
 * THIS MODULE IS NOT A SEVENTH DEFINITION OF "BUSINESS HOURS". It answers one
 * narrower question — whether Five9 will actually place an outbound call — and
 * the only correct source for that is the Five9 dialing schedule. Verified live
 * 2026-09-04 via five9_get_campaign_profiles: all 14 profiles, the "Callback
 * Request" profile included, dial Primary/Alt1/Alt2 08:00-21:00, every day.
 *
 * Do NOT widen this to cover office hours, appointment validity, or SMS quiet
 * hours. Those are different questions with different right answers, and
 * collapsing them is how the six definitions above came to disagree. SMS
 * sendability stays with src/services/quiet-hours.js.
 *
 * WHY THE HOURS ARE ENV-TUNABLE AND READ PER CALL
 * ────────────────────────────────────────────────
 * If Mark changes the Five9 dialing schedule in the admin UI, this must be able
 * to follow within minutes, not within a deploy. Same reasoning as
 * isQuietHoursBypassed() in src/services/quiet-hours.js. The defaults are the
 * live Five9 values, so an unset env is already correct.
 */

const TZ = 'America/New_York';

const DEFAULT_START_HOUR = 8;   // Five9 dialingSchedules[].startTime.hours
const DEFAULT_END_HOUR = 21;    // Five9 dialingSchedules[].stopTime.hours

/**
 * Read an hour-of-day env var, falling back when unset or not a whole hour in
 * 0-24. A malformed value must not silently open the dialer at midnight, so an
 * out-of-range value is discarded rather than clamped.
 */
function hourFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 24) return fallback;
  return n;
}

/** The configured dial window, read fresh. */
export function dialWindowBounds() {
  return {
    startHour: hourFromEnv('FIVE9_DIAL_WINDOW_START_HOUR_ET', DEFAULT_START_HOUR),
    endHour: hourFromEnv('FIVE9_DIAL_WINDOW_END_HOUR_ET', DEFAULT_END_HOUR),
    timeZone: TZ,
  };
}

/**
 * The ET hour (0-23) and minute at an instant, DST-correct.
 *
 * formatToParts with hourCycle 'h23' rather than getHours() — the server runs
 * UTC, so getHours() would answer a different question entirely.
 */
export function etHourMinute(atMs = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(atMs));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value);
  return { hour, minute };
}

/**
 * Is Five9 dialing right now?
 *
 * Half-open on the top: 20:59 ET is inside a 08:00-21:00 window and 21:00 is
 * not, matching the Five9 stopTime. Every day of the week — the Five9 schedule
 * carries no weekday restriction, so neither does this.
 *
 * @param {number} [atMs]  epoch ms; defaults to now
 * @returns {boolean}
 */
export function isWithinDialWindow(atMs = Date.now()) {
  const { startHour, endHour } = dialWindowBounds();
  const { hour } = etHourMinute(atMs);
  if (!Number.isFinite(hour)) return false;
  return hour >= startHour && hour < endHour;
}

/**
 * One line of fact for the reply prompt. Deliberately states the boundary as
 * well as the verdict: told only "the dialer is closed", a model will invent a
 * reopening time, and an invented one contradicts the SMS the customer gets.
 *
 * @param {number} [atMs]
 * @returns {string}
 */
export function dialWindowPromptLine(atMs = Date.now()) {
  const { startHour, endHour } = dialWindowBounds();
  const open = isWithinDialWindow(atMs);
  const fmt = (h) => {
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${h12}:00 ${ampm}`;
  };
  const window = `${fmt(startHour)}-${fmt(endHour)} ET`;
  return open
    ? `PHONE ROOM: OPEN right now (the dialer runs ${window}). An immediate callback CAN be promised.`
    : `PHONE ROOM: CLOSED right now (the dialer runs ${window}). An immediate callback CANNOT be promised — the next one goes out when it reopens.`;
}
