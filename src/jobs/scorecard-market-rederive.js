// ─── Closed-month per-market funnel RE-DERIVE — src/jobs/scorecard-market-rederive.js ───
//
// Replaces the frozen PROPORTIONAL SPLIT on closed-month per-market rows with a
// REAL, event-level MEASUREMENT. The old path (scorecard-market-backfill.js) split
// each company funnel total across markets by shares — every market then converted
// identically (Issue/Demo/Close within <1pt). This job instead re-pulls the month's
// cohort, attributes each lead to its market BRANCH-FIRST (lp_lead_market_assignments,
// ZIP fallback — the same resolution revenue uses), and counts the funnel per market.
// No metric is ever produced by allocating a company total.
//
// TWO HARD CONSTRAINTS (both enforced here):
//   1. COMPANY TOTALS MUST NOT MOVE. A partition re-buckets a fixed event set — it
//      neither creates nor destroys events. The CONSERVATION GUARD compares the
//      Σ(measured per-market) against the FROZEN REECE funnel, per column. If they
//      differ beyond tolerance the month is ABORTED and reported — a moved company
//      total is a bug, not a discovery. We never rescale/force-fit and never touch
//      the REECE row.
//   2. REVENUE STAYS UNTOUCHED. released_dollars / net_sales / good_business /
//      revenue_basis and all provisional/reconciled columns are NEVER written here.
//      Only funnel counts + funnel ratios are updated on the existing net_report_rtp
//      rows. NSLI/Avg Sale are re-expressed as authoritative RTP net (unchanged) over
//      the NEW measured denominators; Good Rate is redefined on a single SOLD basis.
//
// Default dry_run=true → REPORTS conservation drift + per-market distortion, writes
// NOTHING. Apply with dry_run=false once the report is reviewed.
//
//   POST /n8n/admin/scorecard-market-rederive
//     body: { months?: ['2026-03', …], dry_run?: true, tolerance_pct?: 0.5 }
//
// Idempotent (per-row UPDATE on market,as_of_date filtered computed_from='net_report_rtp').

import supabase from '../supabase.js';
import { fetchAndPartition } from './goal-scorecard-daily.js';
import { computeActuals, DEFAULT_MARKET } from './scorecard-metrics.js';

// Funnel columns re-measured (the split's synthetic values are overwritten). Every
// entry is a COUNT/$ produced by counting real per-market events — never a share.
const FUNNEL_COLS = [
  'leads', 'sets', 'issued', 'net_issue', 'demos', 'sales', 'net_close', 'ko_count', 'gross_sales',
];

// Ratios re-derived from the measured funnel. Basis is stated per ratio in
// buildFunnelUpdate — none mixes two dollar bases or two cohorts.
const rate = (nu, de) => (de ? Math.round((nu / de) * 1000) / 10 : null);
const money = (nu, de) => (de ? Math.round(nu / de) : null);
const n = (v) => (v == null || v === '' ? 0 : Number(v));

/** Last-of-month for a 'YYYY-MM' (UTC-safe). */
function monthEnd(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0, 12, 0, 0)).toISOString().slice(0, 10);
}

/** ET today (YYYY-MM-DD) → used to exclude the still-open current month. */
function currentMonth() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
  }).format(new Date()).slice(0, 7);
}

/**
 * Discover the closed months that carry per-market net_report_rtp rows, with the
 * frozen as_of_date to reproduce each month's snapshot window. Excludes the current
 * (still-open) month — a period's funnel cannot be re-derived while it's live.
 * @returns {Promise<Array<{ month:string, period_start:string, as_of_date:string }>>}
 */
