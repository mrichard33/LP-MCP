/**
 * Calculated (commission-style) marketing costs — src/marketing/commission.js
 * (handoff D2 + D8, §7.4).
 *
 * Canvass + Canvass Sticky 15% of net · MVP Marketing 15% of net · Previous
 * Customer + Customer Referral 1% of net. The rates live in
 * marketing_cost_rules; net comes from report 133 through mkt_sales_dollars
 * (never 136). One marketing_expenses row per (rule, market, sub-source,
 * month): cost_type 'calculated', source_system 'commission_rule', approved,
 * allocated direct to its market. Recomputed nightly for the current and the
 * prior month because contract statuses move (Net vs Working shifts daily).
 */
import supabaseDefault from '../supabase.js';
import { allocateExpenseById } from './allocation-io.js';

const LOG = '[MktCommission]';
export const COMMISSION_SOURCE = 'commission_rule';
const cents = (n) => Math.round(Number(n || 0) * 100);

function monthBounds(month) {
  const start = `${String(month).slice(0, 7)}-01`;
  const end = new Date(Date.UTC(+start.slice(0, 4), +start.slice(5, 7), 0)).toISOString().slice(0, 10);
  return { start, end };
}

/** Pure: the rows a month's rules × dollars imply. */
export function buildCommissionRows({ month, rules, dollars, vendors = [] }) {
  const { start, end } = monthBounds(month);
  const rows = [];
  for (const rule of rules) {
    if (rule.effective_from > end || (rule.effective_to && rule.effective_to < start)) continue;
    const vendor = vendors.find((v) => v.default_cost_type === 'calculated' && (rule.lp_sub_sources || []).some((s) => (v.lp_sub_sources || []).includes(s)));
    for (const sub of rule.lp_sub_sources || []) {
      for (const d of dollars) {
        if (d.lp_sub_source !== sub || !/_MKT$/.test(String(d.market || ''))) continue;
        const net = Number(d.net || 0);
        const amount = Math.round(Number(rule.rate) * net * 100) / 100;
        rows.push({
          vendor_id: vendor?.id ?? null, cost_type: 'calculated',
          description: `${rule.label}: ${(Number(rule.rate) * 100).toFixed(rule.rate < 0.01 ? 2 : 0)}% × net $${net.toLocaleString('en-US', { minimumFractionDigits: 2 })} (${sub}, ${d.market})`,
          amount, period_start: start, period_end: end,
          lp_sub_sources: [sub], eligible_markets: [d.market],
          status: 'approved', provisional: false,
          source_system: COMMISSION_SOURCE, source_ref: `${rule.id}|${d.market}|${sub}|${start}`, flags: [],
          approved_by: 'system (commission rule)',
        });
      }
    }
  }
  return rows;
}

/**
 * Recompute one month. Existing rows are updated in place (same source_ref);
 * a row whose basis vanished (the snapshot no longer carries that market ×
 * sub-source) is set to 0 so the ledger never keeps a stale commission.
 */
export async function recomputeCalculatedCosts(month, deps = {}) {
  const supabase = deps.supabase || supabaseDefault;
  const { start } = monthBounds(month);
  const [{ data: rules, error: rErr }, { data: dollars, error: dErr }, { data: vendors }] = await Promise.all([
    supabase.from('marketing_cost_rules').select('*'),
    supabase.rpc('mkt_sales_dollars', { p_month: start }),
    supabase.from('marketing_vendors').select('id, vendor_name, lp_sub_sources, default_cost_type'),
  ]);
  if (rErr) throw new Error(`marketing_cost_rules read failed: ${rErr.message}`);
  if (dErr) throw new Error(`mkt_sales_dollars failed: ${dErr.message}`);
  const out = { month: start, rules: (rules || []).length, dollars_rows: (dollars || []).length, inserted: 0, updated: 0, unchanged: 0, zeroed: 0 };
  if (!(dollars || []).length) {
    console.warn(`${LOG} ${start}: no 133 snapshot for this month — nothing computed`);
    return { ...out, skipped: 'no_snapshot' };
  }
  const wanted = buildCommissionRows({ month: start, rules: rules || [], dollars: dollars || [], vendors: vendors || [] });
  const { data: existing, error: eErr } = await supabase.from('marketing_expenses').select('id, source_ref, amount, status')
    .eq('source_system', COMMISSION_SOURCE).eq('period_start', start);
  if (eErr) throw new Error(`marketing_expenses read failed: ${eErr.message}`);
  const byRef = Object.fromEntries((existing || []).map((r) => [r.source_ref, r]));
  const touched = [];
  for (const row of wanted) {
    const cur = byRef[row.source_ref];
    delete byRef[row.source_ref];
    if (!cur) {
      const { data, error } = await supabase.from('marketing_expenses').insert(row).select('id').single();
      if (error) throw new Error(`commission insert failed: ${error.message}`);
      out.inserted++; touched.push(data.id); continue;
    }
    if (cents(cur.amount) === cents(row.amount) && cur.status === 'approved') { out.unchanged++; continue; }
    const { error } = await supabase.from('marketing_expenses').update({ amount: row.amount, description: row.description, status: 'approved', updated_at: new Date().toISOString() }).eq('id', cur.id);
    if (error) throw new Error(`commission update failed: ${error.message}`);
    out.updated++; touched.push(cur.id);
  }
  for (const cur of Object.values(byRef)) {
    if (cents(cur.amount) === 0) continue;
    const { error } = await supabase.from('marketing_expenses').update({ amount: 0, updated_at: new Date().toISOString() }).eq('id', cur.id);
    if (error) throw new Error(`commission zero failed: ${error.message}`);
    out.zeroed++; touched.push(cur.id);
  }
  for (const id of touched) await allocateExpenseById(id, { supabase });
  console.log(`${LOG} ${start}: ${JSON.stringify(out)}`);
  return out;
}

/** Pure: the first of each month from start's month through end's month (at most 13). */
export function monthsInPeriod(start, end) {
  const out = [];
  let y = +String(start).slice(0, 4);
  let m = +String(start).slice(5, 7);
  const last = String(end).slice(0, 7);
  while (out.length < 13) {
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    out.push(`${ym}-01`);
    if (ym >= last) break;
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/**
 * Recompute the commissions a fresh report 133 snapshot covers (the user,
 * 2026-10-19). The 02:30 ET nightly ran before that day's 133 landed, so the
 * ledger was a day behind it: Fort Myers Canvass held 15% × $322,390 while the
 * 10-19 snapshot said $276,190. Called after a 133 ingest succeeds; the nightly
 * stays as the backstop. Never throws: the snapshot is already stored.
 */
export async function recomputeAfterSalesSnapshot({ periodStart, periodEnd }, deps = {}) {
  const recompute = deps.recompute || recomputeCalculatedCosts;
  const out = [];
  for (const month of monthsInPeriod(periodStart, periodEnd || periodStart)) {
    try {
      out.push(await recompute(month, deps));
    } catch (err) {
      console.error(`${LOG} recompute after 133 for ${month} failed: ${err.message}`);
      out.push({ month, error: err.message });
    }
  }
  return out;
}
