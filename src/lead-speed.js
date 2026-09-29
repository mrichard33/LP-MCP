/**
 * Time to first call — src/lead-speed.js
 *
 * Pure and dependency-free (the same shape as src/lead-leak-classify.js), so
 * every rule here unit-tests offline (scripts/test-lead-speed.js).
 *
 * FIVE9 IS THE ONLY CLOCK FOR "WHEN WAS THIS LEAD CALLED" (ruled 2026-09-26).
 * LP's call data is not used for timing at all: raw_lp_data.firstcalldate has a
 * 60-day median of 7 SECONDS after creation — it is the call that created the
 * lead, not anyone calling the lead back — and call_count is known to be wrong
 * (679 "Set" leads with zero calls). A lead's first call is the first Five9
 * disposition event on its LDS key or its phone at or after the lead existed.
 *
 * LP TIMESTAMPS ARE EASTERN WALL-CLOCK TIME LABELLED AS UTC (measured
 * 2026-09-26). lp_leads.created_at_lp and updated_at_lp carry LP's local
 * `dateentered` / `lastchangedon` digits with a +00 offset: at 21:46 UTC the
 * newest lead read 17:44 "UTC", 4.02h earlier, and matched `dateentered`
 * exactly. Five9's call_start_at is real UTC. Comparing the two raw would make
 * every lead look created four (five, in winter) hours earlier than it was —
 * so every LP time passes through lpLocalToUtcMs before it meets a Five9 time.
 *
 * THE CLOCK ONLY RUNS WHILE THE CALL CENTER IS OPEN. A lead that arrives at
 * 11pm and is called at 8:05am was not ignored for nine hours — it waited five
 * minutes. "Time to first call", "waiting" and the "no retry" gap all count
 * business hours only (BUSINESS_HOURS below). Measuring raw clock time would
 * page every morning on the overnight leads — an alarm that fires on the
 * healthy case gets muted (CLAUDE.md, "Classify before you threshold").
 *
 * 2026-09-29 (the user's ruling): business hours are 8am–8pm Monday–Friday and
 * 9am–5pm Saturday–Sunday, ET. Before this the clock started at the next
 * opening but then ran straight through every night after it, so a lead that
 * arrived at 3pm and was still waiting at 9am the next day read ~18h, not 6h;
 * and weekends used the weekday hours.
 */

export const TIMEZONE = 'America/New_York';
// Hours the phones are worked, ET, 24h clock. Change them here and nowhere else.
export const BUSINESS_HOURS = Object.freeze({
  weekday: Object.freeze({ open: 8, close: 20 }), // Monday–Friday
  weekend: Object.freeze({ open: 9, close: 17 }), // Saturday, Sunday
});

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/** ET wall-clock fields for a true UTC instant. */
function etParts(ms) {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second),
  };
}

/** ET offset from UTC at an instant, in ms (−4h in summer, −5h in winter). */
function etOffsetMs(ms) {
  const f = etParts(ms);
  const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** A true UTC instant for ET wall-clock fields (DST-aware). */
function etWallToUtcMs(year, month, day, hour = 0, minute = 0, second = 0, ms = 0) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  let utc = guess - etOffsetMs(guess);
  utc = guess - etOffsetMs(utc); // second pass settles the DST-change hour
  return utc;
}

/**
 * The real UTC instant of an LP timestamp. LP's digits are Eastern wall-clock
 * time whatever offset the column claims (see header), so the offset is
 * discarded and the digits are read as America/New_York. Null if unreadable.
 */
export function lpLocalToUtcMs(ts) {
  if (ts == null || ts === '') return null;
  const m = String(ts).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?/);
  if (!m) return null;
  const ms = m[7] ? Number(m[7].padEnd(3, '0').slice(0, 3)) : 0;
  return etWallToUtcMs(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0), ms);
}

