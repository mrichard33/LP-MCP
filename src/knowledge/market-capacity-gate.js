/**
 * Market capacity gate — src/knowledge/market-capacity-gate.js
 *
 * Mark, 2026-10-15 (handoff v3). The bot books in-home visits from GHL's free
 * slots, and a GHL appointment carries no market: 3,014 of 3,016 Window
 * Estimate bookings in 30 days were made by the API, none of them knowing
 * whether that market's reps had a seat left or had filed availability at all.
 * Mark ruled against per-market GHL calendars; capacity is enforced here.
 *
 *   R1  an in-home time is offered or booked only when the lead's market has an
 *       open LP seat for that date and band (Morning / Afternoon / Evening,
 *       bandOfEtTime in src/jobs/capacity-bands.js: 18:00, 18:30 and 19:00 all
 *       share Evening);
 *   R2  a date past the market's horizon_date (v_capacity_submission_horizon)
 *       is UNFILED, and unfiled is closed (`unfiled`);
 *   R3  a band that overlaps an active market_meeting_blocks row is closed
 *       (`meeting`);
 *   R4  only the BOT's own offers and bookings are gated. Nothing here is read
 *       by the LP→GHL sync, a call-center booking or a manual move: those never
 *       pass a market to fetchFreeSlots, and that is the whole gate;
 *   R7  a market that resolves to nothing (HOU and WSNC today) is not gated,
 *       logged `capacity_gate_skipped:<reason>`.
 *
 * open = rep slots − slots LP already holds − bot bookings not yet in LP. The
 * last term is why every bot book_appointment payload carries
 * `capacity_market`: between the GHL booking and the LP sync the seat is
 * taken in fact but still free in lp_capacity_slots, and two leads could be
 * booked into the same last seat.
 *
 * A capacity read that FAILS opens the gate (fail open, logged): a Supabase
 * blip must never stop the bot from booking at all. An unfiled date is not a
 * failure; it is a closed date.
 *
 * CAPACITY_GATE_ENABLED=false is the kill switch: fetchFreeSlots and the live
 * chat behave exactly as before, and the 6:30/7:00 handling is off too.
 */

import { bandOfEtTime } from '../jobs/capacity-bands.js';

export const CAPACITY_UNIVERSE = Object.freeze(['FTLAU_MKT', 'FTMYR_MKT', 'JAX_MKT', 'ORL_MKT', 'SAR_MKT', 'STPET_MKT']);
const CAPACITY_TZ = 'America/New_York';   // every capacity market is Eastern
const READ_DAYS = 21;                      // one read covers the 14-day offer window and a little more
const IN_HOME = new Set(['aJj14ONxh1oFyDcQ706O', 'zEdPmkNccR2ovo3rQAd3', 'zS1wg0JqQ1zsszJyJqKX']);
// Band edges as wall clock, for the meeting overlap (R3). Derived from the
// band mapper itself so the cuts live only in capacity-bands.js.
const BAND_RANGES = (() => {
  const out = { 1: null, 2: null, 3: null };
  for (let m = 0; m < 24 * 60; m++) {
    const hhmm = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const b = bandOfEtTime(hhmm);
    if (!out[b]) out[b] = { start: m, end: m + 1 };
    else out[b].end = m + 1;
  }
  return out;
})();

export function capacityGateEnabled(env = process.env) {
  return String(env.CAPACITY_GATE_ENABLED ?? 'true').toLowerCase() !== 'false';
}
export function isInHomeCalendar(calendarId) { return IN_HOME.has(calendarId); }
function cacheMs(env = process.env) {
  const n = Number(env.CAPACITY_GATE_CACHE_SECONDS ?? 60);
  return (Number.isFinite(n) && n >= 0 ? n : 60) * 1000;
}
function lookbackHours(env = process.env) {
  const n = Number(env.CAPACITY_GATE_PENDING_LOOKBACK_HOURS ?? 48);
  return Number.isFinite(n) && n > 0 ? n : 48;
}

