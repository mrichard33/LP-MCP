/**
 * Held spend recommendations — src/marketing/holds.js (handoff D4, §7.5).
 *
 * Lead Gurus "Unknown" / "Out Of Area" spend and the daily territory gap land
 * in REECE_HOLD. Since 2026-10-19 (the user: "Why do we have all these …? This
 * needs to be fixed." — August alone had 30 one-day items, some $0.01, and not
 * one had a suggestion: recommendHolds only ever ran for the current and prior
 * month) the FEED's held days are placed by code, assignHeldFeedSpend below:
 * the offices of that day's held leads, else split by Lead Gurus' issued leads
 * that month. Anything else still held gets a RECOMMENDATION a person applies
 * with one click (the dashboard's "Apply recommendation"). How a held lead is
 * matched:
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
import { callCenterLineKind, HOLD_MARKET } from './allocation.js';

const LOG = '[MktHold]';

/**
 * LP branch markets that are not offices of their own fold into the office
 * that runs them (the user, 2026-10-19: "fold Boca and Miami into Fort
 * Lauderdale"). A matched lead's branch, resolved market or zip can still read
 * BOCA_MKT / MIAMI_MKT, and 21 held feed days placed on 2026-10-19 named those
 * codes: Boca and Miami got their own gray "Other markets" bar, and on a day
 * that also named other offices Fort Lauderdale got $0 (no issued leads under
 * BOCA_MKT). The same aliases as MARKET_ALIASES in src/slack.js.
 */
const OFFICE_ALIASES = { BOCA_MKT: 'FTLAU_MKT', MIAMI_MKT: 'FTLAU_MKT', RFED_MKT: 'FTLAU_MKT', LAKE_MKT: 'ORL_MKT' };
export const officeMarket = (code) => (code ? OFFICE_ALIASES[code] || code : code);
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
      let market = map[hit.lp_branch_id] || null;
      // An Out Of Area lead often has no LP branch (37 of 52 August matches,
      // 2026-10-19); the lead's resolved market (zip / branch) is the next answer.
      if (!market && hit.lp_lead_id) {
        const { data: assigned } = await supabase.from('lp_lead_market_assignments').select('resolved_market_code').eq('lead_id', String(hit.lp_lead_id)).limit(1);
        const code = String(assigned?.[0]?.resolved_market_code || '');
        if (/_MKT$/.test(code)) market = code;
      }
      out.push({ lead_id: lead.lead_id, market: officeMarket(market), reason: `matched LP ${prospectLabel(hit.lp_prospect_id)}, branch ${hit.lp_branch_id || '?'}` });
      continue;
    }
    const zip = digits(lead.zip_code).slice(0, 5);
    if (zip.length === 5) {
      const { data } = await supabase.from('service_area_zips').select('zip, market_code').eq('zip', zip).limit(1);
      if (data?.length) {
        const code = String(data[0].market_code || '');
        const market = officeMarket(/_MKT$/.test(code) ? code : `${code}_MKT`);
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

const cents = (n) => Math.round(Number(n || 0) * 100);

/** Pure: the offices a day's matched held leads point at, most leads first (none = []). */
export function marketsFromMatches(matches = []) {
  const counts = {};
  for (const m of matches) {
    const market = officeMarket(m?.market);
    if (market) counts[market] = (counts[market] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([m]) => m);
}

/**
 * Place every held Lead Gurus feed day of a month (the user, 2026-10-19: "assign it
 * automatically"; supersedes D4's "never spread by code" for the feed). Each held
 * day (an "Unknown" / "Out Of Area" territory row or the day gap) goes to the
 * offices of THAT day's held leads, matched in LP (matchHeldLeads), split by those
 * offices' Lead Gurus issued leads that month; a day with no match is split like
 * any lead-source cost, by Lead Gurus' issued leads per office that month
 * (eligible_markets '{}'). The row keeps flag 'auto_assigned', and the feed sync
 * keeps its markets when the day's amount changes (syncFeedExpenses). A failed
 * lookup leaves the day held for the next run, never guessed.
 */
export async function assignHeldFeedSpend(month, deps = {}) {
  const supabase = deps.supabase || supabaseDefault;
  const { start, end } = monthBounds(month);
  const { data: rows, error } = await supabase.from('marketing_expenses').select('id, period_start, eligible_markets, amount, flags, status')
    .eq('source_system', FEED_SOURCE).eq('status', 'approved').gte('period_start', start).lte('period_start', end);
  if (error) throw new Error(`feed rows read failed: ${error.message}`);
  const held = (rows || []).filter((r) => (r.eligible_markets || []).length === 1 && r.eligible_markets[0] === HOLD_MARKET && cents(r.amount) !== 0);
  const out = { month: start, held: held.length, to_offices: 0, by_source: 0, failed: 0 };
  const allocate = deps.allocate || (await import('./allocation-io.js')).allocateExpenseById;
  const cache = {};
  for (const r of held) {
    try {
      cache[r.period_start] ||= await (deps.matchHeldLeads || matchHeldLeads)(r.period_start, { supabase });
      const markets = marketsFromMatches(cache[r.period_start]);
      const flags = [...new Set([...(r.flags || []), 'auto_assigned'])];
      const { error: uErr } = await supabase.from('marketing_expenses').update({ eligible_markets: markets, flags, updated_at: new Date().toISOString() }).eq('id', r.id);
      if (uErr) throw new Error(uErr.message);
      await allocate(r.id, { supabase });
      if (markets.length) out.to_offices++; else out.by_source++;
    } catch (err) {
      out.failed++;
      console.warn(`${LOG} assign ${r.period_start} (${r.id}): ${err.message}`);
    }
  }
  console.log(`${LOG} ${start} held feed days assigned: ${JSON.stringify(out)}`);
  return out;
}
