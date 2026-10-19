/**
 * Per-sale commission invoices — src/marketing/commission-invoice.js
 *
 * LeadPilot bills 15% of each sale its leads produced, one line per customer
 * ("David Shadlick $68,000 … Sold on 09/14/2025", INV-000088, 2026-10-19). The
 * first one landed on Fort Lauderdale because the only "market word" on the
 * page was LeadPilot's own letterhead (West Palm Beach), and in October, the
 * day it was billed. The sale was David Shadick's (one "l"), Prospect 449431,
 * an Orlando lead, contract 8/26/2026: the invoice misspelled the name and
 * typed 2025. The user, 2026-10-19: "If the lead wasn't created in Fort
 * Lauderdale, it shouldn't use Lead Pilot's office address. We need to locate
 * that lead in Lead Perfection if it isn't in our database."
 *
 * So a line from a commission vendor (marketing_vendors.default_cost_type
 * 'calculated', whose sub-sources carry a marketing_cost_rules rate) is matched
 * to its LP sale: the vendor's sub-source + the sale amount (printed, else line
 * ÷ rate), confirmed by a loose name check (one typo allowed). Our lp_jobs /
 * lp_leads first, then LP live by surname. A match books the line in the lead's
 * office and the CONTRACT month, the month report 133 counts the sale in, so the
 * same month's 15% estimate can step aside for it (commission.js, "the invoice
 * replaces the estimate"). No match: the letterhead guess is dropped (the
 * vendor's own markets, split by its issued leads) and the card says
 * `sale_not_found`. The vendor's printed city is never a market for these lines.
 */
import supabaseDefault from '../supabase.js';
import { marketsForLeads } from './allocation-io.js';

const LOG = '[MktCommissionInvoice]';
export const SALE_NOT_FOUND = 'sale_not_found';

const money = (s) => Number(String(s).replace(/[$,\s]/g, ''));
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();

