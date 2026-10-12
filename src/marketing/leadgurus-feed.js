/**
 * Lead Gurus feed → provisional expenses, and the invoice true-up.
 * src/marketing/leadgurus-feed.js (handoff §7.2, §7.3, D3, D4).
 *
 * The daily pull (src/leadgurus-ingest.js, I.LG) already writes
 * ft_daily_summary and ft_summary_territory. This turns the territory rows
 * into one marketing_expenses row per (date, territory): vendor Lead Gurus,
 * cost_type 'feed', approved + PROVISIONAL, market from
 * marketing_territory_map. The day's gap (daily total − territory sum) goes
 * to REECE_HOLD with the flag 'unassigned_territory' (2026-09-22 was one such
 * day: $4,763.59 that the territory endpoint never attributed).
 *
 * D3: the invoice is the source of truth. When an approved Lead Gurus invoice
 * covers a month, that month's feed rows are marked `superseded` (their
 * allocations go), the invoice is allocated (per-market lines direct, a single
 * total by each market's FEED SHARE that month) and a variance over
 * MKT_FEED_VARIANCE_PCT is posted to the review channel.
 */
import supabaseDefault from '../supabase.js';
import { allocateExpenseById, deleteAllocations, writeAllocations } from './allocation-io.js';
import { splitPeriodByMonth, HOLD_MARKET } from './allocation.js';

const LOG = '[MktFeed]';
export const FEED_SOURCE = 'leadgurus_feed';
export const FEED_SUB_SOURCE = 'Lead Gurus';
export const FEED_GAP_TERRITORY = '__gap__';
const cents = (n) => Math.round(Number(n || 0) * 100);

export async function loadTerritoryMap({ supabase = supabaseDefault } = {}) {
  const { data, error } = await supabase.from('marketing_territory_map').select('territory, market');
  if (error) throw new Error(`marketing_territory_map read failed: ${error.message}`);
  return Object.fromEntries((data || []).map((r) => [String(r.territory).toLowerCase(), r.market]));
}

export async function feedVendor({ supabase = supabaseDefault } = {}) {
  const { data, error } = await supabase.from('marketing_vendors').select('*').eq('vendor_name', 'Lead Gurus').maybeSingle();
  if (error) throw new Error(`vendor read failed: ${error.message}`);
  if (!data) throw new Error('marketing_vendors has no "Lead Gurus" row — apply migration 20261012222106_158_marketing_cost_ledger');
  return data;
}

/**
 * Pure: the expense rows a window of feed data implies.
 * @param {Array} territoryRows  ft_summary_territory rows
 * @param {Array} dailyRows      ft_daily_summary rows
 * @param {Record<string,string>} map  lower(territory) → market
 */
export function buildFeedRows({ territoryRows, dailyRows, map, vendorId }) {
  const rows = [];
  const byDate = {};
  for (const t of territoryRows || []) {
    const spend = Number(t.total_spend || 0);
    byDate[t.date] = (byDate[t.date] || 0) + cents(spend);
    if (cents(spend) === 0) continue;
    const market = map[String(t.territory).toLowerCase()];
    const flags = market ? [] : ['unknown_territory'];
    rows.push({
      vendor_id: vendorId, cost_type: 'feed',
      description: `Lead Gurus feed ${t.date} · ${t.territory}${market ? '' : ' (territory not mapped)'}`,
      amount: Math.round(spend * 100) / 100,
      period_start: t.date, period_end: t.date,
      lp_sub_sources: [FEED_SUB_SOURCE], eligible_markets: [market || HOLD_MARKET],
      status: 'approved', provisional: true,
      source_system: FEED_SOURCE, source_ref: `${t.date}|${t.territory}`, flags,
    });
  }
  for (const d of dailyRows || []) {
    const gap = cents(d.total_spend) - (byDate[d.date] || 0);
    if (gap <= 1) continue; // cents of rounding are not a territory gap
    rows.push({
      vendor_id: vendorId, cost_type: 'feed',
      description: `Lead Gurus feed ${d.date} · not attributed to any territory (daily total − territories)`,
      amount: gap / 100,
      period_start: d.date, period_end: d.date,
      lp_sub_sources: [FEED_SUB_SOURCE], eligible_markets: [HOLD_MARKET],
      status: 'approved', provisional: true,
      source_system: FEED_SOURCE, source_ref: `${d.date}|${FEED_GAP_TERRITORY}`, flags: ['unassigned_territory'],
    });
  }
  return rows;
}

