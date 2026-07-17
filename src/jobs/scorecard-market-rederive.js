// ─── Closed-month per-market funnel RE-DERIVE — src/jobs/scorecard-market-rederive.js ───
//
// Replaces the frozen PROPORTIONAL SPLIT on closed-month rows with a REAL, event-level
// MEASUREMENT. The old path (scorecard-market-backfill.js) split each company funnel
// total across markets by shares — every market then converted identically (Issue/Demo/
// Close within <1pt). This job re-pulls the month's cohort, attributes each lead to its
// market BRANCH-FIRST (lp_lead_market_assignments, ZIP fallback — the resolution revenue
// uses), and COUNTS the funnel per market. No metric is produced by allocating a total.
//
// APPROACH (Option B, corrected). A re-pull "as of now" cannot reproduce a month-close
// snapshot: progression flags (everissued/eversat) and job $ mature over time (a Jan-appt
// lead issued in Feb now counts in the Jan cohort). So we re-measure COMPANY and PER-MARKET
// TOGETHER from the same pull and write BOTH — Σ(markets) = REECE by construction. leads/
// sales conserve to ~0% vs the frozen close; issued/demos mature +3–4% (the matured number
// is the more correct one). We do NOT chase point-in-time conservation against a baseline
// that itself moved.
//
// HARD CONSTRAINTS:
//   • REVENUE UNTOUCHED — released_dollars / net_sales / good_business / revenue_basis /
//     revenue_as_of and the provisional/reconciled columns are NEVER written. Only funnel
//     counts + funnel ratios. NSLI/Avg Sale keep the authoritative RTP net numerator
//     (unchanged) over the NEW measured denominators.
//   • GROSS IS SEPARATED — closed rows carried report RTP GROSS in gross_sales (a revenue
//     figure, not funnel). We PRESERVE it into rtp_gross_dollars and RESTORE gross_sales to
//     funnel SOLD-basis, so Good Rate = (sold gross − cancellations) ÷ sold gross on ONE basis.
//   • BASELINE = latest as_of per (market, period_start) — never an intermediate MTD snapshot.
//   • gross_sales is EXCLUDED from the funnel-conservation report (it is not a funnel count).
//
// Default dry_run=true → REPORTS maturation + per-market distortion, writes NOTHING.
//
//   POST /n8n/admin/scorecard-market-rederive  body: { months?, dry_run?, day_retries? }
//
// Idempotent (per-row UPDATE on market,as_of_date filtered computed_from='net_report_rtp').

import supabase from '../supabase.js';
import { fetchAndPartition } from './goal-scorecard-daily.js';
import { computeActuals, DEFAULT_MARKET } from './scorecard-metrics.js';

// Funnel COUNT columns — used for the maturation report and the partition-integrity
// check. gross_sales is intentionally ABSENT: on closed rows it holds report RTP gross
// (revenue), not a funnel count, so it is never "conserved" or compared here.
const FUNNEL_COUNT_COLS = ['leads', 'sets', 'issued', 'net_issue', 'demos', 'sales', 'net_close', 'ko_count'];
// Columns expected to CONSERVE (cohort membership is stable) vs MATURE (progression flags
// accumulate). Split only for reporting clarity.
const CONSERVING_COLS = ['leads', 'sets', 'sales', 'net_close', 'ko_count'];
const MATURING_COLS = ['issued', 'net_issue', 'demos'];

const rate = (nu, de) => (de ? Math.round((nu / de) * 1000) / 10 : null);
const money = (nu, de) => (de ? Math.round(nu / de) : null);
const n = (v) => (v == null || v === '' ? 0 : Number(v));

/** ET current month 'YYYY-MM' → excludes the still-open month. */
function currentMonth() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
  }).format(new Date()).slice(0, 7);
}

/**
 * Closed months carrying per-market net_report_rtp rows, with the LATEST as_of_date
 * per month (DISTINCT ON latest snapshot) to reproduce each month's final window.
 */
