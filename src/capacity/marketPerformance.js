/**
 * Market conversion performance → bounded ranking weight — src/capacity/marketPerformance.js
 *
 * WHAT THIS IS
 *   Trailing-90d set-to-sale per market from lp_market_scorecard_daily, turned
 *   into a multiplier the ranker scales open slots by:
 *
 *     perf_multiplier = clamp(1 + W × (market_set_to_sale / company - 1), 0.85, 1.15)
 *
 *   Everything except getMarketPerformance is PURE, so the regression fixture
 *   in scripts/test-capacity-ranker.js exercises exactly the arithmetic the
 *   route runs. getMarketPerformance is the one I/O seam and it is injected.
 *
 * WHY IT IS BOUNDED, AND WHY THE CLAMP DOES NOT MOVE
 *   Trailing 90d set-to-sale ranges from 16.0 % (Orlando) to 8.6 % (Fort
 *   Lauderdale). Unweighted capacity ranking points the floor at whichever
 *   market happens to have slots, regardless of whether those slots convert.
 *   But capacity must still DOMINATE: the dialer's job is to fill slots, and a
 *   market that converts well with nothing open is worth nothing tonight.
 *   At W=0.25 the multiplier spans 0.91–1.05, so it can break a near-tie
 *   (Fort Myers over St. Pete when both have 7 open) and can NEVER flip a
 *   7-vs-4 gap. W is an env var so it can be tuned without a deploy; the
 *   ±0.15 clamp holds regardless. DO NOT RAISE THE CLAMP.
 *
 * ── THE TWO WAYS THIS QUERY GOES WRONG ──────────────────────────────────────
 *
 * 1. DEDUPE. lp_market_scorecard_daily is NOT one row per market per day. It
 *    is month-to-date CUMULATIVE snapshots: period_start is the 1st of the
 *    month and there is one row per as_of_date, each restating that month's
 *    running totals. Summing raw rows counts July ~24 times over — 76,136 sets
 *    against a true 25,222 — and every multiplier computed off that is wrong
 *    in a way that looks plausible. DISTINCT ON (market, period_start) ordered
 *    by as_of_date DESC takes the LATEST snapshot of each month, which is that
 *    month's final total.
 *
 * 2. THE WINDOW EDGE. Because the grain is monthly, a bare
 *    `period_start >= CURRENT_DATE - INTERVAL '90 days'` cutoff DROPS THE
 *    OLDEST MONTH ENTIRELY. On 2026-09-04 the cutoff is 2026-06-06 and June's
 *    period_start is 2026-06-01, so all of June fell out: 5,860 sets and a
 *    12.5 % baseline instead of the verified 8,885 / 13.5 %. perfWindowStart
 *    snaps the cutoff back to the FIRST OF ITS MONTH so the window covers
 *    whole months, which is the only grain this table has.
 *
 * VERIFIED 2026-09-04 (trailing 90d, window 2026-06-01):
 *   ORL 1,178 sets 16.0 % → 1.047   SAR 1,213 15.7 % → 1.042
 *   FTM 2,318      14.9 % → 1.027   STP 2,084 13.5 % → 1.001
 *   LAKE  232      11.6 % → 0.966   JAX 1,348  8.8 % → 0.914
 *   FTL   512       8.6 % → 0.909
 *   Company baseline 1,197 / 8,885 = 13.47 %.
 *
 * FRESHNESS IS NOT A CONCERN. Over a 90-day window one day of new data barely
 * moves the value — that is the intended behaviour, not a limitation. The
 * weight tracks reality without twitching, so the result is memoised for 12
 * hours rather than recomputed on every hourly run.
 */

import { runSQL } from '../admin/supabase-admin.js';

export const DEFAULT_PERF_WEIGHT = 0.25;
export const DEFAULT_PERF_WINDOW_DAYS = 90;
export const DEFAULT_PERF_MIN_SETS = 100;

/** Hard bound on how far performance may move a market. DO NOT RAISE. */
export const PERF_CLAMP = 0.15;