/**
 * Upsert the feed rows for a date window and allocate what changed. A row a
 * true-up already superseded is left alone. Returns counts.
 */
export async function syncFeedExpenses({ from, to }, deps = {}) {
  const supabase = deps.supabase || supabaseDefault;
  const vendor = await feedVendor({ supabase });
  const map = await loadTerritoryMap({ supabase });
  const [{ data: terr, error: tErr }, { data: daily, error: dErr }] = await Promise.all([
    supabase.from('ft_summary_territory').select('date, territory, total_spend').gte('date', from).lte('date', to),
    supabase.from('ft_daily_summary').select('date, total_spend').gte('date', from).lte('date', to),
  ]);
  if (tErr) throw new Error(`ft_summary_territory read failed: ${tErr.message}`);
  if (dErr) throw new Error(`ft_daily_summary read failed: ${dErr.message}`);

  const wanted = buildFeedRows({ territoryRows: terr, dailyRows: daily, map, vendorId: vendor.id });
  const { data: existing, error: eErr } = await supabase.from('marketing_expenses')
    .select('id, source_ref, amount, status, eligible_markets')
    .eq('source_system', FEED_SOURCE).gte('period_start', from).lte('period_start', to);
  if (eErr) throw new Error(`marketing_expenses read failed: ${eErr.message}`);
  const byRef = Object.fromEntries((existing || []).map((r) => [r.source_ref, r]));

  const out = { from, to, rows: wanted.length, inserted: 0, updated: 0, unchanged: 0, superseded_kept: 0, zeroed: 0, allocated: 0 };
  const toAllocate = [];
  for (const row of wanted) {
    const cur = byRef[row.source_ref];
    delete byRef[row.source_ref];
    if (!cur) {
      const { data, error } = await supabase.from('marketing_expenses').insert(row).select('id').single();
      if (error) throw new Error(`feed insert ${row.source_ref} failed: ${error.message}`);
      out.inserted++; toAllocate.push(data.id);
      continue;
    }
    if (cur.status === 'superseded') { out.superseded_kept++; continue; }
    const same = cents(cur.amount) === cents(row.amount)
      && JSON.stringify(cur.eligible_markets || []) === JSON.stringify(row.eligible_markets);
    if (same) { out.unchanged++; continue; }
    const { error } = await supabase.from('marketing_expenses')
      .update({ amount: row.amount, eligible_markets: row.eligible_markets, description: row.description, flags: row.flags, updated_at: new Date().toISOString() })
      .eq('id', cur.id);
    if (error) throw new Error(`feed update ${row.source_ref} failed: ${error.message}`);
    out.updated++; toAllocate.push(cur.id);
  }
  // A gap row that no longer has a gap (the feed re-pull attributed the day) → zero it.
  for (const cur of Object.values(byRef)) {
    if (cur.status === 'superseded' || cents(cur.amount) === 0) continue;
    const { error } = await supabase.from('marketing_expenses').update({ amount: 0, updated_at: new Date().toISOString() }).eq('id', cur.id);
    if (error) throw new Error(`feed zero ${cur.source_ref} failed: ${error.message}`);
    out.zeroed++; toAllocate.push(cur.id);
  }
  for (const id of toAllocate) {
    await allocateExpenseById(id, { supabase });
    out.allocated++;
  }
  console.log(`${LOG} sync ${from}..${to}: ${JSON.stringify(out)}`);
  return out;
}

/** Feed spend per market for a month (approved + superseded rows both count: the share is the share). */
export async function feedShareByMarket(month, { supabase = supabaseDefault } = {}) {
  const start = `${month.slice(0, 7)}-01`;
  const end = new Date(Date.UTC(+start.slice(0, 4), +start.slice(5, 7), 0)).toISOString().slice(0, 10);
  const { data, error } = await supabase.from('marketing_expenses').select('id, amount, eligible_markets, status')
    .eq('source_system', FEED_SOURCE).gte('period_start', start).lte('period_start', end).in('status', ['approved', 'superseded']);
  if (error) throw new Error(`feed share read failed: ${error.message}`);
  const byMarket = {};
  let total = 0;
  const ids = [];
  for (const r of data || []) {
    const m = (r.eligible_markets || [])[0];
    if (!m) continue;
    byMarket[m] = (byMarket[m] || 0) + cents(r.amount);
    total += cents(r.amount);
    ids.push({ id: r.id, status: r.status });
  }
  return { start, end, byMarket, totalCents: total, rows: ids };
}

/**
 * Pure: split an invoice amount by feed share. Markets with no feed spend get
 * nothing; a held share stays held. Leftover cent to the largest share.
 */
