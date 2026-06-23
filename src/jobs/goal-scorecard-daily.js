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

const TIMEZONE = 'America/New_York';

// GetLead (options=261120) returns only ~one page per query and StartIndex
// paging is non-functional, so a single wide-window sweep silently truncates to
// ~200 records (138 of ~5,200 leads observed for a full month). We instead query
// one ET calendar day at a time — a day's changed-prospect set sits well under
// any per-query cap — with a PageSize large enough to hold a full day, then
// union the days (dedup by cst_id). Validated against the lp_leads cache.
const DAY_PAGE_SIZE = Number(process.env.SCORECARD_DAY_PAGE_SIZE || 2000);

// Markets confirmed reconciled to a real Reece export → flips reconciled=true.
// Until a market is listed here, its rows render behind the PROVISIONAL banner.
const RECONCILED_MARKETS = new Set(
  (process.env.SCORECARD_RECONCILED_MARKETS || '')
    .split(',').map((s) => s.trim()).filter(Boolean),
);

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

/** Inclusive calendar-day count between two YYYY-MM-DD dates. */
function daysBetween(start, end) {
  const ms = new Date(`${end}T00:00:00Z`) - new Date(`${start}T00:00:00Z`);
  return Math.floor(ms / 86400000) + 1;
}

/** The ET calendar day after a YYYY-MM-DD date (UTC-safe). */
function nextDay(etDate) {
  const d = new Date(`${etDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Fetch every prospect that changed within [periodStart, periodEnd], one ET day
 * at a time (see the DAY_PAGE_SIZE note above for why a single wide sweep can't).
 * Dedups across days by cst_id — a prospect that changed on several days appears
 * in several daily pulls. Throws on LP failure so the caller can abort the write.
 */
async function fetchAllProspects(periodStart, periodEnd) {
  const byCst = new Map(); // cst_id -> prospect; flags are current as of this run
  let anon = 0;            // prospects without a cst_id get a synthetic key so none drop
  for (let day = periodStart; day <= periodEnd; day = nextDay(day)) {
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
    for (const p of items) {
      const cst = getField(p, 'cst_id', 'CST_ID');
      const key = cst != null && cst !== '' ? String(cst) : `__anon_${anon++}`;
      if (!byCst.has(key)) byCst.set(key, p);
    }
    await sleep(RATE_LIMIT_SLEEP_MS); // LP monitors for excessive use
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
  const periodEnd = opts.period_end || opts.date || todayET();
  const periodStart = opts.period_start || monthStart(periodEnd);
  const asOfDate = periodEnd;
  const daysElapsed = daysBetween(periodStart, periodEnd);

  console.log(`[Scorecard] start window=${periodStart}..${periodEnd} options=${SCORECARD_GETLEAD_OPTIONS}`);
  const logId = await syncLogStart('market_scorecard', 'goal_scorecard_daily');

  let prospects;
  try {
    prospects = await fetchAllProspects(periodStart, periodEnd);
  } catch (err) {
    // Circuit open / timeout / partial pull → abort write, keep prior row intact.
    console.error(`[Scorecard] LP fetch failed — aborting write: ${err.message}`);
    await syncLogComplete(logId, 0, `LP fetch failed: ${err.message}`);
    return { success: false, error: err.message, period_start: periodStart, period_end: periodEnd };
  }

  // Single Reece market today; group-by-market keeps the door open for a split.
  const markets = { [DEFAULT_MARKET]: prospects };

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
      ...metrics,
      computed_from: 'lp_api',
      reconciled: RECONCILED_MARKETS.has(market),
      raw_inputs: { ...raw_inputs, prospects_scanned: records.length },
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
    prospects_scanned: prospects.length,
    rows: rows.map((r) => ({
      market: r.market, leads: r.leads, issued: r.issued, sets: r.sets,
      demos: r.demos, sales: r.sales, net_sales: r.net_sales, reconciled: r.reconciled,
    })),
    elapsed_ms: elapsed,
  };
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
