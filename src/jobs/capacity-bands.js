// ─── Per-band capacity reconciliation — src/jobs/capacity-bands.js ───────────
//
// READ-ONLY diagnostic. Writes nothing, schedules nothing, and does not touch
// GHL. Sibling of capacity-sweep.js, which owns all the writing; that file is
// deliberately NOT imported or edited here.
//
// WHY THIS EXISTS: v_appt_board (sql/043) aggregates slot_id away, so the TV
// capacity board structurally cannot show that GHL's 18:00 / 18:30 / 19:00
// booking times ALL draw from the same single LP evening slot per rep.
// Measured 2026-07-25: LP published 15 evening rep-slots company-wide against
// 16 GHL bookings in the evening band alone. sql/048 exposes the band axis;
// this module joins it to the GHL side and reports the gap.
//
// ─── FAIL OPEN (the rule the whole module is built around) ───────────────────
// Reps file availability ONCE A WEEK and NOT on a common schedule, so LP holds
// no rows at all for a market that has not filed yet. Measured 2026-07-25:
// FTLAU_MKT and LAKE_MKT reached only today while four other markets reached
// 2026-08-02.
//
//   ABSENCE OF A CAPACITY ROW MEANS "NOT FILED YET", NEVER "ZERO CAPACITY".
//
// Every row whose date lies beyond ANY market's submission horizon is reported
// UNKNOWN and must never be used to gate, close a slot, or decline a booking.
// Treating absence as zero would have closed Fort Lauderdale and Lakeland for
// two weeks. This applies to any future write path just as much as to this one.
//
// TIMEZONE RULE (binding, inherited from capacity-sweep.js): every date cast on
// a timestamptz goes through (col AT TIME ZONE 'America/New_York')::date. A
// bare ::date rolls tonight's 7pm bookings into tomorrow's band counts.
//
// NO BIND PARAMETERS: runSQL and hlRunSQL are both raw-string RPCs. Every value
// reaching a query is shape-validated by an anchored regex FIRST and escaped
// second — see the guards below and the DATE_RE precedent in capacity-sweep.js.

import { runSQL } from '../admin/supabase-admin.js';
// GHL appointment counts live in the HL MCP Supabase, a different project that
// cannot be cross-joined to LP's — so they are fetched separately and joined in
// JS. This is the SAME lazily-memoized client the hl_* fallback tools use, not
// a second one; it was extracted out of src/tools/admin/hl-fallback.js so a job
// module does not have to import a tool module to reach the HL warehouse.
import { hlRunSQL, esc } from '../admin/hl-client.js';

const TIMEZONE = 'America/New_York';

// ─── ET date helpers ─────────────────────────────────────────────────────────
// DUPLICATED from capacity-sweep.js (lines 110/117/155), where they are
// module-private and that file is live and must not be edited. Same precedent
// as the other job files that carry their own todayET.

/** Today's ET calendar date as YYYY-MM-DD. */
function todayET() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/** Pure calendar arithmetic on a YYYY-MM-DD string (UTC math — no tz drift). */
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─── Band boundaries — SINGLE SOURCE OF TRUTH ────────────────────────────────
//
// LP publishes three bands per rep per day with TmsTime markers 9:00am /
// 12:59pm / 4:59pm. The two cut points below are the LAST minute of Morning and
// the last minute of Afternoon; everything after the second cut is Evening.
//
// Verified against 45 days of live GHL bookings on the Window Estimate
// calendar: 10:00 (x115) → M, 14:00 (x128) → A, 18:00 (x91) and 19:00 (x8) → E.
//
// These two strings appear ONCE. Both the JS mapper (bandOfEtTime) and the SQL
// generator (bandCaseSQL) derive from this array, so the LP-side and GHL-side
// band definitions cannot drift apart — which they silently would if the
// boundaries were written out in both places.

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEFAULT_BAND_CUTS = ['12:59', '16:59'];

/**
 * CAPACITY_BAND_CUTS="12:59,16:59" — comma-delimited, matching the
 * CAPACITY_CONFIRMED_CODES convention (this repo parses no JSON from env).
 * Two ascending HH:MM 24-hour ET times.
 *
 * A malformed value falls back to the defaults with a warning rather than
 * throwing: a typo here would otherwise re-band every appointment in the
 * system, and a boot crash on a diagnostic module is the worse failure.
 */
