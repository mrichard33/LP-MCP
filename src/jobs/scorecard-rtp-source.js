// ─── Scorecard live-month RTP revenue source — src/jobs/scorecard-rtp-source.js ───
//
// The scorecard's headline revenue metric is DEFINED as Released-to-Production (RTP)
// NET, attributed to the RTP milestone completion date, for the job's market. Two
// figures coexist on a live-month row and are NEVER blended into one:
//
//   AUTHORITATIVE  report-sourced RTP net (lp_net_report_rtp) → released_dollars,
//                  revenue_basis='rtp_net_by_milestone_date', revenue_as_of=<report date>.
//   PROVISIONAL    warehouse RTP gross by milestone date, for the days AFTER revenue_as_of
//                  → provisional_gross_dollars / provisional_days. A PACE signal, gross, not
//                  a preview of the report (measured drift ranges −25%…+30% vs net).
//
// INVARIANT (the writer asserts it): released_dollars IS NULL ⇔ revenue_basis IS NULL.
// revenue_basis describes the AUTHORITATIVE column ONLY. When no report exists for the month,
// released_dollars = NULL (never 0 — pending must be distinguishable from genuinely zero) and
// revenue_basis = NULL; the provisional label lives in provisional_basis, never in revenue_basis.
//
// The warehouse CANNOT produce net (no netamount field; finamount only recovers net for clean
// financed deals). So the Net Report stays the authoritative net source — by design, not a gap.

import express from 'express';
import supabase from '../supabase.js';
import { runSQL } from '../admin/supabase-admin.js';

/** Company roll-up market code (mirrors scorecard-metrics.DEFAULT_MARKET). */
const REECE = 'REECE';

export const AUTHORITATIVE_BASIS = 'rtp_net_by_milestone_date';
export const PROVISIONAL_BASIS = 'rtp_gross_by_milestone_date_provisional';

// Live-month source switch. Default = report net (authoritative). Flip to 'warehouse_rtp_gross'
// to promote the warehouse gross into the authoritative column (all-provisional degenerate mode)
// in one line — no rebuild. B is fully implemented; it is simply OFF.
export const LIVE_MONTH_SOURCE = (process.env.SCORECARD_LIVE_MONTH_SOURCE || 'net_report').trim();

const money = (v) => (v == null ? null : Math.round(Number(v) * 100) / 100);
const monthStartOf = (etDate) => `${String(etDate).slice(0, 7)}-01`;

