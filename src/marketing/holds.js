/**
 * Held spend recommendations — src/marketing/holds.js (handoff D4, §7.5).
 *
 * Lead Gurus "Unknown" / "Out Of Area" spend and the daily territory gap sit
 * in REECE_HOLD. Nobody spreads that money automatically. This job writes a
 * RECOMMENDATION on each hold allocation so Mark or Brad can move it with one
 * click (the dashboard's "Apply recommendation", which rewrites
 * eligible_markets and reallocates):
 *
 *   1. who ran it: that day's Unknown / Out Of Area ft_leads matched to
 *      lp_leads by email, then by the last 10 digits of the phone → the
 *      lead's branch → market. "matched LP lead <id>, branch <brn>"
 *   2. geography: ft_leads.zip_code → service_area_zips.market_code → market.
 *      "zip <zip> in <market> service area"
 *   3. else null: "no match — needs manual pick"
 *
 * Several markets → split by lead count, the recommendation names them all.
 */
import supabaseDefault from '../supabase.js';
import { FEED_SOURCE, FEED_GAP_TERRITORY } from './leadgurus-feed.js';
import { prospectLabel } from '../format-helpers.js';
import { callCenterLineKind } from './allocation.js';

const LOG = '[MktHold]';
const digits = (s) => String(s || '').replace(/\D/g, '');
const HELD_TERRITORIES = ['unknown', 'out of area'];

function monthBounds(month) {
  const start = `${String(month).slice(0, 7)}-01`;
  const end = new Date(Date.UTC(+start.slice(0, 4), +start.slice(5, 7), 0)).toISOString().slice(0, 10);
  return { start, end };
}

/** Pure: turn matched leads into one recommendation. */
export function summarizeRecommendation(matches) {
  const counts = {};
  const reasons = [];
  for (const m of matches) {
    if (!m.market) continue;
    counts[m.market] = (counts[m.market] || 0) + 1;
    if (reasons.length < 6) reasons.push(m.reason);
  }
  const markets = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!markets.length) return { recommended_market: null, recommendation_reason: 'no match — needs manual pick' };
  const total = markets.reduce((a, [, n]) => a + n, 0);
  return {
    recommended_market: markets.map(([m]) => m).join(','),
    recommendation_reason: `${markets.map(([m, n]) => `${m} ${n}/${total} lead${n === 1 ? '' : 's'}`).join(', ')} — ${reasons.join('; ')}`.slice(0, 900),
  };
}

/**
 * Match one day's held Lead Gurus leads to a market. Every lookup is best-
 * effort: a failed read leaves the lead unmatched, never throws the job.
 */
export async function matchHeldLeads(date, { supabase = supabaseDefault } = {}) {
  const { data: leads, error } = await supabase.from('ft_leads').select('lead_id, email, phone, zip_code, territory, created_at')
    .gte('created_at', `${date}T00:00:00`).lt('created_at', `${date}T23:59:59.999`);
  if (error) throw new Error(`ft_leads read failed: ${error.message}`);
  const held = (leads || []).filter((l) => !l.territory || HELD_TERRITORIES.includes(String(l.territory).toLowerCase()));
  const out = [];
  let branchMap = null;
  const loadBranchMap = async () => {
    if (branchMap) return branchMap;
    const { data } = await supabase.from('lp_branch_market_map').select('brn_id, market_code');
    branchMap = Object.fromEntries((data || []).map((r) => [r.brn_id, r.market_code]));
    return branchMap;
  };
  for (const lead of held) {
    let hit = null;
    const email = String(lead.email || '').trim().toLowerCase();
    if (email) {
      const { data } = await supabase.from('lp_leads').select('lp_lead_id, lp_prospect_id, lp_branch_id, email').eq('email', email).limit(1);
      if (data?.length) hit = data[0];
    }
    if (!hit) {
      const last10 = digits(lead.phone).slice(-10);
      if (last10.length === 10) {
        const { data } = await supabase.from('lp_leads').select('lp_lead_id, lp_prospect_id, lp_branch_id, phone').like('phone', `%${last10}`).limit(1);
        if (data?.length) hit = data[0];
      }
    }
    if (hit) {
      const map = await loadBranchMap();
      const market = map[hit.lp_branch_id] || null;
      out.push({ lead_id: lead.lead_id, market, reason: `matched LP ${prospectLabel(hit.lp_prospect_id)}, branch ${hit.lp_branch_id || '?'}` });
      continue;
    }
    const zip = digits(lead.zip_code).slice(0, 5);
    if (zip.length === 5) {
      const { data } = await supabase.from('service_area_zips').select('zip, market_code').eq('zip', zip).limit(1);
      if (data?.length) {
        const code = String(data[0].market_code || '');
        const market = /_MKT$/.test(code) ? code : `${code}_MKT`;
        out.push({ lead_id: lead.lead_id, market, reason: `zip ${zip} in ${market} service area` });
        continue;
      }
    }
    out.push({ lead_id: lead.lead_id, market: null, reason: 'no match' });
  }
  return out;
}

