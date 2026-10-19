/**
 * Allocation writer — src/marketing/allocation-io.js
 *
 * The database side of src/marketing/allocation.js: reads gross issued leads
 * (mkt_issued_counts, D1) for each month slice of an expense, runs the pure
 * allocator, and replaces the expense's rows in marketing_expense_allocations.
 * Everything takes `deps.supabase` so it runs against a stub in tests.
 *
 * Only an expense that is `approved` (feed rows are approved + provisional)
 * gets allocations; `rejected` / `superseded` / `pending_review` rows have
 * theirs deleted. The allocator asserts the rows sum to the amount, so an
 * expense that does not reconcile is never written half-way: the delete and
 * insert happen only after the rows exist in memory.
 */
import supabaseDefault from '../supabase.js';
import { allocateExpense, splitPeriodByMonth, splitsBySource, splitsEvenly, callCenterLineKind, HOLD_MARKET } from './allocation.js';
import { agedDays, buildLightFireEvents, daysBetween, EVENT_CANVASS_CONFIRM, EVENT_DEMO, EVENT_DIRECT_NET, isLightFireAgent } from '../payroll/rules.js';
import { createPayrollStore } from '../payroll/store.js';

const LOG = '[MktAlloc]';

/** Gross issued per market for a window, restricted to the expense's sub-sources (none = all). */
export async function issuedByMarketFor({ from, to, subSources = [] }, { supabase = supabaseDefault } = {}) {
  const { data, error } = await supabase.rpc('mkt_issued_counts', { p_from: from, p_to: to });
  if (error) throw new Error(`mkt_issued_counts failed: ${error.message}`);
  const wanted = new Set((subSources || []).filter(Boolean));
  const out = {};
  for (const r of data || []) {
    if (!r.market) continue;
    if (wanted.size && !wanted.has(r.lp_sub_source)) continue;
    out[r.market] = (out[r.market] || 0) + Number(r.issued || 0);
  }
  return out;
}

/** Market per LP lead id, as mkt_issued_counts maps one: the branch map, then the lead's assignment. */
async function marketsForLeads(leadIds, { supabase = supabaseDefault } = {}) {
  const ids = [...new Set((leadIds || []).filter(Boolean).map(String))];
  const out = new Map();
  if (!ids.length) return out;
  const { data: branches, error: bErr } = await supabase.from('lp_branch_market_map').select('brn_id, market_code');
  if (bErr) throw new Error(`branch map read failed: ${bErr.message}`);
  const byBranch = new Map((branches || []).filter((r) => r.market_code).map((r) => [String(r.brn_id), r.market_code]));
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    const [{ data: leads, error: lErr }, { data: assigned, error: aErr }] = await Promise.all([
      supabase.from('lp_leads').select('lp_lead_id, lp_branch_id').in('lp_lead_id', part),
      supabase.from('lp_lead_market_assignments').select('lead_id, resolved_market_code').in('lead_id', part),
    ]);
    if (lErr) throw new Error(`lead branch read failed: ${lErr.message}`);
    if (aErr) throw new Error(`market assignment read failed: ${aErr.message}`);
    for (const r of assigned || []) if (r.resolved_market_code) out.set(String(r.lead_id), r.resolved_market_code);
    for (const l of leads || []) {
      const m = byBranch.get(String(l.lp_branch_id));
      if (m) out.set(String(l.lp_lead_id), m);
    }
  }
  return out;
}

/**
 * The call center's work per office for one window (the user, 2026-10-19:
 * each charge goes to the office of the leads it was for). The SAME events
 * payroll pays LightFire for (src/payroll/rules.js buildLightFireEvents, an
 * "- LF" agent), with the age split of its pay rules (agedDays, default 30):
 *   canvass  canvass appointments confirmed, counted
 *   demo     demos on AGED leads (created 30+ days before the set), counted
 *   sales    net WHOLE dollars RTP'd on NEW leads (report 134), the 1.5% basis
 *            (whole dollars, not cents: the card prints "$41,827 of $179,513 in
 *            sales", and issued_basis is an integer; 2026-10-19 the user could
 *            not read "4182700/17951276 issued")
 * A sale takes the market report 134 prints for the job, else its lead's.
 * Checked against the August invoices: canvass 194 of 194 (8/23-8/31), demos
 * 9-13 of the 12-17 billed a week, sales $179,513 of $169,254 (8/1-8/15):
 * close enough to set the offices' shares, never the amount, which is the invoice's.
 */
