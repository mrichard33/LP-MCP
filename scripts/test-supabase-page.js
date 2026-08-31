/**
 * scripts/test-supabase-page.js
 *
 * Unit coverage for src/supabase-page.js — the guard against a Supabase read
 * that returns a plausible-looking subset of the rows it was asked for.
 *
 * The bug these tests pin down is not hypothetical. scripts/reconcile-p2-stages.js
 * shipped its first draft with an unpaginated chunked read, got one
 * lp_job_milestones row in six, and produced a summary whose every number
 * looked reasonable. The most important test here is the one where the
 * SERVER'S CAP IS SMALLER THAN THE REQUESTED PAGE SIZE: the obvious pager
 * ("stop when a page comes back short") is correct only while the cap happens
 * to equal the page size, and fails silently the moment it doesn't.
 *
 * Pure-function test against a fake client — no DB, no network.
 * Run: node --test scripts/test-supabase-page.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { selectAllIn, selectAllPaged, assertComplete } from '../src/supabase-page.js';

/**
 * A fake PostgREST that behaves like the real one: it honours .range(), caps
 * every response at `serverCap` rows however wide the range, and reports the
 * exact total in `count`.
 */
function fakeClient(rowsByTable, { serverCap = 1000, omitCount = false } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const state = { table, filters: [], order: null, range: null };
      const builder = {
        select() { return builder; },
        in(column, values) {
          state.filters.push((r) => values.map(String).includes(String(r[column])));
          return builder;
        },
        not(column, _op, _value) {
          state.filters.push((r) => r[column] !== null && r[column] !== undefined);
          return builder;
        },
        order(col, { ascending }) { state.order = { col, ascending }; return builder; },
        range(from, to) {
          state.range = { from, to };
          return Promise.resolve(result());
        },
      };
      function result() {
        const all = (rowsByTable[table] || []).filter((r) => state.filters.every((f) => f(r)));
        if (state.order) {
          const c = state.order.col;
          if (all.some((r) => r[c] === undefined)) {
            return { data: null, error: { message: `column ${table}.${c} does not exist` }, count: null };
          }
          all.sort((a, b) => (String(a[c]) > String(b[c]) ? 1 : -1));
        }
        const { from, to } = state.range;
        const width = to - from + 1;
        const page = all.slice(from, from + Math.min(width, serverCap));
        calls.push({ table, from, to, returned: page.length });
        return { data: page, error: null, count: omitCount ? null : all.length };
      }
      return builder;
    },
  };
}

const rows = (n, table = 'x', key = 'id') =>
  Array.from({ length: n }, (_, i) => ({ [key]: String(i).padStart(6, '0'), table, group: String(i % 4) }));

// ─── the failure that motivated the module ──────────────────────────────

test('a read larger than one page returns every row, not the first page', () => {
  const client = fakeClient({ lp_jobs: rows(5892, 'lp_jobs') });
  return selectAllPaged(client, 'lp_jobs', { columns: '*', orderBy: 'id' })
    .then((out) => assert.equal(out.length, 5892));
});

test('THE ONE THAT MATTERS: a server cap SMALLER than the page size still reads everything', async () => {
  // The naive pager asks for 1,000, gets 500, concludes "short page, must be
  // the end" and returns half the data with no error. Advancing by rows
  // actually received is what makes this correct for any cap.
  const client = fakeClient({ lp_jobs: rows(5892, 'lp_jobs') }, { serverCap: 500 });
  const out = await selectAllPaged(client, 'lp_jobs', { columns: '*', orderBy: 'id' });
  assert.equal(out.length, 5892);
});

test('a cap of 1 still terminates and still reads everything', async () => {
  const client = fakeClient({ tiny: rows(7, 'tiny') }, { serverCap: 1 });
  assert.equal((await selectAllPaged(client, 'tiny', { columns: '*', orderBy: 'id' })).length, 7);
});

