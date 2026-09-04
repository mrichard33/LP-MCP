#!/usr/bin/env node
/**
 * LP result-set paging — scripts/test-lp-paging.js
 *
 * Covers WO-13: LP's StartIndex is a 1-based PAGE index, not a row offset.
 *
 * The fake LP below implements BOTH readings so the walker can be tested
 * against each. The point of the suite is not that page mode is faster — it is
 * that the walker returns EVERY ROW EXACTLY ONCE under either server, and only
 * adopts page mode when it has proved the two addressings agree.
 *
 * The contract:
 *   1. Page-index server: every row returned once, in order, at ~N/pageSize calls.
 *   2. Row-offset server: page mode is never adopted, behaviour is unchanged.
 *   3. A server that serves a DIFFERENT record under page addressing is refused
 *      outright — this is the skipped-rows guard, and it is the whole reason
 *      the inference is safe to ship.
 *   4. A genuinely empty window terminates without claiming page mode.
 *   5. A result set that fits in one page never probes at all.
 *   6. Deep fallback still returns every row when page mode is refused.
 *   7. An LP error retries once smaller, then propagates.
 *
 * Run: node scripts/test-lp-paging.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPageWalker, PAGING_MODE } from '../src/lp-paging.js';

const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));
const idOf = (r) => r.id;

// StartIndex is a 1-based PAGE index — the real LP behaviour WO-13 identified.
function pageIndexServer(total) {
  const all = rows(total);
  return async ({ PageSize, StartIndex }) => {
    const start = (StartIndex - 1) * PageSize;
    return all.slice(start, start + PageSize);
  };
}

// StartIndex is a 1-based ROW offset — what the code used to assume.
function rowOffsetServer(total) {
  const all = rows(total);
  return async ({ PageSize, StartIndex }) => all.slice(StartIndex - 1, StartIndex - 1 + PageSize);
}

async function drain(walker, cap = 10000) {
  const seen = [];
  for (let i = 0; i < cap; i++) {
    const { items, done } = await walker.next();
    if (done) break;
    seen.push(...items);
  }
  return seen;
}

// ─── 1. Page-index server: every row once, at page cost ──────────────────────
test('page-index LP: returns every row exactly once and adopts page mode', async () => {
  const walker = createPageWalker({ fetch: pageIndexServer(175), pageSize: 50, idOf, label: '[t]' });
  const seen = await drain(walker);

  assert.deepEqual(seen.map(idOf), rows(175).map(idOf), 'every row, in order, no gaps or repeats');
  assert.equal(walker.stats.mode, PAGING_MODE.PAGE);
  assert.ok(walker.stats.apiCalls < 20,
    `expected page-cost paging, got ${walker.stats.apiCalls} calls (old behaviour was 128)`);
});

// ─── 2. Row-offset server: unchanged, page mode never claimed ────────────────
// If the WO-13 inference is wrong for some endpoint, that endpoint must keep
// working exactly as it does today.
test('row-offset LP: pages normally and never claims page mode', async () => {
  const walker = createPageWalker({ fetch: rowOffsetServer(175), pageSize: 50, idOf, label: '[t]' });
  const seen = await drain(walker);

  assert.deepEqual(seen.map(idOf), rows(175).map(idOf));
  assert.notEqual(walker.stats.mode, PAGING_MODE.PAGE, 'a row-offset server must never be read as page-indexed');
});

// ─── 3. THE GUARD: disagreeing server is refused ─────────────────────────────
// A server that serves rows under page addressing but a DIFFERENT record than
// the row probe would cause silent row loss. The walker must refuse it.
test('refuses page mode when the two addressings disagree, and still returns every row', async () => {
  const all = rows(175);
  // Page addressing here is offset by a page — first row of "page 2" is row 101,
  // not row 51. Adopting it would skip rows 51..100.
  const treacherous = async ({ PageSize, StartIndex }) => {
    if (PageSize === 1) return all.slice(StartIndex - 1, StartIndex);       // row offset
    if (StartIndex === 1) return all.slice(0, PageSize);                     // page 1 agrees
    if (StartIndex > 40) return [];                                          // the empty-page symptom
    return all.slice(StartIndex * PageSize, StartIndex * PageSize + PageSize); // shifted by one page
  };

  const walker = createPageWalker({ fetch: treacherous, pageSize: 50, idOf, label: '[t]' });
  const seen = await drain(walker);

  assert.notEqual(walker.stats.mode, PAGING_MODE.PAGE, 'disagreement MUST refuse page mode');
  assert.deepEqual(seen.map(idOf), all.map(idOf), 'and no row may be skipped by the fallback');
});

// ─── 4. Empty window ─────────────────────────────────────────────────────────
test('an empty window terminates immediately without claiming page mode', async () => {
  const walker = createPageWalker({ fetch: pageIndexServer(0), pageSize: 50, idOf, label: '[t]' });
  const seen = await drain(walker);

  assert.deepEqual(seen, []);
  assert.equal(walker.stats.mode, PAGING_MODE.NORMAL);
});

// ─── 5. Single short page — the common case — costs no probe ─────────────────
test('a result set smaller than one page needs no probing', async () => {
  const walker = createPageWalker({ fetch: pageIndexServer(12), pageSize: 50, idOf, label: '[t]' });
  const seen = await drain(walker);

  assert.equal(seen.length, 12);
  // One call returns the 12 rows; the next returns empty; one row probe confirms the end.
  assert.ok(walker.stats.apiCalls <= 3, `expected a cheap exit, got ${walker.stats.apiCalls}`);
});

// ─── 6. Exact page boundary ──────────────────────────────────────────────────
// Total is an exact multiple of the page size, so the "is there more?" question
// is decided entirely by the probe. A regression here loses the last page or
// loops forever.
test('a result set that is an exact multiple of the page size terminates cleanly', async () => {
  const walker = createPageWalker({ fetch: pageIndexServer(100), pageSize: 50, idOf, label: '[t]' });
  const seen = await drain(walker);
  assert.deepEqual(seen.map(idOf), rows(100).map(idOf));
});

// ─── 7. Errors: one reduced-size retry, then propagate ───────────────────────
test('a failing page retries once smaller before giving up', async () => {
  const sizes = [];
  let calls = 0;
  const flaky = async ({ PageSize }) => {
    sizes.push(PageSize);
    if (++calls === 1) throw new Error('LP API 500');
    return rows(5);
  };
  const walker = createPageWalker({ fetch: flaky, pageSize: 50, idOf, label: '[t]' });
  const { items } = await walker.next();

  assert.equal(items.length, 5);
  assert.deepEqual(sizes, [50, 12], 'retry is at a quarter of the page size');
});

test('a page that fails twice propagates so the caller can record truncation', async () => {
  const alwaysDown = async () => { throw new Error('LP API 500'); };
  const walker = createPageWalker({ fetch: alwaysDown, pageSize: 50, idOf, label: '[t]' });
  await assert.rejects(() => walker.next(), /LP API 500/);
});

// ─── 8. onFetch runs before every round trip ─────────────────────────────────
// capacity-sweep yields to its fast pass between LP calls; the walker must not
// starve it by making several calls back to back.
test('onFetch is awaited before every LP call', async () => {
  let yields = 0;
  const walker = createPageWalker({
    fetch: pageIndexServer(175), pageSize: 50, idOf, label: '[t]',
    onFetch: async () => { yields++; },
  });
  await drain(walker);
  assert.equal(yields, walker.stats.apiCalls, 'one yield per LP call, including probes');
});