/** The ET calendar day after a YYYY-MM-DD date (UTC-safe). */
function nextDay(etDate) {
  const d = new Date(`${etDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
/** Inclusive calendar-day count of [from, to]; 0 when from > to. */
function inclusiveDays(from, to) {
  if (!from || !to || from > to) return 0;
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86400000) + 1;
}

/**
 * Authoritative RTP net for a month from the ingested Net Report (lp_net_report_rtp).
 * Uses the LATEST report snapshot for the month (max report_as_of). Never gap-filled.
 *
 * @returns {{ hasReport: boolean, revenueAsOf: string|null, byMarket: Map<string,number> }}
 *   byMarket includes a REECE roll-up key.
 */
export async function computeAuthoritativeRtpNet({ periodStart }) {
  const reportMonth = monthStartOf(periodStart);
  if (!supabase) return { hasReport: false, revenueAsOf: null, byMarket: new Map() };

  const { data, error } = await supabase
    .from('lp_net_report_rtp')
    .select('market, released_net, report_as_of')
    .eq('report_month', reportMonth)
    .order('report_as_of', { ascending: false });
  if (error) throw new Error(`net-report read failed: ${error.message}`);
  if (!data || !data.length) return { hasReport: false, revenueAsOf: null, byMarket: new Map() };

  const revenueAsOf = String(data[0].report_as_of).slice(0, 10);
  const byMarket = new Map();
  for (const r of data) {
    if (String(r.report_as_of).slice(0, 10) !== revenueAsOf) continue; // latest snapshot only
    byMarket.set(r.market, money(r.released_net));
  }
  return { hasReport: true, revenueAsOf, byMarket };
}

/**
 * Warehouse RTP GROSS by milestone date, market-attributed via lp_jobs.branch_code →
 * lp_branch_market_map. Summed for act_date in (sinceDate, periodEnd] — i.e. the days AFTER
 * the report's coverage (the provisional tail). When sinceDate is null the whole month counts.
 *
 * @returns {Map<string,number>} market → gross $, including a REECE roll-up key. Empty when the
 *   tail has no completed RTP milestones (still a valid state — 0 provisional dollars).
 */
export async function computeProvisionalRtpGross({ periodStart, periodEnd, sinceDate }) {
  const lower = sinceDate ? nextDay(sinceDate) : monthStartOf(periodStart); // day AFTER the report
  const upperExclusive = nextDay(periodEnd);
  const byMarket = new Map();
  if (lower > periodEnd) return byMarket; // no provisional days

  const sql = `
    SELECT COALESCE(bm.market_code, 'UNMAPPED') AS market,
           ROUND(SUM(j.job_value)::numeric, 2)  AS gross
    FROM lp_job_milestones m
    JOIN lp_jobs j ON j.lp_job_id = m.lp_job_id
    LEFT JOIN lp_branch_market_map bm ON UPPER(TRIM(bm.brn_id)) = j.branch_code
    WHERE m.datetype = 'RTP'
      AND m.act_date >= '${lower}'::date
      AND m.act_date <  '${upperExclusive}'::date
    GROUP BY 1`;
  const rows = (await runSQL(sql)) || [];

  let reece = 0;
  for (const r of rows) {
    const g = money(r.gross) || 0;
    byMarket.set(r.market, g);
    reece += g; // REECE = Σ every market (incl. UNMAPPED, so the roll-up never silently drops $)
  }
  byMarket.set(REECE, money(reece));
  return byMarket;
}

// ─── Net Report ingest + drift routes ────────────────────────────────────────────
// LP exposes no report API, so the authoritative RTP net enters via a manual upload or a
// scheduled drop of the Net Report CSV. Reporting layer only — nothing writes back to LP.

/** Minimal RFC-4180-ish CSV parser (handles quoted fields, embedded commas, "" escapes). */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const monthKeyOf = (mdy) => {
  // 'M/D/YYYY' → 'YYYY-MM-01'
  const [m, , y] = mdy.split('/');
  if (!m || !y) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`;
};
const isoOf = (mdy) => {
  const [m, d, y] = mdy.split('/');
  if (!m || !d || !y) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

/**
 * Parse a Net Report CSV into per-(market, report_month) RTP net totals + a REECE roll-up.
 * Sums NetAmount for rows where MdtDescr='RTP', grouping MilestoneDate month × brp_id→market.
 * `brnMap` is brp_id(upper) → market_code (from lp_branch_market_map). report_as_of defaults to
 * the max EDate in the file (the report's coverage end date).
 */
export function parseNetReportRtp(csvText, brnMap, reportAsOfOverride) {
  const rows = parseCsv(csvText);
  if (!rows.length) throw new Error('empty CSV');
  const header = rows[0].map((h) => h.trim());
  const idx = (name) => header.indexOf(name);
  const iMdt = idx('MdtDescr'), iMd = idx('MilestoneDate'), iNet = idx('NetAmount'), iBrp = idx('brp_id'), iEnd = idx('EDate');
  if (iMdt < 0 || iMd < 0 || iNet < 0 || iBrp < 0) {
    throw new Error('CSV missing required columns (MdtDescr, MilestoneDate, NetAmount, brp_id)');
  }
  const agg = new Map();       // `${market}|${month}` → { market, month, net, rows }
  const reece = new Map();     // month → { net, rows }
  const unmapped = new Map();  // brp_id → count
  let maxEnd = null;
  const bump = (map, key, seed, net) => {
    const e = map.get(key) || seed; e.net += net; e.rows += 1; map.set(key, e);
  };
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length <= iMdt) continue;
    if ((row[iMdt] || '').trim() !== 'RTP') continue;
    const md = (row[iMd] || '').trim();
    const month = monthKeyOf(md);
    if (!month) continue;
    const net = Number((row[iNet] || '0').trim()) || 0;
    const brp = (row[iBrp] || '').trim().toUpperCase();
    const market = brnMap.get(brp);
    if (iEnd >= 0) { const e = isoOf((row[iEnd] || '').trim()); if (e && (!maxEnd || e > maxEnd)) maxEnd = e; }
    if (!market) { unmapped.set(brp, (unmapped.get(brp) || 0) + 1); continue; }
    bump(agg, `${market}|${month}`, { market, month, net: 0, rows: 0 }, net);
    bump(reece, month, { market: REECE, month, net: 0, rows: 0 }, net);
  }
  const reportAsOf = reportAsOfOverride || maxEnd;
  if (!reportAsOf) throw new Error('no report_as_of (pass ?report_as_of= or include EDate in CSV)');
  const out = [];
  for (const e of agg.values()) out.push({ market: e.market, report_month: e.month, report_as_of: reportAsOf, released_net: money(e.net), rows_counted: e.rows });
  for (const [month, e] of reece) out.push({ market: REECE, report_month: month, report_as_of: reportAsOf, released_net: money(e.net), rows_counted: e.rows });
  return { records: out, report_as_of: reportAsOf, unmapped: Object.fromEntries(unmapped) };
}