export function splitByFeedShare(amount, byMarketCents) {
  const total = Object.values(byMarketCents).reduce((a, c) => a + c, 0);
  const amountCents = cents(amount);
  const markets = Object.keys(byMarketCents).sort();
  if (!total || !markets.length) return null;
  const rows = markets.map((m) => ({ market: m, cents: Math.floor((amountCents * byMarketCents[m]) / total), share: byMarketCents[m] / total }));
  const leftover = amountCents - rows.reduce((a, r) => a + r.cents, 0);
  if (leftover) rows.reduce((b, r) => (r.share > b.share ? r : b), rows[0]).cents += leftover;
  return rows.map((r) => ({ market: r.market, rule: 'proportional', issued_basis: null, issued_total: null, amount: r.cents / 100, share: r.share }));
}

/**
 * D3 true-up for one approved invoice expense set (all rows of a document).
 * Returns { months: [{month, feed, invoice, variance_pct, posted}] }.
 */
export async function trueUpInvoice(expenses, deps = {}) {
  const supabase = deps.supabase || supabaseDefault;
  const post = deps.post || (async () => ({ ok: false }));
  const variancePct = Number(deps.variancePct ?? process.env.MKT_FEED_VARIANCE_PCT ?? 0.02);
  const rows = (expenses || []).filter((e) => e.status === 'approved');
  if (!rows.length) return { months: [] };
  const months = new Set();
  for (const e of rows) for (const s of splitPeriodByMonth(e.period_start, e.period_end, e.amount)) months.add(s.month);

  const out = { months: [] };
  for (const month of [...months].sort()) {
    const share = await feedShareByMarket(month, { supabase });
    // 1. supersede the feed rows of that month
    const toSupersede = share.rows.filter((r) => r.status === 'approved').map((r) => r.id);
    if (toSupersede.length) {
      const { error } = await supabase.from('marketing_expenses').update({ status: 'superseded', updated_at: new Date().toISOString() }).in('id', toSupersede);
      if (error) throw new Error(`supersede feed rows failed: ${error.message}`);
      for (const id of toSupersede) await deleteAllocations(id, { supabase });
    }
    // 2. allocate the invoice rows: per-market lines go direct through the
    //    normal allocator; a single all-markets total is split by feed share.
    let invoiceCents = 0;
    for (const e of rows) {
      const slices = splitPeriodByMonth(e.period_start, e.period_end, e.amount).filter((s) => s.month === month);
      if (!slices.length) continue;
      invoiceCents += slices.reduce((a, s) => a + cents(s.amount), 0);
      const single = (e.eligible_markets || []).length > 1 && slices.length === 1
        && cents(slices[0].amount) === cents(e.amount);
      if (single && Object.keys(share.byMarket).length) {
        const split = splitByFeedShare(e.amount, share.byMarket);
        if (split) {
          const basis = split.map((r) => `${r.market} ${(r.share * 100).toFixed(1)}%`).join(', ');
          await writeAllocations(e.id, split.map(({ share: _s, ...r }) => ({ ...r, month, lp_sub_source: FEED_SUB_SOURCE })), { supabase });
          await supabase.from('marketing_expenses').update({
            description: `${(e.description || 'Lead Gurus invoice').replace(/ \[split by feed share:.*\]$/, '')} [split by feed share: ${basis}]`,
            updated_at: new Date().toISOString(),
          }).eq('id', e.id);
          continue;
        }
      }
      await allocateExpenseById(e.id, { supabase });
    }
    // 3. variance
    const feed = share.totalCents / 100;
    const invoice = invoiceCents / 100;
    const variance = feed > 0 ? (invoice - feed) / feed : null;
    const over = variance !== null && Math.abs(variance) > variancePct;
    let posted = false;
    if (over) {
      const label = new Date(`${month}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      const text = `Lead Gurus ${label}: invoice $${invoice.toLocaleString('en-US', { minimumFractionDigits: 2 })} vs feed $${feed.toLocaleString('en-US', { minimumFractionDigits: 2 })} (Δ ${(variance * 100).toFixed(1)}%) — likely agency fee or late spend.`;
      const r = await post(text);
      posted = !!r?.ok;
      console.log(`${LOG} variance ${month}: ${text} (posted=${posted})`);
    }
    out.months.push({ month, feed, invoice, variance_pct: variance === null ? null : Math.round(variance * 10000) / 100, superseded: toSupersede.length, posted });
  }
  return out;
}