/** Recommend a market for every hold allocation in a month. */
export async function recommendHolds(month, deps = {}) {
  const supabase = deps.supabase || supabaseDefault;
  const { start } = monthBounds(month);
  const { data: allocs, error } = await supabase.from('marketing_expense_allocations').select('id, expense_id, month, amount, rule').eq('month', start).eq('rule', 'hold');
  if (error) throw new Error(`hold allocations read failed: ${error.message}`);
  const out = { month: start, holds: (allocs || []).length, recommended: 0, unmatched: 0 };
  if (!allocs?.length) return out;
  const { data: expenses } = await supabase.from('marketing_expenses').select('id, source_system, source_ref, period_start, eligible_markets, lp_sub_sources, description').in('id', allocs.map((a) => a.expense_id));
  const byId = Object.fromEntries((expenses || []).map((e) => [e.id, e]));
  const cache = {};
  for (const a of allocs) {
    const e = byId[a.expense_id];
    // 2026-10-13: a line split by source that is waiting for its first issued
    // lead of the month is not a held lead to place by hand; the nightly re-run
    // splits it. Its allocation already says so.
    if (e && !(e.eligible_markets || []).length) continue;
    // 2026-10-19: so is a call center's demo / sales / canvass line waiting on its leads.
    if (e && callCenterLineKind(e)) continue;
    let rec;
    if (e?.source_system === FEED_SOURCE && e.period_start) {
      try {
        cache[e.period_start] ||= await (deps.matchHeldLeads || matchHeldLeads)(e.period_start, { supabase });
        const matches = cache[e.period_start];
        rec = summarizeRecommendation(matches);
        if (String(e.source_ref || '').endsWith(`|${FEED_GAP_TERRITORY}`) && rec.recommended_market) {
          rec.recommendation_reason = `day gap; held leads that day: ${rec.recommendation_reason}`.slice(0, 900);
        }
      } catch (err) {
        console.warn(`${LOG} ${e.period_start}: ${err.message}`);
        rec = { recommended_market: null, recommendation_reason: `lookup failed: ${err.message}`.slice(0, 300) };
      }
    } else {
      rec = { recommended_market: null, recommendation_reason: 'no match — needs manual pick' };
    }
    await supabase.from('marketing_expense_allocations').update(rec).eq('id', a.id);
    if (rec.recommended_market) out.recommended++; else out.unmatched++;
  }
  console.log(`${LOG} ${start}: ${JSON.stringify(out)}`);
  return out;
}

/**
 * "Apply recommendation" (a person's click, never automatic): rewrite the
 * expense's eligible_markets to the recommended market(s) and reallocate.
 */
export async function applyRecommendation(expenseId, { markets, by }, deps = {}) {
  const supabase = deps.supabase || supabaseDefault;
  const list = (markets || []).map((m) => String(m).trim()).filter((m) => /_MKT$/.test(m));
  if (!list.length) return { ok: false, error: 'no market codes' };
  const { error } = await supabase.from('marketing_expenses').update({ eligible_markets: list, flags: ['held_then_applied'], updated_at: new Date().toISOString(), approved_by: `${by || 'person'} (applied recommendation)` }).eq('id', expenseId);
  if (error) throw new Error(`apply recommendation failed: ${error.message}`);
  const { allocateExpenseById } = await import('./allocation-io.js');
  return { ok: true, ...(await allocateExpenseById(expenseId, { supabase })) };
}