/**
 * Restate CLOSED-month scorecard rows to the report's EXACT cent values, sourced from
 * lp_net_report_rtp (populated by the same ingest path — one rounding policy, no ad-hoc load).
 * Closed months had been loaded as rounded whole dollars, so the YTD hero was off by cents
 * (e.g. Jan stored 6,941,858 vs report 6,941,857.11). This corrects released_dollars / net_sales
 * / good_business to the report figure for every net_report_rtp row with a period_start strictly
 * before `throughMonthStart` (default: first of the current month, so only closed months move).
 * Utility markets (OUT_OF_AREA / UNASSIGNED) carry no report revenue and are left untouched at 0,
 * so Σ(markets) still equals REECE to the cent.
 *
 * @param {string} [throughMonthStart]  YYYY-MM-01 exclusive upper bound; default current month.
 * @returns {{ restated:number }}
 */
export async function restateClosedFromReport({ throughMonthStart } = {}) {
  const bound = throughMonthStart
    ? `DATE '${throughMonthStart}'`
    : `date_trunc('month', CURRENT_DATE)`;
  const sql = `
    WITH latest AS (
      SELECT DISTINCT ON (market, report_month) market, report_month, released_net, report_as_of
      FROM lp_net_report_rtp
      ORDER BY market, report_month, report_as_of DESC
    )
    UPDATE lp_market_scorecard_daily t
    SET released_dollars = s.released_net,
        net_sales        = s.released_net,
        good_business    = s.released_net,
        revenue_basis    = 'rtp_net_by_milestone_date',
        raw_inputs = COALESCE(t.raw_inputs, '{}'::jsonb) || jsonb_build_object(
          'revenue_basis', 'rtp_net_by_milestone_date',
          'restated_from', 'net_report_exact',
          'report_as_of', s.report_as_of)
    FROM latest s
    WHERE t.computed_from = 'net_report_rtp'
      AND t.market = s.market
      AND t.period_start = s.report_month
      AND t.period_start < ${bound}
    RETURNING t.id`;
  const rows = (await runSQL(sql)) || [];
  return { restated: Array.isArray(rows) ? rows.length : 0 };
}

