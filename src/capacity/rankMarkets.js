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
 *   Sort DESCENDING by score = open_true × perf_multiplier, where
 *   open_true = requested - confirmed - set_pending, with two guards that keep
 *   their precedence and still win over score:
 *     1. UNKNOWN — FAIL OPEN. No capacity row, or requested = 0, means the
 *        market has NOT FILED YET, never that it has zero capacity. Excluded
 *        from the ranking, listed in unknown[], never ranked 1.
 *     2. OVERSOLD. When open_true <= 0 the market cannot absorb another
 *        appointment no matter how it scores — ranks last among ranked markets.
 *     3. SMALL DENOMINATOR (requested < 4) is still computed and reported, but
 *        NO LONGER REORDERS ANYTHING. Absolute scoring already handles small
 *        markets correctly: a 2-slot market scores 2 and lands mid-table on
 *        its own, which is where it belongs. The flag remains for the board.
 *   A market can carry both flags; the oversold tier decides where it sorts.
 *
 * ── WHY ABSOLUTE OPEN SLOTS, AND NOT confirmed/requested ────────────────────
 *
 * THE BUG THIS FILE NOW FIXES: fill_pct = confirmed / requested ignores
 * set_pending — the hopper. A market whose slots are all spoken for still
 * reads "empty" and wins priority 1. On 2026-09-05 Jacksonville ranked FIRST
 * with 2 confirmed + 14 pending against 17 slots — ONE genuinely open slot —
 * while St. Pete and Fort Myers each had SEVEN. The oversold guard only fires
 * at open_true <= 0, so JAX at 1 sailed straight through it.
 *
 * ABSOLUTE, NOT A RATE. The dialer's job is to fill slots, so the size of the
 * prize is what matters. Sorting by open RATE puts Lakeland (2 of 2 open =
 * 100 %) above St. Pete (7 of 20 = 35 %) and spends the floor's best hour on
 * two appointments. Sorting by absolute open slots puts the work where the
 * work is.
 *
 * THE WEIGHT IS DELIBERATELY TOO SMALL TO MATTER MUCH. perf_multiplier is
 * clamped to [0.85, 1.15] (src/capacity/marketPerformance.js) and spans only
 * 0.91–1.05 at the default W=0.25 — enough to break a near-tie (Fort Myers
 * over St. Pete when both have 7 open), never enough to flip a 7-vs-4 gap.
 * Capacity dominates; performance decides ties. Markets with no performance
 * data score exactly as their open slots.
 *
 * fill_pct is KEPT in the output for dashboard parity — it is no longer the
 * sort key. It is reported in PERCENTAGE POINTS (0–100, one decimal); the
 * board API itself emits a 0–1 fraction.
 */

export const DEFAULT_SMALL_DENOMINATOR = 4;

/**
 * Minimum SCORE GAP (in slots) two adjacent markets must differ by before
 * trading places counts as material. Was 5 fill-percentage points, which is
 * meaningless now the sort key is a slot count — a fractional weight
 * difference alone must not re-point the floor.
 */
export const DEFAULT_SWAP_MARGIN = 0.5;

/** Consecutive bottom-half applied rankings before starvation promotion. */
export const DEFAULT_STARVATION_THRESHOLD = 3;

/** The seven LP markets. There is no Tampa market — LP has no TPA branch. */
export const MARKET_CODES = Object.freeze([
  'FTLAU_MKT', 'ORL_MKT', 'STPET_MKT', 'JAX_MKT', 'FTMYR_MKT', 'SAR_MKT', 'LAKE_MKT',
]);

// Sort tiers — lower dials first. Precedence is UNKNOWN (excluded entirely) >
// OVERSOLD > score. SMALL_DENOMINATOR is no longer a tier: it is reported but
// does not reorder.
const TIER_NORMAL = 0;
const TIER_OVERSOLD = 1;

