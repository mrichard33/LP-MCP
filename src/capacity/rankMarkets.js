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
 * RANKING RULES (settled — see HANDOFF, do not relitigate):
 *   Sort ascending by fill_pct = confirmed / requested for the slot date, with
 *   three guards, first-match-wins:
 *     1. UNKNOWN — FAIL OPEN. No capacity row, or requested = 0, means the
 *        market has NOT FILED YET, never that it has zero capacity. Excluded
 *        from the ranking, listed in unknown[], never ranked 1.
 *     2. OVERSOLD. open_true = requested - confirmed - set_pending. When
 *        open_true <= 0 the market cannot absorb another appointment no
 *        matter what its fill % reads — ranks last among ranked markets.
 *     3. SMALL DENOMINATOR. requested < 4 makes the percentage meaningless
 *        (a 2-slot market can only read 0 / 50 / 100 %) — ranks after every
 *        normal market, before oversold ones.
 *   A market can carry both OVERSOLD and SMALL_DENOMINATOR; both flags are
 *   reported, and the oversold tier decides where it sorts.
 *
 * THE BEHAVIOUR THIS FILE EXISTS FOR: Lakeland on 2026-09-04 read 0.0 %
 * (0 confirmed of 2 requested) with 3 appointments already pending —
 * open_true = -1. A naive fill-% sort puts it at priority 1 and points the
 * whole floor at a market with nothing to sell. It ranks LAST.
 *
 * fill_pct is reported in PERCENTAGE POINTS (0–100, one decimal) so the
 * swap margin (CAPACITY_RANKER_SWAP_MARGIN, "5 points") compares on the same
 * scale the dashboard displays. The board API itself emits a 0–1 fraction.
 */

export const DEFAULT_SMALL_DENOMINATOR = 4;
export const DEFAULT_SWAP_MARGIN = 5;

/** The seven LP markets. There is no Tampa market — LP has no TPA branch. */
export const MARKET_CODES = Object.freeze([
  'FTLAU_MKT', 'ORL_MKT', 'STPET_MKT', 'JAX_MKT', 'FTMYR_MKT', 'SAR_MKT', 'LAKE_MKT',
]);

// Sort tiers — lower dials first. Precedence is UNKNOWN (excluded entirely) >
// OVERSOLD > SMALL_DENOMINATOR > fill %.
const TIER_NORMAL = 0;
const TIER_SMALL_DENOMINATOR = 1;
const TIER_OVERSOLD = 2;

function toCount(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function pct(confirmed, requested) {
  return Math.round((1000 * confirmed) / requested) / 10;
}

/**
 * @param {Array<{market:string, requested:number, confirmed:number, set_pending:number}>} rows
 *        One row per market for ONE slot date (the board's `offices` array).
 * @param {object} [opts]
 * @param {string[]} [opts.markets]  Market codes expected (default: the seven).
 *        A code in `markets` with no row → unknown (fail open). A row whose
 *        code is NOT in `markets` → unknown with reason 'unmapped_market' so it
 *        is visible rather than silently ranked against a list that does not
 *        exist.
 * @param {number} [opts.smallDenominator]  requested below this is flagged.
 * @returns {{ ranking: Array, unknown: Array }}
 */
export function rankMarkets(rows, { markets = MARKET_CODES, smallDenominator = DEFAULT_SMALL_DENOMINATOR } = {}) {
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
    const openTrue = requested - confirmed - setPending;
    const oversold = openTrue <= 0;
    const small = requested < smallDenominator;
    const flags = [];
    if (oversold) flags.push('oversold');
    if (small) flags.push('small_denominator');
    candidates.push({
      market: code,
      requested,
      confirmed,
      set_pending: setPending,
      fill_pct: pct(confirmed, requested),
      open_true: openTrue,
      oversold,
      small_denominator: small,
      flags,
      _tier: oversold ? TIER_OVERSOLD : (small ? TIER_SMALL_DENOMINATOR : TIER_NORMAL),
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
    (a._tier - b._tier)
    || (a.fill_pct - b.fill_pct)
    || (b.open_true - a.open_true)          // same fill %: more truly-open slots first
    || a.market.localeCompare(b.market));   // deterministic last resort

  const ranking = candidates.map((c, i) => {
    const { _tier, ...rest } = c;
    return { rank: i + 1, ...rest };
  });

  return { ranking, unknown };
}

/**
 * Material-change test between the last APPLIED ranking and a new one.
 *
 * Material = a rank swap between two markets whose fill % differ by at least
 * `swapMargin` points, OR any market changing oversold / small_denominator /
 * unknown state. Anything else is noise the floor should not be re-pointed
 * for. No prior applied ranking at all is material by definition — there is
 * nothing on Five9 that reflects this ranking yet.
 *
 * Both arguments are { ranking, unknown } shapes as produced by rankMarkets
 * (the log row stores exactly those two arrays).
 */
export function isMaterialChange(prev, next, { swapMargin = DEFAULT_SWAP_MARGIN } = {}) {
  const reasons = [];
  if (!prev || !Array.isArray(prev.ranking)) {
    return { changed: true, reasons: ['no_prior_applied_ranking'] };
  }

  const stateOf = (r) => ({
    unknown: false,
    oversold: r.oversold === true || (Array.isArray(r.flags) && r.flags.includes('oversold')),
    small_denominator: r.small_denominator === true || (Array.isArray(r.flags) && r.flags.includes('small_denominator')),
  });
  const stateMap = (snap) => {
    const m = new Map();
    for (const r of snap.ranking || []) m.set(r.market, stateOf(r));
    for (const u of snap.unknown || []) m.set(u.market, { unknown: true, oversold: false, small_denominator: false });
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

  const prevIdx = new Map((prev.ranking || []).map((r, i) => [r.market, i]));
  const nextIdx = new Map((next.ranking || []).map((r, i) => [r.market, i]));
  const nextFill = new Map((next.ranking || []).map((r) => [r.market, Number(r.fill_pct) || 0]));
  const shared = [...nextIdx.keys()].filter((m) => prevIdx.has(m));
  for (let i = 0; i < shared.length; i += 1) {
    for (let j = i + 1; j < shared.length; j += 1) {
      const a = shared[i];
      const b = shared[j];
      const swapped = Math.sign(prevIdx.get(a) - prevIdx.get(b)) !== Math.sign(nextIdx.get(a) - nextIdx.get(b));
      if (!swapped) continue;
      const gap = Math.abs(nextFill.get(a) - nextFill.get(b));
      if (gap >= swapMargin) {
        reasons.push(`${a}/${b}: rank swap with ${gap.toFixed(1)}-point fill gap (margin ${swapMargin})`);
      }
    }
  }

  return { changed: reasons.length > 0, reasons };
}