const BAND_CUTS = (() => {
  const raw = String(process.env.CAPACITY_BAND_CUTS || DEFAULT_BAND_CUTS.join(','))
    .split(',').map((s) => s.trim()).filter(Boolean);
  const valid = raw.length === 2 && raw.every((s) => HHMM_RE.test(s)) && raw[0] < raw[1];
  if (!valid) {
    console.warn(
      `[CapacityBands] invalid CAPACITY_BAND_CUTS "${raw.join(',')}" — ` +
      `expected two ascending HH:MM values; using ${DEFAULT_BAND_CUTS.join(',')}`
    );
    return [...DEFAULT_BAND_CUTS];
  }
  return raw;
})();

const BAND_LABEL = { 1: 'M', 2: 'A', 3: 'E' };
const BAND_NAME = { 1: 'Morning', 2: 'Afternoon', 3: 'Evening' };

/** JS side: zero-padded 'HH:MM' in ET → slot_id 1|2|3. */
export function bandOfEtTime(hhmm) {
  if (hhmm <= BAND_CUTS[0]) return 1;
  if (hhmm <= BAND_CUTS[1]) return 2;
  return 3;
}

/**
 * SQL side: the same two cuts, the same comparison. `tsExpr` names a
 * timestamptz column. to_char(...,'HH24:MI') is fixed-width and zero-padded, so
 * lexicographic compare IS chronological compare — this is literally what
 * bandOfEtTime does, which is the point.
 *
 * Interpolation is safe: BAND_CUTS passed HHMM_RE at module load.
 */
export function bandCaseSQL(tsExpr) {
  const local = `to_char((${tsExpr} AT TIME ZONE '${TIMEZONE}'), 'HH24:MI')`;
  return `CASE WHEN ${local} <= '${BAND_CUTS[0]}' THEN 1 ` +
         `WHEN ${local} <= '${BAND_CUTS[1]}' THEN 2 ELSE 3 END`;
}

// ─── Config (comma-delimited / numeric env, matching capacity-sweep.js) ──────

const TIGHT_RATIO = parseFloat(process.env.CAPACITY_BAND_TIGHT_RATIO || '0.8');
const DEFAULT_FORWARD_DAYS = parseInt(process.env.CAPACITY_BAND_FORWARD_DAYS || '14', 10);
const MAX_WINDOW_DAYS = parseInt(process.env.CAPACITY_BAND_MAX_WINDOW_DAYS || '60', 10);
/** GHL Window Estimate calendar. */
const DEFAULT_CALENDAR_ID = process.env.CAPACITY_BAND_CALENDAR_ID || 'aJj14ONxh1oFyDcQ706O';
/**
 * GHL statuses that OCCUPY a slot. 'cancelled' is counted and reported
 * SEPARATELY, never as booked. Live statuses on the Window Estimate calendar as
 * of 2026-07-25: new, confirmed, cancelled, showed, noshow. Anything outside
 * this list stays visible as ghl_total - ghl_booked - ghl_cancelled rather than
 * disappearing.
 */
const GHL_BOOKED_STATUSES = String(
  process.env.CAPACITY_BAND_GHL_STATUSES || 'new,confirmed,showed,noshow'
).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

// ─── Input validation ────────────────────────────────────────────────────────
// Everything below runs BEFORE a value reaches interpolated SQL.

const CALENDAR_ID_RE = /^[A-Za-z0-9]{15,30}$/;  // GHL ids: ~20 alphanumerics
const MARKET_RE = /^[A-Z0-9_]{2,32}$/;          // *_MKT codes plus 'UNRESOLVED'

/** Caller error — mapped to 400 by the route, so a typo is not a 500. */
export class BadRequest extends Error {}

/** DATE_RE shape plus a round-trip: the regex alone accepts 2026-13-45. */
function assertDate(value, label) {
  const s = String(value ?? '').trim();
  if (!DATE_RE.test(s)) throw new BadRequest(`${label} must be YYYY-MM-DD`);
  const d = new Date(`${s}T00:00:00Z`);
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new BadRequest(`${label} is not a real calendar date`);
  }
  return s;
}