/** 12 hours. Performance does not move hourly; recomputing invites flapping. */
export const PERF_MEMO_MS = 12 * 60 * 60 * 1000;

/** Not real markets. Excluded from the market list AND the company baseline. */
export const EXCLUDED_MARKETS = Object.freeze(['REECE', 'OUT_OF_AREA', 'UNASSIGNED']);

const TABLE = 'lp_market_scorecard_daily';

export function resolvePerfWeight(raw = process.env.RANKER_PERF_WEIGHT) {
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : DEFAULT_PERF_WEIGHT;
}

export function resolvePerfWindowDays(raw = process.env.RANKER_PERF_WINDOW_DAYS) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PERF_WINDOW_DAYS;
}

export function resolvePerfMinSets(raw = process.env.RANKER_PERF_MIN_SETS) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PERF_MIN_SETS;
}

/**
 * The window's lower bound: `days` back from `asOf`, snapped to the first of
 * THAT month. See note 2 in the header — the table's grain is monthly, so a
 * mid-month cutoff silently discards the month it lands in.
 *
 * @param {string} asOf  YYYY-MM-DD
 * @returns {string}     YYYY-MM-01
 */
export function perfWindowStart(asOf, days = DEFAULT_PERF_WINDOW_DAYS) {
  const [y, m, d] = String(asOf).split('-').map(Number);
  const cutoff = new Date(Date.UTC(y, m - 1, d - days));
  const yy = cutoff.getUTCFullYear();
  const mm = String(cutoff.getUTCMonth() + 1).padStart(2, '0');
  return `${yy}-${mm}-01`;
}

/**
 * The deduped trailing-window aggregate. One row per market: total sets, total
 * sales. Built as text because the dedupe needs DISTINCT ON, which PostgREST's
 * query builder cannot express.
 *
 * windowStart is produced by perfWindowStart and is always YYYY-MM-01, so it
 * is interpolated as a literal after a strict shape check rather than bound —
 * run_sql takes a single statement string.
 */
export function buildScorecardQuery({ windowStart }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(windowStart))) {
    throw new Error(`buildScorecardQuery: windowStart must be YYYY-MM-DD, got ${windowStart}`);
  }
  const excluded = EXCLUDED_MARKETS.map((m) => `'${m}'`).join(', ');
  return `
    SELECT market,
           SUM(sets)  AS sets,
           SUM(sales) AS sales
    FROM (
      SELECT DISTINCT ON (market, period_start) market, period_start, sets, sales
      FROM ${TABLE}
      WHERE period_start >= DATE '${windowStart}'
        AND market NOT IN (${excluded})
      ORDER BY market, period_start, as_of_date DESC
    ) m
    GROUP BY market
  `.trim();
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Rows → { MARKET: { multiplier, set_to_sale, sets, sales, insufficient_sample } }
 * plus a `_company` entry carrying the baseline the multipliers were computed
 * against. PURE.
 *
 * A market with fewer than `minSets` in the window gets multiplier EXACTLY 1.0
 * — never a penalty for being small. It still counts toward the company
 * baseline, because its sets and sales are real company volume.
 *
 * @param {Array<{market:string, sets:number, sales:number}>} rows
 */
export function computeMultipliers(rows, {
  weight = DEFAULT_PERF_WEIGHT,
  minSets = DEFAULT_PERF_MIN_SETS,
} = {}) {
  const agg = new Map();
  for (const r of rows || []) {
    const code = String(r?.market ?? '').trim();
    if (!code || EXCLUDED_MARKETS.includes(code)) continue;
    const cur = agg.get(code) || { sets: 0, sales: 0 };
    cur.sets += num(r.sets);
    cur.sales += num(r.sales);
    agg.set(code, cur);
  }

  let companySets = 0;
  let companySales = 0;
  for (const v of agg.values()) { companySets += v.sets; companySales += v.sales; }
  const companyRate = companySets > 0 ? companySales / companySets : 0;

  const out = {
    _company: { sets: companySets, sales: companySales, set_to_sale: companyRate },
  };

  for (const [code, v] of agg) {
    const rate = v.sets > 0 ? v.sales / v.sets : 0;
    const insufficient = v.sets < minSets;
    let multiplier = 1;
    if (!insufficient && companyRate > 0) {
      const raw = 1 + weight * (rate / companyRate - 1);
      multiplier = Math.min(1 + PERF_CLAMP, Math.max(1 - PERF_CLAMP, raw));
    }
    out[code] = {
      multiplier,
      set_to_sale: rate,
      sets: v.sets,
      sales: v.sales,
      insufficient_sample: insufficient,
    };
  }
  return out;
}

