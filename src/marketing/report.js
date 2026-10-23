/**
 * Brad-format report model — src/marketing/report.js (handoff §9).
 *
 * Reads v_market_subsource_cost (migration 20261012222106) and shapes the three sheets Brad's
 * `September_Month_Cost_FT_Myers_Office.xlsx` carries:
 *   Campaign Summary  the selected month, one row per sub-source
 *   Monthly Results   Jan → the selected month, one row per month
 *   Weekly            the last 8 ISO weeks (Raw, Issue, Total Cost, Cost / Issued)
 * plus the footnotes: † provisional (feed, no invoice yet), held company-
 * level $ with its recommendation, and the 133 snapshot date.
 *
 * Numbers here are the INPUTS. Every ratio is a formula in the workbook
 * (report-xlsx.js), never a typed value (D7).
 */
import supabaseDefault from '../supabase.js';
import { marketLabel } from './slack-review.js';

export const COMPANY = 'REECE';
export const MARKETS = ['STPET_MKT', 'ORL_MKT', 'FTMYR_MKT', 'FTLAU_MKT', 'JAX_MKT', 'SAR_MKT'];
const num = (v) => (v == null ? 0 : Number(v) || 0);

function monthStart(ym) { return `${String(ym).slice(0, 7)}-01`; }
function yearStart(ym) { return `${String(ym).slice(0, 4)}-01-01`; }
export function monthLabel(ym) {
  return new Date(`${monthStart(ym)}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export async function loadViewRows({ grain, from, to }, { supabase = supabaseDefault } = {}) {
  const out = [];
  for (let page = 0; page < 50; page++) {
    const { data, error } = await supabase.from('v_market_subsource_cost').select('*')
      .eq('grain', grain).gte('period_start', from).lte('period_start', to)
      .order('period_start').range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(`v_market_subsource_cost read failed: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/** Pure: sum rows into one record per key. */
function aggregate(rows, keyFn) {
  const by = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    const a = by.get(k) || { key: k, raw: 0, set_count: 0, issued: 0, sat: 0, sold: 0, gross: 0, working: 0, net: 0, invoice_cost: 0, calculated_cost: 0, has_provisional: false, as_of: null, has_dollars: false };
    a.raw += num(r.raw); a.set_count += num(r.set_count); a.issued += num(r.issued); a.sat += num(r.sat); a.sold += num(r.sold);
    if (r.gross != null || r.net != null || r.working != null) a.has_dollars = true;
    a.gross += num(r.gross); a.working += num(r.working); a.net += num(r.net);
    a.invoice_cost += num(r.invoice_cost); a.calculated_cost += num(r.calculated_cost);
    a.has_provisional = a.has_provisional || !!r.has_provisional;
    if (r.as_of_snapshot && (!a.as_of || r.as_of_snapshot > a.as_of)) a.as_of = r.as_of_snapshot;
    by.set(k, a);
  }
  return [...by.values()];
}

const isMarket = (m) => MARKETS.includes(m);

/** A campaign with no sub-source reads "Unknown", never "(none)" (the user, 2026-10-19). */
export function campaignLabel(key) {
  const s = String(key ?? '').trim();
  return !s || s.toLowerCase() === '(none)' ? 'Unknown' : s;
}

/**
 * Pure: the model for one market (or the company roll-up) from view rows.
 * @param {object} p
 * @param {string} p.market   a market code or COMPANY
 * @param {string} p.month    YYYY-MM
 * @param {Array}  p.monthRows   grain='month' rows for the year to date
 * @param {Array}  p.weekRows    grain='iso_week' rows for the last 8 weeks
 */
export function buildMarketModel({ market, month, monthRows, weekRows }) {
  const mine = (r) => (market === COMPANY ? isMarket(r.market) : r.market === market);
  const m0 = monthStart(month);
  const thisMonth = monthRows.filter((r) => r.period_start === m0 && mine(r));
  const campaign = aggregate(thisMonth, (r) => campaignLabel(r.lp_sub_source))
    .filter((a) => a.raw || a.issued || a.invoice_cost || a.calculated_cost || a.gross)
    .sort((a, b) => (b.invoice_cost + b.calculated_cost) - (a.invoice_cost + a.calculated_cost) || b.raw - a.raw)
    .map((a) => ({ label: a.key, ...a }));
  const monthly = aggregate(monthRows.filter((r) => mine(r) && r.period_start <= m0), (r) => r.period_start)
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((a) => ({ label: monthLabel(a.key), ...a }));
  const weekly = aggregate(weekRows.filter(mine), (r) => r.period_start)
    .sort((a, b) => a.key.localeCompare(b.key)).slice(-8)
    .map((a) => ({ label: `Week of ${a.key}`, ...a }));
  const held = aggregate(monthRows.filter((r) => r.period_start === m0 && r.market === 'REECE_HOLD'), () => 'held');
  const heldTotal = held.length ? held[0].invoice_cost + held[0].calculated_cost : 0;
  const recommendations = [...new Set(monthRows.filter((r) => r.period_start === m0 && r.market === 'REECE_HOLD' && r.recommended_market).map((r) => `${r.recommended_market}: ${r.recommendation_reason || ''}`))];
  // 2026-10-19: billed but not found, parked until a revised invoice, a confirmed
  // charge or a credit settles it (allocation.js DISPUTED_MARKET).
  const disputed = aggregate(monthRows.filter((r) => r.period_start === m0 && r.market === 'DISPUTED'), () => 'disputed');
  const disputedTotal = disputed.length ? disputed[0].invoice_cost + disputed[0].calculated_cost : 0;
  const asOf = thisMonth.map((r) => r.as_of_snapshot).filter(Boolean).sort().pop() || null;
  const footnotes = [
    campaign.some((c) => c.has_provisional) ? '† provisional: Lead Gurus feed spend until the invoice replaces it at month close; Canvass commission is a 15% estimate until canvasser payroll is uploaded.' : null,
    heldTotal ? `Held at company level (REECE_HOLD), not in any market: $${heldTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}${recommendations.length ? ` — recommended: ${recommendations.join(' | ')}` : ' — no recommendation yet'}.` : null,
    disputedTotal ? `Disputed, not in any market (billed for more than we could find; waiting on a revised invoice, a confirmed charge or a credit): $${disputedTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}.` : null,
    asOf ? `Net / Working $ as of the ${asOf} report 133 snapshot — statuses move daily.` : 'Net / Working $: no report 133 snapshot for this month yet.',
    'Net $ = jobs released to production (RTP) or completed; Working $ = sold but not yet RTP.',
    'Cost / Issued Lead = (Invoice Cost + Calculated Cost) ÷ Issued. Calculated = Canvass 15% (estimate until canvasser payroll), MVP Marketing 15%, LeadPilotData 15% of net. Previous Customer and Customer Referral carry no cost.',
  ].filter(Boolean);
  return { market, title: market === COMPANY ? 'Reece Windows & Doors — all markets' : marketLabel(market), month, monthLabel: monthLabel(month), campaign, monthly, weekly, held: heldTotal, disputed: disputedTotal, recommendations, asOf, footnotes };
}

/** Load everything one month's report needs and build every market model + the company. */
export async function buildReportModels({ month, markets = MARKETS }, deps = {}) {
  const m0 = monthStart(month);
  const weekFrom = new Date(Date.parse(`${m0}T00:00:00Z`) - 70 * 86400000).toISOString().slice(0, 10);
  const monthEnd = new Date(Date.UTC(+m0.slice(0, 4), +m0.slice(5, 7), 0)).toISOString().slice(0, 10);
  const [monthRows, weekRows] = await Promise.all([
    loadViewRows({ grain: 'month', from: yearStart(month), to: m0 }, deps),
    loadViewRows({ grain: 'iso_week', from: weekFrom, to: monthEnd }, deps),
  ]);
  return [...markets, COMPANY].map((market) => buildMarketModel({ market, month, monthRows, weekRows }));
}
