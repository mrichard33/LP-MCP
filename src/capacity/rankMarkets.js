/**
 * Capacity → Five9 market priority ranker — src/capacity/rankMarkets.js
 *
 * PURE. Capacity rows in, ranked order + flags out. No I/O, no env reads —
 * every knob is a parameter with a default, so the regression fixture in
 * scripts/test-capacity-ranker.js exercises exactly the code the route runs.
 *
 * SOURCE (prerequisite verified 2026-09-03): the rows are the `offices` array
 * of GET /board/capacity (src/jobs/capacity-sweep.js buildBoardResponse) —
 * the same aggregate the Appointment Capacity TV board polls through the
 * dashboard's /api/capacity-board proxy. NOT v_appt_board and NOT
 * lp_appt_fill_snapshot: both lagged the live board on confirmed/booked when
 * checked (ORL 4/27 and 9/27 against a live 11/27), and the snapshot is daily.
 *
 * ── RANKING RULE: CONFIRMED CAPACITY %, LOWEST FIRST (the user, 2026-10-15) ──
 *
 *   fill = confirmed ÷ requested        (the board's `confirmed` column only)
 *
 * The office with the LOWEST fill dials first. That is the whole sort key.
 * An EXACT tie on fill breaks on the existing market conversion ranking
 * (trailing-90d set-to-sale, perf_multiplier from marketPerformance.js):
 * the higher-converting office first, then market code so the order is
 * deterministic. The user's example: Office A 1 of 10 (10 %) ranks above
 * Office B 11 of 20 (55 %) although both still need 9.
 *
 * WHAT NO LONGER COUNTS, ON PURPOSE:
 *   - Set / hopper appointments (set_pending). They were half a slot from
 *     2026-10-09 and a whole slot before that. Out entirely: only a confirmed
 *     appointment fills capacity. set_pending is still reported, never used.
 *   - Appointments still needed (requested − confirmed). The old sort key was
 *     absolute open slots, which put the biggest office first whatever its
 *     fill (Fort Myers 6/41 = 14.6 % ranked 1 over Jacksonville 0/22 on
 *     dial_priority_log #670). still_needed is reported for the board, never
 *     used to order.
 *   - Conversion as a WEIGHT. It used to scale open slots and could reorder
 *     near-ties. It now decides only a dead-even fill, never a real gap
 *     (14.3 % always beats 14.6 %, whatever either office converts at).
 *   - The starvation guard (forced a zero-confirmed market to rank 2). Under
 *     this rule a market with 0 confirmed is already at 0 % and sorts to the
 *     top on its own, and promoting anything would override the percentage.
 *
 * Fill is compared EXACTLY by cross-multiplying (cA × rB vs cB × rA), never on
 * the rounded fill_pct, so 1/10 and 2/20 are a true tie and 1/3 vs 33.3 % is
 * never decided by a rounding accident.
 *
 * GUARDS THAT STILL HOLD:
 *   1. UNKNOWN — FAIL OPEN. No capacity row, or requested = 0, means the
 *      market has NOT FILED YET, never that it has zero capacity. Excluded
 *      from the ranking, listed in unknown[], never ranked 1.
 *   2. OVERSOLD (confirmed >= requested) is flagged; at 100 %+ it sorts last
 *      on the percentage alone.
 *   3. SMALL DENOMINATOR (requested < 4) is flagged for the board and does
 *      not reorder anything.
 *
 * fill_pct is reported in PERCENTAGE POINTS (0–100, one decimal); the board
 * API itself emits a 0–1 fraction. `score` carries the same number so older
 * readers of dial_priority_log keep working.
 */

export const DEFAULT_SMALL_DENOMINATOR = 4;

/**
 * A swap is material when the two markets that traded places differ in fill
 * by MORE than this many percentage points. Default 0: any real difference in
 * confirmed % that reorders the markets re-points Five9 (14.3 % must dial
 * ahead of 14.6 %), while a swap made by the conversion tiebreak alone is a
 * 0-point gap and never writes. Was 0.5 SLOTS while the sort key was open
 * slots (env CAPACITY_RANKER_SWAP_MARGIN); the env is now
 * CAPACITY_RANKER_SWAP_MARGIN_PCT so the old value cannot be read in the
 * wrong unit.
 */
