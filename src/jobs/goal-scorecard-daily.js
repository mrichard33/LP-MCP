// ─── Daily Goal/Variance Scorecard Job — src/jobs/goal-scorecard-daily.js ───
//
// Computes the "Monday a.m." scorecard ACTUALS for the current MTD window
// (or an explicit period for backfill/tie-out) and upserts one row per market
// into lp_market_scorecard_daily. Goal columns / pace / variance are NOT
// computed here — the dashboard derives those at read time from the editable
// scorecard_goals table.
//
// Data source is the LP API (getLeads, options=261120), NEVER the lp_leads
// cache — the cache undercounts demos (Google PPC Windows Jun 1-22: cache 5 vs
// live ~21). Respects the lp-client circuit breaker; on a partial/failed pull
// it aborts the write and leaves the prior day's row intact.
//
// ENDPOINTS (registered by registerGoalScorecardRoutes):
//   POST /n8n/admin/goal-scorecard-run   body: { period_start?, period_end?, date? }
//   GET  /n8n/admin/goal-scorecard-status
//
// SCHEDULER (startGoalScorecardScheduler): daily at 06:00 ET.

import supabase from '../supabase.js';
import { getLeads } from '../lp-client.js';
import { extractArray, getField, RATE_LIMIT_SLEEP_MS, sleep } from '../sync-utils.js';
import { syncLogStart, syncLogComplete } from '../sync-log.js';
import {
  computeActuals, SCORECARD_GETLEAD_OPTIONS, DEFAULT_MARKET,
} from './scorecard-metrics.js';
import {
  resolveSellingCalendar, sellingDaysElapsed, sellingDaysInPeriod,
  lastCompletedSellingDay, monthEnd,
} from '../selling-days.js';

const TIMEZONE = 'America/New_York';

// GetLead (options=261120) returns only ~one page per query and StartIndex
// paging is non-functional, so a single wide-window sweep silently truncates to
// ~200 records (138 of ~5,200 leads observed for a full month). We instead query
// one ET calendar day at a time — a day's changed-prospect set sits well under
// any per-query cap — with a PageSize large enough to hold a full day, then
// union the days (dedup by cst_id). Validated against the lp_leads cache.
const DAY_PAGE_SIZE = Number(process.env.SCORECARD_DAY_PAGE_SIZE || 2000);

// Daily pulls run in small concurrent batches so a full month returns in seconds
// (one sequential call per day took ~4 min and dropped the HTTP caller). Kept
// modest — LP monitors for excessive concurrent use.
const FETCH_CONCURRENCY = Number(process.env.SCORECARD_FETCH_CONCURRENCY || 6);

// Pull a lookback window before periodStart so appointments SET in a prior month
// (and never re-touched in the appt month — no-shows, quiet reschedules) are
// still captured. The live GetLead pull is keyed by CHANGE date, so without this
// the by-appt-date cohort ran ~10-18% light vs the official report. Counts stay
// scoped to the cohort window in computeActuals; only the fetch window widens.
const PULL_LOOKBACK_DAYS = Number(process.env.SCORECARD_PULL_LOOKBACK_DAYS || 60);