/** Wall-clock parts of an instant in a zone: { date 'YYYY-MM-DD', hhmm 'HH:MM', dow 0-6 }. Pure. */
export function localParts(iso, tz = CAPACITY_TZ) {
  const t = new Date(iso);
  if (!Number.isFinite(t.getTime())) return null;
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(t).map(x => [x.type, x.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { date: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour}:${p.minute}`, dow };
}
function dowOfDate(ymd) { return new Date(`${ymd}T12:00:00Z`).getUTCDay(); }
function toMinutes(t) { const m = String(t || '').match(/^(\d{1,2}):(\d{2})/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; }

/** True when an active meeting row covers any part of `band` on `date`. Pure. */
export function meetingClosesBand(meetings, date, band) {
  const range = BAND_RANGES[band];
  if (!range) return false;
  const dow = dowOfDate(date);
  return (meetings || []).some(m => {
    if (m.active === false) return false;
    const day = m.specific_date ? String(m.specific_date).slice(0, 10) === date : Number(m.day_of_week) === dow;
    if (!day) return false;
    const s = toMinutes(m.start_local); const e = toMinutes(m.end_local);
    return s != null && e != null && s < range.end && e > range.start;
  });
}

/**
 * Openings per date|band. Pure.
 * @param {object} a
 * @param {Array<{slot_date, slot_id, has_appt}>} a.capacityRows  the market's rep slots
 * @param {string|null} a.horizonDate   last filed date; null = never filed
 * @param {Array} a.meetings            market_meeting_blocks rows
 * @param {Array<{start_iso}>} a.pending  bot bookings not yet in LP
 * @param {string[]} a.dates            'YYYY-MM-DD' dates to report
 * @returns {Map<string, {date, band, capacity, lp_booked, pending_bot, open, filed, closed_reason}>}
 */
export function computeOpenings({ capacityRows = [], horizonDate = null, meetings = [], pending = [], dates = [], tz = CAPACITY_TZ }) {
  const out = new Map();
  const cap = new Map(); const booked = new Map(); const pend = new Map();
  for (const r of capacityRows) {
    const k = `${String(r.slot_date).slice(0, 10)}|${Number(r.slot_id)}`;
    cap.set(k, (cap.get(k) || 0) + 1);
    if (r.has_appt === true) booked.set(k, (booked.get(k) || 0) + 1);
  }
  for (const p of pending) {
    const lp = localParts(p.start_iso, tz);
    if (!lp) continue;
    const k = `${lp.date}|${bandOfEtTime(lp.hhmm)}`;
    pend.set(k, (pend.get(k) || 0) + 1);
  }
  for (const date of dates) {
    for (const band of [1, 2, 3]) {
      const k = `${date}|${band}`;
      const capacity = cap.get(k) || 0;
      const lpBooked = booked.get(k) || 0;
      const pendingBot = pend.get(k) || 0;
      const filed = !!horizonDate && date <= String(horizonDate).slice(0, 10);
      let open = Math.max(0, capacity - lpBooked - pendingBot);
      let closed = null;
      if (!filed) { open = 0; closed = 'unfiled'; }
      else if (meetingClosesBand(meetings, date, band)) { open = 0; closed = 'meeting'; }
      else if (open === 0) closed = capacity === 0 ? 'no_capacity' : 'full';
      out.set(k, { date, band, capacity, lp_booked: lpBooked, pending_bot: pendingBot, open, filed, closed_reason: closed });
    }
  }
  return out;
}

function datesFrom(fromYmd, days) {
  const out = [];
  const base = new Date(`${fromYmd}T12:00:00Z`).getTime();
  for (let i = 0; i < days; i++) out.push(new Date(base + i * 86_400_000).toISOString().slice(0, 10));
  return out;
}

// ── I/O (deps seam) ─────────────────────────────────────────────────────────

async function defaultRunSQL(q) { const { runSQL } = await import('../admin/supabase-admin.js'); return runSQL(q); }
export const defaultGateDeps = {
  async readBranchMap() {
    return (await defaultRunSQL('SELECT brn_id, market_code FROM lp_branch_market_map WHERE market_code IS NOT NULL')) || [];
  },
  async readCapacity(market, fromYmd, toYmd) {
    return (await defaultRunSQL(
      `SELECT cs.slot_date::text AS slot_date, cs.slot_id, cs.has_appt
         FROM lp_capacity_slots cs
         JOIN lp_branch_market_map bm ON upper(trim(bm.brn_id)) = upper(trim(cs.rep_home_market))
        WHERE bm.market_code = '${market}' AND cs.slot_date BETWEEN '${fromYmd}' AND '${toYmd}'`)) || [];
  },
  async readHorizon(market) {
    const rows = await defaultRunSQL(`SELECT horizon_date::text AS horizon_date FROM v_capacity_submission_horizon WHERE market = '${market}'`);
    return rows?.[0]?.horizon_date || null;
  },
  async readMeetings(market) {
    return (await defaultRunSQL(
      `SELECT day_of_week, specific_date::text AS specific_date, start_local::text AS start_local, end_local::text AS end_local, active
         FROM market_meeting_blocks WHERE market_code = '${market}' AND active`)) || [];
  },
  // Bot bookings that hold a seat LP does not show yet: a completed bot
  // book_appointment stamped with this market, on an in-home calendar, with no
  // successful LP sync mark for the contact since it was booked.
  async readPendingBot(market, hours) {
    return (await defaultRunSQL(
      `SELECT a.execution_result->>'start_time' AS start_iso
         FROM agent_actions a
        WHERE a.action_type = 'book_appointment' AND a.status = 'completed'
          AND a.created_at > now() - interval '${Math.round(hours)} hours'
          AND a.action_payload->>'capacity_market' = '${market}'
          AND a.execution_result->>'action' = 'appointment_booked'
          AND a.execution_result->>'calendar_id' IN (${[...IN_HOME].map(c => `'${c}'`).join(',')})
          AND NOT EXISTS (SELECT 1 FROM lp_appointment_sync_marks m
                           WHERE m.contact_id = a.target_id AND m.created_at >= a.created_at
                             AND m.dedup_key NOT LIKE 'refused:%')`)) || [];
  },
};

let branchCache = null;
const marketCache = new Map();
/** Test seam. */
export function _resetCapacityGateCache() { branchCache = null; marketCache.clear(); }

/**
 * A service code (SAR, BOCA, LAKE: context.market.market_code) or a capacity
 * code → the capacity code, the same mapping the capacity tools use
 * (lp_branch_market_map). `{ skip }` when nothing maps (R7).
 */
export async function toCapacityMarket(code, deps = defaultGateDeps, { nowMs = Date.now() } = {}) {
  const raw = String(code || '').trim().toUpperCase();
  if (!raw) return { skip: 'unresolved' };
  if (CAPACITY_UNIVERSE.includes(raw)) return { code: raw };
  if (!branchCache || nowMs - branchCache.at > 10 * 60_000) {
    const rows = await deps.readBranchMap();
    branchCache = { at: nowMs, map: new Map(rows.map(r => [String(r.brn_id || '').trim().toUpperCase(), String(r.market_code || '').trim().toUpperCase()])) };
  }
  const mapped = branchCache.map.get(raw);
  if (!mapped) return { skip: 'not_in_universe' };
  return CAPACITY_UNIVERSE.includes(mapped) ? { code: mapped } : { skip: 'not_in_universe' };
}

async function loadMarket(market, deps, nowMs, env) {
  const hit = marketCache.get(market);
  if (hit && nowMs - hit.at < cacheMs(env)) return hit.value;
  const from = localParts(new Date(nowMs).toISOString()).date;
  const dates = datesFrom(from, READ_DAYS);
  const to = dates[dates.length - 1];
  const [capacityRows, horizonDate, meetings, pending] = await Promise.all([
    deps.readCapacity(market, from, to),
    deps.readHorizon(market),
    deps.readMeetings(market),
    deps.readPendingBot(market, lookbackHours(env)),
  ]);
  const value = { openings: computeOpenings({ capacityRows, horizonDate, meetings, pending, dates }), horizonDate, dates };
  marketCache.set(market, { at: nowMs, value });
  return value;
}

/** Openings for a market between two dates (inclusive), read through the cache. */
export async function getMarketBandOpenings(marketCode, fromDate, toDate, deps = defaultGateDeps, { nowMs = Date.now(), env = process.env } = {}) {
  const { openings } = await loadMarket(marketCode, deps, nowMs, env);
  return [...openings.values()].filter(o => (!fromDate || o.date >= fromDate) && (!toDate || o.date <= toDate));
}

/**
 * Is one in-home time bookable for this capacity market? A date beyond the
 * read window is past every horizon, so it is unfiled.
 * @returns {Promise<{ok: boolean, band: number|null, closed_reason: string|null}>}
 */
export async function isSlotBookable(marketCode, iso, deps = defaultGateDeps, { nowMs = Date.now(), env = process.env, log = true } = {}) {
  const lp = localParts(iso);
  if (!lp) return { ok: true, band: null, closed_reason: null };
  const band = bandOfEtTime(lp.hhmm);
  const { openings, horizonDate } = await loadMarket(marketCode, deps, nowMs, env);
  const o = openings.get(`${lp.date}|${band}`)
    || { open: 0, closed_reason: horizonDate && lp.date <= horizonDate ? 'no_capacity' : 'unfiled' };
  const ok = o.open > 0;
  if (log) console.log(`[CapacityGate] market=${marketCode} date=${lp.date} band=${band} open=${o.open} reason=${o.closed_reason || 'open'}`);
  return { ok, band, closed_reason: ok ? null : o.closed_reason, date: lp.date, open: o.open };
}

/**
 * The one gate decision: may the bot use the gate for this read, and on which
 * market? `{ market }` to gate, `{ skip }` (logged) to leave the read as is.
 */
export async function resolveGate({ calendarId, marketCode }, deps = defaultGateDeps, { env = process.env } = {}) {
  if (!capacityGateEnabled(env)) return { skip: 'disabled' };
  if (!isInHomeCalendar(calendarId)) return { skip: 'not_in_home' };
  if (marketCode == null || marketCode === '') {
    console.log('[CapacityGate] capacity_gate_skipped:unresolved');
    return { skip: 'unresolved' };
  }
  try {
    const m = await toCapacityMarket(marketCode, deps);
    if (m.skip) { console.log(`[CapacityGate] capacity_gate_skipped:${m.skip} (market=${marketCode})`); return m; }
    return { market: m.code };
  } catch (err) {
    console.warn(`[CapacityGate] capacity_gate_skipped:read_failed (market=${marketCode}): ${err.message}`);
    return { skip: 'read_failed' };
  }
}

/**
 * Keep only the slots the market can take. Fails open: a read that throws
 * returns the slots unchanged with `skipped: 'read_failed'`.
 * @returns {Promise<{slots: Array, gated: boolean, removed: number, market: string|null, skipped: string|null}>}
 */
export async function filterSlotsByCapacity({ calendarId, marketCode, slots }, deps = defaultGateDeps, opts = {}) {
  const list = Array.isArray(slots) ? slots : [];
  const gate = await resolveGate({ calendarId, marketCode }, deps, opts);
  if (gate.skip) return { slots: list, gated: false, removed: 0, market: null, skipped: gate.skip };
  try {
    const kept = [];
    const closed = {};
    const seen = new Set();
    for (const s of list) {
      const r = await isSlotBookable(gate.market, s.iso, deps, { ...opts, log: false });
      if (r.ok) { kept.push(s); continue; }
      closed[r.closed_reason] = (closed[r.closed_reason] || 0) + 1;
      // One line per closed date|band, for comparing with get_capacity_vs_ghl.
      const k = `${r.date}|${r.band}`;
      if (!seen.has(k)) { seen.add(k); console.log(`[CapacityGate] market=${gate.market} date=${r.date} band=${r.band} open=${r.open} reason=${r.closed_reason}`); }
    }
    const removed = list.length - kept.length;
    if (removed) console.log(`[CapacityGate] market=${gate.market} calendar=${calendarId} kept=${kept.length} removed=${removed} reasons=${JSON.stringify(closed)}`);
    return { slots: kept, gated: true, removed, market: gate.market, skipped: null };
  } catch (err) {
    console.warn(`[CapacityGate] capacity_gate_skipped:read_failed (market=${gate.market}): ${err.message}`);
    return { slots: list, gated: false, removed: 0, market: gate.market, skipped: 'read_failed' };
  }
}

/** The capacity code to stamp on a bot booking (pending_bot), or null. Never throws. */
export async function capacityMarketFor(marketCode, deps = defaultGateDeps) {
  if (!capacityGateEnabled()) return null;
  try { const m = await toCapacityMarket(marketCode, deps); return m.code || null; } catch { return null; }
}
