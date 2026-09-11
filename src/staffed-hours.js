/**
 * Staffed Hours — src/staffed-hours.js
 *
 * The one place that answers "is anybody here to make the call right now?".
 *
 * WHY THIS EXISTS
 * ───────────────
 * src/dial-window.js answers a narrower question — will Five9 place an
 * outbound call — and the only correct source for that is the Five9 dialing
 * schedule: 08:00-21:00 ET, every day, verified live 2026-09-04. That is a
 * machine's schedule, not a person's.
 *
 * The Callback Request campaign runs in PREVIEW mode. PREVIEW does not
 * auto-dial: Five9 presents the record to a logged-in agent, who places the
 * call. So the binding constraint on a callback actually happening is A PERSON
 * BEING THERE, and the dial window does not measure that. On 2026-09-04 Mark
 * ruled to accept the gap. On 2026-09-11 he reopened it and ruled the other
 * way: WHEN THE OFFICE IS CLOSED, THE BOT MUST NOT SUGGEST ANYONE WILL CALL
 * IMMEDIATELY. This module is that ruling.
 *
 * It is deliberately separate from dial-window.js rather than folded into it.
 * "The dialer is running" and "the floor is staffed" are two different facts,
 * and an immediate-callback promise needs BOTH. dial-window.js composes them in
 * canPromiseImmediateCall(); neither module answers the other's question.
 *
 * This is also NOT office hours for SMS quiet hours (src/services/quiet-hours.js),
 * appointment validity, or the knowledge base's published hours. Do not widen it.
 *
 * WHY THE SCHEDULE IS PER-DAY
 * ───────────────────────────
 * Confirmed by Mark 2026-09-11: Mon-Fri 8:00 AM-8:00 PM, Sat 9:00 AM-8:00 PM,
 * Sun 9:00 AM-5:00 PM ET. Saturday and Sunday open an hour later than the
 * weekdays and Sunday closes three hours earlier, so a single start/end pair
 * across a flat list of days cannot express the real floor. Modelling it as one
 * would mean rounding Mark's answer to fit the code, which is how the six
 * disagreeing "business hours" definitions catalogued in dial-window.js came
 * about in the first place.
 *
 * WHY IT IS ENV-TUNABLE AND READ PER CALL
 * ────────────────────────────────────────
 * If the floor's schedule changes, this must follow within minutes, not within
 * a deploy — same reasoning as dialWindowBounds() and isQuietHoursBypassed().
 * The defaults are Mark's confirmed hours, so an unset env is already correct.
 *
 * DST-CORRECTNESS
 * ───────────────
 * The server runs UTC. Every hour and weekday here comes from
 * Intl.DateTimeFormat with America/New_York via formatToParts — never
 * getHours()/getDay(), which would answer a different question entirely and
 * would be wrong by an hour for half the year.
 */

const TZ = 'America/New_York';

