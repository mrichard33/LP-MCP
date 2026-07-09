// ─── Per-market backfill (proportional split) — src/jobs/scorecard-market-backfill.js ───
//
// Splits each FROZEN REECE snapshot in lp_market_scorecard_daily into per-market
// rows WITHOUT disturbing the reconciled REECE totals. Re-pulling history from LP
// would return today's job states (drift), so instead we:
//
//   1. Pull the cohort fresh for each month and partition by market (C2 preview)
//      to get the current per-market DISTRIBUTION (shares).
//   2. Allocate each frozen REECE column across markets by those shares, with
//      integer/dollar remainders repaired so Σ(markets) = the frozen REECE value
//      to the penny for every column.
//   3. Re-derive ratios from the allocated numerators and upsert the per-market
//      rows at the same as_of_date.
//
// One-shot: POST /n8n/admin/scorecard-market-backfill  body: { months?: ['2026-01', …] }
// Idempotent (upsert on market,as_of_date). REECE rows are never written here.

import supabase from '../supabase.js';
import { computeGoalScorecard } from './goal-scorecard-daily.js';

const NUMERATORS = [
  'leads', 'sets', 'issued', 'net_issue', 'demos', 'sales', 'net_close', 'ko_count',
  'gross_sales', 'net_sales', 'released_dollars', 'working_dollars',
];
const BUCKETS = ['other_pending', 'cancelled_dollars'];

const n = (v) => (v == null || v === '' ? null : Number(v));
function rate(numr, den) { return den ? Math.round((numr / den) * 1000) / 10 : null; }
function money(numr, den) { return den ? Math.round(numr / den) : null; }
function bucketOf(row, key) {
  return n(row?.raw_inputs?.bucket_tally?.[key]);
}

/**
 * Allocate an integer/dollar `total` across `shares` (per-market basis values),
 * returning integers that sum EXACTLY to round(total). Remainder goes to the
 * markets with the largest fractional parts.
 */
export function allocateProportional(total, shares) {
  const T = Math.round(Number(total) || 0);
  const basis = shares.map((s) => Number(s) || 0);
  const sum = basis.reduce((a, b) => a + b, 0);
  if (T === 0) return basis.map(() => 0);
  if (sum <= 0) {
    // No fresh basis for this column but the frozen total is non-zero — split as
    // evenly as possible so Σ(markets) still equals the frozen REECE value.
    const each = Math.floor(T / basis.length);
    const out = basis.map(() => each);
    for (let i = 0, rem = T - each * basis.length; i < rem; i++) out[i] += 1;
    return out;
  }
  const raw = basis.map((b) => (b / sum) * T);
  const out = raw.map((x) => Math.floor(x));
  let rem = T - out.reduce((a, b) => a + b, 0);
  const order = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; rem > 0 && order.length; k++, rem--) out[order[k % order.length].i] += 1;
  return out;
}

/** Group all frozen REECE snapshots by month; carry the widest cohort window. */
async function loadFrozenReece(months) {
  const { data, error } = await supabase
    .from('lp_market_scorecard_daily')
    .select('*')
    .eq('market', 'REECE')
    .order('as_of_date', { ascending: true });
  if (error) throw new Error(`load REECE rows failed: ${error.message}`);
  const byMonth = new Map(); // 'YYYY-MM' → { month, period_start, rows:[], latestAsOf, latestEnd }
  for (const r of data || []) {
    const mo = String(r.period_start).slice(0, 7);
    if (months && !months.includes(mo)) continue;
    const e = byMonth.get(mo) || { month: mo, period_start: r.period_start, rows: [], latestAsOf: '', latestEnd: r.period_end };
    e.rows.push(r);
    if (String(r.as_of_date) > String(e.latestAsOf)) { e.latestAsOf = String(r.as_of_date); e.latestEnd = r.period_end; }
    byMonth.set(mo, e);
  }
  return [...byMonth.values()];
}

/**
 * @param {object} [opts]
 * @param {string[]} [opts.months]  Restrict to these 'YYYY-MM' months (default: all).
 */
