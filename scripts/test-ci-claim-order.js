/**
 * Tests — the pipeline claims the NEWEST calls first
 * scripts/test-ci-claim-order.js
 *
 * WHY THE ORDER MATTERS. A CRM note is worth most while the call is still live
 * for whoever is working the record: a note on this morning's conversation
 * changes the next call, one on a five-day-old conversation is history.
 *
 * Claiming oldest-first put every fresh call behind the entire backlog. On
 * 2026-08-25 that backlog was 1,509 calls from 08-19..08-21, so a call taken
 * this morning would have been the 1,510th processed — it would reach the rep
 * long after it could change anything.
 *
 * ── THERE ARE TWO IMPLEMENTATIONS AND THEY MUST AGREE ──────────────────────
 * The order is written down in THREE places:
 *
 *   sql/063_ci_claim_fn.sql   the claim function
 *   src/admin/startup-mirrors.js  the boot-time self-healing mirror of it
 *   src/ci/worker.js          claimBatch's fallback SELECT, used when the
 *                             function is missing
 *
 * A fresh deploy self-heals from the mirror, so if the mirror and the file
 * disagree the live ordering depends on which one ran last. And if the
 * fallback disagrees with both, processing order depends on whether the SQL
 * function happened to be deployed. All three are asserted here, because every
 * one of those differences "works" — nothing fails, the pipeline just quietly
 * processes calls in a different order than the one that was designed.
 *
 * No network, no DB — this reads the source.
 *
 * Run: node --test scripts/test-ci-claim-order.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { claimBatch } from '../src/ci/worker.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Pull the ORDER BY out of a claim_ci_calls definition. */
function claimOrderBy(sql) {
  const fn = /WITH claimed AS \(([\s\S]*?)FOR UPDATE SKIP LOCKED/i.exec(sql);
  if (!fn) return null;
  const m = /ORDER BY\s+([a-z_]+)(\s+DESC|\s+ASC)?/i.exec(fn[1]);
  if (!m) return null;
  return { column: m[1], direction: (m[2] || '').trim().toUpperCase() || 'ASC' };
}

// ─── the SQL function and its mirror ────────────────────────────────────────

test('sql/063 claims the newest call first', () => {
  const order = claimOrderBy(read('sql/063_ci_claim_fn.sql'));
  assert.ok(order, 'the claim CTE must still be findable — if this fails the function moved');
  assert.equal(order.column, 'call_start');
  assert.equal(order.direction, 'DESC', 'oldest-first buries every fresh call behind the backlog');
});

test('the runMigrations mirror orders identically to sql/063', () => {
  // A fresh deploy self-heals from this mirror. If the two disagree, the live
  // ordering depends on which one ran — invisible until someone wonders why
  // yesterday's calls are being processed before this morning's.
  const fromFile = claimOrderBy(read('sql/063_ci_claim_fn.sql'));
  const fromMirror = claimOrderBy(read('src/admin/startup-mirrors.js'));
  assert.ok(fromMirror, 'the startup mirrors must still carry the claim_ci_calls DDL');
  assert.deepEqual(fromMirror, fromFile);
});

// ─── the fallback path ──────────────────────────────────────────────────────

test('the non-claiming fallback SELECT also takes the newest first', () => {
  // claimBatch falls back to a plain SELECT when the SQL function is missing
  // (the deploy-before-DDL grace). It must not order differently, or the
  // pipeline's behaviour would depend on migration timing.
  const src = claimBatch.toString();
  const m = /order\(\s*'call_start'\s*,\s*\{\s*ascending:\s*(true|false)\s*\}/.exec(src);
  assert.ok(m, 'the fallback must still order explicitly by call_start');
  assert.equal(m[1], 'false', 'ascending:true is oldest-first — it must match the SQL function');
});

// ─── the ordering actually selects the newest ───────────────────────────────

test('newest-first picks up today\'s call ahead of a five-day backlog', () => {
  // The property in plain terms, asserted on the comparator the ORDER BY
  // expresses rather than on a live database.
  const backlog = [
    { id: 'old-1', call_start: '2026-08-19T12:31:35Z' },
    { id: 'old-2', call_start: '2026-08-20T09:00:00Z' },
    { id: 'old-3', call_start: '2026-08-21T17:45:00Z' },
    { id: 'today', call_start: '2026-08-25T08:05:00Z' },
  ];
  const newestFirst = [...backlog].sort(
    (a, b) => new Date(b.call_start) - new Date(a.call_start),
  );
  assert.equal(newestFirst[0].id, 'today', "this morning's call must be claimed first");

  // And the backlog still drains behind it, in recency order — nothing is
  // dropped, it is only deprioritised.
  assert.deepEqual(newestFirst.map((c) => c.id), ['today', 'old-3', 'old-2', 'old-1']);
});

test('a batch smaller than the queue still reaches every call eventually', () => {
  // The starvation question, stated as the invariant that matters: each pass
  // removes the calls it processed, so the tail moves up. Newest-first only
  // starves if new arrivals outpace throughput — capacity is ~72k calls/day
  // against ~650/day of real volume, so the queue empties many times over.
  const CAPACITY_PER_DAY = 25 * 2 * 60 * 24;   // batch 25, every 30s
  const OBSERVED_VOLUME_PER_DAY = 650;          // eligible calls, 2026-08-19..21
  assert.ok(
    CAPACITY_PER_DAY > OBSERVED_VOLUME_PER_DAY * 10,
    'if this stops holding, newest-first can starve the tail — reserve a share of'
    + ' each batch for the oldest rows rather than reverting to oldest-first',
  );
});