/** Shift a YYYY-MM-DD (ET) back by n calendar days (UTC-safe). */
function minusDays(etDate, n) {
  const d = new Date(`${etDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// Markets confirmed reconciled to a real Reece export → flips reconciled=true.
// Until a market is listed here, its rows render behind the PROVISIONAL banner.
const RECONCILED_MARKETS = new Set(
  (process.env.SCORECARD_RECONCILED_MARKETS || '')
    .split(',').map((s) => s.trim()).filter(Boolean),
);

// Selling-day calendar (Mon–Sat minus Reece closures). Drives the as-of anchor,
// the selling-day elapsed count, and the working-days-in-period denominator so
// the read layer prorates the goal on a consistent selling-day basis.
const SELLING_CAL = resolveSellingCalendar();

/** Today's ET calendar date as YYYY-MM-DD. */
function todayET() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/** First-of-month for an ET YYYY-MM-DD date. */
function monthStart(etDate) {
  return `${etDate.slice(0, 7)}-01`;
}

/** The ET calendar day after a YYYY-MM-DD date (UTC-safe). */
function nextDay(etDate) {
  const d = new Date(`${etDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Fetch one ET day's changed prospects (single page). Throws on LP failure. */
async function fetchDayProspects(day) {
  const res = await getLeads({
    startdate: day, enddate: day,
    options: SCORECARD_GETLEAD_OPTIONS,
    PageSize: DAY_PAGE_SIZE,
    StartIndex: 1,
  });
  const items = extractArray(res);
  if (items.length >= DAY_PAGE_SIZE) {
    // A single day filled the page — possible truncation. Surface it; raise
    // SCORECARD_DAY_PAGE_SIZE if this ever fires for real Reece volume.
    console.warn(`[Scorecard] day ${day} returned ${items.length} >= PageSize ${DAY_PAGE_SIZE} — possible truncation`);
  }
  return items;
}

/**
 * Fetch every prospect that changed within [periodStart, periodEnd], one ET day
 * at a time (see the DAY_PAGE_SIZE note above for why a single wide sweep can't),
 * fetched in small concurrent batches, then unioned deduped by cst_id — a
 * prospect that changed on several days appears in several daily pulls. Throws on
 * LP failure so the caller can abort the write.
 */
async function fetchAllProspects(periodStart, periodEnd) {
  const days = [];
  for (let day = periodStart; day <= periodEnd; day = nextDay(day)) days.push(day);

  const byCst = new Map(); // cst_id -> prospect; flags are current as of this run
  let anon = 0;            // prospects without a cst_id get a synthetic key so none drop
  for (let i = 0; i < days.length; i += FETCH_CONCURRENCY) {
    const pages = await Promise.all(days.slice(i, i + FETCH_CONCURRENCY).map(fetchDayProspects));
    for (const items of pages) {
      for (const p of items) {
        const cst = getField(p, 'cst_id', 'CST_ID');
        const key = cst != null && cst !== '' ? String(cst) : `__anon_${anon++}`;
        if (!byCst.has(key)) byCst.set(key, p);
      }
    }
    await sleep(RATE_LIMIT_SLEEP_MS); // brief pause between batches (LP monitors usage)
  }
  return [...byCst.values()];
}

/**
 * Compute + upsert the scorecard for a window.
 *
 * @param {object} [opts]
 * @param {string} [opts.period_start] YYYY-MM-DD (ET). Default: first of current month.
 * @param {string} [opts.period_end]   YYYY-MM-DD (ET). Default: today.
 * @param {string} [opts.date]         Alias: sets period_end (and infers month start).
 */
export async function computeGoalScorecard(opts = {}) {
  const startedAt = Date.now();
  // Default (cron) path anchors the snapshot to the last COMPLETED selling day —
  // today is in progress, so including it would distort pace/goal math. Explicit
  // period_end/date (backfill, tie-out) pass through verbatim.
  const periodEnd = opts.period_end || opts.date || lastCompletedSellingDay(todayET(), SELLING_CAL);
  const periodStart = opts.period_start || monthStart(periodEnd);
  const asOfDate = periodEnd;
  // Selling days (not calendar days) on a consistent basis for numerator and
  // denominator: elapsed = selling days [periodStart, asOf]; working-days =
  // selling days across the FULL month so the read layer can prorate the goal.
  const daysElapsed = sellingDaysElapsed(periodStart, periodEnd, SELLING_CAL);
  const workingDaysInPeriod = sellingDaysInPeriod(periodStart, monthEnd(periodStart), SELLING_CAL);
  const fetchStart = minusDays(periodStart, PULL_LOOKBACK_DAYS);

  console.log(`[Scorecard] start cohort=${periodStart}..${periodEnd} fetch=${fetchStart}..${periodEnd} (lookback ${PULL_LOOKBACK_DAYS}d) options=${SCORECARD_GETLEAD_OPTIONS}`);
  const logId = await syncLogStart('market_scorecard', 'goal_scorecard_daily');

  let prospects;
  try {
    prospects = await fetchAllProspects(fetchStart, periodEnd);
  } catch (err) {
    // Circuit open / timeout / partial pull → abort write, keep prior row intact.
    console.error(`[Scorecard] LP fetch failed — aborting write: ${err.message}`);
    await syncLogComplete(logId, 0, `LP fetch failed: ${err.message}`);
    return { success: false, error: err.message, period_start: periodStart, period_end: periodEnd };
  }

  // Single Reece market today; group-by-market keeps the door open for a split.
  const markets = { [DEFAULT_MARKET]: prospects };

  // Raw leads in (true top-of-funnel) — the ONE figure sourced from the CACHE,
  // counted by creation date, not the LP-API by-appt cohort. Carries cache
  // freshness, not LP-API freshness. Auxiliary: a failure here must NOT abort the
  // LP-API write. Half-open range [start, nextDay(end)) covers the whole end day
  // whether created_at_lp is a date or a timestamp.
  let rawLeadsIn = null;
  try {
    const { count, error: cntErr } = await supabase
      .from('lp_leads')
      .select('*', { count: 'exact', head: true })
      .gte('created_at_lp', periodStart)
      .lt('created_at_lp', nextDay(periodEnd));
    if (cntErr) console.warn(`[Scorecard] raw_leads_in count failed: ${cntErr.message}`);
    else rawLeadsIn = count ?? null;   // count comes from the response header (head:true → data is null)
  } catch (err) {
    console.warn(`[Scorecard] raw_leads_in count threw: ${err.message}`);
  }

  const rows = [];
  for (const [market, records] of Object.entries(markets)) {
    const actuals = computeActuals(records, { periodStart, periodEnd });
    const { raw_inputs, ...metrics } = actuals;
    rows.push({
      market,
      as_of_date: asOfDate,
      period_start: periodStart,
      period_end: periodEnd,
      days_elapsed: daysElapsed,
      working_days_in_period: workingDaysInPeriod,
      ...metrics,
      raw_leads_in: rawLeadsIn,
      computed_from: 'lp_api',
      reconciled: RECONCILED_MARKETS.has(market),
      raw_inputs: {
        ...raw_inputs,
        prospects_scanned: records.length,
        raw_leads_basis: 'lp_leads.created_at_lp (cache)',
      },
    });
  }

  const { error } = await supabase
    .from('lp_market_scorecard_daily')
    .upsert(rows, { onConflict: 'market,as_of_date' });

  if (error) {
    console.error(`[Scorecard] upsert failed: ${error.message}`);
    await syncLogComplete(logId, 0, error.message);
    return { success: false, error: error.message };
  }

  // Per-source actuals (Phase 2) — same prospect set, no extra LP calls. A failure
  // here must NOT fail the run: the aggregate row is already written.
  let sourceRows = 0, unmappedSources = 0;
  try {
    const res = await writeSourceScorecard({ markets, asOfDate, periodStart, periodEnd, daysElapsed });
    sourceRows = res.count;
    unmappedSources = res.unmapped;
    console.log(`[Scorecard] source rows upserted=${sourceRows} unmapped=${unmappedSources}`);
  } catch (err) {
    console.warn(`[Scorecard] per-source upsert failed (aggregate kept): ${err.message}`);
  }

  const elapsed = Date.now() - startedAt;
  await syncLogComplete(logId, rows.length, null);
  const summary = rows.map((r) => `${r.market}: leads=${r.leads} demos=${r.demos} sales=${r.sales}`).join(' | ');
  console.log(`[Scorecard] done ${summary} prospects=${prospects.length} elapsed=${elapsed}ms`);

  return {
    success: true,
    period_start: periodStart,
    period_end: periodEnd,
    as_of_date: asOfDate,
    markets: rows.length,
    source_rows: sourceRows,
    unmapped_sources: unmappedSources,
    prospects_scanned: prospects.length,
    rows: rows.map((r) => ({
      market: r.market, leads: r.leads, raw_leads_in: r.raw_leads_in,
      issued: r.issued, sets: r.sets, demos: r.demos, sales: r.sales,
      net_sales: r.net_sales, released_dollars: r.released_dollars,
      working_dollars: r.working_dollars, pending_total: r.pending_total,
      gross_sales: r.gross_sales, reconciled: r.reconciled,
    })),
    elapsed_ms: elapsed,
  };
}

/**
 * Compute per-(source, sub_source) actuals for each market and upsert them into
 * lp_source_scorecard_daily. Same prospect set and same metric definitions as the
 * aggregate row — no extra LP calls. Resolves each source through lp_source_mapping
 * to a GHL intent bucket; rows that don't resolve are flagged raw_inputs.unmapped.
 *
 * @returns {{ count:number, unmapped:number }}
 */
async function writeSourceScorecard({ markets, asOfDate, periodStart, periodEnd, daysElapsed }) {
  // Load the (small) source-mapping table once and build offline lookups that
  // mirror resolveSourceBucket: prefer the sub-source detail, then the raw source.
  const subdetailMap = new Map();   // lp_source_subdetail → ghl_intent_bucket
  const rawMap = new Map();         // lp_source_raw       → ghl_intent_bucket
  const { data: mappingRows } = await supabase
    .from('lp_source_mapping')
    .select('lp_source_subdetail, lp_source_raw, ghl_intent_bucket');
  for (const m of mappingRows || []) {
    if (m.lp_source_subdetail) subdetailMap.set(m.lp_source_subdetail, m.ghl_intent_bucket);
    else if (m.lp_source_raw) rawMap.set(m.lp_source_raw, m.ghl_intent_bucket);
  }
  const resolveMapping = (subSource, source) => {
    const bySub = subSource != null ? subdetailMap.get(subSource) : undefined;
    if (bySub && bySub !== 'unmapped') return { bucket: bySub, unmapped: false };
    const byRaw = source != null ? rawMap.get(source) : undefined;
    if (byRaw && byRaw !== 'unmapped') return { bucket: byRaw, unmapped: false };
    return { bucket: null, unmapped: true };
  };

  const rows = [];
  let unmapped = 0;
  for (const [market, records] of Object.entries(markets)) {
    const groups = computeActuals(records, { periodStart, periodEnd, groupBy: ['source', 'sub_source'] });
    for (const g of groups) {
      const resolved = resolveMapping(g.sub_source, g.source);
      if (resolved.unmapped) unmapped += 1;
      // Coalesce null/empty so the (market, source, sub_source, as_of_date) upsert
      // key is deterministic (Postgres treats NULLs as distinct in UNIQUE).
      const src = g.source == null || g.source === '' ? '(none)' : g.source;
      const sub = g.sub_source == null || g.sub_source === '' ? '(none)' : g.sub_source;
      rows.push({
        market, source: src, sub_source: sub,
        as_of_date: asOfDate, period_start: periodStart, period_end: periodEnd, days_elapsed: daysElapsed,
        leads: g.leads, sets: g.sets, issued: g.issued, net_issue: g.net_issue,
        demos: g.demos, sales: g.sales, net_close: g.net_close, ko_count: g.ko_count,
        gross_sales: g.gross_sales, net_sales: g.net_sales, released_dollars: g.released_dollars,
        working_dollars: g.working_dollars, pending_total: g.pending_total,
        pct_issue: g.pct_issue, demo_pct: g.demo_pct, close_pct: g.close_pct, pct_net_close: g.pct_net_close,
        good_rate_pct: g.good_rate_pct, ko_pct: g.ko_pct, gsli: g.gsli, nsli: g.nsli, avg_sale: g.avg_sale,
        computed_from: 'lp_api', reconciled: RECONCILED_MARKETS.has(market),
        raw_inputs: {
          bucket: resolved.bucket,
          unmapped: resolved.unmapped,
          revenue_basis: g.revenue_basis,
          source_raw: g.source ?? null,
          sub_source_raw: g.sub_source ?? null,
        },
      });
    }
  }

  if (rows.length) {
    const { error } = await supabase
      .from('lp_source_scorecard_daily')
      .upsert(rows, { onConflict: 'market,source,sub_source,as_of_date' });
    if (error) throw new Error(error.message);
  }
  return { count: rows.length, unmapped };
}

// ─── HTTP routes ─────────────────────────────────────────────────────
export function registerGoalScorecardRoutes(app) {
  app.post('/n8n/admin/goal-scorecard-run', async (req, res) => {
    try {
      const result = await computeGoalScorecard({
        period_start: req.body?.period_start || req.query?.period_start,
        period_end: req.body?.period_end || req.query?.period_end,
        date: req.body?.date || req.query?.date,
      });
      res.json(result); // success=false surfaces as 200 with structured body for cron/n8n
    } catch (err) {
      console.error('[Scorecard] /goal-scorecard-run error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/n8n/admin/goal-scorecard-status', async (req, res) => {
    try {
      const { data } = await supabase
        .from('lp_market_scorecard_daily')
        .select('market, as_of_date, leads, demos, sales, reconciled, created_at')
        .order('as_of_date', { ascending: false })
        .limit(10);
      res.json({ success: true, recent: data || [] });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  console.log('[Scorecard] Routes registered: POST /n8n/admin/goal-scorecard-run | GET /n8n/admin/goal-scorecard-status');
}

// ─── Scheduler — daily at 06:00 ET ───────────────────────────────────
let scorecardTimer = null;
let lastRunDate = null; // ET date string of the last successful daily run

export function startGoalScorecardScheduler() {
  if (scorecardTimer) return;
  console.log('[Scorecard] Scheduler started — daily run at 06:00 ET');

  const checkAndRun = async () => {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE, hour: '2-digit', hour12: false,
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? -1);
    const today = todayET();
    if (hour === 6 && lastRunDate !== today) {
      lastRunDate = today; // claim the slot before awaiting (avoids double-fire)
      try {
        await computeGoalScorecard();
      } catch (err) {
        console.error('[Scorecard] daily run failed:', err.message);
      }
    }
  };

  // Check every 5 minutes; fires once when the ET hour is 06.
  scorecardTimer = setInterval(checkAndRun, 5 * 60 * 1000);
}

export function stopGoalScorecardScheduler() {
  if (scorecardTimer) {
    clearInterval(scorecardTimer);
    scorecardTimer = null;
  }
}
