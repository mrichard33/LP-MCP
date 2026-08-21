/**
 * Call Intelligence time conversions — src/ci/time.js
 *
 * THREE timezones meet in this subsystem and §17 names them the highest-
 * likelihood source of silent mismatch:
 *
 *   Call Log report   Pacific (America/Los_Angeles), DST-aware, lags 5–10 min
 *   Recording files   FIXED EST (GMT-05:00), NO DST — the export config's zone
 *   Display           ET (America/New_York), DST-aware — presentation only
 *
 * Rule: convert every source to UTC at ingest and store timestamptz. Render ET
 * only at the presentation layer (the SQL views already do that).
 *
 * Everything here is PURE — no env reads, no clients, no import-time work — so
 * the conversions can be asserted directly without stubbing. That matters more
 * here than anywhere else in the pipeline: an hour of drift does not throw, it
 * just silently attaches recordings to the wrong calls for eight months a year.
 */

/** Two-digit-safe integer parse for filename/date fragments. */
const int = (v) => {
  const n = parseInt(String(v), 10);
  return Number.isNaN(n) ? null : n;
};

/**
 * Is this a real calendar date? A regex alone accepts 2026-13-45, and Date
 * silently ROLLS IT OVER into 2027 — which is how an unparseable timestamp
 * becomes a confidently wrong instant instead of a null.
 */
const validYmd = (y, month, day) => {
  if (!Number.isFinite(y) || !Number.isFinite(month) || !Number.isFinite(day)) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(y, month - 1, day));
  return probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
};

/** Three-letter month abbreviations → 0-based index, for the RFC-822 shape. */
const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Wall-clock component ranges. Hours are 0–23 after meridiem folding. */
const validHms = (h, min, s) =>
  Number.isFinite(h) && Number.isFinite(min) && Number.isFinite(s) &&
  h >= 0 && h <= 23 && min >= 0 && min <= 59 && s >= 0 && s <= 59;

/**
 * Wall-clock in a named IANA zone → UTC Date, DST-aware.
 *
 * Same approach as localNYToUTC (src/n8n-helpers.js): guess the instant as if
 * the wall clock were UTC, ask Intl how that instant renders in the target
 * zone, and correct by the difference. Correct across DST boundaries because
 * the offset is measured at the instant in question rather than assumed.
 */
export function zonedWallClockToUtc(timeZone, y, monthIdx, d, h = 0, min = 0, s = 0) {
  const utcGuess = Date.UTC(y, monthIdx, d, h, min, s);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(
    fmt.formatToParts(new Date(utcGuess)).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]),
  );
  // Intl renders midnight as hour 24 in some locales/zones; normalize.
  const hour = p.hour === '24' ? 0 : Number(p.hour);
  const rendered = Date.UTC(+p.year, +p.month - 1, +p.day, hour, +p.minute, +p.second);
  const offsetMs = rendered - utcGuess;
  return new Date(utcGuess - offsetMs);
}

/** Pacific wall clock → UTC. The Call Log report emits Pacific. */
export function pacificWallClockToUtc(y, monthIdx, d, h = 0, min = 0, s = 0) {
  return zonedWallClockToUtc('America/Los_Angeles', y, monthIdx, d, h, min, s);
}

/**
 * Parse a Five9 Call Log timestamp cell (Pacific wall clock) → UTC Date.
 *
 * Five9's saved-report cells are plain strings and the exact shape depends on
 * how the report is configured, so several known shapes are accepted:
 *
 *   2026-08-20 14:30:12      2026-08-20T14:30:12
 *   8/20/2026 2:30:12 PM     08/20/2026 14:30
 *
 * Anything else returns null RATHER THAN GUESSING. A null propagates to the
 * caller as an ineligible/review reason; inventing a timestamp here would
 * produce a confidently wrong call_start and mis-join every recording for it.
 */
export function parsePacificReportTimestamp(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;

  // RFC-822-ish, and THE FORMAT THIS DOMAIN ACTUALLY EMITS (verified against
  // the live Call Log 2026-08-21): 'Fri, 21 Aug 2026 09:00:12'. The leading
  // weekday is optional. This case is first because it is the real one — the
  // two below are defensive, for a differently-configured saved report.
  let m = /^(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) {
    const month = MONTHS[m[2].toLowerCase()];
    if (month === undefined) return null;
    const [day, y, h, min, sec] = [int(m[1]), int(m[3]), int(m[4]), int(m[5]), int(m[6] ?? 0)];
    if (!validYmd(y, month + 1, day) || !validHms(h, min, sec)) return null;
    return pacificWallClockToUtc(y, month, day, h, min, sec);
  }

  // ISO-ish: YYYY-MM-DD[ T]HH:MM[:SS]
  m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) {
    const [y, month, day, h, min, sec] = [int(m[1]), int(m[2]), int(m[3]), int(m[4]), int(m[5]), int(m[6] ?? 0)];
    if (!validYmd(y, month, day) || !validHms(h, min, sec)) return null;
    return pacificWallClockToUtc(y, month - 1, day, h, min, sec);
  }

  // US-ish: M/D/YYYY H:MM[:SS] [AM|PM]
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/.exec(s);
  if (m) {
    const [month, day, y, min, sec] = [int(m[1]), int(m[2]), int(m[3]), int(m[5]), int(m[6] ?? 0)];
    let hour = int(m[4]);
    const mer = (m[7] || '').toUpperCase();
    // With a meridiem the clock is 1–12; without one it is already 24-hour.
    if (mer) {
      if (hour < 1 || hour > 12) return null;
      if (mer === 'PM' && hour !== 12) hour += 12;
      if (mer === 'AM' && hour === 12) hour = 0;
    }
    if (!validYmd(y, month, day) || !validHms(hour, min, sec)) return null;
    return pacificWallClockToUtc(y, month - 1, day, hour, min, sec);
  }

  return null;
}