/* ─── The one I/O seam, memoised ─────────────────────────────────────────── */

let cache = null; // { at:number, value:object }

/** Test hook. */
export function _resetPerfCache() { cache = null; }

/**
 * Read, dedupe, aggregate and weight — memoised for PERF_MEMO_MS.
 *
 * FAILS OPEN. A query error returns {} and logs, which rankMarkets reads as
 * "every multiplier is 1.0" — pure open-slot order. A scorecard outage must
 * degrade the ranking to unweighted, never take the ranker down: the floor
 * still needs a dial order.
 */
export async function getMarketPerformance({
  query = null,
  asOf = null,
  weight = resolvePerfWeight(),
  windowDays = resolvePerfWindowDays(),
  minSets = resolvePerfMinSets(),
  now = Date.now(),
  log = console.log,
} = {}) {
  if (cache && now - cache.at < PERF_MEMO_MS) return cache.value;

  const asOfDate = asOf || new Date(now).toISOString().slice(0, 10);
  const windowStart = perfWindowStart(asOfDate, windowDays);
  const sql = buildScorecardQuery({ windowStart });

  let rows;
  try {
    const run = query || ((text) => runSQL(text));
    rows = await run(sql);
    if (rows && !Array.isArray(rows) && Array.isArray(rows.rows)) rows = rows.rows;
    if (!Array.isArray(rows)) rows = [];
  } catch (err) {
    log(`[MarketPerformance] WARN scorecard read FAILED — ranking falls back to unweighted open slots: ${err.message}`);
    return {};
  }

  const value = computeMultipliers(rows, { weight, minSets });
  cache = { at: now, value };
  const summary = Object.entries(value)
    .filter(([k]) => k !== '_company')
    .sort((a, b) => b[1].multiplier - a[1].multiplier)
    .map(([k, v]) => `${k}=${v.multiplier.toFixed(3)}${v.insufficient_sample ? '*' : ''}`)
    .join(' ');
  log(`[MarketPerformance] window_start=${windowStart} W=${weight} min_sets=${minSets} company=${(value._company.set_to_sale * 100).toFixed(1)}% ${summary}`);
  return value;
}

/* ─── Starvation history ─────────────────────────────────────────────────── */

/**
 * Consecutive BOTTOM-HALF placements per market, reading applied rankings most
 * recent first. PURE.
 *
 * A market sitting mid-table indefinitely never gets worked, however sound the
 * score that put it there. This counts how long that has been true so the
 * ranker can force it up for one cycle.
 *
 * Bottom half of n ranked markets is rank > n/2 — for the seven LP markets
 * that is ranks 4 through 7. The FIRST top-half placement stops the count:
 * the streak is consecutive by definition, so an older run of bottom-half
 * placements behind a top-half one does not carry forward.
 *
 * @param {Array<{ranking:Array<{market:string, rank:number}>}>} history
 *        applied = true rows, most recent first.
 */
export function countBottomHalfStreaks(history) {
  const streaks = {};
  const stopped = new Set();

  for (const entry of history || []) {
    const ranking = entry?.ranking;
    if (!Array.isArray(ranking) || ranking.length === 0) continue;
    const size = ranking.length;
    for (const r of ranking) {
      const code = String(r?.market ?? '').trim();
      if (!code || stopped.has(code)) continue;
      const rank = Number(r?.rank);
      if (!Number.isFinite(rank)) continue;
      if (rank > size / 2) streaks[code] = (streaks[code] || 0) + 1;
      else stopped.add(code); // top half — the streak ends here
    }
  }
  return streaks;
}
