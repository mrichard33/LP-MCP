/**
 * Quiet Hours — src/services/quiet-hours.js
 *
 * Conversation Quality Pass v1.0, Item 2 (2026-07-07). Evidence: a proactive
 * booking push landed at 9:09 PM ET with sends continuing to 9:33 PM — past
 * the 9 PM courtesy/TCPA line, ~40 minutes after the lead went quiet.
 *
 * Policy: bot-INITIATED sends (hold returns, follow-up re-engagements,
 * dead-man-switch confirmations — anything not answering a fresh inbound)
 * are gated to the QUIET_HOURS_END–QUIET_HOURS_START window in
 * America/New_York (defaults: 08:00–21:00 ET). Outside the window the send
 * is HELD (deferral → retry_at = next window open), never dropped — the
 * always-respond policy is law, quiet hours delay, they do not silence.
 * Direct replies to a fresh inbound are ALWAYS allowed at any hour (the
 * caller makes that determination; this module only answers time questions).
 *
 * DST-safe: all wall-clock math goes through Intl.DateTimeFormat with
 * timeZone (same pattern as src/appointment-dates.js etYmd) — the UTC
 * offset is derived per-instant via timeZoneName:'shortOffset', so
 * EST(-05:00)/EDT(-04:00) transitions are handled by the platform.
 *
 * Env: QUIET_HOURS_START (default '21:00'), QUIET_HOURS_END (default
 * '08:00') — ET wall-clock 'HH:MM'. Mark can tune without a deploy.
 *
 * QUIET_HOURS_BYPASS_CONTACT_IDS (2026-08-14) — comma-separated GHL contact
 * ids exempt from the hold. QA only: it exists so the full loop, including
 * bot-INITIATED sends (hold returns, follow-up re-engagements), can be
 * exercised after 9 PM ET against a test contact. Deliberately an id
 * allowlist rather than a global switch or a tag:
 *   - a global switch (start === end) would disable the TCPA/courtesy line
 *     for every real customer;
 *   - a tag would need a GHL read on the send path, which can fail, and a
 *     failed read must never be the reason a real customer gets a 10 PM text.
 * An id list is inert for everyone not named in it and costs no I/O.
 */

const TZ = 'America/New_York';

function parseHHMM(raw, fallbackMinutes) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw || '').trim());
  if (!m) return fallbackMinutes;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return fallbackMinutes;
  return h * 60 + min;
}

function quietStartMinutes() {
  return parseHHMM(process.env.QUIET_HOURS_START, 21 * 60); // 9:00 PM ET
}

function quietEndMinutes() {
  return parseHHMM(process.env.QUIET_HOURS_END, 8 * 60);    // 8:00 AM ET
}

/** ET wall-clock parts + UTC offset (minutes) for an instant. */
function etParts(date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZoneName: 'shortOffset',
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  // 'GMT-4' / 'GMT-04:00' → minutes east of UTC (negative for ET)
  const offMatch = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(parts.timeZoneName || '');
  const offsetMin = offMatch
    ? (offMatch[1] === '-' ? -1 : 1) * (Number(offMatch[2]) * 60 + Number(offMatch[3] || 0))
    : -300;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Intl can render midnight as '24' with hour12:false on some ICU builds
    minutesOfDay: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
    offsetMin,
  };
}

/**
 * True when `now` falls inside quiet hours (ET). The window wraps midnight
 * (e.g. 21:00 → 08:00). A degenerate config where start === end disables
 * quiet hours entirely (never quiet).
 */
export function isInQuietHours(now = new Date()) {
  const start = quietStartMinutes();
  const end = quietEndMinutes();
  if (start === end) return false;
  const { minutesOfDay } = etParts(now);
  if (start > end) {
    // wraps midnight: quiet if >= start OR < end
    return minutesOfDay >= start || minutesOfDay < end;
  }
  return minutesOfDay >= start && minutesOfDay < end;
}

/**
 * The next instant (UTC ISO string) at which the send window opens —
 * QUIET_HOURS_END ET today or tomorrow, whichever is next. Only meaningful
 * when isInQuietHours(now) is true, but safe to call anytime.
 */
export function nextSendWindowOpenAt(now = new Date()) {
  const end = quietEndMinutes();
  const { year, month, day, minutesOfDay, offsetMin } = etParts(now);

  // Candidate: today at END (ET). If we're already past it, tomorrow at END.
  const dayShift = minutesOfDay < end ? 0 : 1;
  // Build the ET wall-clock target as if it were UTC, then remove the offset.
  const target = new Date(Date.UTC(year, month - 1, day + dayShift, Math.floor(end / 60), end % 60, 0, 0));
  let openAt = new Date(target.getTime() - offsetMin * 60 * 1000);

  // DST edge: the offset at the TARGET instant may differ from the offset
  // now (spring-forward/fall-back night). One correction pass lands within
  // the correct hour.
  const check = etParts(openAt);
  if (check.offsetMin !== offsetMin) {
    openAt = new Date(target.getTime() - check.offsetMin * 60 * 1000);
  }
  return openAt.toISOString();
}

/**
 * True when this contact is exempt from the quiet-hours hold.
 *
 * Read per call, not captured at module load, so the allowlist can be changed
 * in Railway without a redeploy — same reasoning as configuredInOfficeSenderName
 * in src/response-generator.js.
 *
 * @param {string|null} contactId  GHL contact id
 */
export function isQuietHoursBypassed(contactId) {
  if (!contactId) return false;
  const raw = process.env.QUIET_HOURS_BYPASS_CONTACT_IDS;
  if (!raw) return false;
  const wanted = String(contactId).trim();
  if (!wanted) return false;
  return String(raw)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .includes(wanted);
}

export default { isInQuietHours, nextSendWindowOpenAt, isQuietHoursBypassed };
