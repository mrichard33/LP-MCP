// ─── LP Sales Schedule Reader — src/services/sales-schedule.js ───────────────
//
// READ-ONLY. Fetches Lead Perfection's real appointment capacity from
// POST /api/SalesApi/GetSalesSchedule and reconciles it against what the GHL
// booking calendars have actually accepted.
//
// WHY THIS EXISTS
// A GHL calendar carries a single static "max appointments per slot" number.
// LP carries the truth: per rep, per day, per market, per slot band, with a
// HasApptScheduled flag. Those two numbers have never been compared, so the
// booking calendar can accept more appointments than there are reps to run
// them. This module makes the gap measurable BEFORE anything writes.
//
// LP SLOT MODEL — three bands per day, not five clock times:
//   SlotId 1 = "M" morning    (TmsTime marker  9:00am)
//   SlotId 2 = "A" afternoon  (TmsTime marker 12:59pm)
//   SlotId 3 = "E" evening    (TmsTime marker  4:59pm)
// GHL offers 10:00 / 14:00 / 18:00 / 18:30 / 19:00 ET. The three evening clock
// times all consume the SAME single evening rep-slot, which is where oversell
// concentrates. Band boundaries are derived from the TmsTime markers in the
// live LP response so this self-adapts if LP retimes a band; BAND_FALLBACK is
// used only when LP returns no parseable marker.
//
// KNOWN LIMIT — market attribution.
// GHL appointment rows carry no market field, so the GHL side of the
// reconciliation is company-wide. LP capacity IS returned split by market so
// the per-market shape is visible. Attributing each GHL appointment to a
// market needs a contact-zip join (see check_service_area) and is deliberately
// out of scope for this first read-only pass — a single company-wide number
// cannot drive per-market decisions and should not be presented as if it can.
//
// LAYERING NOTE: hlRunSQL is imported from tools/admin/hl-fallback.js, which
// already owns the HL Supabase client. Reusing it avoids standing up a second
// client for the same database. The two Supabases remain separate — nothing
// here cross-joins them; LP capacity and GHL bookings are fetched
// independently and merged in JS on the date key.

import { lpPost, withCircuit } from '../lp-client.js';
import { hlRunSQL } from '../tools/admin/hl-fallback.js';

const LP_SCHEDULE_PATH = '/api/SalesApi/GetSalesSchedule';

// Window Estimate — carries ~99% of live booking volume.
export const DEFAULT_CALENDAR_IDS = ['aJj14ONxh1oFyDcQ706O'];

// The five clock times the business actually runs appointments at (ET).
export const OFFICIAL_TIMES_ET = ['10:00', '14:00', '18:00', '18:30', '19:00'];

// Used only if LP returns no parseable TmsTime marker.
const BAND_FALLBACK = [
  { slot_id: 1, code: 'M', marker: '9:00am', start_minute: 540 },
  { slot_id: 2, code: 'A', marker: '12:59pm', start_minute: 779 },
  { slot_id: 3, code: 'E', marker: '4:59pm', start_minute: 1019 },
];

const BAND_ORDER = ['M', 'A', 'E'];

// ─── date helpers (business runs in America/New_York) ────────────────────────

const ET_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Current ET calendar date as YYYY-MM-DD. */
export function etTodayKey() {
  return ET_DATE_FMT.format(new Date());
}