export const DEFAULT_SWAP_MARGIN = 0;

/**
 * The six LP markets. There is no Tampa market — LP has no TPA branch.
 *
 * 2026-09-28 — Lakeland merged into Orlando (sql/135_lake_orl_merge.sql).
 * lp_branch_market_map now folds branch LAKE into ORL_MKT, so Lakeland's reps
 * and appointments arrive inside Orlando's capacity row. LAKE_MKT must NOT come
 * back here: it would read as an unfiled market and park the empty LKE lists
 * in the "unknown" tier above every non-market list.
 */
export const MARKET_CODES = Object.freeze([
  'FTLAU_MKT', 'ORL_MKT', 'STPET_MKT', 'JAX_MKT', 'FTMYR_MKT', 'SAR_MKT',
]);

function toCount(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function pct(confirmed, requested) {
  return Math.round((1000 * confirmed) / requested) / 10;
}

/** Exact fill comparison: negative when `a` is LESS filled (dials first). */
export function compareFill(a, b) {
  return a.confirmed * b.requested - b.confirmed * a.requested;
}

/**
 * @param {Array<{market:string, requested:number, confirmed:number, set_pending?:number}>} rows
 *        One row per market for ONE slot date (the board's `offices` array).
 * @param {object} [opts]
 * @param {string[]} [opts.markets]  Market codes expected (default: the six).
 *        A code in `markets` with no row → unknown (fail open). A row whose
 *        code is NOT in `markets` → unknown with reason 'unmapped_market' so it
 *        is visible rather than silently ranked against a list that does not
 *        exist.
 * @param {number} [opts.smallDenominator]  requested below this is flagged.
 * @param {object} [opts.performance]  { MARKET: { multiplier, set_to_sale } }
 *        from marketPerformance.js. Used ONLY to break an exact fill tie. A
 *        market absent from it ties at 1.0, so a scorecard outage leaves ties
 *        to the market code and never takes the ranker down.
 * @returns {{ ranking: Array, unknown: Array }}
 */
export function rankMarkets(rows, {
  markets = MARKET_CODES,
  smallDenominator = DEFAULT_SMALL_DENOMINATOR,
  performance = {},
} = {}) {
  const byMarket = new Map();
  for (const r of rows || []) {
    const code = String(r?.market ?? '').trim();
    if (!code) continue;
    byMarket.set(code, r);
  }

  const unknown = [];
  const candidates = [];

  for (const code of markets) {
    const row = byMarket.get(code);
    if (!row) {
      unknown.push({ market: code, reason: 'no_capacity_row' });
      continue;
    }
    const requested = toCount(row.requested);
    const confirmed = toCount(row.confirmed);
    const setPending = toCount(row.set_pending);
    if (requested <= 0) {
      unknown.push({ market: code, reason: 'requested_zero', requested, confirmed, set_pending: setPending });
      continue;
    }
    const oversold = confirmed >= requested;
    const small = requested < smallDenominator;
    const perf = performance?.[code] || null;
    const multiplier = Number.isFinite(perf?.multiplier) ? perf.multiplier : 1;
    const flags = [];
    if (oversold) flags.push('oversold');
    if (small) flags.push('small_denominator');
    const fillPct = pct(confirmed, requested);
    candidates.push({
      market: code,
      requested,
      confirmed,
      set_pending: setPending,          // reported only — the hopper does not rank
      still_needed: Math.max(0, requested - confirmed), // reported only
      fill_pct: fillPct,
      score: fillPct,                   // the sort key, kept under the old name for log readers
      perf_multiplier: multiplier,
      set_to_sale: Number.isFinite(perf?.set_to_sale) ? perf.set_to_sale : null,
      oversold,
      small_denominator: small,
      flags,
    });
  }

  // Rows for codes outside the mapping: surfaced, never ranked. The route
  // reports these separately so a source-side code change is a visible event.
  for (const [code, row] of byMarket) {
    if (!markets.includes(code)) {
      unknown.push({
        market: code,
        reason: 'unmapped_market',
        requested: toCount(row.requested),
        confirmed: toCount(row.confirmed),
        set_pending: toCount(row.set_pending),
      });
    }
  }

  candidates.sort((a, b) =>
    compareFill(a, b)                                  // LOWEST confirmed % dials first
    || (b.perf_multiplier - a.perf_multiplier)         // exact tie: better conversion first
    || a.market.localeCompare(b.market));              // deterministic last resort

  const ranking = candidates.map((c, i) => ({ rank: i + 1, ...c }));
  return { ranking, unknown };
}

/**
 * Material-change test between the last APPLIED ranking and a new one.
 *
 * Material = a market MOVING POSITION where the two markets that traded places
 * differ in confirmed fill by MORE than `swapMargin` percentage points, OR any
 * market changing oversold / small_denominator / unknown state. A swap made by
 * the conversion tiebreak alone (same fill) is noise the floor should not be
 * re-pointed for. No prior applied ranking at all is material by definition —
 * there is nothing on Five9 that reflects this ranking yet.
 *
 * The gap is read from the NEW ranking's fill_pct, which every row carries.
 * A prior row logged under the open-slot scoring (or carrying the retired
 * starvation_promoted flag) still compares: only its order and state are read,
 * and a changed scoring basis that reorders markets is a real change.
 *
 * Both arguments are { ranking, unknown } shapes as produced by rankMarkets
 * (the log row stores exactly those two arrays).
 */
export function isMaterialChange(prev, next, { swapMargin = DEFAULT_SWAP_MARGIN } = {}) {
  const reasons = [];
  if (!prev || !Array.isArray(prev.ranking)) {
    return { changed: true, reasons: ['no_prior_applied_ranking'] };
  }

  const hasFlag = (r, f) => Array.isArray(r.flags) && r.flags.includes(f);
  const stateOf = (r) => ({
    unknown: false,
    oversold: r.oversold === true || hasFlag(r, 'oversold'),
    small_denominator: r.small_denominator === true || hasFlag(r, 'small_denominator'),
  });
  const UNKNOWN_STATE = { unknown: true, oversold: false, small_denominator: false };
  const stateMap = (snap) => {
    const m = new Map();
    for (const r of snap.ranking || []) m.set(r.market, stateOf(r));
    for (const u of snap.unknown || []) m.set(u.market, UNKNOWN_STATE);
    return m;
  };
  const prevState = stateMap(prev);
  const nextState = stateMap(next);
  const allMarkets = new Set([...prevState.keys(), ...nextState.keys()]);
  for (const market of allMarkets) {
    const a = prevState.get(market);
    const b = nextState.get(market);
    if (!a || !b) { reasons.push(`${market}: appeared_or_vanished`); continue; }
    for (const k of ['unknown', 'oversold', 'small_denominator']) {
      if (a[k] !== b[k]) reasons.push(`${market}: ${k} ${a[k]} → ${b[k]}`);
    }
  }

  const fillOf = (r) => (Number.isFinite(Number(r.fill_pct)) ? Number(r.fill_pct) : 0);
  const prevIdx = new Map((prev.ranking || []).map((r, i) => [r.market, i]));
  const nextIdx = new Map((next.ranking || []).map((r, i) => [r.market, i]));
  const nextFill = new Map((next.ranking || []).map((r) => [r.market, fillOf(r)]));
  const shared = [...nextIdx.keys()].filter((m) => prevIdx.has(m));
  for (let i = 0; i < shared.length; i += 1) {
    for (let j = i + 1; j < shared.length; j += 1) {
      const a = shared[i];
      const b = shared[j];
      const swapped = Math.sign(prevIdx.get(a) - prevIdx.get(b)) !== Math.sign(nextIdx.get(a) - nextIdx.get(b));
      if (!swapped) continue;
      const gap = Math.abs(nextFill.get(a) - nextFill.get(b));
      if (gap > swapMargin) {
        reasons.push(`${a}/${b}: rank swap with a ${gap.toFixed(1)}-point fill gap (margin ${swapMargin})`);
      }
    }
  }

  return { changed: reasons.length > 0, reasons };
}
