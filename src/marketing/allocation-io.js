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
import { allocateExpense, splitPeriodByMonth, splitsBySource, HOLD_MARKET } from './allocation.js';

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
  const holdOnly = (expense.eligible_markets || []).length === 1 && expense.eligible_markets[0] === HOLD_MARKET;
  if (!holdOnly && ((expense.eligible_markets || []).length > 1 || splitsBySource(expense))) {
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