// ISO-8601 weekday numbering: Mon=1 … Sun=7.
const ISO_DAY_BY_NAME = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const DAY_NAME_BY_ISO = { 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday', 7: 'Sunday' };
const SHORT_DAY_BY_ISO = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun' };

// Mark, 2026-09-11. Keys are ISO weekdays; values are [startHour, endHour),
// half-open on the top so 19:59 is inside a …-20 day and 20:00 is not.
const DEFAULT_SCHEDULE = {
  1: [8, 20], 2: [8, 20], 3: [8, 20], 4: [8, 20], 5: [8, 20],
  6: [9, 20],
  7: [9, 17],
};

const isHour = (n) => Number.isInteger(n) && n >= 0 && n <= 24;

/**
 * Parse CALL_PROMISE_HOURS_ET — a comma list of `day:start-end` entries, where
 * `day` is an ISO weekday or an inclusive range: `1-5:8-20,6:9-20,7:9-17`.
 * A day absent from the list is unstaffed.
 *
 * Discard-not-repair, the same rule as hourFromEnv in dial-window.js: ANY
 * malformed entry falls the WHOLE schedule back to the default. A half-parsed
 * schedule would silently un-staff a day, and the failure mode of that is the
 * bot going quiet on a day the floor is actually working.
 */
function scheduleFromEnv(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return null;
  const out = {};
  for (const entry of text.split(',')) {
    const m = /^\s*(\d)\s*(?:-\s*(\d)\s*)?:\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(entry);
    if (!m) return null;
    const dayFrom = Number(m[1]);
    const dayTo = m[2] === undefined ? dayFrom : Number(m[2]);
    const start = Number(m[3]);
    const end = Number(m[4]);
    if (!Number.isInteger(dayFrom) || dayFrom < 1 || dayFrom > 7) return null;
    if (!Number.isInteger(dayTo) || dayTo < dayFrom || dayTo > 7) return null;
    if (!isHour(start) || !isHour(end) || end <= start) return null;
    for (let d = dayFrom; d <= dayTo; d++) out[d] = [start, end];
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Read an hour-of-day env var. Returns null when unset or not a whole hour in
 * 0-24, so the caller can tell "not set" from "set to 0".
 */
function hourFromEnv(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(raw);
  return isHour(n) ? n : null;
}

/**
 * Read CALL_PROMISE_DAYS_ET — a comma list of ISO weekdays. Returns null when
 * unset or malformed (whole-list discard, same reasoning as scheduleFromEnv).
 */
function daysFromEnv(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const parts = String(raw).split(',').map(s => s.trim()).filter(s => s !== '');
  if (!parts.length) return null;
  const days = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 1 || n > 7) return null;
    if (!days.includes(n)) days.push(n);
  }
  return days.sort((a, b) => a - b);
}

/**
 * The staffed schedule, read fresh on every call.
 *
 * Precedence:
 *   1. CALL_PROMISE_HOURS_ET — the full per-day form, e.g. "1-5:8-20,6:9-20,7:9-17".
 *   2. CALL_PROMISE_DAYS_ET / CALL_PROMISE_START_HOUR_ET / CALL_PROMISE_END_HOUR_ET —
 *      the flat form, applying ONE start/end across the listed days. Kept
 *      because it is the simplest knob to reach for when the whole floor moves
 *      together; setting any one of the three switches to this form, with the
 *      other two defaulting to Mon-Fri and 8-20.
 *   3. Mark's confirmed hours.
 *
 * @returns {{schedule: Record<number,[number,number]>, timeZone: string}}
 */
export function staffedHoursBounds() {
  const perDay = scheduleFromEnv(process.env.CALL_PROMISE_HOURS_ET);
  if (perDay) return { schedule: perDay, timeZone: TZ };

  const days = daysFromEnv('CALL_PROMISE_DAYS_ET');
  const start = hourFromEnv('CALL_PROMISE_START_HOUR_ET');
  const end = hourFromEnv('CALL_PROMISE_END_HOUR_ET');
  if (days || start !== null || end !== null) {
    const s = start ?? 8;
    const e = end ?? 20;
    if (e > s) {
      const schedule = {};
      for (const d of (days ?? [1, 2, 3, 4, 5])) schedule[d] = [s, e];
      return { schedule, timeZone: TZ };
    }
  }
  return { schedule: { ...DEFAULT_SCHEDULE }, timeZone: TZ };
}

/**
 * The full ET civil date and wall-clock time at an instant, DST-correct.
 * formatToParts, never getHours()/getDay() — the server runs UTC.
 */
export function etParts(atMs = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(atMs));
  const get = (t) => parts.find(p => p.type === t)?.value;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    isoDay: ISO_DAY_BY_NAME[get('weekday')] ?? null,
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
  };
}

/**
 * The epoch ms at which the ET wall clock reads `hour:00:00` on the ET calendar
 * date {year, month, day}.
 *
 * Solves for the offset rather than assuming -5 or -4: guess a UTC instant,
 * read back what ET actually calls it, and correct by the difference. One pass
 * is enough away from a transition; the second settles the transition days.
 */
function etCivilToMs({ year, month, day, hour }) {
  const want = Date.UTC(year, month - 1, day, hour, 0, 0);
  let t = want;
  for (let i = 0; i < 2; i++) {
    const c = etParts(t);
    if (!Number.isFinite(c.hour)) return null;
    const asUtc = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
    const next = want - (asUtc - t); // (asUtc - t) is the ET offset at t
    if (next === t) return t;
    t = next;
  }
  return t;
}

