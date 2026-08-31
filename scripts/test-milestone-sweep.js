#!/usr/bin/env node
/**
 * test-milestone-sweep.js — the milestone sweep's candidate walk.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-08-31 this sweep was firing nothing at all, and had been for as long
 * as the backlog had existed. Not crashing — firing zero, while logging a
 * cheerful "Milestones: 0 tags fired" every fifteen minutes. Three things had
 * to be true at once:
 *
 *   - the candidate query had no .limit()/.range(), so PostgREST silently
 *     handed back 1,000 of 27,668 rows;
 *   - it had no ORDER BY, so those 1,000 were heap order — the SAME 1,000 on
 *     every pass (measured: 100% overlap between consecutive reads);
 *   - a row is only marked ghl_tag_fired once a tag really lands, so the
 *     15,050 rows with no resolvable contact could never leave the set, and
 *     heap order had parked them in exactly the window being re-read.
 *
 * Each of those alone is survivable. Together they wedge the job shut.
 *
 * scripts/test-ghl-link-propagate.js already pins the one thing the fix must
 * NOT do (filter on ghl_contact_id — that would arm sql/075 to fire thousands
 * of historical tags). It does so against source text, because this module
 * builds its Supabase and GHL clients at import time.
 *
 * readCandidatePage() takes its client as an argument, which gives the walk a
 * real seam. These tests drive it with a fake PostgREST that honours .gt(),
 * .order() and .limit() and caps every response the way the real one does —
 * so the properties below are asserted by BEHAVIOUR, not by matching source.
 *
 *   node scripts/test-milestone-sweep.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readCandidatePage } from '../src/milestones.js';

const NOW = new Date('2026-08-31T00:00:00Z');

/**
 * A fake PostgREST that behaves like the real one in the ways that bit us:
 * it applies filters, it caps the response, and — critically — if you do not
 * order it, it returns rows in a stable "heap" order that is NOT id order.
 */
function fakeClient(rows, { cap = 1000 } = {}) {
  const calls = [];
  const q = {
    _filters: [], _order: null, _limit: null, _table: null,
    from(t) { this._table = t; calls.push({ table: t }); return this; },
    select() { return this; },
    not(col, op, val) { this._filters.push(['not', col, op, val]); return this; },
    gte(col, val) { this._filters.push(['gte', col, val]); return this; },
    lte(col, val) { this._filters.push(['lte', col, val]); return this; },
    eq(col, val) { this._filters.push(['eq', col, val]); return this; },
    gt(col, val) { this._filters.push(['gt', col, val]); return this; },
    order(col, opts) { this._order = { col, ascending: opts?.ascending !== false }; return this; },
    limit(n) {
      this._limit = n;
      let out = rows.filter((r) => this._filters.every(([kind, col, a]) => {
        if (kind === 'eq') return r[col] === a;
        if (kind === 'gt') return String(r[col]) > String(a);
        if (kind === 'gte') return String(r[col]) >= String(a);
        if (kind === 'lte') return String(r[col]) <= String(a);
        if (kind === 'not') return r[col] !== null && r[col] !== undefined;
        return true;
      }));
      if (this._order) {
        const { col, ascending } = this._order;
        out = [...out].sort((x, y) => (String(x[col]) < String(y[col]) ? -1 : String(x[col]) > String(y[col]) ? 1 : 0));
        if (!ascending) out.reverse();
      } // unordered => whatever order `rows` is in, stably (the heap-order bug)
      const capped = Math.min(n ?? cap, cap);
      return Promise.resolve({ data: out.slice(0, capped), error: null });
    },
    _snapshot() { return { filters: this._filters, order: this._order, limit: this._limit, table: this._table }; },
  };
  // A fresh builder per from(), like the real single-use builder.
  return {
    lastQuery: null,
    from(t) {
      const b = Object.create(q);
      b._filters = []; b._order = null; b._limit = null;
      this.lastQuery = b;
      return b.from(t);
    },
  };
}

const row = (id, over = {}) => ({
  id,
  lp_job_id: `job-${id}`,
  lp_lead_id: `lead-${id}`,
  ghl_contact_id: null,
  mdt_id: 'C',
  datetype: 'Completion',
  act_date: '2026-01-01T00:00:00Z',
  ghl_tag_fired: false,
  ...over,
});

const uuid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const UUID_MIN = uuid(0);

// ── the predicate ────────────────────────────────────────────────
test('eligibility is decided by act_date and ghl_tag_fired only — never by ghl_contact_id', async () => {
  const client = fakeClient([row(uuid(1))]);
  await readCandidatePage(client, { now: NOW, cursor: UUID_MIN });
  const cols = client.lastQuery._filters.map(([, col]) => col);
  assert.ok(cols.includes('act_date'), 'act_date must be in the predicate');
  assert.ok(cols.includes('ghl_tag_fired'), 'ghl_tag_fired must be in the predicate');
  assert.equal(
    cols.includes('ghl_contact_id'), false,
    'the sweep now filters on ghl_contact_id. sql/075_ghl_link_propagate.sql is only safe '
    + 'because the fire set does not depend on that column — adding this filter arms '
    + 'thousands of historical fires. See scripts/test-ghl-link-propagate.js.',
  );
});