/** Shift a YYYY-MM-DD key by n days. Anchored at UTC noon so DST can't slip it. */
export function addDaysKey(key, n) {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** YYYY-MM-DD -> MM/DD/YYYY (the format LP expects). */
function keyToLpDate(key) {
  const [y, m, d] = key.split('-');
  return `${m}/${d}/${y}`;
}

/** LP returns "7/25/26" (M/D/YY). Normalise to YYYY-MM-DD for joining. */
function lpDateToKey(raw) {
  const m = String(raw || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${yr}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

/** "12:59pm" -> minutes since midnight. Null if unparseable. */
function parseTmsTime(raw) {
  const m = String(raw || '').trim().toLowerCase().match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  if (m[3] === 'pm' && h !== 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  return h * 60 + parseInt(m[2], 10);
}

/** "18:30" -> minutes since midnight. */
function hhmmToMinutes(raw) {
  const m = String(raw || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// ─── band derivation ─────────────────────────────────────────────────────────

/**
 * Derive band boundaries from the live LP response. Falls back to
 * BAND_FALLBACK when LP gives us nothing parseable.
 */
export function deriveBandBoundaries(lpDays) {
  const seen = new Map();
  for (const day of lpDays || []) {
    for (const rep of day?.Availability || []) {
      for (const slot of rep?.Slots || []) {
        const startMinute = parseTmsTime(slot?.TmsTime);
        if (startMinute === null || slot?.SlotId === undefined) continue;
        if (seen.has(slot.SlotId)) continue;
        seen.set(slot.SlotId, {
          slot_id: slot.SlotId,
          code: String(slot.SlotDescr || '').trim() || `S${slot.SlotId}`,
          marker: String(slot.TmsTime).trim(),
          start_minute: startMinute,
        });
      }
    }
  }
  if (!seen.size) return [...BAND_FALLBACK];
  return [...seen.values()].sort((a, b) => a.start_minute - b.start_minute);
}

/** Bucket a minutes-since-midnight value into a band code. */
export function bandForMinutes(minutes, boundaries) {
  if (minutes === null || minutes === undefined) return null;
  let code = boundaries[0]?.code ?? null;
  for (const b of boundaries) {
    if (minutes >= b.start_minute) code = b.code;
  }
  return code;
}

function emptyBandMap() {
  const out = {};
  for (const code of BAND_ORDER) out[code] = { slots: 0, booked: 0, open: 0 };
  return out;
}

// ─── LP capacity ─────────────────────────────────────────────────────────────

/**
 * Fetch the raw LP sales schedule for an inclusive ET date range.
 * Read-only: GetSalesSchedule is a Get* endpoint and mutates nothing.
 */
export async function fetchSalesSchedule({ startKey, endKey }) {
  const spanDays =
    Math.round(
      (new Date(`${endKey}T12:00:00Z`) - new Date(`${startKey}T12:00:00Z`)) / 86400000
    ) + 1;
  const fields = {
    startdate: keyToLpDate(startKey),
    enddate: keyToLpDate(endKey),
    PageSize: '500',
    StartIndex: '1',
  };
  // Wide ranges need the long timeout budget; short ones stay fail-fast.
  const fast = spanDays <= 3;
  const raw = await withCircuit(() => lpPost(LP_SCHEDULE_PATH, fields, 2, { fast }));
  return Array.isArray(raw) ? raw : [];
}

/**
 * Roll LP's per-rep slot grid up into per-date capacity, split by band and by
 * market. "slots" = rep-slots that exist, "booked" = HasApptScheduled true,
 * "open" = still bookable in LP.
 */
export function rollupCapacity(lpDays, boundaries) {
  const byDate = new Map();

  for (const day of lpDays || []) {
    const key = lpDateToKey(day?.Date);
    if (!key) continue;

    if (!byDate.has(key)) {
      byDate.set(key, {
        date: key,
        slots_per_day: day?.SlotsPerDay ?? null,
        rep_count: 0,
        bands: emptyBandMap(),
        by_market: {},
      });
    }
    const bucket = byDate.get(key);

    for (const rep of day?.Availability || []) {
      bucket.rep_count += 1;
      const market = String(rep?.RepHomeMarket || 'UNKNOWN').trim() || 'UNKNOWN';
      if (!bucket.by_market[market]) bucket.by_market[market] = emptyBandMap();

      for (const slot of rep?.Slots || []) {
        const minutes = parseTmsTime(slot?.TmsTime);
        const code =
          bandForMinutes(minutes, boundaries) ??
          String(slot?.SlotDescr || '').trim() ??
          null;
        if (!code || !bucket.bands[code]) continue;

        const booked = slot?.HasApptScheduled === true;
        for (const target of [bucket.bands[code], bucket.by_market[market][code]]) {
          target.slots += 1;
          if (booked) target.booked += 1;
          else target.open += 1;
        }
      }
    }
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// ─── GHL bookings (HL Supabase cache) ────────────────────────────────────────

/** Calendar IDs are interpolated into SQL — allow only GHL's id charset. */
function assertCalendarIds(ids) {
  const clean = (ids || []).map((s) => String(s).trim()).filter(Boolean);
  if (!clean.length) throw new Error('At least one calendar_id is required.');
  for (const id of clean) {
    if (!/^[A-Za-z0-9]{16,32}$/.test(id)) {
      throw new Error(`Invalid calendar_id "${id}" — expected 16-32 alphanumeric chars.`);
    }
  }
  return clean;
}

/**
 * What GHL has actually accepted, per ET date and clock time, for the given
 * calendars. Excludes soft-deleted rows and cancellations — a cancelled
 * appointment consumes no rep.
 */
export async function fetchGhlBookings({ calendarIds, startKey, endKey }) {
  const ids = assertCalendarIds(calendarIds);
  const inList = ids.map((id) => `'${id}'`).join(',');
  const endExclusive = addDaysKey(endKey, 1);

  const sql = `
    SELECT to_char(start_time AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS date_et,
           to_char(start_time AT TIME ZONE 'America/New_York', 'HH24:MI')    AS time_et,
           count(*)::int AS booked
    FROM appointments
    WHERE deleted_at IS NULL
      AND ghl_calendar_id IN (${inList})
      AND COALESCE(status, '') NOT IN ('cancelled', 'canceled')
      AND start_time >= '${startKey}'
      AND start_time <  '${endExclusive}'
    GROUP BY 1, 2
    ORDER BY 1, 2`;

  const rows = await hlRunSQL(sql);
  return Array.isArray(rows) ? rows : [];
}

// ─── reconciliation ──────────────────────────────────────────────────────────

/**
 * Merge LP capacity with GHL bookings and flag the mismatches.
 *
 * Findings are deliberately conservative. `ghl_booked` and `lp_booked` are NOT
 * the same population — LP also holds call-centre and canvass appointments set
 * outside GHL — so we never subtract one from the other. The defensible signal
 * is GHL bookings against LP's TOTAL rep-slots for that band, which is a hard
 * ceiling regardless of which system did the booking.
 */
export async function reconcileCapacity({
  days = 14,
  calendar_ids = DEFAULT_CALENDAR_IDS,
  official_times = OFFICIAL_TIMES_ET,
} = {}) {
  const span = Math.max(1, Math.min(Number(days) || 14, 60));
  const startKey = etTodayKey();
  const endKey = addDaysKey(startKey, span - 1);

  const lpRaw = await fetchSalesSchedule({ startKey, endKey });
  const boundaries = deriveBandBoundaries(lpRaw);
  const lpDays = rollupCapacity(lpRaw, boundaries);

  let ghlRows = [];
  let ghlError = null;
  try {
    ghlRows = await fetchGhlBookings({ calendarIds: calendar_ids, startKey, endKey });
  } catch (err) {
    // LP capacity on its own is still worth returning.
    ghlError = err.message;
  }

  const officialSet = new Set(official_times);
  const ghlByDate = new Map();
  for (const row of ghlRows) {
    const key = row.date_et;
    if (!ghlByDate.has(key)) {
      ghlByDate.set(key, { bands: { M: 0, A: 0, E: 0 }, off_schedule: [], total: 0 });
    }
    const bucket = ghlByDate.get(key);
    const minutes = hhmmToMinutes(row.time_et);
    const code = bandForMinutes(minutes, boundaries);
    const n = Number(row.booked) || 0;
    if (code && bucket.bands[code] !== undefined) bucket.bands[code] += n;
    bucket.total += n;
    if (!officialSet.has(row.time_et)) {
      bucket.off_schedule.push({ time_et: row.time_et, booked: n });
    }
  }

  const allDates = new Set([...lpDays.map((d) => d.date), ...ghlByDate.keys()]);
  const out = [];

  for (const date of [...allDates].sort()) {
    const lp = lpDays.find((d) => d.date === date) || {
      date,
      slots_per_day: null,
      rep_count: 0,
      bands: emptyBandMap(),
      by_market: {},
    };
    const ghl = ghlByDate.get(date) || { bands: { M: 0, A: 0, E: 0 }, off_schedule: [], total: 0 };

    const findings = [];
    for (const code of BAND_ORDER) {
      const capacity = lp.bands[code]?.slots ?? 0;
      const booked = ghl.bands[code] ?? 0;
      if (booked === 0) continue;
      if (capacity === 0) {
        findings.push({
          band: code,
          severity: 'critical',
          code: 'no_lp_capacity',
          detail: `${booked} booked in GHL, LP has no ${code} rep-slots this date.`,
        });
      } else if (booked > capacity) {
        findings.push({
          band: code,
          severity: 'critical',
          code: 'oversold',
          detail: `${booked} booked in GHL vs ${capacity} total LP rep-slots.`,
        });
      } else if (booked / capacity >= 0.9) {
        findings.push({
          band: code,
          severity: 'warning',
          code: 'at_capacity',
          detail: `${booked} booked in GHL vs ${capacity} total LP rep-slots (>=90%).`,
        });
      }
    }
    const offCount = ghl.off_schedule.reduce((s, r) => s + r.booked, 0);
    if (offCount > 0) {
      findings.push({
        band: null,
        severity: 'warning',
        code: 'off_schedule',
        detail: `${offCount} appointment(s) booked outside the official times.`,
        times: ghl.off_schedule,
      });
    }

    out.push({
      date,
      lp: {
        rep_count: lp.rep_count,
        slots_per_day: lp.slots_per_day,
        bands: lp.bands,
        by_market: lp.by_market,
      },
      ghl: { bands: ghl.bands, total: ghl.total, off_schedule: ghl.off_schedule },
      findings,
    });
  }

  const critical = out.filter((d) => d.findings.some((f) => f.severity === 'critical'));

  return {
    generated_at: new Date().toISOString(),
    window: { start_date: startKey, end_date: endKey, days: span },
    calendars: calendar_ids,
    official_times_et: official_times,
    band_boundaries: boundaries,
    notes: [
      'READ-ONLY. Nothing was written to LP, GHL, agent_actions or system_events.',
      'GHL bookings are company-wide: appointment rows carry no market field. LP capacity is split by market so the shape is visible.',
      'lp.booked and ghl.bands are different populations (LP also holds call-centre and canvass appointments). Findings compare GHL bookings against LP TOTAL rep-slots, which is a hard ceiling either way.',
      "GHL's 18:00, 18:30 and 19:00 all consume the SAME single LP evening rep-slot.",
    ],
    ghl_query_error: ghlError,
    summary: {
      days_analysed: out.length,
      days_with_critical: critical.length,
      critical_dates: critical.map((d) => d.date),
    },
    days: out,
  };
}

/** Thin wrapper: LP capacity only, no GHL comparison. */
export async function getSalesSchedule({ days = 7, group_by_market = true } = {}) {
  const span = Math.max(1, Math.min(Number(days) || 7, 60));
  const startKey = etTodayKey();
  const endKey = addDaysKey(startKey, span - 1);

  const lpRaw = await fetchSalesSchedule({ startKey, endKey });
  const boundaries = deriveBandBoundaries(lpRaw);
  const rolled = rollupCapacity(lpRaw, boundaries);

  return {
    generated_at: new Date().toISOString(),
    window: { start_date: startKey, end_date: endKey, days: span },
    band_boundaries: boundaries,
    source: `LP ${LP_SCHEDULE_PATH} (read-only)`,
    days: rolled.map((d) => ({
      date: d.date,
      rep_count: d.rep_count,
      slots_per_day: d.slots_per_day,
      bands: d.bands,
      ...(group_by_market ? { by_market: d.by_market } : {}),
    })),
  };
}