/** ET calendar day (YYYY-MM-DD) of a true UTC instant. */
export function etDay(ms) {
  const f = etParts(ms);
  return `${f.year}-${String(f.month).padStart(2, '0')}-${String(f.day).padStart(2, '0')}`;
}

/** Business hours for an ET calendar date: { open, close } (24h clock). */
export function hoursForDay(year, month, day) {
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 = Sunday
  return dow === 0 || dow === 6 ? BUSINESS_HOURS.weekend : BUSINESS_HOURS.weekday;
}

/** The opening and closing instants (true UTC ms) of the ET day containing `ms`. */
function dayWindow(ms) {
  const f = etParts(ms);
  const h = hoursForDay(f.year, f.month, f.day);
  return {
    f,
    openMs: etWallToUtcMs(f.year, f.month, f.day, h.open),
    closeMs: etWallToUtcMs(f.year, f.month, f.day, h.close),
  };
}

/** Midnight ET at the start of the calendar day after the ET date `f`. */
function nextEtMidnight(f) {
  const n = new Date(Date.UTC(f.year, f.month - 1, f.day + 1));
  return etWallToUtcMs(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), 0);
}

/**
 * When the phones could first have rung for something that arrived at `ms`:
 * `ms` itself inside business hours, else the next opening (the same day's if
 * it is still early, otherwise the next day's — weekend hours on a weekend).
 */
export function workingStartMs(ms) {
  let t = ms;
  for (let guard = 0; guard < 14; guard += 1) {
    const { f, openMs, closeMs } = dayWindow(t);
    if (t < openMs) return openMs;
    if (t < closeMs) return t;
    t = nextEtMidnight(f);
  }
  return t;
}

/** Is the call center open at `ms`? */
export const isOpenAt = (ms) => workingStartMs(ms) === ms;

/** First value in an ascending array that is ≥ t, or null (binary search). */
function firstAtOrAfter(sorted, t) {
  if (!Array.isArray(sorted) || sorted.length === 0) return null;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < t) lo = mid + 1; else hi = mid;
  }
  return lo < sorted.length ? sorted[lo] : null;
}

/**
 * The first Five9 call on this lead at or after it existed, as a true UTC ms,
 * or null if Five9 never rang it.
 *
 * ctx.five9Keys   Map 'LDS<lp_lead_id>' → ascending call times (ms)
 * ctx.five9Phones Map phone10           → ascending call times (ms), any event
 * `phone10` is the lead's normalized phone (the caller normalizes).
 *
 * A call BEFORE the lead existed is ignored — that was an earlier lead for the
 * same household, or the inbound call that created this one. A lead with no
 * readable creation time takes the earliest call (it can hide a leak, never
 * invent one).
 */
export function firstCallAfter({ leadId, phone10, createdAtLp }, ctx) {
  const createdMs = lpLocalToUtcMs(createdAtLp);
  const from = createdMs ?? -Infinity;
  const byKey = leadId != null ? firstAtOrAfter(ctx.five9Keys?.get(`LDS${String(leadId).trim()}`), from) : null;
  const byPhone = phone10 ? firstAtOrAfter(ctx.five9Phones?.get(phone10), from) : null;
  if (byKey == null) return byPhone;
  if (byPhone == null) return byKey;
  return Math.min(byKey, byPhone);
}

/**
 * LEADS THAT ARRIVE ON A LIVE CALL (2026-09-26). Many LP leads are keyed in by
 * an agent DURING an inbound call, so the call starts a few minutes before the
 * lead exists. Measured the day this shipped: correcting LP's clock moved ~590
 * leads from "called" to "uncalled", and they were overwhelmingly these. A
 * customer who was on the phone with us when the lead was made was worked, not
 * missed. So a Five9 call up to CREATION_CALL_WINDOW_MIN before creation marks
 * the lead as reached — and such a lead is kept out of the time-to-first-call
 * numbers, because it never waited for a call at all.
 */
export const CREATION_CALL_WINDOW_MIN = 60;