function assertCalendarId(value) {
  const s = String(value ?? '').trim();
  if (!CALENDAR_ID_RE.test(s)) {
    throw new BadRequest('calendar_id must be 15-30 alphanumeric characters');
  }
  return s;
}

/** Optional — null means "no market lens". */
function assertMarket(value) {
  if (value == null || String(value).trim() === '') return null;
  const s = String(value).trim().toUpperCase();
  if (!MARKET_RE.test(s)) throw new BadRequest('market must match ^[A-Z0-9_]{2,32}$');
  return s;
}

/**
 * Resolve and bound the window. The cap is not ceremony: the HL-side ET date
 * predicate is non-sargable, so an unbounded window scans a table shared with
 * the live HL service, and the reconcile materializes days x 3 rows each
 * carrying two market-name arrays. LP's own forward window is 14 days.
 */
function resolveWindow(startDate, endDate) {
  const start = startDate ? assertDate(startDate, 'start_date') : todayET();
  const end = endDate ? assertDate(endDate, 'end_date') : addDays(start, DEFAULT_FORWARD_DAYS);
  if (end < start) throw new BadRequest('end_date must be on or after start_date');
  const span = Math.round(
    (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000
  ) + 1;
  if (span > MAX_WINDOW_DAYS) {
    throw new BadRequest(`window of ${span} days exceeds the ${MAX_WINDOW_DAYS}-day maximum`);
  }
  return { start, end };
}

/**
 * hlRunSQL wraps SELECTs in json_agg and pipes the result through
 * unwrapSingleValue(): a zero-row SELECT returns NULL rather than [], and a
 * single-row single-column result collapses to a bare scalar. Normalize.
 */
function asRows(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  if (typeof value === 'object') return [value];
  return [];
}

const num = (v) => Number(v) || 0;

// ─── LP reads ────────────────────────────────────────────────────────────────

/**
 * Per-band LP capacity from v_appt_board_bands. Warehouse-only — no LP API
 * calls — so it stays fast enough to serve a request synchronously.
 *
 * Here `market` IS a true filter: these rows are per-market by construction.
 * (On the reconcile path it cannot be — see reconcileBands.)
 */
export async function getBandCapacity({ startDate, endDate, market } = {}) {
  const { start, end } = resolveWindow(startDate, endDate);
  const mkt = assertMarket(market);
  const rows = await runSQL(
    `SELECT slot_date::text AS slot_date, market, slot_id, band,
            capacity, booked, open_slots
       FROM v_appt_board_bands
      WHERE slot_date BETWEEN '${esc(start)}'::date AND '${esc(end)}'::date
        ${mkt ? `AND market = '${esc(mkt)}'` : ''}
      ORDER BY slot_date, market, slot_id`
  );
  return (rows || []).map((r) => ({
    slot_date: r.slot_date,
    market: r.market,
    slot_id: Number(r.slot_id),
    band: r.band,
    capacity: num(r.capacity),
    booked: num(r.booked),
    open_slots: num(r.open_slots),
  }));
}

/**
 * market -> { horizon_date, days_filed, last_swept_at }.
 *
 * A market that has NEVER filed is absent from this map entirely. Callers must
 * treat absent as horizon_date=null — unknown for every date — and must source
 * the market universe from lp_branch_market_map, never from these keys.
 */
export async function getSubmissionHorizons() {
  const rows = await runSQL(
    `SELECT market, horizon_date::text AS horizon_date, days_filed, last_swept_at
       FROM v_capacity_submission_horizon
      ORDER BY market`
  );
  const map = new Map();
  for (const r of rows || []) {
    map.set(r.market, {
      horizon_date: r.horizon_date || null,
      days_filed: num(r.days_filed),
      last_swept_at: r.last_swept_at || null,
    });
  }
  return map;
}

/**
 * The market UNIVERSE — every market that COULD file — from the branch map, not
 * from the capacity rows. This is load-bearing for fail-open: a market that has
 * filed nothing at all has no capacity row and no horizon row, so deriving the
 * universe from either would make it silently vanish from markets_unknown
 * instead of blocking the gate. That is the exact fail-closed bug the rule
 * exists to prevent.
 *
 * UNRESOLVED is appended when any capacity row landed there (a branch code
 * missing from the map); it is empty today but must not be able to hide.
 */
async function getMarketUniverse() {
  const rows = await runSQL(
    `SELECT market_code AS market FROM lp_branch_market_map
      WHERE market_code IS NOT NULL
      UNION
     SELECT 'UNRESOLVED' FROM v_appt_board_bands WHERE market = 'UNRESOLVED'
      ORDER BY 1`
  );
  return (rows || []).map((r) => r.market);
}

/** max(swept_at) across the slot table — the staleness signal. */
async function getLastSweptAt() {
  const rows = await runSQL('SELECT max(swept_at) AS last_swept_at FROM lp_capacity_slots');
  return rows?.[0]?.last_swept_at || null;
}

// ─── GHL read (separate Supabase) ────────────────────────────────────────────

/**
 * GHL booking counts per (ET date, band) for one calendar.
 *
 * Never throws: an HL outage or an unconfigured HL_SUPABASE_URL returns
 * { ok:false, error } so the caller can degrade instead of losing the LP half
 * of the diagnostic too.
 */
export async function getGhlBandBookings({ startDate, endDate, calendarId } = {}) {
  const { start, end } = resolveWindow(startDate, endDate);
  const cal = assertCalendarId(calendarId || DEFAULT_CALENDAR_ID);
  const statusArray = `ARRAY[${GHL_BOOKED_STATUSES.map((s) => `'${esc(s)}'`).join(',')}]::text[]`;
  const bandExpr = bandCaseSQL('a.start_time');   // same cuts as bandOfEtTime

  const q =
    `SELECT (a.start_time AT TIME ZONE '${TIMEZONE}')::date::text AS slot_date,
            ${bandExpr} AS slot_id,
            count(*) FILTER (
              WHERE lower(coalesce(a.status, '')) = ANY(${statusArray})
            ) AS ghl_booked,
            count(*) FILTER (
              WHERE lower(coalesce(a.status, '')) = 'cancelled'
            ) AS ghl_cancelled,
            count(*) AS ghl_total
       FROM appointments a
      WHERE a.ghl_calendar_id = '${esc(cal)}'
        AND a.deleted_at IS NULL
        -- Sargable pre-filter on the raw timestamptz so an index stays usable.
        -- Deliberately widened a day either side: it must never exclude a row
        -- the authoritative ET predicate below would include.
        AND a.start_time >= '${esc(start)}'::date - interval '1 day'
        AND a.start_time <  '${esc(end)}'::date + interval '2 days'
        AND (a.start_time AT TIME ZONE '${TIMEZONE}')::date
              BETWEEN '${esc(start)}'::date AND '${esc(end)}'::date
      GROUP BY 1, 2
      ORDER BY 1, 2`;

  try {
    const rows = asRows(await hlRunSQL(q)).map((r) => ({
      slot_date: r.slot_date,
      slot_id: Number(r.slot_id),
      ghl_booked: num(r.ghl_booked),
      ghl_cancelled: num(r.ghl_cancelled),
      ghl_total: num(r.ghl_total),
    }));
    return { ok: true, calendar_id: cal, rows };
  } catch (err) {
    // HL not configured / RPC failure / HL Supabase down. Degrade, do not throw.
    console.warn(`[CapacityBands] GHL bookings unavailable: ${err.message}`);
    return { ok: false, calendar_id: cal, error: err.message, rows: [] };
  }
}

// ─── Reconcile ───────────────────────────────────────────────────────────────

/**
 * Status ladder — ordered and non-overlapping, FIRST MATCH WINS. The plain
 * definitions overlap ("booked <= capacity" and "booked >= 80% of capacity" are
 * both true at 9 of 10); precedence is what resolves it.
 *
 *   UNKNOWN   any contributing market is beyond its horizon, or GHL is
 *             unreachable. NEVER gate on this row.
 *   OVERSOLD  ghl_booked > capacity
 *   TIGHT     ghl_booked >= TIGHT_RATIO * capacity
 *   OK        everything else
 */
export function bandStatus({ capacity, booked, marketsUnknown, ghlAvailable }) {
  if (marketsUnknown.length > 0 || !ghlAvailable || booked == null) return 'UNKNOWN';
  if (capacity === 0) return booked > 0 ? 'OVERSOLD' : 'OK';
  if (booked > capacity) return 'OVERSOLD';
  if (booked >= TIGHT_RATIO * capacity) return 'TIGHT';
  return 'OK';
}

/**
 * THE FAIL-OPEN GUARD, isolated and pure so it can be tested directly.
 *
 * Splits the market universe for one date into those whose filed availability
 * reaches it and those it does not. String compare on YYYY-MM-DD is
 * chronological, so no date parsing is needed.
 *
 * A market with no horizon entry has NEVER FILED and is unknown for every date
 * — including today. It must land in `unknown`, never in `counted`, or its
 * absent capacity would read as zero and close the market.
 *
 * @param {string[]} universe   every market that could file (from the branch map)
 * @param {Map} horizons        market -> { horizon_date, ... }; missing = never filed
 * @param {string} slotDate     YYYY-MM-DD
 */
export function partitionMarketsByHorizon(universe, horizons, slotDate) {
  const counted = [];
  const unknown = [];
  for (const m of universe) {
    const horizon = horizons.get(m)?.horizon_date || null;
    if (horizon && horizon >= slotDate) counted.push(m);
    else unknown.push(m);
  }
  return { counted, unknown };
}

/**
 * The Phase 1 deliverable: LP band capacity vs GHL bookings, per (date, band),
 * with the fail-open horizon guard applied.
 *
 * The horizon join is done in JS rather than SQL for two reasons that are not
 * stylistic: markets_unknown must be a NAME LIST (an operator needs to know
 * WHICH market has not filed, not how many), and a market that has filed
 * nothing has no row to anti-join against.
 */
export async function reconcileBands({ startDate, endDate, calendarId, market } = {}) {
  const { start, end } = resolveWindow(startDate, endDate);
  const cal = assertCalendarId(calendarId || DEFAULT_CALENDAR_ID);
  const mkt = assertMarket(market);

  const [capacityRows, horizons, universe, lastSweptAt, ghl] = await Promise.all([
    // Always ALL markets — a market lens must not change the totals. See below.
    getBandCapacity({ startDate: start, endDate: end }),
    getSubmissionHorizons(),
    getMarketUniverse(),
    getLastSweptAt(),
    getGhlBandBookings({ startDate: start, endDate: end, calendarId: cal }),
  ]);

  // (date|slot) -> rolled-up LP capacity, plus the per-market breakdown the
  // market lens reads from.
  const capacityBy = new Map();
  for (const r of capacityRows) {
    const key = `${r.slot_date}|${r.slot_id}`;
    if (!capacityBy.has(key)) capacityBy.set(key, { capacity: 0, lp_booked: 0, by_market: {} });
    const cell = capacityBy.get(key);
    cell.by_market[r.market] = { capacity: r.capacity, booked: r.booked };
    cell.capacity += r.capacity;
    cell.lp_booked += r.booked;
  }

  const ghlBy = new Map();
  for (const r of ghl.rows) ghlBy.set(`${r.slot_date}|${r.slot_id}`, r);

  const rows = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const { counted, unknown } = partitionMarketsByHorizon(universe, horizons, d);
    for (const slotId of [1, 2, 3]) {
      const cell = capacityBy.get(`${d}|${slotId}`) || { capacity: 0, lp_booked: 0, by_market: {} };
      const g = ghlBy.get(`${d}|${slotId}`) || null;
      const ghlBooked = ghl.ok ? (g?.ghl_booked ?? 0) : null;

      const unknownReasons = [];
      if (unknown.length) unknownReasons.push('MARKETS_NOT_FILED');
      if (!ghl.ok) unknownReasons.push('GHL_UNAVAILABLE');

      rows.push({
        slot_date: d,
        slot_id: slotId,
        band: BAND_LABEL[slotId],
        // Filed markets only — capacity from a market beyond its horizon does
        // not exist yet and must not be invented as zero.
        lp_capacity: cell.capacity,
        // LP's own has_appt flag: appointments booked through ANY channel, not
        // just this GHL calendar.
        lp_booked: cell.lp_booked,
        lp_open: Math.max(0, cell.capacity - cell.lp_booked),
        ghl_booked: ghlBooked,
        ghl_cancelled: ghl.ok ? (g?.ghl_cancelled ?? 0) : null,
        // UNCAPPED above 1.0 — overbooking is real and must stay visible.
        // null rather than a divide-by-zero when capacity is 0.
        fill_pct: (cell.capacity > 0 && ghlBooked != null) ? ghlBooked / cell.capacity : null,
        // LP knows about bookings this calendar never saw, and vice versa. The
        // delta is a finding to investigate, not an error.
        lp_minus_ghl: ghlBooked == null ? null : cell.lp_booked - ghlBooked,
        status: bandStatus({
          capacity: cell.capacity,
          booked: ghlBooked,
          marketsUnknown: unknown,
          ghlAvailable: ghl.ok,
        }),
        unknown_reasons: unknownReasons,
        markets_counted: counted,
        markets_unknown: unknown,   // NAME LIST — which market, not how many
        ...(mkt ? { market_capacity: cell.by_market[mkt] || { capacity: 0, booked: 0 } } : {}),
      });
    }
  }

  const totals = rows.reduce((acc, r) => {
    acc.lp_capacity += r.lp_capacity;
    acc.lp_booked += r.lp_booked;
    if (r.ghl_booked != null) acc.ghl_booked += r.ghl_booked;
    acc[r.status.toLowerCase()] = (acc[r.status.toLowerCase()] || 0) + 1;
    return acc;
  }, { lp_capacity: 0, lp_booked: 0, ghl_booked: 0, ok: 0, tight: 0, oversold: 0, unknown: 0 });

  const knownDates = new Set(rows.filter((r) => !r.markets_unknown.length).map((r) => r.slot_date));

  return {
    window: { start, end },
    calendar_id: cal,
    generated_at: new Date().toISOString(),
    last_swept_at: lastSweptAt,
    band_cuts: BAND_CUTS,
    tight_ratio: TIGHT_RATIO,
    bands: BAND_NAME,
    ghl: {
      available: ghl.ok,
      error: ghl.ok ? null : ghl.error,
      counted_statuses: GHL_BOOKED_STATUSES,
    },
    degraded: !ghl.ok,
    market_universe: universe,
    horizons: Object.fromEntries(horizons),
    ...(mkt ? {
      market_lens: mkt,
      market_lens_note:
        'lp_capacity, ghl_booked and status remain LOCATION-WIDE. GHL appointments ' +
        'carry no market dimension (no branch column; assigned_to is a GHL user id ' +
        'with no slr_id mapping), so filtering the LP side alone would report a false ' +
        'OVERSOLD on every row. market_capacity is the LP-side slice only.',
    } : {}),
    summary: {
      // A default window today is almost entirely UNKNOWN because two markets
      // have only filed through today. That is the finding, not a fault.
      days_in_window: new Set(rows.map((r) => r.slot_date)).size,
      days_fully_known: knownDates.size,
      first_unknown_date: rows.find((r) => r.markets_unknown.length)?.slot_date || null,
      ...totals,
    },
    rows,
  };
}