function toCount(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function pct(confirmed, requested) {
  return Math.round((1000 * confirmed) / requested) / 10;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
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
 * @param {object} [opts.performance]  { MARKET: { multiplier, set_to_sale } }
 *        from marketPerformance.js. A market absent from it scores at 1.0, so
 *        an empty object is pure open-slot order and a scorecard outage
 *        degrades gracefully instead of taking the ranker down.
 * @param {object} [opts.starvationStreaks]  { MARKET: consecutiveBottomHalf }
 *        from countBottomHalfStreaks. See the starvation guard below.
 * @param {number} [opts.starvationThreshold]
 * @returns {{ ranking: Array, unknown: Array }}
 */
export function rankMarkets(rows, {
  markets = MARKET_CODES,
  smallDenominator = DEFAULT_SMALL_DENOMINATOR,
  performance = {},
  starvationStreaks = {},
  starvationThreshold = DEFAULT_STARVATION_THRESHOLD,
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
    const openTrue = requested - confirmed - setPending;
    const oversold = openTrue <= 0;
    const small = requested < smallDenominator;
    const perf = performance?.[code] || null;
    const multiplier = Number.isFinite(perf?.multiplier) ? perf.multiplier : 1;
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
      score: round3(openTrue * multiplier),
      perf_multiplier: multiplier,
      set_to_sale: Number.isFinite(perf?.set_to_sale) ? perf.set_to_sale : null,
      oversold,
      small_denominator: small,
      starvation_promoted: false,
      flags,
      _tier: oversold ? TIER_OVERSOLD : TIER_NORMAL,
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
    || (b.score - a.score)                  // MORE weighted open slots dial first
    || (b.open_true - a.open_true)          // same score: more raw open slots
    || a.market.localeCompare(b.market));   // deterministic last resort

  // ── Starvation guard ──────────────────────────────────────────────────────
  //
  // A small market can sit mid-table indefinitely and never get worked: its
  // score is honestly low every single run, so it is never wrong to rank it
  // there and it is never dialed either. When a market has slots open, has
  // ZERO confirmed appointments, and has placed bottom-half in `threshold`
  // consecutive APPLIED rankings, force it to rank 2 for one cycle.
  //
  // NEVER rank 1 — the top slot stays earned on score. Rank 2 is enough to get
  // the market worked, and it self-cancels: rank 2 of seven is top half, so
  // the streak resets and the guard stands down on the next run.
  //
  // Oversold markets are never promoted; there is nothing to sell.
  const promoted = candidates.find((c) => (
    !c.oversold
    && c.open_true > 0
    && c.confirmed === 0
    && (starvationStreaks?.[c.market] || 0) >= starvationThreshold
  ));
  if (promoted && candidates.length > 1 && candidates.indexOf(promoted) > 1) {
    promoted.starvation_promoted = true;
    promoted.flags.push('starvation_promoted');
    candidates.splice(candidates.indexOf(promoted), 1);
    candidates.splice(1, 0, promoted);
  }

  const ranking = candidates.map((c, i) => {
    const { _tier, ...rest } = c;
    return { rank: i + 1, ...rest };
  });

  return { ranking, unknown };
}

/**
 * Material-change test between the last APPLIED ranking and a new one.
 *
 * Material = a market MOVING POSITION where the two markets that traded places
 * differ in score by at least `swapMargin` slots, OR any market changing
 * oversold / small_denominator / starvation_promoted / unknown state.
 * Anything else is noise the floor should not be re-pointed for. No prior
 * applied ranking at all is material by definition — there is nothing on Five9
 * that reflects this ranking yet.
 *
 * THE MARGIN CHANGED MEANING. It used to be 5 fill-percentage points, which is
 * meaningless now the sort key is a slot count. It is now a minimum SCORE GAP
 * in slots (default 0.5) required for two markets to trade places, so a
 * fractional performance-weight difference alone can never trigger a Five9
 * write — but a market genuinely gaining or losing a slot can.
 *
 * Both arguments are { ranking, unknown } shapes as produced by rankMarkets
 * (the log row stores exactly those two arrays). Rows logged before this
 * change carry no `score`; they fall back to open_true, which is the same
 * number at multiplier 1.0.
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
    starvation_promoted: r.starvation_promoted === true || hasFlag(r, 'starvation_promoted'),
  });
  const UNKNOWN_STATE = { unknown: true, oversold: false, small_denominator: false, starvation_promoted: false };
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
    for (const k of ['unknown', 'oversold', 'small_denominator', 'starvation_promoted']) {
      if (a[k] !== b[k]) reasons.push(`${market}: ${k} ${a[k]} → ${b[k]}`);
    }
  }

  // Score, falling back to open_true for rows logged before scoring existed.
  const scoreOf = (r) => (Number.isFinite(Number(r.score)) ? Number(r.score) : Number(r.open_true) || 0);
  const prevIdx = new Map((prev.ranking || []).map((r, i) => [r.market, i]));
  const nextIdx = new Map((next.ranking || []).map((r, i) => [r.market, i]));
  const nextScore = new Map((next.ranking || []).map((r) => [r.market, scoreOf(r)]));
  const shared = [...nextIdx.keys()].filter((m) => prevIdx.has(m));
  for (let i = 0; i < shared.length; i += 1) {
    for (let j = i + 1; j < shared.length; j += 1) {
      const a = shared[i];
      const b = shared[j];
      const swapped = Math.sign(prevIdx.get(a) - prevIdx.get(b)) !== Math.sign(nextIdx.get(a) - nextIdx.get(b));
      if (!swapped) continue;
      const gap = Math.abs(nextScore.get(a) - nextScore.get(b));
      if (gap >= swapMargin) {
        reasons.push(`${a}/${b}: rank swap with a ${gap.toFixed(2)}-slot score gap (margin ${swapMargin})`);
      }
    }
  }

  return { changed: reasons.length > 0, reasons };
}