export async function callCenterWorkByMarketFor({ kind, from, to }, { supabase = supabaseDefault, store = null, env = process.env } = {}) {
  const st = store || createPayrollStore({ supabase });
  const period = { start: from, end: to };
  const aged = agedDays(env);
  const isAged = (ev) => { const d = daysBetween(ev.lead_created_date, ev.set_date); return d == null ? null : d >= aged; };
  let events;
  const jobMarket = new Map();
  if (kind === 'canvass') {
    events = buildLightFireEvents({ canvassLeads: await st.loadCanvassConfirms(period), period })
      .filter((ev) => ev.event_type === EVENT_CANVASS_CONFIRM && isLightFireAgent(ev.agent_name));
  } else if (kind === 'demo') {
    events = buildLightFireEvents({ demoLeads: await st.loadDemos(period), period })
      .filter((ev) => ev.event_type === EVENT_DEMO && isLightFireAgent(ev.agent_name) && isAged(ev) === true);
  } else if (kind === 'sales') {
    const net = await st.load134(period);
    const matches = await st.matchJobsToLeads(net.rows.map((r) => r.job_number));
    const netJobs = [];
    for (const row of net.rows) {
      const m = matches.get(String(row.job_number));
      if (!m?.lead) continue;
      netJobs.push({ ...row, lead: m.lead });
      if (row.market) jobMarket.set(String(row.job_number), row.market);
    }
    events = buildLightFireEvents({ netJobs, period })
      .filter((ev) => ev.event_type === EVENT_DIRECT_NET && isLightFireAgent(ev.agent_name) && isAged(ev) === false && ev.basis_cents > 0);
  } else {
    throw new Error(`call-center work: unknown kind "${kind}"`);
  }
  const leadMarket = await marketsForLeads(events.map((ev) => ev.lp_lead_id), { supabase });
  const out = {};
  for (const ev of events) {
    const m = jobMarket.get(String(ev.job_number)) || leadMarket.get(String(ev.lp_lead_id));
    if (!m) continue;
    out[m] = (out[m] || 0) + (kind === 'sales' ? ev.basis_cents / 100 : 1);
  }
  if (kind === 'sales') for (const m of Object.keys(out)) out[m] = Math.round(out[m]);
  return out;
}

/**
 * Dollars the call center bills per unit of a kind's weight, from its active
 * pay_rules (the same table payroll pays it from): a demo / canvass
 * confirmation's amount_cents, or the sales pct (dollars per dollar of sales).
 * The newest rule wins whatever its start date (the August invoices predate the
 * 2026-09-01 rules at the same rates). Unreadable → null: no dispute can be told,
 * so the line is split by what was found, as before.
 */
const KIND_EVENT = { canvass: EVENT_CANVASS_CONFIRM, demo: EVENT_DEMO, sales: EVENT_DIRECT_NET };
export async function callCenterUnitPrice(kind, { supabase = supabaseDefault } = {}) {
  const event = KIND_EVENT[kind];
  if (!event) return null;
  try {
    const { data, error } = await supabase.from('pay_rules').select('amount_cents, pct, effective_from')
      .eq('payee_type', 'partner').eq('event_type', event).eq('active', true)
      .order('effective_from', { ascending: false }).limit(1);
    if (error || !data?.length) return null;
    const r = data[0];
    if (kind === 'sales') return r.pct != null && Number(r.pct) > 0 ? Number(r.pct) : null;
    return r.amount_cents != null && Number(r.amount_cents) > 0 ? Number(r.amount_cents) / 100 : null;
  } catch {
    return null;
  }
}

/** Last day of the calendar month a YYYY-MM-01 starts. */
function monthLastDay(month) {
  const start = `${String(month).slice(0, 7)}-01`;
  return new Date(Date.UTC(+start.slice(0, 4), +start.slice(5, 7), 0)).toISOString().slice(0, 10);
}

/**
 * Compute (not write) the allocation rows for an expense. Reads one issued
 * count set per month slice, over the slice's WHOLE calendar month (D1; see
 * allocation.js), then hands a sync lookup to the pure allocator. An expense
 * with no markets picked reads them too: its sub-source's issued leads pick
 * the markets (the user, 2026-10-13).
 */
export async function previewAllocation(expense, deps = {}) {
  const slices = splitPeriodByMonth(expense.period_start, expense.period_end, expense.amount);
  const counts = {};
  const workKind = callCenterLineKind(expense);
  if (workKind) {
    // The slice's own days, not its whole month: the invoice bills one week's work.
    // The unit price lets the allocator see a line billed for more than was found.
    const unitPrice = await callCenterUnitPrice(workKind, deps);
    for (const s of slices) counts[s.month] = { weights: await callCenterWorkByMarketFor({ kind: workKind, from: s.start, to: s.end }, deps), unitPrice };
    return allocateExpense(expense, (month) => counts[month] || {});
  }
  const holdOnly = (expense.eligible_markets || []).length === 1 && expense.eligible_markets[0] === HOLD_MARKET;
  if (!holdOnly && !splitsEvenly(expense) && ((expense.eligible_markets || []).length > 1 || splitsBySource(expense))) {
    for (const s of slices) {
      counts[s.month] = await issuedByMarketFor({ from: s.month, to: monthLastDay(s.month), subSources: expense.lp_sub_sources }, deps);
    }
  }
  return allocateExpense(expense, (month) => counts[month] || {});
}