/** Levenshtein distance, small strings only. */
export function editDistance(a, b) {
  a = String(a); b = String(b);
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/**
 * Pure: what one invoice line says about its sale. The name is the words
 * before the first dollar figure; the sale is a printed figure that is not the
 * line's own amount, else line ÷ rate; "Sold on" is kept for the card only
 * (LeadPilot's was a deposit date with the wrong year).
 */
export function saleFromLine(line, rate) {
  const text = String(line?.description || '');
  const amount = Number(line?.amount || 0);
  const figures = [...text.matchAll(/\$\s?([\d,]+(?:\.\d{1,2})?)/g)].map((m) => money(m[1])).filter((n) => n > 0);
  const printed = figures.find((n) => Math.abs(n - amount) >= 1);
  const sale = printed ?? (rate > 0 && amount > 0 ? Math.round((amount / rate) * 100) / 100 : null);
  const name = norm(text.split(/\$|\d/)[0]).replace(/\b(commission|on|sale|for|job|customer)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const sold = text.match(/sold\s+on\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i)?.[1] || null;
  return { name: name || null, sale, sold };
}

/** Pure: does the invoice's name read as this LP customer's (one typo per name allowed)? */
export function nameMatches(invoiceName, { first_name, last_name } = {}) {
  const words = norm(invoiceName).split(' ').filter((w) => w.length > 1);
  const lasts = norm(last_name).split(' ').filter((w) => w.length > 1);
  const firsts = norm(first_name).split(' ').filter((w) => w.length > 1);
  if (!words.length || !lasts.length) return false;
  const close = (w, n) => w === n || (n.length >= 4 && w.length >= 4 && editDistance(w, n) <= Math.max(1, Math.floor(n.length / 5)));
  const lastHit = lasts.some((n) => words.some((w) => close(w, n)));
  if (!lastHit) return false;
  return !firsts.length || words.length < 2 || firsts.some((n) => words.some((w) => close(w, n)));
}

/**
 * Pure: the one sale a line is for. Candidates already share the sub-source;
 * the amount must agree to the dollar. A name that matches decides between
 * several; one amount-match whose name does NOT match is still refused (a
 * different customer who happened to buy at the same price).
 */
export function pickSale(candidates, { name, sale }) {
  const byAmount = (candidates || []).filter((c) => sale != null && Math.abs(Number(c.job_value) - sale) < 1);
  const named = name ? byAmount.filter((c) => nameMatches(name, c)) : [];
  if (named.length === 1) return named[0];
  if (!name && byAmount.length === 1) return byAmount[0];
  return null;
}

function monthOf(date) {
  const d = String(date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const start = `${d.slice(0, 7)}-01`;
  const end = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 0)).toISOString().slice(0, 10);
  return { start, end };
}

const usd = (n) => `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const mdY = (d) => { const s = String(d || '').slice(0, 10); return s ? `${+s.slice(5, 7)}/${+s.slice(8, 10)}/${s.slice(0, 4)}` : ''; };

/** Pure: the row a matched line becomes (the lead's office, the contract month). */
export function applySaleMatch(row, line, match) {
  const month = monthOf(match.contract_date);
  const who = [match.first_name, match.last_name].filter(Boolean).join(' ');
  const where = match.market_label || match.market;
  return {
    ...row,
    eligible_markets: [match.market],
    period_start: month?.start ?? row.period_start,
    period_end: month?.end ?? row.period_end,
    description: `${line.description} · LP: Prospect ${match.prospect_id || 'unknown'}, ${who}, ${where}, ${usd(match.job_value)} sold ${mdY(match.contract_date)}`.slice(0, 500),
  };
}

/** Our copy first: lp_jobs at that amount, on a lead of the vendor's sub-sources. */
async function salesFromDb({ sale, subSources }, { supabase }) {
  const { data: jobs, error } = await supabase.from('lp_jobs').select('lp_lead_id, job_value, branch_code, created_at_lp, raw_lp_data')
    .gte('job_value', sale - 1).lte('job_value', sale + 1).limit(200);
  if (error) throw new Error(`lp_jobs read failed: ${error.message}`);
  const leadIds = [...new Set((jobs || []).map((j) => String(j.lp_lead_id)).filter(Boolean))];
  if (!leadIds.length) return [];
  const { data: leads, error: lErr } = await supabase.from('lp_leads').select('lp_lead_id, lp_prospect_id, first_name, last_name, lead_source_detail').in('lp_lead_id', leadIds);
  if (lErr) throw new Error(`lp_leads read failed: ${lErr.message}`);
  const wanted = new Set(subSources);
  const byId = new Map((leads || []).filter((l) => wanted.has(l.lead_source_detail)).map((l) => [String(l.lp_lead_id), l]));
  const markets = await marketsForLeads([...byId.keys()], { supabase });
  const out = [];
  for (const j of jobs || []) {
    const l = byId.get(String(j.lp_lead_id));
    if (!l) continue;
    out.push({
      lp_lead_id: String(l.lp_lead_id), prospect_id: l.lp_prospect_id ? String(l.lp_prospect_id) : null,
      first_name: l.first_name, last_name: l.last_name, job_value: Number(j.job_value),
      contract_date: j.raw_lp_data?.contractdate || j.created_at_lp || null,
      market: markets.get(String(l.lp_lead_id)) || null, branch: j.branch_code || null, found_in: 'database',
    });
  }
  return out;
}

/**
 * LP live, by surname, when our copy has nothing (lp_leads has holes). LP's
 * customer search is a prefix match, so the first four letters survive a typo
 * at the end ("Shadlick" → "Shad" finds "Shadick"); the name check then keeps
 * the near misses, and at most `maxLeads` prospects are opened.
 */
async function salesFromLp({ name, sale, subSources }, { lp, branchMap, maxLeads = 5 }) {
  const words = norm(name).split(' ').filter((w) => w.length > 1);
  const surname = words[words.length - 1];
  if (!surname || surname.length < 4) return [];
  const asArray = (r) => (Array.isArray(r) ? r : (Array.isArray(r?.data) ? r.data : []));
  const prospects = asArray(await lp.getCustomers3({ lastname: surname.slice(0, 4) }))
    .filter((p) => nameMatches(name, { first_name: p.FirstName, last_name: p.LastName }))
    .slice(0, maxLeads);
  const wanted = new Set(subSources);
  const out = [];
  for (const p of prospects) {
    const rec = asArray(await lp.getLead(String(p.ProspectID)))[0];
    for (const lead of rec?.leads || []) {
      if (!wanted.has(lead.sourcesubdescr)) continue;
      for (const job of lead.jobs || []) {
        out.push({
          lp_lead_id: String(lead.id), prospect_id: String(p.ProspectID), first_name: rec.firstname, last_name: rec.lastname,
          job_value: Number(job.grossamount || lead.GrossSaleAmount || 0), contract_date: job.contractdate || null,
          market: branchMap.get(String(job.pds_id || lead.brn_id || '').trim()) || branchMap.get(String(lead.brn_id || '').trim()) || null,
          branch: lead.brn_id || null, found_in: 'lead_perfection',
        });
      }
    }
  }
  return out.filter((c) => Math.abs(c.job_value - sale) < 1);
}

/**
 * Match every line of a commission vendor's invoice to its LP sale. Returns the
 * rows to insert (matched ones moved to their office and month; unmatched ones
 * on the vendor's own markets) and what was found, for the analysis and card.
 * A failed read is "not found" (flagged for a person), never a guess.
 */
export async function matchCommissionInvoiceRows({ rows, lines, vendor }, deps = {}) {
  const supabase = deps.supabase || supabaseDefault;
  const subSources = vendor?.lp_sub_sources || [];
  if (vendor?.default_cost_type !== 'calculated' || !subSources.length) return { rows, matches: [], flags: [] };
  const { data: rules } = await supabase.from('marketing_cost_rules').select('rate, lp_sub_sources');
  const rate = Number((rules || []).find((r) => (r.lp_sub_sources || []).some((s) => subSources.includes(s)))?.rate || 0);
  const { data: branches } = await supabase.from('lp_branch_market_map').select('brn_id, market_code, market_label');
  const branchMap = new Map((branches || []).map((b) => [String(b.brn_id), b.market_code]));
  const labelOf = new Map((branches || []).map((b) => [b.market_code, b.market_label]));
  let lp = deps.lp;
  const matches = [];
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const line = lines[i] || { description: row.description, amount: row.amount };
    const want = saleFromLine(line, rate);
    let match = null;
    try {
      if (want.sale) {
        match = pickSale(await salesFromDb({ sale: want.sale, subSources }, { supabase }), want);
        if (!match && want.name) {
          lp = lp || await import('../lp-client.js');
          match = pickSale(await salesFromLp({ ...want, subSources }, { lp, branchMap }), want);
        }
      }
    } catch (err) {
      console.warn(`${LOG} line ${row.line_no}: sale lookup failed (${err.message})`);
    }
    if (match?.market) {
      match.market_label = labelOf.get(match.market) || null;
      out.push(applySaleMatch(row, line, match));
      matches.push({ line_no: row.line_no, found: true, ...want, ...match });
    } else {
      out.push({ ...row, eligible_markets: vendor.eligible_markets || [], description: String(line.description || row.description || '').slice(0, 500) });
      matches.push({ line_no: row.line_no, found: false, ...want });
    }
  }
  const flags = matches.some((m) => !m.found) ? [SALE_NOT_FOUND] : [];
  console.log(`${LOG} ${vendor.vendor_name}: ${matches.filter((m) => m.found).length}/${matches.length} line(s) matched to an LP sale`);
  return { rows: out, matches, flags };
}