/** The Five9 call that was live when the lead was created, as ms, or null. */
export function creationCallMs({ leadId, phone10, createdAtLp }, ctx) {
  const createdMs = lpLocalToUtcMs(createdAtLp);
  if (createdMs == null) return null;
  const from = createdMs - CREATION_CALL_WINDOW_MIN * MINUTE_MS;
  const inWindow = (list) => {
    const t = firstAtOrAfter(list, from);
    return t != null && t < createdMs ? t : null;
  };
  const byKey = leadId != null ? inWindow(ctx.five9Keys?.get(`LDS${String(leadId).trim()}`)) : null;
  return byKey ?? (phone10 ? inWindow(ctx.five9Phones?.get(phone10)) : null);
}

/**
 * INQUIRY-STAGE CALLS (2026-09-29). Five9 often dials a lead while it is still
 * an LP INQUIRY — lp_rec_key 'INQ…', before LP has stamped the lead — and LP's
 * create time can land hours AFTER that dial. Six leads on the 2026-09-29 card
 * read "Never dialled" though DIAL ASAP had rung each of them 1–3 times on
 * 9/27–9/28 (Answering Machine / Hung Up); Five9's contact record already
 * carried lead_id = the LP lead id at call time, so those were calls to THIS
 * lead. creationCallMs's 60-minute window cannot see them.
 *
 * So a Five9 call on the lead's phone (or key) up to `hours` (env
 * LEAD_PRECREATE_CALL_HOURS, default 48) BEFORE created_at_lp marks the lead
 * as called. Such a lead is kept OUT of the time-to-first-call numbers: its
 * "first call" precedes its creation, so the minutes would read 0 or negative
 * and flatter the floor. Excluded, not counted as 0.
 *
 * The Eastern-offset reading in lpLocalToUtcMs is unchanged; this only widens
 * what counts as "called", it does not move LP's clock.
 *
 * Returns { count, lastMs } over [created − hours, created), or null.
 */
export const PRECREATE_CALL_HOURS = 48;

export function precreateCalls({ leadId, phone10, createdAtLp }, ctx, hours = PRECREATE_CALL_HOURS) {
  const createdMs = lpLocalToUtcMs(createdAtLp);
  if (createdMs == null) return null;
  const from = createdMs - hours * HOUR_MS;
  const times = new Set();
  const add = (list) => { for (const t of list || []) if (t >= from && t < createdMs) times.add(t); };
  if (leadId != null) add(ctx.five9Keys?.get(`LDS${String(leadId).trim()}`));
  if (phone10) add(ctx.five9Phones?.get(phone10));
  if (!times.size) return null;
  return { count: times.size, lastMs: Math.max(...times) };
}

/**
 * Every Five9 call on this lead from `hours` before it was created onward,
 * ascending and de-duplicated (a call seen on both its key and its phone is one
 * call). What "Called N×" on the waiting card counts.
 */
export function callsSince({ leadId, phone10, createdAtLp }, ctx, hours = PRECREATE_CALL_HOURS) {
  const createdMs = lpLocalToUtcMs(createdAtLp);
  const from = createdMs == null ? -Infinity : createdMs - hours * HOUR_MS;
  const times = new Set();
  const add = (list) => { for (const t of list || []) if (t >= from) times.add(t); };
  if (leadId != null) add(ctx.five9Keys?.get(`LDS${String(leadId).trim()}`));
  if (phone10) add(ctx.five9Phones?.get(phone10));
  return [...times].sort((a, b) => a - b);
}

/**
 * Call-center time between two instants, in ms: only the hours inside
 * BUSINESS_HOURS (ET, weekend hours on weekends) count. "No retry in 4 hours" must not fire at
 * 8:30am on a lead last rung at 7pm — the phones were off for 13 of those hours.
 */