async function discoverClosedMonths(monthsFilter) {
  const { data, error } = await supabase
    .from('lp_market_scorecard_daily')
    .select('period_start, as_of_date')
    .eq('computed_from', 'net_report_rtp')
    .neq('market', DEFAULT_MARKET);
  if (error) throw new Error(`discover closed months failed: ${error.message}`);
  const cur = currentMonth();
  const byMonth = new Map(); // month → latest as_of_date
  for (const r of data || []) {
    const month = String(r.period_start).slice(0, 7);
    if (month >= cur) continue;                              // never the open month
    if (monthsFilter && !monthsFilter.includes(month)) continue;
    const prev = byMonth.get(month);
    if (!prev || String(r.as_of_date) > prev.as_of_date) {
      byMonth.set(month, { period_start: `${month}-01`, as_of_date: String(r.as_of_date) });
    }
  }
  return [...byMonth.entries()]
    .map(([month, v]) => ({ month, ...v }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

/** Build the funnel-only UPDATE payload for one market from its measured actuals. */
function buildFunnelUpdate(actuals, frozenRow) {
  const {
    leads, sets, issued, net_issue, demos, sales, net_close, ko_count, gross_sales,
    released_dollars, working_dollars, other_pending,
  } = actuals;
  // Sold-basis net for Good Rate: (gross − cancelled) = released+working+other, taken
  // from the SAME funnel measurement as gross_sales (one basis, one cohort). We do NOT
  // use released_dollars (RTP net) here — RTP-net ÷ sold-gross would mix two bases.
  const soldNet = n(released_dollars) + n(working_dollars) + n(other_pending);
  // Authoritative RTP net stays exactly as frozen (revenue untouched); it only moves
  // to the NEW measured funnel denominators for the dollars-per-event rates.
  const rtpNet = frozenRow.released_dollars; // == net_sales on a net_report_rtp row
  return {
    leads, sets, issued, net_issue, demos, sales, net_close, ko_count, gross_sales,
    // Funnel-basis ratios (counts measured this run):
    pct_issue: rate(issued, sets),
    demo_pct: rate(demos, net_issue),
    close_pct: rate(sales, demos),
    pct_net_close: rate(net_close, demos),
    ko_pct: rate(ko_count, sales),
    gsli: money(gross_sales, issued),
    // Good Rate — SOLD basis only: (gross − cancelled) ÷ gross, both from the funnel.
    good_rate_pct: rate(soldNet, gross_sales),
    // NSLI / Avg Sale — authoritative RTP net (unchanged) ÷ measured funnel count.
    nsli: rtpNet == null ? null : money(Number(rtpNet), issued),
    avg_sale: rtpNet == null ? null : money(Number(rtpNet), sales),
  };
}

/**
 * @param {object} [opts]
 * @param {string[]} [opts.months]        Restrict to these 'YYYY-MM'.
 * @param {boolean}  [opts.dryRun=true]   Report only; write nothing.
 * @param {number}   [opts.tolerancePct=0.5]  Max % company-total drift per column to
 *                                        still WRITE. Above it → ABORT the month.
 */
export async function rederiveMarketFunnel(opts = {}) {
  const startedAt = Date.now();
  const dryRun = opts.dryRun !== false;                       // default: report only
  const tolerancePct = opts.tolerancePct != null ? Number(opts.tolerancePct) : 0.5;
  const targets = await discoverClosedMonths(opts.months);
  if (!targets.length) return { success: true, months: 0, note: 'no closed net_report_rtp months' };

  const perMonth = [];
  let monthsWritten = 0;

  for (const t of targets) {
    const periodStart = t.period_start;
    const periodEnd = t.as_of_date; // reproduce the frozen snapshot window
    let part;
    try {
      part = await fetchAndPartition({ periodStart, periodEnd });
    } catch (err) {
      perMonth.push({ month: t.month, error: `re-pull failed: ${err.message}` });
      continue;
    }
    const { markets } = part;

    // Measure each market's funnel from the re-pulled, branch-first-partitioned cohort.
    const measured = {}; // market → actuals
    for (const [market, records] of Object.entries(markets)) {
      if (market === DEFAULT_MARKET) continue;
      measured[market] = computeActuals(records, { periodStart, periodEnd });
    }

    // Load the frozen per-market rows (funnel BEFORE + authoritative revenue) and the
    // frozen REECE company funnel (the conservation reference — never overwritten).
    const { data: frozenRows, error: fe } = await supabase
      .from('lp_market_scorecard_daily')
      .select(`market, as_of_date, ${FUNNEL_COLS.join(', ')}, close_pct, released_dollars, net_sales`)
      .eq('computed_from', 'net_report_rtp')
      .eq('period_start', periodStart);
    if (fe) { perMonth.push({ month: t.month, error: `load frozen failed: ${fe.message}` }); continue; }
    const frozenByMarket = Object.fromEntries((frozenRows || []).map((r) => [r.market, r]));
    const frozenReece = frozenByMarket[DEFAULT_MARKET];
    if (!frozenReece) { perMonth.push({ month: t.month, error: 'no frozen REECE row' }); continue; }

    // ── CONSERVATION GUARD ──────────────────────────────────────────────────────
    // Σ(measured per-market) must equal the frozen REECE funnel, per column. A
    // partition conserves events; drift beyond tolerance means the re-pull returned a
    // different event set → ABORT + report (do NOT rescale, do NOT touch REECE).
    const measuredMarkets = Object.keys(measured);
    const conservation = {};
    let guardPassed = true;
    for (const col of FUNNEL_COLS) {
      const sum = measuredMarkets.reduce((a, m) => a + n(measured[m][col]), 0);
      const frozen = n(frozenReece[col]);
      const diff = sum - frozen;
      const pct = frozen ? Math.round((Math.abs(diff) / frozen) * 1000) / 10 : (sum ? 100 : 0);
      const within = pct <= tolerancePct;
      if (!within) guardPassed = false;
      conservation[col] = { frozen, measured_sum: sum, diff, drift_pct: pct, within };
    }

    // Distortion report: each market's close% (and key counts) BEFORE (split) → AFTER
    // (measured), so the size of the old distortion is visible even in dry-run.
    const closePcts = [];
    const marketReport = measuredMarkets
      .filter((m) => m !== 'UNASSIGNED' && m !== 'OUT_OF_AREA')
      .map((m) => {
        const a = measured[m];
        const f = frozenByMarket[m] || {};
        const afterClose = rate(n(a.sales), n(a.demos));
        if (afterClose != null) closePcts.push(afterClose);
        return {
          market: m,
          before: { leads: n(f.leads), issued: n(f.issued), demos: n(f.demos), sales: n(f.sales), close_pct: f.close_pct },
          after: { leads: a.leads, issued: a.issued, demos: a.demos, sales: a.sales, close_pct: afterClose },
        };
      })
      .sort((x, y) => (x.after.close_pct ?? 0) - (y.after.close_pct ?? 0));
    const closeSpread = closePcts.length
      ? Math.round((Math.max(...closePcts) - Math.min(...closePcts)) * 10) / 10 : null;

    let wrote = false;
    if (!dryRun && guardPassed) {
      // Overwrite ONLY funnel columns + funnel ratios on the existing net_report_rtp
      // rows. Revenue columns are never in the payload. REECE is never written.
      let ok = true;
      for (const m of measuredMarkets) {
        const frozen = frozenByMarket[m];
        if (!frozen) continue; // measured a market with no frozen row → skip (report)
        const update = buildFunnelUpdate(measured[m], frozen);
        const { error: ue } = await supabase
          .from('lp_market_scorecard_daily')
          .update(update)
          .eq('market', m)
          .eq('as_of_date', frozen.as_of_date)
          .eq('computed_from', 'net_report_rtp');
        if (ue) { ok = false; perMonth.push({ month: t.month, market: m, error: `update failed: ${ue.message}` }); break; }
      }
      wrote = ok;
      if (ok) monthsWritten += 1;
    }

    perMonth.push({
      month: t.month,
      as_of_date: t.as_of_date,
      guard_passed: guardPassed,
      wrote,
      close_pct_spread: closeSpread,          // Phase-1 gate: expect ≥ 10pt
      conservation,                            // per-column frozen vs measured (proof)
      markets: marketReport,                   // before(split) → after(measured) distortion
    });
  }

  return {
    success: true,
    dry_run: dryRun,
    tolerance_pct: tolerancePct,
    months: targets.length,
    months_written: monthsWritten,
    per_month: perMonth,
    elapsed_ms: Date.now() - startedAt,
  };
}

// ─── HTTP route (one-shot) ───────────────────────────────────────────
export function registerScorecardRederiveRoutes(app) {
  app.post('/n8n/admin/scorecard-market-rederive', async (req, res) => {
    try {
      const months = Array.isArray(req.body?.months) ? req.body.months : undefined;
      const dryRunRaw = req.body?.dry_run ?? req.query?.dry_run;
      const dryRun = !(dryRunRaw === false || dryRunRaw === 'false'); // default true (safe)
      const tolerancePct = req.body?.tolerance_pct ?? req.query?.tolerance_pct;
      const result = await rederiveMarketFunnel({ months, dryRun, tolerancePct });
      res.json(result);
    } catch (err) {
      console.error('[ScorecardRederive] error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });
  console.log('[ScorecardRederive] Route registered: POST /n8n/admin/scorecard-market-rederive');
}