/**
 * Recording-filename clock → UTC, at a FIXED offset with NO DST.
 *
 * The Recordings export config is pinned to EST (GMT-05:00) year-round, so the
 * offset is a constant (-300) and NOT America/New_York. Using the named zone
 * would add an hour from March to November — verified against a real file:
 * '4_30_12 PM' in a 8_5_2026 folder was written at 21:30 UTC, which is
 * 16:30 EST. America/New_York would have made it 20:30 UTC and missed the
 * call by a full hour.
 *
 * @param {object}  a
 * @param {string}  a.dateDir    the folder name, 'M_D_YYYY', not zero-padded
 * @param {string}  a.clockText  the filename clock, 'H_MM_SS AM/PM'
 * @param {number}  a.offsetMin  signed minutes, -300 for EST (config default)
 * @returns {Date|null} null when either fragment is unparseable — never a guess
 */
export function filenameClockToUtc({ dateDir, clockText, offsetMin = -300 } = {}) {
  const date = parseDateDir(dateDir);
  const clock = parseClockText(clockText);
  if (!date || !clock) return null;
  // Wall clock in a fixed-offset zone: UTC = wall - offset.
  const wallAsUtc = Date.UTC(date.year, date.monthIdx, date.day, clock.hour, clock.minute, clock.second);
  return new Date(wallAsUtc - offsetMin * 60 * 1000);
}

/**
 * Parse a date folder: 'M_D_YYYY'.
 *
 * LENIENT on zero-padding, deliberately asymmetric with dateDirFor(). The
 * archive spells these unpadded ('8_5_2026'), so that is what we must WRITE
 * when constructing a path to crawl — a padded path does not exist on the
 * server and would find nothing. But when READING a directory listing,
 * rejecting a padded name would mean skipping real recordings if the export
 * ever changed its formatting. Strict out, tolerant in.
 *
 * Impossible dates are still rejected: '13_45_2026' must not roll over into
 * 2027, which is what Date would do unchecked.
 */
export function parseDateDir(dirName) {
  const m = /^(\d{1,2})_(\d{1,2})_(\d{4})$/.exec(String(dirName ?? '').trim());
  if (!m) return null;
  const month = int(m[1]);
  const day = int(m[2]);
  const year = int(m[3]);
  if (!validYmd(year, month, day)) return null;
  return { year, monthIdx: month - 1, day };
}

/**
 * Build the date folder for an instant, in the FIXED recording offset.
 * Unpadded, because that is how the archive spells it — a zero-padded path
 * simply does not exist on the server and the crawl would find nothing.
 */
export function dateDirFor(date, offsetMin = -300) {
  const shifted = new Date(date.getTime() + offsetMin * 60 * 1000);
  return `${shifted.getUTCMonth() + 1}_${shifted.getUTCDate()}_${shifted.getUTCFullYear()}`;
}

/** Parse 'H_MM_SS AM/PM' (the filename clock). Seconds are required. */
export function parseClockText(text) {
  const m = /^(\d{1,2})_(\d{2})_(\d{2})\s*([AaPp][Mm])$/.exec(String(text ?? '').trim());
  if (!m) return null;
  let hour = int(m[1]);
  const minute = int(m[2]);
  const second = int(m[3]);
  const mer = m[4].toUpperCase();
  if (hour < 1 || hour > 12 || minute > 59 || second > 59) return null;
  if (mer === 'PM' && hour !== 12) hour += 12;
  if (mer === 'AM' && hour === 12) hour = 0;
  return { hour, minute, second };
}

/**
 * Split [from, to) into windows no longer than maxHours.
 *
 * The Call Log report caps at 5000 rows and silently truncates past it, so the
 * caller pulls in slices and asserts the row count per slice. Splitting is
 * deterministic and inclusive of the tail remainder; a zero/negative span
 * yields no windows rather than looping forever.
 */
export function splitWindows(from, to, maxHours = 6) {
  const start = from instanceof Date ? from.getTime() : new Date(from).getTime();
  const end = to instanceof Date ? to.getTime() : new Date(to).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const stepMs = Math.max(1, maxHours) * 60 * 60 * 1000;
  const out = [];
  for (let t = start; t < end; t += stepMs) {
    out.push({ from: new Date(t), to: new Date(Math.min(t + stepMs, end)) });
  }
  return out;
}

/**
 * Format a UTC instant as the naive local-datetime string Five9 report
 * criteria expect: 'YYYY-MM-DDTHH:MM:SS', no 'Z' and no offset. The criteria
 * are interpreted in the domain's reporting zone (Pacific), so the caller
 * converts UTC → Pacific wall clock before formatting.
 */
export function toPacificCriteriaString(date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(
    fmt.formatToParts(date).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]),
  );
  const hour = p.hour === '24' ? '00' : p.hour;
  return `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}:${p.second}`;
}

/**
 * Last four digits of a phone number, for logs.
 *
 * Security posture (handoff §10): logs carry ci_calls.id plus last-4 only —
 * never a full number, transcript text, or note body. The repo has no existing
 * masking helper, so this is the first; centralizing it means a log site
 * cannot accidentally interpolate the raw value.
 */
export function last4(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits ? `x${digits.slice(-4)}` : 'x????';
}

/** Normalize a phone to its last 10 digits for comparison (LP stores 10). */
export function last10(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}