export function workingMsBetween(fromMs, toMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return 0;
  let total = 0;
  let cursor = fromMs;
  for (let guard = 0; guard < 400 && cursor < toMs; guard += 1) {
    const start = workingStartMs(cursor);
    if (start >= toMs) break;
    const { closeMs } = dayWindow(start);
    total += Math.min(closeMs, toMs) - start;
    cursor = closeMs;
  }
  return total;
}

/**
 * Business minutes from the lead's arrival to its first call: closed hours
 * (nights, and outside the shorter weekend hours) never count. A call made
 * before opening (someone dialled early) counts as 0, never negative. Null
 * when there was no call or no creation time.
 */
export function minutesToFirstCall(createdAtLp, firstCallMs) {
  const createdMs = lpLocalToUtcMs(createdAtLp);
  if (createdMs == null || firstCallMs == null) return null;
  return workingMsBetween(createdMs, firstCallMs) / MINUTE_MS;
}

/** How long a still-uncalled lead has been waiting, in business hours only (ms). */
export function waitingMs(createdAtLp, nowMs) {
  const createdMs = lpLocalToUtcMs(createdAtLp);
  if (createdMs == null) return null;
  return workingMsBetween(createdMs, nowMs);
}

/** Percentile (0–1) of a numeric array, linear interpolation. Null when empty. */
export function percentile(values, p) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const idx = (v.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return v[lo] + (v[hi] - v[lo]) * (idx - lo);
}

const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

/**
 * One row per ET creation day, the stored shape of lead_call_speed_daily.
 *
 * `leads` items: { createdDay, minutes, expected }
 *   minutes   working minutes to first Five9 call, null = never called
 *   expected  true when the lead SHOULD have been called — it was called, or it
 *             is uncalled for a leak reason. An uncalled DNC, rep-hold or
 *             already-booked lead was never owed a call, so it is left out of
 *             the called-within shares (classify before you threshold). "Data"
 *             leads count as owed since 2026-09-28.
 *
 * Median/p90 are over called leads only — a never-called lead has no time to
 * average; it shows up in never_called and in the within-24h share instead.
 */
export function dailySpeedRows(leads) {
  const byDay = new Map();
  for (const l of leads || []) {
    if (!l?.createdDay) continue;
    const d = byDay.get(l.createdDay) || { leads: 0, expected: 0, called: 0, never: 0, h1: 0, h24: 0, mins: [] };
    d.leads += 1;
    if (l.minutes != null) {
      d.called += 1;
      d.mins.push(l.minutes);
      if (l.minutes <= 60) d.h1 += 1;
      if (l.minutes <= 24 * 60) d.h24 += 1;
    }
    if (l.expected) {
      d.expected += 1;
      if (l.minutes == null) d.never += 1;
    }
    byDay.set(l.createdDay, d);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, d]) => ({
      created_day: day,
      leads: d.leads,
      expected: d.expected,
      called: d.called,
      never_called: d.never,
      called_1h: d.h1,
      called_24h: d.h24,
      median_min: round1(percentile(d.mins, 0.5)),
      p90_min: round1(percentile(d.mins, 0.9)),
    }));
}

/**
 * The speed numbers over a set of lead items: median working minutes to first
 * call, and the share of owed leads NOT called within 24 working hours.
 */
export function speedStats(leads) {
  const called = (leads || []).filter((l) => l.minutes != null).map((l) => l.minutes);
  const owed = (leads || []).filter((l) => l.expected);
  const slow = owed.filter((l) => l.minutes == null || l.minutes > 24 * 60).length;
  return {
    leads: (leads || []).length,
    owed: owed.length,
    called: called.length,
    median_min: round1(percentile(called, 0.5)),
    p90_min: round1(percentile(called, 0.9)),
    pct_called_1h: owed.length ? owed.filter((l) => l.minutes != null && l.minutes <= 60).length / owed.length : null,
    pct_not_called_24h: owed.length ? slow / owed.length : null,
  };
}

export const _internal = { etOffsetMs, etWallToUtcMs, firstAtOrAfter, HOUR_MS, DAY_MS };