async function discoverClosedMonths(monthsFilter) {
  const { data, error } = await supabase
    .from('lp_market_scorecard_daily')
    .select('period_start, as_of_date')
    .eq('computed_from', 'net_report_rtp')
    .neq('market', DEFAULT_MARKET);
  if (error) throw new Error(`discover closed months failed: ${error.message}`);
  const cur = currentMonth();
  const byMonth = new Map();
  for (const r of data || []) {
    const month = String(r.period_start).slice(0, 7);
    if (month >= cur) continue;
    if (monthsFilter && !monthsFilter.includes(month)) continue;
    const prev = byMonth.get(month);
    if (!prev || String(r.as_of_date) > prev.as_of_date) {
      byMonth.set(month, { period_start: `${month}-01`, as_of_date: String(r.as_of_date) });
    }
  }
  return [...byMonth.entries()].map(([month, v]) => ({ month, ...v })).sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * Load the LATEST-as_of net_report_rtp row per market for a period_start (the baseline
 * the dashboard's resolved view surfaces). Reduces the full snapshot set to one row per
 * market by max(as_of_date) — fixes the guard-read-wrong-row defect.
 * @returns {Promise<Record<string, object>>} market → latest frozen row
 */
async function loadFrozenLatest(periodStart) {
  const { data, error } = await supabase
    .from('lp_market_scorecard_daily')
    .select(`market, as_of_date, ${FUNNEL_COUNT_COLS.join(', ')}, gross_sales, released_dollars, net_sales, rtp_gross_dollars`)
    .eq('computed_from', 'net_report_rtp')
    .eq('period_start', periodStart)
    .order('as_of_date', { ascending: false });
  if (error) throw new Error(`load frozen failed: ${error.message}`);
  const byMarket = {};
  for (const r of data || []) {
    if (!(r.market in byMarket)) byMarket[r.market] = r; // first seen = latest as_of (ordered desc)
  }
  return byMarket;
}

/** Build the funnel-only UPDATE payload for one market from its measured actuals. */
function buildFunnelUpdate(measured, frozen) {
  const { leads, sets, issued, net_issue, demos, sales, net_close, ko_count, gross_sales } = measured;
  // Funnel SOLD net = sold gross − cancellations, taken straight from computeActuals'
  // net_sales (= released + working + other_pending). MUST use net_sales, not a re-sum of
  // released/working: `other_pending` is NOT a top-level field (it lives in
  // raw_inputs.bucket_tally), and for long-settled closed-month jobs the sold dollars land
  // in that `other` bucket — re-summing top-level released+working alone collapses to ~0 and
  // zeroes Good Rate. Never released_dollars (that is RTP net).
  const soldNet = n(measured.net_sales);
  const grossSold = n(gross_sales);
  // Authoritative RTP net stays exactly as frozen (revenue untouched); it only moves to
  // the NEW measured funnel denominators for the dollars-per-event rates.
  const rtpNet = frozen.released_dollars;
  // Preserve report RTP gross: capture the current gross_sales into rtp_gross_dollars
  // the first time (idempotent — keep an already-captured value on re-runs).
  const rtpGross = frozen.rtp_gross_dollars != null ? frozen.rtp_gross_dollars : frozen.gross_sales;
  return {
    leads, sets, issued, net_issue, demos, sales, net_close, ko_count,
    gross_sales: grossSold,          // RESTORED to funnel sold-basis
    rtp_gross_dollars: rtpGross,     // report RTP gross moved to its own revenue column
    pct_issue: rate(issued, sets),
    demo_pct: rate(demos, net_issue),
    close_pct: rate(sales, demos),
    pct_net_close: rate(net_close, demos),
    ko_pct: rate(ko_count, sales),
    gsli: money(grossSold, issued),
    // Good Rate — single SOLD basis: (sold gross − cancellations) ÷ sold gross.
    good_rate_pct: rate(soldNet, grossSold),
    // NSLI / Avg Sale — authoritative RTP net (unchanged) ÷ measured funnel count.
    nsli: rtpNet == null ? null : money(Number(rtpNet), issued),
    avg_sale: rtpNet == null ? null : money(Number(rtpNet), sales),
  };
}

let _rtpGrossColumnEnsured = false;
async function ensureRtpGrossColumn() {
  if (_rtpGrossColumnEnsured) return;
  try {
    await supabase.rpc('exec_sql', {
      sql: 'ALTER TABLE lp_market_scorecard_daily ADD COLUMN IF NOT EXISTS rtp_gross_dollars numeric;',
    });
    _rtpGrossColumnEnsured = true;
  } catch (err) {
    console.warn(`[ScorecardRederive] ensureRtpGrossColumn skipped: ${err.message}`);
  }
}

/**
 * @param {object} [opts]
 * @param {string[]} [opts.months]      Restrict to these 'YYYY-MM'.
 * @param {boolean}  [opts.dryRun=true] Report only; write nothing.
 * @param {number}   [opts.dayRetries=4] Per-day LP fetch retries (handles 500 timeouts).
 */
export async function rederiveMarketFunnel(opts = {}) {
  const startedAt = Date.now();
  const dryRun = opts.dryRun !== false;
  const dayRetries = opts.dayRetries != null ? Number(opts.dayRetries) : 4;
  const targets = await discoverClosedMonths(opts.months);
  if (!targets.length) return { success: true, months: 0, note: 'no closed net_report_rtp months' };

  // Ensure the rtp_gross_dollars column exists BEFORE loadFrozenLatest selects it —
  // in dry-run too (the read needs it), not only on apply.
  await ensureRtpGrossColumn();

  const perMonth = [];
  let monthsWritten = 0;

  for (const t of targets) {
    const periodStart = t.period_start;
    const periodEnd = t.as_of_date; // reproduce the month's final snapshot window
    let part;
    try {
      part = await fetchAndPartition({ periodStart, periodEnd, branchFirst: true, dayRetries });
    } catch (err) {
      perMonth.push({ month: t.month, error: `re-pull failed: ${err.message}` });
      continue;
    }
    const { markets } = part;

    // Measure COMPANY (REECE, full cohort) and PER-MARKET from the same pull. Each
    // prospect lands in exactly one market group AND in REECE, so Σ(markets)=REECE.
    const measured = {};
    for (const [market, records] of Object.entries(markets)) {
      measured[market] = computeActuals(records, { periodStart, periodEnd });
    }
    const measuredReece = measured[DEFAULT_MARKET];
    const marketKeys = Object.keys(measured).filter((m) => m !== DEFAULT_MARKET);

    // Partition integrity: Σ(per-market) must equal the measured REECE per funnel count.
    // This is the real invariant now (both are written from this same measurement).
    const integrity = {};
    let integrityOk = true;
    for (const col of FUNNEL_COUNT_COLS) {
      const sum = marketKeys.reduce((a, m) => a + n(measured[m][col]), 0);
      const reece = n(measuredReece[col]);
      const ok = sum === reece;
      if (!ok) integrityOk = false;
      integrity[col] = { reece, market_sum: sum, diff: sum - reece, ok };
    }

    // Baseline = latest as_of per market (fixes the wrong-row defect).
    const frozenLatest = await loadFrozenLatest(periodStart);
    const frozenReece = frozenLatest[DEFAULT_MARKET];

    // Maturation report: measured REECE vs the CORRECT (latest) frozen REECE, per funnel
    // count. gross_sales excluded (it's revenue on the frozen row). Split conserving vs
    // maturing for readability.
    const maturation = { conserving: {}, maturing: {} };
    for (const col of FUNNEL_COUNT_COLS) {
      const frozen = n(frozenReece?.[col]);
      const meas = n(measuredReece[col]);
      const diff = meas - frozen;
      const pct = frozen ? Math.round((diff / frozen) * 1000) / 10 : (meas ? 100 : 0);
      const bucket = CONSERVING_COLS.includes(col) ? 'conserving' : 'maturing';
      maturation[bucket][col] = { frozen, measured: meas, diff, drift_pct: pct };
    }

    // Distortion + close% spread over the 7 real markets.
    const closePcts = [];
    const marketReport = marketKeys
      .filter((m) => m !== 'UNASSIGNED' && m !== 'OUT_OF_AREA')
      .map((m) => {
        const a = measured[m];
        const f = frozenLatest[m] || {};
        const afterClose = rate(n(a.sales), n(a.demos));
        if (afterClose != null) closePcts.push(afterClose);
        return {
          market: m,
          before: { leads: n(f.leads), issued: n(f.issued), demos: n(f.demos), sales: n(f.sales), close_pct: f.close_pct },
          after: { leads: a.leads, issued: a.issued, demos: a.demos, sales: a.sales, close_pct: afterClose },
        };
      })
      .sort((x, y) => (x.after.close_pct ?? 0) - (y.after.close_pct ?? 0));
    const closeSpread = closePcts.length ? Math.round((Math.max(...closePcts) - Math.min(...closePcts)) * 10) / 10 : null;

    // Apply: write funnel columns to BOTH REECE and per-market latest-as_of rows from the
    // same measurement. Revenue columns are never in the payload.
    let wrote = false;
    const writeIssues = [];
    if (!dryRun && integrityOk) {
      let ok = true;
      for (const m of Object.keys(measured)) {
        const frozen = frozenLatest[m];
        if (!frozen) { writeIssues.push(`${m}: no frozen row`); continue; }
        const update = buildFunnelUpdate(measured[m], frozen);
        const { error: ue } = await supabase
          .from('lp_market_scorecard_daily')
          .update(update)
          .eq('market', m)
          .eq('as_of_date', frozen.as_of_date)
          .eq('computed_from', 'net_report_rtp');
        if (ue) { ok = false; writeIssues.push(`${m}: ${ue.message}`); break; }
      }
      wrote = ok;
      if (ok) monthsWritten += 1;
    }

    perMonth.push({
      month: t.month,
      as_of_date: t.as_of_date,
      partition_integrity_ok: integrityOk,
      integrity,
      wrote,
      write_issues: writeIssues.length ? writeIssues : undefined,
      close_pct_spread: closeSpread,   // Phase-1 gate: expect ≥ 10pt
      maturation,                      // conserving (~0%) vs maturing (+3–4%) vs frozen-latest
      markets: marketReport,           // before(split) → after(measured)
    });
  }

  return {
    success: true,
    dry_run: dryRun,
    day_retries: dayRetries,
    months: targets.length,
    months_written: monthsWritten,
    per_month: perMonth,
    elapsed_ms: Date.now() - startedAt,
  };
}

// ─── Run persistence (fire-and-forget, pollable) ─────────────────────
const REPORT_TABLE = 'scorecard_rederive_reports';

async function ensureReportTable() {
  try {
    await supabase.rpc('exec_sql', {
      sql: `CREATE TABLE IF NOT EXISTS ${REPORT_TABLE} (
        run_id text PRIMARY KEY,
        started_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz,
        dry_run boolean,
        status text NOT NULL DEFAULT 'running',
        report jsonb,
        error text
      );`,
    });
  } catch (err) {
    console.warn(`[ScorecardRederive] ensureReportTable skipped: ${err.message}`);
  }
}

/** Run the re-derive in the background and persist its report by run_id. */
async function runRederiveInBackground(runId, opts) {
  try {
    await supabase.from(REPORT_TABLE).upsert(
      { run_id: runId, dry_run: opts.dryRun !== false, status: 'running', report: null, error: null },
      { onConflict: 'run_id' },
    );
    const result = await rederiveMarketFunnel(opts);
    await supabase.from(REPORT_TABLE).update({
      status: 'done', report: result, finished_at: new Date().toISOString(),
    }).eq('run_id', runId);
    console.log(`[ScorecardRederive] run ${runId} done (dry_run=${opts.dryRun !== false}, months=${result.months})`);
  } catch (err) {
    console.error(`[ScorecardRederive] run ${runId} failed: ${err.message}`);
    await supabase.from(REPORT_TABLE).update({
      status: 'error', error: err.message, finished_at: new Date().toISOString(),
    }).eq('run_id', runId).then(() => {}, () => {});
  }
}

// ─── HTTP routes ─────────────────────────────────────────────────────
export function registerScorecardRederiveRoutes(app) {
  app.post('/n8n/admin/scorecard-market-rederive', async (req, res) => {
    try {
      const months = Array.isArray(req.body?.months) ? req.body.months : undefined;
      const dryRunRaw = req.body?.dry_run ?? req.query?.dry_run;
      const dryRun = !(dryRunRaw === false || dryRunRaw === 'false'); // default true (safe)
      const dayRetries = req.body?.day_retries ?? req.query?.day_retries;
      const runId = `rederive_${new Date().toISOString().replace(/[:.]/g, '-')}`;
      await ensureReportTable();
      runRederiveInBackground(runId, { months, dryRun, dayRetries });
      res.status(202).json({
        success: true, started: true, run_id: runId, dry_run: dryRun,
        poll: `GET /n8n/admin/scorecard-market-rederive/status?run_id=${runId}`,
        poll_sql: `SELECT status, report, error FROM ${REPORT_TABLE} WHERE run_id='${runId}'`,
      });
    } catch (err) {
      console.error('[ScorecardRederive] error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/n8n/admin/scorecard-market-rederive/status', async (req, res) => {
    try {
      const runId = req.query?.run_id;
      const q = runId
        ? supabase.from(REPORT_TABLE).select('*').eq('run_id', runId)
        : supabase.from(REPORT_TABLE).select('*').order('started_at', { ascending: false }).limit(10);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      res.json({ success: true, runs: data || [] });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  console.log('[ScorecardRederive] Routes registered: POST /n8n/admin/scorecard-market-rederive | GET …/status');
}