export async function deleteAllocations(expenseId, { supabase = supabaseDefault } = {}) {
  const { error } = await supabase.from('marketing_expense_allocations').delete().eq('expense_id', expenseId);
  if (error) throw new Error(`delete allocations failed: ${error.message}`);
}

/**
 * Replace an expense's allocations. Returns { ok, rows, skipped?, error? }.
 * Never throws for a business reason (a non-approved row is `skipped`); a
 * database failure throws so the caller's job records it.
 */
export async function allocateExpenseById(expenseId, deps = {}) {
  const supabase = deps.supabase || supabaseDefault;
  const { data: expense, error } = await supabase.from('marketing_expenses').select('*').eq('id', expenseId).maybeSingle();
  if (error) throw new Error(`read expense failed: ${error.message}`);
  if (!expense) return { ok: false, error: 'not_found' };
  if (expense.status !== 'approved') {
    await deleteAllocations(expenseId, deps);
    return { ok: true, skipped: expense.status, rows: [] };
  }
  const rows = await previewAllocation(expense, deps);
  await deleteAllocations(expenseId, deps);
  const insert = rows.map((r) => ({
    expense_id: expenseId, month: r.month, market: r.market, lp_sub_source: r.lp_sub_source,
    rule: r.rule, issued_basis: r.issued_basis, issued_total: r.issued_total, amount: r.amount,
    recommended_market: null, recommendation_reason: r.note || null,
  }));
  if (insert.length) {
    const { error: insErr } = await supabase.from('marketing_expense_allocations').insert(insert);
    if (insErr) throw new Error(`insert allocations failed: ${insErr.message}`);
  }
  return { ok: true, rows };
}

/**
 * Write allocations for an expense from rows the CALLER computed (the Lead
 * Gurus true-up splits a single invoice total by feed share, not by issued
 * leads). Still asserts the sum.
 */
export async function writeAllocations(expenseId, rows, { supabase = supabaseDefault } = {}) {
  const cents = (n) => Math.round(Number(n) * 100);
  const { data: expense, error } = await supabase.from('marketing_expenses').select('id, amount').eq('id', expenseId).maybeSingle();
  if (error || !expense) throw new Error(`read expense failed: ${error?.message || 'not_found'}`);
  const sum = rows.reduce((a, r) => a + cents(r.amount), 0);
  if (sum !== cents(expense.amount)) throw new Error(`allocation: expense ${expenseId} rows ${sum} ≠ amount ${cents(expense.amount)} cents`);
  await deleteAllocations(expenseId, { supabase });
  const { error: insErr } = await supabase.from('marketing_expense_allocations').insert(rows.map((r) => ({ ...r, expense_id: expenseId })));
  if (insErr) throw new Error(`insert allocations failed: ${insErr.message}`);
}

/**
 * Re-run every expense that touches a month (nightly, and after a backfill).
 * Rows are re-run one by one so a single bad row cannot roll back the month.
 */
export async function reallocateMonth(month, deps = {}) {
  const supabase = deps.supabase || supabaseDefault;
  const start = `${String(month).slice(0, 7)}-01`;
  const end = new Date(Date.UTC(+start.slice(0, 4), +start.slice(5, 7), 0)).toISOString().slice(0, 10);
  const { data, error } = await supabase.from('marketing_expenses').select('id, status')
    .lte('period_start', end).gte('period_end', start).in('status', ['approved', 'superseded', 'rejected', 'pending_review']);
  if (error) throw new Error(`list expenses failed: ${error.message}`);
  const out = { month: start, total: (data || []).length, allocated: 0, cleared: 0, failed: 0, errors: [] };
  for (const e of data || []) {
    try {
      const r = await allocateExpenseById(e.id, deps);
      if (r.skipped) out.cleared++; else if (r.ok) out.allocated++;
    } catch (err) {
      out.failed++;
      out.errors.push(`${e.id}: ${err.message}`);
      console.error(`${LOG} reallocate ${e.id} failed: ${err.message}`);
    }
  }
  return out;
}

/**
 * The "sum of allocations = amount" reconciliation (handoff §11.2). Returns
 * the failing expenses; an empty array is the acceptance condition.
 */
export async function reconcileAllocations({ supabase = supabaseDefault } = {}) {
  const { data: expenses, error } = await supabase.from('marketing_expenses').select('id, amount, status').eq('status', 'approved');
  if (error) throw new Error(`reconcile read failed: ${error.message}`);
  const { data: allocs, error: aErr } = await supabase.from('marketing_expense_allocations').select('expense_id, amount');
  if (aErr) throw new Error(`reconcile read allocations failed: ${aErr.message}`);
  const sums = {};
  for (const a of allocs || []) sums[a.expense_id] = (sums[a.expense_id] || 0) + Math.round(Number(a.amount) * 100);
  return (expenses || [])
    .filter((e) => (sums[e.id] || 0) !== Math.round(Number(e.amount) * 100))
    .map((e) => ({ id: e.id, amount: Number(e.amount), allocated: (sums[e.id] || 0) / 100 }));
}
