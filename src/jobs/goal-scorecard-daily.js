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
import { resolveLiveMonthRevenue, PROVISIONAL_BASIS, LIVE_MONTH_SOURCE } from './scorecard-rtp-source.js';
import {
  buildProspectMarketMap, buildProspectMarketMapFromAssignments,
  getMarketMaps, resolveMarket, normalizeZip5,
} from './market-resolver.js';
import {
  resolveSellingCalendar, sellingDaysElapsed, sellingDaysInPeriod, lastCompletedSellingDay,
} from '../selling-days.js';

const TIMEZONE = 'America/New_York';

// Selling-day calendar (Mon–Sat minus Reece closures) — drives the selling-day
// `days_elapsed` numerator and the `working_days_in_period` denominator the
// dashboard prorates the MTD goal against. Resolved once from env.
const SELLING_CAL = resolveSellingCalendar(process.env);

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

/** Last-of-month for an ET YYYY-MM-DD date (UTC-safe; day 0 of next month). */
function monthEnd(etDate) {
  const [y, m] = etDate.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 0, 12, 0, 0)); // day 0 of month m+1 = last day of month m
  return d.toISOString().slice(0, 10);
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
 * Fetch one day with bounded exponential-backoff retry. LP intermittently returns
 * 500 "Execution Timeout Expired" under load (its DB read timing out); a single
 * such day would otherwise reject the whole month's Promise.all. dayRetries=0
 * preserves the nightly writer's fail-fast behavior.
 */
async function fetchDayWithRetry(day, dayRetries) {
  let attempt = 0;
  for (;;) {
    try {
      return await fetchDayProspects(day);
    } catch (err) {
      if (attempt >= dayRetries) throw err;
      const backoff = 1000 * 2 ** attempt; // 1s, 2s, 4s, …
      console.warn(`[Scorecard] day ${day} fetch failed (attempt ${attempt + 1}/${dayRetries + 1}): ${err.message} — retry in ${backoff}ms`);
      await sleep(backoff);
      attempt += 1;
    }
  }
}

/**
 * Fetch every prospect that changed within [periodStart, periodEnd], one ET day
 * at a time (see the DAY_PAGE_SIZE note above for why a single wide sweep can't),
 * fetched in small concurrent batches, then unioned deduped by cst_id — a
 * prospect that changed on several days appears in several daily pulls. Throws on
 * LP failure so the caller can abort the write.
 *
 * @param {{ dayRetries?: number }} [opts] per-day retry count (default 0 = fail-fast).
 */