test('unfired rows only — an already-fired row is not a candidate', async () => {
  const client = fakeClient([row(uuid(1)), row(uuid(2), { ghl_tag_fired: true })]);
  const { data } = await readCandidatePage(client, { now: NOW, cursor: UUID_MIN });
  assert.deepEqual(data.map(r => r.id), [uuid(1)]);
});

test('a future act_date is excluded server-side', async () => {
  const client = fakeClient([row(uuid(1)), row(uuid(2), { act_date: '2027-01-01T00:00:00Z' })]);
  const { data } = await readCandidatePage(client, { now: NOW, cursor: UUID_MIN });
  assert.deepEqual(data.map(r => r.id), [uuid(1)]);
});

// ── the walk ─────────────────────────────────────────────────────
test('the page is ORDERED by id — the absence of this is what wedged the sweep', async () => {
  const client = fakeClient([row(uuid(1))]);
  await readCandidatePage(client, { now: NOW, cursor: UUID_MIN });
  assert.deepEqual(client.lastQuery._order, { col: 'id', ascending: true });
});

test('the page is BOUNDED — an unbounded read is silently capped by PostgREST', async () => {
  const client = fakeClient([row(uuid(1))]);
  await readCandidatePage(client, { now: NOW, cursor: UUID_MIN, pageRows: 500 });
  assert.equal(client.lastQuery._limit, 500);
});

test('ordering rescues a queue whose heap order is all unfireable rows', async () => {
  // 12 unfireable rows sit at the head in heap order; the 3 fireable ones are
  // last. This is the shape of the real queue: dead rows clustered by heap
  // order, fireable rows unreachable behind them.
  const dead = Array.from({ length: 12 }, (_, i) => row(uuid(100 + i)));
  const live = [uuid(1), uuid(2), uuid(3)].map(id => row(id, { ghl_contact_id: `c-${id}` }));
  const client = fakeClient([...dead, ...live], { cap: 10 });

  const { data } = await readCandidatePage(client, { now: NOW, cursor: UUID_MIN });
  assert.equal(data.length, 10, 'the cap still applies — that is the point of paging');
  assert.deepEqual(
    data.slice(0, 3).map(r => r.id), [uuid(1), uuid(2), uuid(3)],
    'ordered by id, the fireable rows are reachable in the first page. Unordered, '
    + 'they sat behind 12 dead rows against a cap of 10 and could never be seen.',
  );
});

test('the cursor advances past unfireable rows instead of stopping at them', async () => {
  const rows = Array.from({ length: 25 }, (_, i) => row(uuid(i + 1)));
  const client = fakeClient(rows, { cap: 10 });

  const seen = [];
  let cursor = UUID_MIN;
  for (let i = 0; i < 5; i++) {
    const { data } = await readCandidatePage(client, { now: NOW, cursor });
    if (!data.length) break;
    seen.push(...data.map(r => r.id));
    cursor = data[data.length - 1].id;
  }
  assert.equal(seen.length, 25, 'every candidate is reached across pages');
  assert.equal(new Set(seen).size, 25, 'no row is returned twice');
  assert.deepEqual(seen, rows.map(r => r.id), 'and in id order');
});

test('KEYSET, NOT OFFSET — firing rows mid-walk must not make the walk skip', async () => {
  // The walk mutates its own result set: firing a row sets ghl_tag_fired and
  // drops it from the filter. Under .range(from, …) the next window would
  // slide by exactly the number fired and step over unread rows. A cursor on
  // id is immune, so this asserts the filter is a `gt` on id.
  const rows = Array.from({ length: 20 }, (_, i) => row(uuid(i + 1)));
  const client = fakeClient(rows, { cap: 10 });

  const first = await readCandidatePage(client, { now: NOW, cursor: UUID_MIN });
  const gtFilter = client.lastQuery._filters.find(([kind, col]) => kind === 'gt' && col === 'id');
  assert.ok(gtFilter, 'the walk must advance by a keyset cursor on id, not by offset');

  // Simulate the first page being fired (they leave the candidate set).
  for (const r of first.data) r.ghl_tag_fired = true;

  const second = await readCandidatePage(client, { now: NOW, cursor: first.data[first.data.length - 1].id });
  assert.deepEqual(
    second.data.map(r => r.id),
    rows.slice(10, 20).map(r => r.id),
    'rows 11-20 must follow rows 1-10. An offset cursor would have skipped to 21+ '
    + 'because the first ten had left the set.',
  );
});

test('an exhausted queue returns an empty page, which ends the walk', async () => {
  const client = fakeClient([row(uuid(1))]);
  const { data } = await readCandidatePage(client, { now: NOW, cursor: uuid(9) });
  assert.deepEqual(data, []);
});