test('an exactly-full final page does not lose or duplicate rows', async () => {
  const client = fakeClient({ exact: rows(2000, 'exact') }, { serverCap: 1000 });
  const out = await selectAllPaged(client, 'exact', { columns: '*', orderBy: 'id' });
  assert.equal(out.length, 2000);
  assert.equal(new Set(out.map((r) => r.id)).size, 2000);
});

// ─── chunked IN reads ───────────────────────────────────────────────────

test('an IN read spanning many chunks AND many pages returns every row', async () => {
  // 600 keys at 200 per chunk, each chunk far exceeding one page.
  const data = [];
  for (let k = 0; k < 600; k++) {
    for (let j = 0; j < 10; j++) data.push({ id: `${k}-${j}`, lp_job_id: String(k) });
  }
  const client = fakeClient({ lp_job_milestones: data }, { serverCap: 1000 });
  const out = await selectAllIn(client, 'lp_job_milestones', {
    columns: '*', orderBy: 'id', column: 'lp_job_id',
    values: Array.from({ length: 600 }, (_, k) => String(k)),
  });
  assert.equal(out.length, 6000);
  assert.equal(new Set(out.map((r) => r.id)).size, 6000);
});

test('an empty key list reads nothing rather than reading everything', async () => {
  // .in(col, []) matching nothing is the safe reading, but skipping the round
  // trip entirely is what stops an empty list from becoming an unfiltered scan.
  const client = fakeClient({ lp_jobs: rows(10, 'lp_jobs') });
  assert.deepEqual(await selectAllIn(client, 'lp_jobs', {
    columns: '*', orderBy: 'id', column: 'lp_job_id', values: [],
  }), []);
  assert.equal(client.calls.length, 0);
});

test('a refine filter is applied to every page of every chunk', async () => {
  const data = rows(3000, 'lp_job_milestones').map((r, i) => ({ ...r, act_date: i % 2 ? '2026-01-01' : null }));
  const client = fakeClient({ lp_job_milestones: data }, { serverCap: 400 });
  const out = await selectAllIn(client, 'lp_job_milestones', {
    columns: '*', orderBy: 'id', column: 'group', values: ['0', '1', '2', '3'],
    refine: (q) => q.not('act_date', 'is', null),
  });
  assert.equal(out.length, 1500);
  assert.ok(out.every((r) => r.act_date));
});

// ─── refusals ───────────────────────────────────────────────────────────

test('a missing orderBy is refused, not defaulted', async () => {
  const client = fakeClient({ lp_jobs: rows(5) });
  await assert.rejects(
    () => selectAllPaged(client, 'lp_jobs', { columns: '*' }),
    /needs an orderBy/,
  );
});

test('orderBy is not defaulted to id, because some tables have no id', async () => {
  // lp_prospects is keyed on lp_prospect_id and has no id column at all. A
  // hardcoded default throws here; naming the key is the caller's job.
  const client = fakeClient({ lp_prospects: [{ lp_prospect_id: 'p1', ghl_contact_id: 'c1' }] });
  await assert.rejects(
    () => selectAllPaged(client, 'lp_prospects', { columns: '*', orderBy: 'id' }),
    /does not exist/,
  );
  const out = await selectAllPaged(client, 'lp_prospects', { columns: '*', orderBy: 'lp_prospect_id' });
  assert.equal(out.length, 1);
});

test('a server that reports no exact count is refused, never trusted', async () => {
  const client = fakeClient({ lp_jobs: rows(50) }, { omitCount: true });
  await assert.rejects(
    () => selectAllPaged(client, 'lp_jobs', { columns: '*', orderBy: 'id' }),
    /completeness cannot be verified/,
  );
});

test('assertComplete passes a whole read and throws on a truncated one', () => {
  assert.doesNotThrow(() => assertComplete('agent_rules', rows(12), 12));
  assert.throws(() => assertComplete('agent_rules', rows(1000), 1512), /truncated: got 1000 of 1512/);
  assert.throws(() => assertComplete('agent_rules', rows(12), undefined), /no exact row count/);
});