export async function fetchAllProspects(periodStart, periodEnd, { dayRetries = 0 } = {}) {
  const days = [];
  for (let day = periodStart; day <= periodEnd; day = nextDay(day)) days.push(day);

  const byCst = new Map(); // cst_id -> prospect; flags are current as of this run
  let anon = 0;            // prospects without a cst_id get a synthetic key so none drop
  for (let i = 0; i < days.length; i += FETCH_CONCURRENCY) {
    const pages = await Promise.all(days.slice(i, i + FETCH_CONCURRENCY).map((d) => fetchDayWithRetry(d, dayRetries)));
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

// Gate for the NIGHTLY live-month writer only: attribute the funnel BRANCH-first
// (matches revenue) vs the legacy prospect-ZIP path. Default OFF so a deploy is
// INERT — the nightly job keeps its pre-existing prospect-ZIP behavior until this
// env var is flipped to 'true'. The closed-month re-derive ALWAYS measures
// branch-first regardless of this flag (it passes branchFirst:true explicitly), so
// the gate can be run and verified before the live-month behavior is switched on.
const BRANCH_FIRST_NIGHTLY =
  String(process.env.SCORECARD_BRANCH_FIRST_ATTRIBUTION || '').trim().toLowerCase() === 'true';

/**
 * Partition a prospect cohort into per-market groups. REECE always holds the full
 * cohort (company roll-up); each prospect also lands in exactly ONE market group,
 * so Σ(market rows) = REECE for every count/$ column.
 *
 * Resolution order per prospect (when branchFirst — funnel attribution MATCHES revenue):
 *   1. lp_lead_market_assignments — BRANCH-first, ZIP fallback (the same audit the
 *      Net Report ties 1,710/1,710); a job-bearing lead credits its branch market.
 *   2. inline prospect ZIP (zip → branch → market) for prospects with no assignment.
 *   3. lp_leads cache ZIP for prospects missing both an assignment and an inline zip.
 * With branchFirst=false, step 1 is skipped → the legacy prospect-ZIP-only behavior.
 * A lookup failure degrades gracefully to REECE-only for the run.
 *
 * @param {object[]} prospects
 * @param {{ branchFirst?: boolean }} [opts] branchFirst=false → legacy ZIP-only path.
 * @returns {Promise<{ markets: Record<string, object[]>, resolveStats: object }>}
 */
export async function partitionProspectsByMarket(prospects, { branchFirst = true } = {}) {
  const cstOf = (p) => String(getField(p, 'cst_id', 'CST_ID') ?? '');
  const zipOf = (p) => getField(p, 'zip', 'ZIP', 'Zip', 'zipcode', 'zip_code');
  const markets = { [DEFAULT_MARKET]: prospects };
  // How each prospect was attributed — surfaced on REECE.raw_inputs so a run is
  // self-verifying (branch vs own-zip vs cache-zip vs out-of-area vs unassigned).
  const resolveStats = { by_branch: 0, by_zip: 0, by_cache_zip: 0, out_of_area: 0, unassigned: 0 };
  try {
    const maps = await getMarketMaps();
    const cstIds = prospects.map(cstOf);
    // Branch-first per-lead attribution from the nightly assignment audit (skipped
    // when branchFirst=false → legacy prospect-ZIP behavior, deploy stays inert).
    const asgMap = branchFirst ? await buildProspectMarketMapFromAssignments(cstIds) : new Map();
    // Cache-ZIP fallback only for prospects with neither an assignment nor an inline zip.
    const noInlineZip = prospects
      .filter((p) => !asgMap.has(cstOf(p)) && !normalizeZip5(zipOf(p)))
      .map(cstOf);
    const cacheMap = noInlineZip.length ? await buildProspectMarketMap(noInlineZip) : new Map();
    for (const p of prospects) {
      const cst = cstOf(p);
      const asg = asgMap.get(cst);
      let mk;
      if (asg && asg.market_code) {
        mk = asg.market_code;
        if (asg.method === 'brn_map') resolveStats.by_branch++;
        else if (mk === 'OUT_OF_AREA') resolveStats.out_of_area++;
        else if (mk === 'UNASSIGNED') resolveStats.unassigned++;
        else resolveStats.by_zip++;
      } else {
        mk = resolveMarket(zipOf(p), maps).market_code;
        if (mk === 'UNASSIGNED') {
          const fromCache = cacheMap.get(cst);
          if (fromCache && fromCache !== 'UNASSIGNED') { mk = fromCache; resolveStats.by_cache_zip++; }
          else resolveStats.unassigned++;
        } else if (mk === 'OUT_OF_AREA') resolveStats.out_of_area++;
        else resolveStats.by_zip++;
      }
      if (mk === DEFAULT_MARKET) continue; // guard against a stray REECE key
      (markets[mk] ||= []).push(p);
    }
  } catch (err) {
    console.warn(`[Scorecard] market partition failed — REECE only this run: ${err.message}`);
  }
  return { markets, resolveStats };
}

/**
 * Fetch a window's prospect cohort (with the standard pre-period lookback) and
 * partition it by market. Shared by the daily writer and the closed-month funnel
 * re-derive so both MEASURE per-market funnel identically (no company-total split).
 *
 * @returns {Promise<{ prospects: object[], markets: Record<string, object[]>, resolveStats: object }>}
 */
export async function fetchAndPartition({ periodStart, periodEnd, branchFirst = true, dayRetries = 0 }) {
  const fetchStart = minusDays(periodStart, PULL_LOOKBACK_DAYS);
  const prospects = await fetchAllProspects(fetchStart, periodEnd, { dayRetries });
  const { markets, resolveStats } = await partitionProspectsByMarket(prospects, { branchFirst });
  return { prospects, markets, resolveStats };
}

/**
 * Compute + upsert the scorecard for a window.
 *
 * @param {object} [opts]
 * @param {string} [opts.period_start] YYYY-MM-DD (ET). Default: first of current month.
 * @param {string} [opts.period_end]   YYYY-MM-DD (ET). Default: last completed selling day.
 * @param {string} [opts.date]         Alias: sets period_end (and infers month start).
 * @param {boolean} [opts.persist=true] When false, compute but DO NOT upsert — returns
 *   the full aggregate row (incl. raw_inputs) + full per-source rows. Used by the
 *   dashboard's period filter so a short-window recompute never overwrites the stored
 *   MTD snapshot (conflict key is market,as_of_date).
 */
export async function computeGoalScorecard(opts = {}) {
  const startedAt = Date.now();
  const persist = opts.persist !== false;
  // Scheduled daily run (no explicit end) snapshots through the LAST COMPLETED
  // selling day — never partial-today — so as_of matches the dashboard's stale
  // guard. Explicit backfill/preview keeps the caller's window end.
  const periodEnd = opts.period_end || opts.date || lastCompletedSellingDay(todayET(), SELLING_CAL);
  const periodStart = opts.period_start || monthStart(periodEnd);
  const asOfDate = periodEnd;
  // Selling-day basis: numerator = selling days in [start, as_of]; denominator =
  // selling days in the start month. Numerator and denominator share one basis so
  // the dashboard's MTD-goal proration (elapsed/working_days) is correct.
  const daysElapsed = sellingDaysElapsed(periodStart, asOfDate, SELLING_CAL);
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

  // Partition the cohort by each lead's resolved market. REECE stays the company
  // roll-up (always written); each prospect lands in exactly one market group so
  // Σ(market rows) = REECE to the penny for every count/$ column. Attribution is
  // branch-first (lp_lead_market_assignments) then ZIP — matching revenue — so a
  // job-bearing lead credits its true operating market, not its mailing ZIP.
  const reeceOnly = { [DEFAULT_MARKET]: prospects };
  const { markets, resolveStats } = await partitionProspectsByMarket(prospects, { branchFirst: BRANCH_FIRST_NIGHTLY });

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
    // Utility rows (UNASSIGNED / OUT_OF_AREA) are written ONLY when they carry
    // in-cohort activity — a zero row would just be noise on the By-Market table.
    const isUtility = market === 'UNASSIGNED' || market === 'OUT_OF_AREA';
    const hasActivity =
      (metrics.sets || 0) + (metrics.issued || 0) + (metrics.demos || 0) +
      (metrics.sales || 0) + (metrics.gross_sales || 0) > 0;
    if (isUtility && !hasActivity) continue;
    rows.push({
      market,
      as_of_date: asOfDate,
      period_start: periodStart,
      period_end: periodEnd,
      days_elapsed: daysElapsed,
      working_days_in_period: workingDaysInPeriod,
      ...metrics,
      // raw_leads_in is a company-wide cache count — carry it on REECE only so the
      // per-market rows stay summable against REECE (Σ markets excludes this aux col).
      raw_leads_in: market === DEFAULT_MARKET ? rawLeadsIn : null,
      computed_from: 'lp_api',
      reconciled: RECONCILED_MARKETS.has(market),
      raw_inputs: {
        ...raw_inputs,
        prospects_scanned: records.length,
        raw_leads_basis: market === DEFAULT_MARKET ? 'lp_leads.created_at_lp (cache)' : 'per-market (prospect zip → branch → market)',
        ...(market === DEFAULT_MARKET ? { market_resolution: resolveStats } : {}),
      },
    });
  }

  // ── Realign the REVENUE columns to RTP net by milestone date ────────────────────
  // The funnel columns above stay lp_api. Revenue is the AUTHORITATIVE metric: report-sourced
  // RTP net (released_dollars/net_sales/good_business), with a warehouse-gross PROVISIONAL
  // companion in its own columns — never blended. See src/jobs/scorecard-rtp-source.js.
  // INVARIANT enforced per row: released_dollars IS NULL ⇔ revenue_basis IS NULL.
  const rrate = (nu, de) => (de ? Math.round((nu / de) * 1000) / 10 : null);
  const rmoney = (nu, de) => (de ? Math.round(nu / de) : null);
  let revByMarket;
  try {
    revByMarket = await resolveLiveMonthRevenue({
      periodStart, periodEnd, marketCodes: rows.map((r) => r.market),
    });
  } catch (err) {
    console.error(`[Scorecard] RTP revenue resolve failed — aborting write: ${err.message}`);
    await syncLogComplete(logId, 0, `RTP revenue resolve failed: ${err.message}`);
    return { success: false, error: err.message, period_start: periodStart, period_end: periodEnd };
  }
  for (const row of rows) {
    const rev = revByMarket.get(row.market) || {
      released_dollars: null, revenue_basis: null, revenue_as_of: null, reconciled: false,
      provisional_gross_dollars: null, provisional_days: null, provisional_basis: PROVISIONAL_BASIS,
    };
    const net = rev.released_dollars; // authoritative RTP net (null when no report — never 0)
    // Funnel SOLD-basis net (= sold gross − cancellations = released+working+other), captured
    // BEFORE the RTP overwrite below — it drives Good Rate on a single sold basis, matching the
    // closed-month re-derive. NEVER mixed with RTP net.
    const soldNet = row.net_sales;
    // released_dollars / net_sales / good_business move together and are ALL NULL when pending
    // (never 0) — one rule, no 0-vs-NULL ambiguity. YTD sums must COALESCE(net_sales,0) at the
    // summation site (the dashboard's num() already coerces null→0).
    row.released_dollars = net;
    row.net_sales = net;
    row.good_business = net;
    row.working_dollars = 0;
    row.pending_total = 0;
    row.pending_dollars = 0;
    row.revenue_basis = rev.revenue_basis;
    row.revenue_as_of = rev.revenue_as_of;
    row.reconciled = rev.reconciled;  // report-backed ⇒ reconciled (provisional banner off)
    row.provisional_gross_dollars = rev.provisional_gross_dollars;
    row.provisional_days = rev.provisional_days;
    // NSLI / Avg Sale keep the authoritative RTP-net numerator (gross_sales stays funnel-basis).
    row.nsli = net == null ? null : rmoney(net, row.issued || 0);
    row.avg_sale = net == null ? null : rmoney(net, row.net_close || 0);
    // Good Rate — single SOLD basis: (sold gross − cancellations) ÷ sold gross. Funnel-only, so
    // it is computable even for a report-less (pending-revenue) month.
    row.good_rate_pct = rrate(soldNet, row.gross_sales || 0);
    // The RTP-net basis has no released/working/other/cancelled split — drop the v1 revenue
    // buckets so the nightly validator's net-identity check skips them (they no longer describe
    // the stored net). Funnel diagnostics (status_tally, issue_diag, …) are retained.
    const { bucket_tally, open_quotes, status_dollar_tally, suspect_sold_sample, pending_basis,
      ...funnelInputs } = row.raw_inputs || {};
    row.raw_inputs = {
      ...funnelInputs,
      revenue_basis: rev.revenue_basis,             // overwrite the retired 'v1' label from finalizeActuals
      provisional_basis: rev.provisional_basis,     // provisional label lives HERE, never in revenue_basis
      revenue_as_of: rev.revenue_as_of,
      provisional_days: rev.provisional_days,
      provisional_gross_dollars: rev.provisional_gross_dollars,
      live_month_source: LIVE_MONTH_SOURCE,
    };
    // INVARIANT — fail loudly rather than persist a row that looks authoritative but is empty.
    // released_dollars, net_sales, good_business, and revenue_basis are all NULL together (pending)
    // or all set together (report-backed). Never a bare 0 masquerading as pending.
    const authNull = row.released_dollars == null;
    if (authNull !== (row.revenue_basis == null)
        || (row.net_sales == null) !== authNull
        || (row.good_business == null) !== authNull) {
      const msg = `revenue invariant violated (${row.market} ${row.as_of_date}): `
        + `released_dollars=${row.released_dollars} net_sales=${row.net_sales} `
        + `good_business=${row.good_business} revenue_basis=${row.revenue_basis}`;
      console.error(`[Scorecard] ${msg}`);
      await syncLogComplete(logId, 0, msg);
      return { success: false, error: msg, period_start: periodStart, period_end: periodEnd };
    }
  }

  // Compute per-source actuals (Phase 2) — same prospect set, no extra LP calls.
  // In preview mode nothing is written; we still build the rows to return.
  let sourceRows = 0, unmappedSources = 0, sourceRowsFull = [];
  if (persist) {
    const { error } = await supabase
      .from('lp_market_scorecard_daily')
      .upsert(rows, { onConflict: 'market,as_of_date' });
    if (error) {
      console.error(`[Scorecard] upsert failed: ${error.message}`);
      await syncLogComplete(logId, 0, error.message);
      return { success: false, error: error.message };
    }
    // A per-source failure must NOT fail the run: the aggregate row is already written.
    try {
      const res = await writeSourceScorecard({
        markets: reeceOnly, asOfDate, periodStart, periodEnd, daysElapsed, workingDaysInPeriod, persist: true,
      });
      sourceRows = res.count;
      unmappedSources = res.unmapped;
      sourceRowsFull = res.rows;
      console.log(`[Scorecard] source rows upserted=${sourceRows} unmapped=${unmappedSources}`);
    } catch (err) {
      console.warn(`[Scorecard] per-source upsert failed (aggregate kept): ${err.message}`);
    }
  } else {
    // Preview: compute source rows without writing (errors here are non-fatal).
    try {
      const res = await writeSourceScorecard({
        markets: reeceOnly, asOfDate, periodStart, periodEnd, daysElapsed, workingDaysInPeriod, persist: false,
      });
      sourceRows = res.count;
      unmappedSources = res.unmapped;
      sourceRowsFull = res.rows;
    } catch (err) {
      console.warn(`[Scorecard] per-source preview failed (aggregate kept): ${err.message}`);
    }
  }

  const elapsed = Date.now() - startedAt;
  await syncLogComplete(logId, rows.length, null);
  const summary = rows.map((r) => `${r.market}: leads=${r.leads} demos=${r.demos} sales=${r.sales}`).join(' | ');
  console.log(`[Scorecard] done${persist ? '' : ' (preview)'} ${summary} prospects=${prospects.length} elapsed=${elapsed}ms`);

  const base = {
    success: true,
    persisted: persist,
    period_start: periodStart,
    period_end: periodEnd,
    as_of_date: asOfDate,
    days_elapsed: daysElapsed,
    working_days_in_period: workingDaysInPeriod,
    markets: rows.length,
    source_rows: sourceRows,
    unmapped_sources: unmappedSources,
    prospects_scanned: prospects.length,
    elapsed_ms: elapsed,
  };

  // Preview mode returns the FULL aggregate row(s) + full per-source rows so the
  // dashboard can render the period directly without a stored snapshot.
  if (!persist) {
    return { ...base, actuals: rows[0] ?? null, rows, sources: sourceRowsFull };
  }

  return {
    ...base,
    rows: rows.map((r) => ({
      market: r.market, leads: r.leads, raw_leads_in: r.raw_leads_in,
      issued: r.issued, sets: r.sets, demos: r.demos, sales: r.sales,
      net_sales: r.net_sales, released_dollars: r.released_dollars,
      working_dollars: r.working_dollars, pending_total: r.pending_total,
      gross_sales: r.gross_sales, reconciled: r.reconciled,
    })),
  };
}

/**
 * Compute per-(source, sub_source) actuals for each market and upsert them into
 * lp_source_scorecard_daily. Same prospect set and same metric definitions as the
 * aggregate row — no extra LP calls. Resolves each source through lp_source_mapping
 * to a GHL intent bucket; rows that don't resolve are flagged raw_inputs.unmapped.
 *
 * @returns {{ count:number, unmapped:number, rows:object[] }}
 */
async function writeSourceScorecard({
  markets, asOfDate, periodStart, periodEnd, daysElapsed, workingDaysInPeriod, persist = true,
}) {
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
        as_of_date: asOfDate, period_start: periodStart, period_end: periodEnd,
        days_elapsed: daysElapsed, working_days_in_period: workingDaysInPeriod,
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

  if (persist && rows.length) {
    const { error } = await supabase
      .from('lp_source_scorecard_daily')
      .upsert(rows, { onConflict: 'market,source,sub_source,as_of_date' });
    if (error) throw new Error(error.message);
  }
  return { count: rows.length, unmapped, rows };
}

// ─── HTTP routes ─────────────────────────────────────────────────────
export function registerGoalScorecardRoutes(app) {
  app.post('/n8n/admin/goal-scorecard-run', async (req, res) => {
    try {
      // persist defaults true; the dashboard's period filter passes persist:false
      // (or ?persist=false) for short-window previews that must NOT overwrite the
      // stored MTD snapshot.
      const persistRaw = req.body?.persist ?? req.query?.persist;
      const persist = !(persistRaw === false || persistRaw === 'false');
      const result = await computeGoalScorecard({
        period_start: req.body?.period_start || req.query?.period_start,
        period_end: req.body?.period_end || req.query?.period_end,
        date: req.body?.date || req.query?.date,
        persist,
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
let lastRunDate = null; // ET date string of the last SUCCESSFUL daily run
let lastCatchupAt = null; // epoch ms of the watchdog's last catch-up attempt

/** Minimum spacing between watchdog catch-up attempts. */
const CATCHUP_MIN_GAP_MS = Number(process.env.GOAL_SCORECARD_CATCHUP_GAP_MS || 60 * 60 * 1000);

/**
 * How long a run may take before the scheduler stops WAITING on it.
 *
 * The LP API degrades: on 2026-08-10 the lead sync was fetching ONE prospect per
 * page (164 leads in 16.5 min) with `empty page at StartIndex=N but probe found
 * rows — retrying smaller` firing continuously, and a manual
 * POST /n8n/admin/goal-scorecard-run returned nothing after 240s. Without a
 * bound, the 06:00 run simply runs past its own hour and the day is lost.
 *
 * ⚠️ 120_000 was a GUESS, and it was wrong. Measured in production on
 * 2026-08-11: a healthy full run over 18,908 prospects takes **338 seconds**.
 * The deadline fired at 120s, the watchdog declared "this is a real failure,
 * not a missed window" and paged GroupMe — and then the run finished
 * successfully 3.5 minutes later and wrote all ten market rows.
 *
 * Slow is not hung. The deadline is now set above the observed healthy run with
 * room to spare, and passing it is a WARNING rather than a verdict — see
 * `attemptDailyRun`.
 */
const RUN_TIMEOUT_MS = Number(process.env.GOAL_SCORECARD_TIMEOUT_MS || 600_000);

/** Attempts per ET day, so a persistently sick API cannot become a run-storm. */
const MAX_ATTEMPTS_PER_DAY = 3;

// Attempt accounting and the in-flight lock live in the guard below, which owns
// them together — the lock has to outlive the deadline, and a promise is the
// only thing that knows when the actual work finished.

/**
 * One guarded attempt at the daily run. Returns true only on success.
 *
 * ══ WHY THE SLOT IS CLAIMED ON SUCCESS, NOT ON ATTEMPT ══
 *
 * This used to read `lastRunDate = today` BEFORE awaiting, to avoid a double
 * fire. The cost was that any failure — or any hang — burned the whole day: the
 * guard said "already ran today" when nothing had been written. Combined with a
 * firing window of exactly one hour, that is how lp_market_scorecard_daily
 * stopped at 2026-08-07 while the report snapshots stayed current.
 *
 * The double-fire it was protecting against is now handled by `inFlight` (one
 * run at a time) and by the per-day attempt cap, both of which are honest about
 * what happened. `lastRunDate` means what it says again: the last day this
 * actually succeeded.
 *
 * ══ WHY THE DEADLINE DOES NOT DECIDE THE OUTCOME ══
 *
 * `Promise.race` does not cancel the loser, and there is no AbortController
 * plumbed through lp-client. The first version raced the run against a timeout
 * and treated losing that race as failure — which produced, live on
 * 2026-08-11: a deadline at 120s, `run FAILED (attempt 1/3)`, a GroupMe page
 * reading "this is a real failure, not a missed window" … and then the run
 * completing normally at 338s and writing every row. The alert was false, the
 * attempt was spent on a run that worked, and worst of all the `finally`
 * released the in-flight lock while the work was still hammering the LP API,
 * so the next watchdog poll could stack a second run on top of the first.
 *
 * So: the RUN owns the outcome and the lock; the deadline only decides how long
 * the caller waits for an answer. Passing it returns `'slow'` — not a failure,
 * not something to page anyone about. When the work eventually settles it
 * records its own success or failure, and only then releases the lock.
 *
 * Returns: 'ok' | 'failed' | 'slow' | 'in_flight' | 'capped'.
 */
export function createRunGuard({ timeoutMs, maxAttemptsPerDay, log = console } = {}) {
  let inFlight = null; // the underlying work promise, or null
  let attempts = { date: null, n: 0 };
  let lastSuccess = null; // ET date string of the last SUCCESSFUL run

  return {
    get busy() {
      return inFlight != null;
    },
    get lastSuccessDate() {
      return lastSuccess;
    },
    attemptsOn(date) {
      return attempts.date === date ? attempts.n : 0;
    },
    /** Resolves once the work settles — used by tests to await the real thing. */
    settled() {
      return inFlight ?? Promise.resolve();
    },
    async attempt(today, why, work) {
      if (inFlight) {
        log.warn(`[Scorecard] ${why}: a run is already in flight — not stacking another`);
        return 'in_flight';
      }
      if (attempts.date !== today) attempts = { date: today, n: 0 };
      if (attempts.n >= maxAttemptsPerDay) {
        log.warn(`[Scorecard] ${why}: ${maxAttemptsPerDay} attempts already made today — standing down until tomorrow`);
        return 'capped';
      }

      const attempt = (attempts.n += 1);

      // The run owns its own lifecycle. It never rejects — the outcome is the
      // resolved value — so abandoning the wait below cannot orphan a rejection.
      const run = Promise.resolve()
        .then(work)
        .then(() => {
          lastSuccess = today; // success, and only success
          log.log(`[Scorecard] ${why}: run succeeded (attempt ${attempt}/${maxAttemptsPerDay})`);
          return true;
        })
        .catch((err) => {
          log.error(`[Scorecard] ${why}: run FAILED (attempt ${attempt}/${maxAttemptsPerDay}): ${err.message}`);
          return false; // the day stays reclaimable
        })
        .finally(() => {
          inFlight = null; // released when the WORK ends, not when the wait does
        });
      inFlight = run;

      let timer;
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => resolve('slow'), timeoutMs);
      });
      const outcome = await Promise.race([run, deadline]);
      clearTimeout(timer);

      if (outcome === 'slow') {
        log.warn(
          `[Scorecard] ${why}: still running after ${timeoutMs}ms (attempt ${attempt}/${maxAttemptsPerDay}) — ` +
            `leaving it in flight; a healthy full run measured 338s on 2026-08-11. ` +
            `The lock stays held, so nothing will stack on it.`,
        );
        return 'slow';
      }
      return outcome ? 'ok' : 'failed';
    },
  };
}

const runGuard = createRunGuard({
  timeoutMs: RUN_TIMEOUT_MS,
  maxAttemptsPerDay: MAX_ATTEMPTS_PER_DAY,
});

async function attemptDailyRun(today, why) {
  const outcome = await runGuard.attempt(today, why, () => computeGoalScorecard());
  lastRunDate = runGuard.lastSuccessDate ?? lastRunDate;
  return outcome;
}
let lastWatchdogAlertDate = null; // ET date of the last missing-snapshot alert

// Freshness watchdog (added after the Jul 31–Aug 4 outage, when the daily
// snapshot silently stopped for five days and surfaced only as wrong numbers
// on the leadership scorecard). Selling-day-aware: from 07:00 ET onward —
// after the 06:00 run window — the expected snapshot for the last COMPLETED
// selling day must exist. If it doesn't, ping GroupMe once per ET day and
// keep pinging daily until a snapshot lands. Alert-only by design: no
// self-healing runs, no restarts. Kill switch: SCORECARD_WATCHDOG_DISABLED.
const WATCHDOG_DISABLED =
  (process.env.SCORECARD_WATCHDOG_DISABLED || 'false').toLowerCase() === 'true';

/**
 * How many SELLING days the data is behind, given the newest as-of we have and
 * the one we expected.
 *
 * `sellingDaysElapsed` counts INCLUSIVE of both endpoints, so the gap between
 * them is one less — a snapshot that already reaches the expected day is 0
 * behind, not 1. Sundays and Reece closures are not lateness. Null when no
 * snapshot exists at all, which is a different (worse) statement than "0".
 *
 * Exported for the test: this is a one-line arithmetic with an off-by-one in it,
 * and an alert that overstates the outage by a day is how a missed morning gets
 * mistaken for the Jul 31–Aug 4 five-day outage.
 */
export function stalenessLagSellingDays(actualAsOf, expectedAsOf, cal) {
  if (!actualAsOf) return null;
  if (actualAsOf >= expectedAsOf) return 0;
  return Math.max(0, sellingDaysElapsed(actualAsOf, expectedAsOf, cal) - 1);
}

async function checkSnapshotFreshness(today) {
  if (WATCHDOG_DISABLED || lastWatchdogAlertDate === today) return;
  const expectedAsOf = lastCompletedSellingDay(today, SELLING_CAL);
  try {
    const { data, error } = await supabase
      .from('lp_market_scorecard_daily')
      .select('as_of_date')
      .eq('market', DEFAULT_MARKET)
      .gte('as_of_date', expectedAsOf)
      .limit(1);
    if (error) {
      console.error('[Scorecard] watchdog query failed:', error.message);
      return;
    }
    if (data && data.length > 0) return; // healthy

    // ── SELF-HEAL BEFORE ALERTING ────────────────────────────────────────
    //
    // The daily run fires only while the ET hour is exactly 6. If the process
    // is not alive in that window the day is simply lost — and this service
    // restarts on every Railway deploy, so losing the window is routine, not
    // exotic. That is how lp_market_scorecard_daily stopped at 2026-08-07
    // while the report snapshots ran current through 08-10: three consecutive
    // days missed, each one alerted and none retried.
    //
    // The watchdog already knows the one thing that matters — the expected row
    // is absent — so it should RUN the job, not just describe the hole. Alert
    // only if the catch-up itself fails; a hole that healed is not an incident.
    //
    // SPACED retries, not one-and-done. The watchdog polls every 5 minutes, so
    // an ungated catch-up would burn all three daily attempts inside a quarter
    // hour — every one of them against the same sick API, and then stand down
    // for the rest of the day. A gap between attempts is what makes the cap
    // useful: if LP is unwell at 07:00 and healthy by noon, the noon attempt is
    // the one that lands.
    const sinceLast = lastCatchupAt == null ? Infinity : Date.now() - lastCatchupAt;
    if (sinceLast >= CATCHUP_MIN_GAP_MS) {
      lastCatchupAt = Date.now();
      console.warn(`[Scorecard] watchdog: no row for ${expectedAsOf} — running the daily job now (the 06:00 ET window was missed or the run failed)`);
      const outcome = await attemptDailyRun(today, 'watchdog catch-up');

      // A run still working is not a run that failed. Paging on 'slow' is
      // exactly what happened on 2026-08-11: the alert fired at 120s and the
      // job finished fine at 338s. Say nothing and let the next poll see the
      // row — the in-flight lock guarantees we are not racing it.
      if (outcome === 'slow' || outcome === 'in_flight') {
        console.log(`[Scorecard] watchdog: a run is in flight for ${expectedAsOf} — deferring the verdict to the next poll`);
        return;
      }

      if (outcome === 'ok') {
        const { data: healed } = await supabase
          .from('lp_market_scorecard_daily')
          .select('as_of_date')
          .eq('market', DEFAULT_MARKET)
          .gte('as_of_date', expectedAsOf)
          .limit(1);
        if (healed && healed.length > 0) {
          console.log(`[Scorecard] watchdog: catch-up run succeeded for ${expectedAsOf}`);
          return; // healed — nothing to page anyone about
        }
      }
    }

    lastWatchdogAlertDate = today; // once per ET day, re-alerts tomorrow if still missing

    // How far behind we actually are. Only queried on the failure path — the
    // healthy path already returned. Without this the alert can say "missing"
    // but not "missing for how long", and one missed morning reads exactly like
    // the five-day outage of Jul 31–Aug 4.
    let actualAsOf = null;
    try {
      const { data: latest } = await supabase
        .from('lp_market_scorecard_daily')
        .select('as_of_date')
        .eq('market', DEFAULT_MARKET)
        .order('as_of_date', { ascending: false })
        .limit(1);
      actualAsOf = latest?.[0]?.as_of_date ?? null;
    } catch (lagErr) {
      console.error('[Scorecard] watchdog lag lookup failed:', lagErr.message);
    }
    const lagDays = stalenessLagSellingDays(actualAsOf, expectedAsOf, SELLING_CAL);
    const lagPhrase = lagDays == null
      ? 'no snapshot has ever been written'
      : `${lagDays} selling day${lagDays === 1 ? '' : 's'} behind (last: ${actualAsOf})`;

    const msg =
      `⚠️ SCORECARD SNAPSHOT MISSING — lp_market_scorecard_daily has no row for ` +
      `${expectedAsOf} (last completed selling day) — ${lagPhrase}. The 06:00 ET run did not ` +
      `write, AND the watchdog's catch-up run did not fix it — so this is a real failure, ` +
      `not a missed window. The dashboard is showing its "no data yet" state. ` +
      `Check LP-MCP logs, then retry via POST /n8n/admin/goal-scorecard-run.`;
    console.error(`[Scorecard] watchdog: ${msg}`);

    // ── A LOG LINE IS NOT A SIGNAL ───────────────────────────────────────
    //
    // console.error and GroupMe are both fire-and-forget: nothing stores them,
    // nothing can query them, and nobody was reading either. That is how three
    // consecutive missed days (2026-08-08 → 08-10) passed unnoticed while the
    // dashboard served four-day-old numbers as current.
    //
    // `bypass_filter: true` is LOAD-BEARING. emitEvent runs applyIntakeFilter
    // BEFORE the idempotency check and silently returns {filtered:true} on a
    // drop — an infrastructure alert that can itself be filtered out is the
    // exact failure mode this exists to end.
    //
    // Keyed on the missing day, so re-checking every 5 minutes records the
    // incident once rather than 288 times, and a second missing day is its own
    // event rather than a duplicate.
    try {
      const { emitEvent } = await import('../event-emitter.js');
      await emitEvent({
        event_type: 'scorecard.snapshot_stale',
        event_subtype: lagDays == null ? 'unknown' : `${lagDays}d`,
        source: 'lp_mcp',
        entity_type: 'market',
        entity_id: DEFAULT_MARKET,
        payload: {
          expected_as_of: expectedAsOf,
          actual_as_of: actualAsOf,
          lag_selling_days: lagDays,
          detail: msg,
        },
        priority: 'high',
        idempotency_key: `scorecard_stale:${expectedAsOf}`,
        bypass_filter: true,
      });
    } catch (evErr) {
      console.error('[Scorecard] watchdog event emit failed:', evErr.message);
    }

    try {
      const { sendGroupMeMessage } = await import('../groupme.js');
      await sendGroupMeMessage(msg);
    } catch (gmErr) {
      console.error('[Scorecard] watchdog GroupMe send failed:', gmErr.message);
    }
  } catch (err) {
    console.error('[Scorecard] watchdog threw:', err.message);
  }
}

export function startGoalScorecardScheduler() {
  if (scorecardTimer) return;
  console.log('[Scorecard] Scheduler started — daily run at 06:00 ET (+ 07:00 ET freshness watchdog)');

  const checkAndRun = async () => {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE, hour: '2-digit', hour12: false,
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? -1);
    const today = todayET();
    if (hour === 6 && lastRunDate !== today) {
      await attemptDailyRun(today, 'daily 06:00 ET');
    }
    // Watchdog window: any check from 07:00 ET onward (covers deploys that
    // boot mid-day — a fresh process still verifies today's snapshot exists).
    if (hour >= 7) {
      await checkSnapshotFreshness(today);
    }
  };

  // Check every 5 minutes; fires the run once when the ET hour is 06.
  scorecardTimer = setInterval(checkAndRun, 5 * 60 * 1000);
}

export function stopGoalScorecardScheduler() {
  if (scorecardTimer) {
    clearInterval(scorecardTimer);
    scorecardTimer = null;
  }
}