/** "8:00 AM" from an hour-of-day. */
export function formatHour(h) {
  const ampm = h >= 12 && h < 24 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:00 ${ampm}`;
}

/**
 * The staffed schedule in words: "Mon–Fri 8:00 AM–8:00 PM, Sat 9:00 AM–8:00 PM,
 * Sun 9:00 AM–5:00 PM ET". Runs of days sharing the same hours collapse into a
 * range.
 *
 * Rendered from the schedule rather than written out as a constant, so the
 * prompt line can never state hours the code is not actually using — the exact
 * drift dial-window.js exists to prevent.
 */
export function staffedHoursHuman(schedule = staffedHoursBounds().schedule) {
  const days = Object.keys(schedule).map(Number).sort((a, b) => a - b);
  if (!days.length) return 'no staffed hours';
  const groups = [];
  for (const d of days) {
    const [s, e] = schedule[d];
    const last = groups[groups.length - 1];
    if (last && last.start === s && last.end === e && last.to === d - 1) last.to = d;
    else groups.push({ from: d, to: d, start: s, end: e });
  }
  const rendered = groups.map(g => {
    const label = g.from === g.to
      ? SHORT_DAY_BY_ISO[g.from]
      : `${SHORT_DAY_BY_ISO[g.from]}–${SHORT_DAY_BY_ISO[g.to]}`;
    return `${label} ${formatHour(g.start)}–${formatHour(g.end)}`;
  });
  return `${rendered.join(', ')} ET`;
}

/**
 * Is the floor staffed right now?
 *
 * Half-open on the top, matching isWithinDialWindow: 19:59 ET is inside an
 * 08:00-20:00 day and 20:00 is not.
 *
 * @param {number} [atMs]  epoch ms; defaults to now
 * @returns {boolean}
 */
export function isWithinStaffedHours(atMs = Date.now()) {
  const { schedule } = staffedHoursBounds();
  const { isoDay, hour } = etParts(atMs);
  if (isoDay === null || !Number.isFinite(hour)) return false;
  const window = schedule[isoDay];
  if (!window) return false;
  return hour >= window[0] && hour < window[1];
}

/**
 * The next instant the floor opens, and how to say it out loud.
 *
 * Exists because a model told only "the office is closed" will invent a
 * reopening time, and an invented one contradicts what the customer is told
 * everywhere else. Same reasoning as stating the boundary in
 * dialWindowPromptLine.
 *
 * @param {number} [atMs]
 * @returns {{atMs: (number|null), human: string}} — human reads
 *   "today at 9:00 AM" when the opening is later the same ET day, otherwise
 *   "Monday at 8:00 AM". Both null/"" only if no day is staffed at all.
 */
export function nextStaffedOpening(atMs = Date.now()) {
  const { schedule } = staffedHoursBounds();
  const now = etParts(atMs);
  if (now.isoDay === null || !Number.isFinite(now.hour)) return { atMs: null, human: '' };

  for (let offset = 0; offset <= 7; offset++) {
    // Step the ET CIVIL date, not the instant: adding 24h of real time across
    // a DST boundary lands on the wrong calendar day.
    const d = new Date(Date.UTC(now.year, now.month - 1, now.day + offset));
    const isoDay = ((d.getUTCDay() + 6) % 7) + 1; // JS Sun=0 → ISO Sun=7
    const window = schedule[isoDay];
    if (!window) continue;
    // Today only counts if the opening has not already passed.
    if (offset === 0 && now.hour >= window[0]) continue;

    return {
      atMs: etCivilToMs({
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        day: d.getUTCDate(),
        hour: window[0],
      }),
      human: offset === 0
        ? `today at ${formatHour(window[0])}`
        : `${DAY_NAME_BY_ISO[isoDay]} at ${formatHour(window[0])}`,
    };
  }
  return { atMs: null, human: '' };
}

export default {
  staffedHoursBounds,
  isWithinStaffedHours,
  nextStaffedOpening,
  staffedHoursHuman,
  formatHour,
  etParts,
};