export function registerNetReportRoutes(app) {
  // Raw-text body (CSV can exceed express.json()'s 100kb cap), scoped to this route.
  app.post('/n8n/admin/net-report-ingest', express.text({ type: '*/*', limit: '25mb' }), async (req, res) => {
    try {
      if (!supabase) return res.status(500).json({ success: false, error: 'Supabase not configured' });
      const csvText = typeof req.body === 'string' ? req.body : '';
      if (!csvText.trim()) return res.status(400).json({ success: false, error: 'POST the raw Net Report CSV as the request body' });

      const { data: mapRows, error: mapErr } = await supabase.from('lp_branch_market_map').select('brn_id, market_code');
      if (mapErr) throw new Error(`branch map read failed: ${mapErr.message}`);
      const brnMap = new Map((mapRows || []).map((m) => [String(m.brn_id).trim().toUpperCase(), m.market_code]));

      const parsed = parseNetReportRtp(csvText, brnMap, (req.query.report_as_of || '').trim() || null);
      if (!parsed.records.length) return res.status(400).json({ success: false, error: 'no RTP rows parsed', unmapped: parsed.unmapped });

      const { error: upErr } = await supabase
        .from('lp_net_report_rtp')
        .upsert(parsed.records, { onConflict: 'market,report_month,report_as_of' });
      if (upErr) throw new Error(`staging upsert failed: ${upErr.message}`);

      const months = [...new Set(parsed.records.map((r) => r.report_month))].sort();
      res.json({ success: true, report_as_of: parsed.report_as_of, rows_ingested: parsed.records.length, months, unmapped: parsed.unmapped });
    } catch (err) {
      console.error('[NetReport] ingest error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Provisional-vs-authoritative drift for every closed month we have both sources for. Keeps the
  // provisional's true magnitude/direction visible (measured −25%…+30% vs net) — a PACE signal,
  // never a report preview. Do not tune the provisional to match the report; the delta is signal.
  app.get('/n8n/admin/net-report-drift', async (req, res) => {
    try {
      const sql = `
        WITH wh AS (
          SELECT to_char(date_trunc('month', m.act_date), 'YYYY-MM') AS mo,
                 ROUND(SUM(j.job_value)::numeric, 2) AS warehouse_gross
          FROM lp_job_milestones m
          JOIN lp_jobs j ON j.lp_job_id = m.lp_job_id
          WHERE m.datetype = 'RTP'
            AND m.act_date >= date_trunc('year', CURRENT_DATE)
            AND m.act_date <  date_trunc('month', CURRENT_DATE)
          GROUP BY 1
        ),
        rep AS (
          SELECT DISTINCT ON (period_start) to_char(period_start, 'YYYY-MM') AS mo,
                 released_dollars AS report_net
          FROM lp_market_scorecard_daily
          WHERE computed_from = 'net_report_rtp' AND market = 'REECE'
          ORDER BY period_start, as_of_date DESC
        )
        SELECT rep.mo, rep.report_net, wh.warehouse_gross,
               ROUND(wh.warehouse_gross - rep.report_net, 2) AS drift_abs,
               ROUND(100.0 * (wh.warehouse_gross - rep.report_net) / NULLIF(rep.report_net, 0), 1) AS drift_pct
        FROM rep LEFT JOIN wh USING (mo)
        ORDER BY rep.mo`;
      const drift = (await runSQL(sql)) || [];
      res.json({ success: true, market: REECE, note: 'warehouse RTP gross vs report RTP net, by milestone month (closed). Provisional is a pace signal, not a report preview.', drift });
    } catch (err) {
      console.error('[NetReport] drift error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Restate closed-month scorecard rows to the report's exact cent values (fixes the rounded
  // whole-dollar closed load that left the YTD hero off by cents). Reads lp_net_report_rtp only —
  // ingest the report first. `?through=YYYY-MM-01` bounds which months are treated as closed.
  app.post('/n8n/admin/net-report-restate-closed', async (req, res) => {
    try {
      if (!supabase) return res.status(500).json({ success: false, error: 'Supabase not configured' });
      const through = (req.query.through || '').trim() || undefined;
      const result = await restateClosedFromReport({ throughMonthStart: through });
      res.json({ success: true, ...result, through: through || 'current_month' });
    } catch (err) {
      console.error('[NetReport] restate error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  console.log('[NetReport] Routes registered: POST /n8n/admin/net-report-ingest | GET /n8n/admin/net-report-drift | POST /n8n/admin/net-report-restate-closed');
}

/**
 * Resolve the live-month revenue shape for every market in the run, honoring the config switch
 * and the invariant. Returns a Map(market → revenue fields) the daily writer merges onto each
 * scorecard row. Authoritative and provisional are ALWAYS in separate fields — never summed.
 *
 * Fields per market:
 *   released_dollars           authoritative RTP net (NULL when no report — never 0)
 *   revenue_basis              AUTHORITATIVE_BASIS when net present, else NULL (invariant)
 *   revenue_as_of              report coverage-end date (NULL when no report)
 *   reconciled                 true iff report-backed
 *   provisional_gross_dollars  warehouse RTP gross for the days after revenue_as_of (pace)
 *   provisional_days           # calendar days in the provisional tail
 *   provisional_basis          PROVISIONAL_BASIS (constant label, lives outside revenue_basis)
 *
 * @param {string[]} marketCodes  markets present in this run (so no-report markets still emit).
 */
export async function resolveLiveMonthRevenue({ periodStart, periodEnd, marketCodes }) {
  const codes = Array.from(new Set([...(marketCodes || []), REECE]));

  // ── Config B: warehouse gross is the authoritative column (all provisional, labeled) ──
  if (LIVE_MONTH_SOURCE === 'warehouse_rtp_gross') {
    const gross = await computeProvisionalRtpGross({ periodStart, periodEnd, sinceDate: null });
    const out = new Map();
    for (const code of codes) {
      const g = gross.has(code) ? gross.get(code) : 0;
      out.set(code, {
        released_dollars: g,
        revenue_basis: PROVISIONAL_BASIS, // authoritative column holds gross → labeled provisional
        revenue_as_of: null,
        reconciled: false,
        provisional_gross_dollars: null, // the whole figure is already provisional; no separate tail
        provisional_days: inclusiveDays(monthStartOf(periodStart), periodEnd),
        provisional_basis: PROVISIONAL_BASIS,
      });
    }
    return out;
  }

  // ── Config A (default): report net authoritative + warehouse-gross provisional companion ──
  const auth = await computeAuthoritativeRtpNet({ periodStart });
  const tailGross = await computeProvisionalRtpGross({
    periodStart, periodEnd, sinceDate: auth.hasReport ? auth.revenueAsOf : null,
  });
  const provDays = auth.hasReport
    ? inclusiveDays(nextDay(auth.revenueAsOf), periodEnd)
    : inclusiveDays(monthStartOf(periodStart), periodEnd);

  const out = new Map();
  for (const code of codes) {
    const net = auth.byMarket.has(code) ? auth.byMarket.get(code) : null;
    const hasNet = auth.hasReport && net != null;
    out.set(code, {
      // INVARIANT: released_dollars and revenue_basis are NULL together, or set together.
      released_dollars: hasNet ? net : null,
      revenue_basis: hasNet ? AUTHORITATIVE_BASIS : null,
      revenue_as_of: hasNet ? auth.revenueAsOf : null,
      reconciled: hasNet,
      provisional_gross_dollars: tailGross.has(code) ? tailGross.get(code) : (provDays > 0 ? 0 : null),
      provisional_days: provDays,
      provisional_basis: PROVISIONAL_BASIS,
    });
  }
  return out;
}