// ─── Route ───────────────────────────────────────────────────────────────────

/**
 * GET /admin/capacity-bands?start=&end=&calendar_id=&market=
 *
 * Authenticated, unlike /board/capacity — this is an admin diagnostic, not a
 * kiosk feed. `authenticate` is passed in from src/index.js rather than
 * imported to keep this module free of a circular dependency; it is optional so
 * the module stays independently testable.
 *
 * NOTE: `authenticate` fails OPEN when MCP_AUTH_TOKEN is unset and is bypassed
 * by AUTH_SOFT_LAUNCH=true. The input validation above is therefore mandatory,
 * not defensive — the same reasoning behind the DATE_RE guard on the
 * unauthenticated /board/capacity route.
 */
export function registerCapacityBandRoutes(app, authenticate) {
  const guards = typeof authenticate === 'function' ? [authenticate] : [];

  app.get('/admin/capacity-bands', ...guards, async (req, res) => {
    try {
      const out = await reconcileBands({
        startDate: req.query.start,
        endDate: req.query.end,
        calendarId: req.query.calendar_id,
        market: req.query.market,
      });
      res.json(out);
    } catch (err) {
      if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
      console.error('[CapacityBands] /admin/capacity-bands failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  console.log(
    '[CapacityBands] Route: GET /admin/capacity-bands?start&end&calendar_id&market' +
    `${guards.length ? ' (authenticated)' : ' (UNAUTHENTICATED — no middleware passed)'}`
  );
}