export async function backfillMarketSplit(opts = {}) {
  const startedAt = Date.now();
  const target = await loadFrozenReece(opts.months);
  if (!target.length) return { success: true, months: 0, rows_written: 0, note: 'no matching REECE snapshots' };

  let rowsWritten = 0;
  const perMonth = [];

  for (const m of target) {
    // 1. Fresh per-market distribution for the month (widest cohort window).
    const monthStart = `${m.month}-01`;
    let fresh;
    try {
      fresh = await computeGoalScorecard({ period_start: monthStart, period_end: m.latestEnd, persist: false });
    } catch (err) {
      perMonth.push({ month: m.month, error: `fresh pull failed: ${err.message}` });
      continue;
    }
    const freshRows = (fresh?.rows || []).filter((r) => r.market !== 'REECE');
    const marketCodes = freshRows.map((r) => r.market);
    if (!marketCodes.length) { perMonth.push({ month: m.month, error: 'no per-market fresh rows' }); continue; }
    const freshByMarket = Object.fromEntries(freshRows.map((r) => [r.market, r]));

    // 2. For each frozen snapshot in the month, allocate by the month's shares.
    const outRows = [];
    for (const frozen of m.rows) {
      // Per-numerator allocation.
      const alloc = {}; // market → { metric → value|null }
      for (const code of marketCodes) alloc[code] = {};

      for (const metric of NUMERATORS) {
        const total = n(frozen[metric]);
        if (total == null) { for (const code of marketCodes) alloc[code][metric] = null; continue; }
        const shares = marketCodes.map((code) => n(freshByMarket[code][metric]) || 0);
        const got = allocateProportional(total, shares);
        marketCodes.forEach((code, i) => { alloc[code][metric] = got[i]; });
      }
      for (const bkt of BUCKETS) {
        const total = bucketOf(frozen, bkt);
        if (total == null) { for (const code of marketCodes) alloc[code][bkt] = null; continue; }
        const shares = marketCodes.map((code) => bucketOf(freshByMarket[code], bkt) || 0);
        const got = allocateProportional(total, shares);
        marketCodes.forEach((code, i) => { alloc[code][bkt] = got[i]; });
      }

      for (const code of marketCodes) {
        const a = alloc[code];
        const isUtility = code === 'UNASSIGNED' || code === 'OUT_OF_AREA';
        const activity = (a.sets || 0) + (a.issued || 0) + (a.demos || 0) + (a.sales || 0) + (a.gross_sales || 0);
        if (isUtility && activity === 0) continue; // don't write empty utility rows

        const released = a.released_dollars;
        const working = a.working_dollars;
        const other = a.other_pending;
        const cancelled = a.cancelled_dollars;
        const gross = a.gross_sales ?? 0;
        const netSales = a.net_sales ?? 0;
        const bucketTally = released == null && working == null && other == null && cancelled == null
          ? undefined
          : {
              released_dollars: released ?? 0,
              working_dollars: working ?? 0,
              other_pending: other ?? 0,
              cancelled_dollars: cancelled ?? 0,
            };

        outRows.push({
          market: code,
          as_of_date: frozen.as_of_date,
          period_start: frozen.period_start,
          period_end: frozen.period_end,
          days_elapsed: frozen.days_elapsed,
          working_days_in_period: frozen.working_days_in_period,
          leads: a.leads, sets: a.sets, issued: a.issued, net_issue: a.net_issue,
          demos: a.demos, sales: a.sales, net_close: a.net_close, ko_count: a.ko_count,
          gross_sales: gross, net_sales: netSales, good_business: netSales,
          released_dollars: released, working_dollars: working,
          pending_total: working, pending_dollars: working, deposits: 0,
          raw_leads_in: null,
          pct_issue: rate(a.issued || 0, a.sets || 0),
          demo_pct: rate(a.demos || 0, a.net_issue || 0),
          close_pct: rate(a.sales || 0, a.demos || 0),
          pct_net_close: rate(a.net_close || 0, a.demos || 0),
          good_rate_pct: released == null ? null : rate(released, gross),
          ko_pct: rate(a.ko_count || 0, a.sales || 0),
          gsli: money(gross, a.issued || 0),
          nsli: money(netSales, a.issued || 0),
          avg_sale: money(netSales, a.net_close || 0),
          computed_from: 'backfill_split',
          reconciled: frozen.reconciled,
          raw_inputs: {
            revenue_basis: 'backfill proportional split of frozen REECE',
            split_from: 'REECE', split_month: m.month,
            ...(bucketTally ? { bucket_tally: bucketTally } : {}),
          },
        });
      }
    }

    if (outRows.length) {
      const { error } = await supabase
        .from('lp_market_scorecard_daily')
        .upsert(outRows, { onConflict: 'market,as_of_date' });
      if (error) { perMonth.push({ month: m.month, error: `upsert failed: ${error.message}` }); continue; }
      rowsWritten += outRows.length;
    }
    perMonth.push({ month: m.month, snapshots: m.rows.length, markets: marketCodes.length, rows: outRows.length });
  }

  return { success: true, months: target.length, rows_written: rowsWritten, per_month: perMonth, elapsed_ms: Date.now() - startedAt };
}

// ─── HTTP route (one-shot) ───────────────────────────────────────────
export function registerScorecardBackfillRoutes(app) {
  app.post('/n8n/admin/scorecard-market-backfill', async (req, res) => {
    try {
      const months = Array.isArray(req.body?.months) ? req.body.months : undefined;
      const result = await backfillMarketSplit({ months });
      res.json(result);
    } catch (err) {
      console.error('[ScorecardBackfill] error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });
  console.log('[ScorecardBackfill] Route registered: POST /n8n/admin/scorecard-market-backfill');
}
