/**
 * test-ghl-shared-budget.js — the shared GHL request budget counter.
 *
 * WHY IT EXISTS. LP-MCP and HL-MCP each run a token bucket against the SAME GHL
 * location (65/min and 60/min as of 2026-09-14) and neither can see the other,
 * so every ceiling decision has been a guess. Measured after #927 brought 25
 * ungoverned call sites into LP-MCP's bucket: ~80 `acquireToken timed out after
 * 30000ms` lines in 35 minutes at queue depths 9-23, all `tokens=0,
 * paused=false`, and ZERO 429s. The bucket throttles below real demand while
 * the limit it defends against never fires. ghl-rate-limiter.js's own header
 * says not to exceed ~60-70 without confirming the shared sustained limit —
 * this module is that confirmation.
 *
 * THE PROPERTY THAT MATTERS MOST is that a measurement can never hurt the thing
 * it measures. A counter that throws, blocks, or double-counts is worse than no
 * counter, so most of what follows is about failure rather than happy path.
 */

process.env.GHL_SHARED_BUDGET_MODE = 'shadow';
process.env.GHL_BUDGET_SERVICE_NAME = 'lp-mcp-test';

import test from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../src/ghl-shared-budget.js');
const {
  recordGhlRequest, flushSharedBudget, readCombinedRate,
  minuteBucket, sharedBudgetMode, __testing,
} = mod;

const reset = () => __testing.pending.clear();

/** A Supabase-shaped stub that records what it was asked to insert. */
function stubClient({ insertError = null, selectRows = [], selectError = null } = {}) {
  const calls = { inserted: [] };
  return {
    calls,
    from: () => ({
      insert: async (rows) => { calls.inserted.push(...rows); return { error: insertError }; },
      select: () => ({ gte: async () => ({ data: selectRows, error: selectError }) }),
    }),
  };
}

// ═══════════════════════════════════════════════════════════════════
// Counting
// ═══════════════════════════════════════════════════════════════════

test('requests accumulate into minute buckets', () => {
  reset();
  const t = Date.parse('2026-09-14T19:07:12.000Z');
  recordGhlRequest(t);
  recordGhlRequest(t + 5000);        // same minute
  recordGhlRequest(t + 60000);       // next minute
  assert.equal(__testing.pending.get('2026-09-14T19:07:00.000Z'), 2);
  assert.equal(__testing.pending.get('2026-09-14T19:08:00.000Z'), 1);
});

test('minute buckets are truncated, not rounded', () => {
  assert.equal(minuteBucket(Date.parse('2026-09-14T19:07:59.999Z')), '2026-09-14T19:07:00.000Z');
  assert.equal(minuteBucket(Date.parse('2026-09-14T19:07:00.000Z')), '2026-09-14T19:07:00.000Z');
});

// ═══════════════════════════════════════════════════════════════════
// Flushing — and the ways it must fail safely
// ═══════════════════════════════════════════════════════════════════

test('a flush writes one row per bucket and drains them', async () => {
  reset();
  const t = Date.parse('2026-09-14T19:07:00.000Z');
  recordGhlRequest(t); recordGhlRequest(t); recordGhlRequest(t + 60000);

  const client = stubClient();
  const r = await flushSharedBudget({ client });

  assert.equal(r.written, 2);
  assert.equal(__testing.pending.size, 0, 'buckets must be drained after a write');
  assert.deepEqual(client.calls.inserted.map((x) => x.requests).sort(), [1, 2]);
  assert.ok(client.calls.inserted.every((x) => x.service === 'lp-mcp-test'));
});

test('a failed flush DROPS the window rather than double-counting it', async () => {
  // Deliberate: this is a measurement. A number inflated by a retry is worse
  // than a missing minute, because it would argue for a lower ceiling than the
  // evidence supports.
  reset();
  recordGhlRequest(Date.parse('2026-09-14T19:07:00.000Z'));

  const r = await flushSharedBudget({ client: stubClient({ insertError: { message: 'relation does not exist' } }) });
  assert.equal(r.written, 0);
  assert.match(r.error, /relation does not exist/);
  assert.equal(__testing.pending.size, 0, 'the window is dropped, not queued for retry');
});

test('a throwing client never propagates', async () => {
  reset();
  recordGhlRequest();
  const exploding = { from: () => { throw new Error('HL not configured'); } };
  const r = await flushSharedBudget({ client: exploding });
  assert.equal(r.written, 0);
  assert.match(r.error, /HL not configured/, 'the error is reported, not thrown');
});

test('flushing nothing is a no-op', async () => {
  reset();
  const client = stubClient();
  assert.deepEqual(await flushSharedBudget({ client }), { written: 0 });
  assert.equal(client.calls.inserted.length, 0, 'no empty inserts');
});

// ═══════════════════════════════════════════════════════════════════
// Reading — the number this exists to produce
// ═══════════════════════════════════════════════════════════════════

test('the combined rate sums BOTH services per minute', async () => {
  // The whole point: one number neither service can produce alone.
  const client = stubClient({ selectRows: [
    { minute_bucket: '2026-09-14T19:07:00.000Z', service: 'lp-mcp', requests: 62 },
    { minute_bucket: '2026-09-14T19:07:00.000Z', service: 'hl-mcp', requests: 55 },
    { minute_bucket: '2026-09-14T19:06:00.000Z', service: 'lp-mcp', requests: 40 },
  ] });

  const r = await readCombinedRate({ client });
  assert.equal(r.ok, true);
  assert.equal(r.peak_total_per_min, 117, '62 + 55 — neither bucket alone shows this');

  const newest = r.buckets[0];
  assert.equal(newest.minute_bucket, '2026-09-14T19:07:00.000Z', 'newest first');
  assert.equal(newest['lp-mcp'], 62);
  assert.equal(newest['hl-mcp'], 55);
  assert.equal(newest.total, 117);
});

test('an unreadable table reports it rather than claiming zero', async () => {
  // Reporting 0 req/min would read as "we have huge headroom" — the exact wrong
  // conclusion to draw from a broken read.
  const r = await readCombinedRate({ client: stubClient({ selectError: { message: 'permission denied' } }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /permission denied/);
  assert.deepEqual(r.buckets, []);
});

// ═══════════════════════════════════════════════════════════════════
// Off by default
// ═══════════════════════════════════════════════════════════════════

test('shadow is the only mode that does anything; there is no enforce', () => {
  assert.equal(sharedBudgetMode(), 'shadow');
  // No enforce branch exists on purpose: you cannot enforce against a number
  // you have not measured yet, and a dead branch would be speculation.
  assert.ok(!('enforce' in mod), 'no enforcement surface is exported');
});

test('mode off means no counting at all', async () => {
  // Verified in a child process so the module re-reads env at import time.
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, ['-e', `
    process.env.GHL_SHARED_BUDGET_MODE = 'off';
    import('./src/ghl-shared-budget.js').then((m) => {
      m.recordGhlRequest();
      m.recordGhlRequest();
      console.log(JSON.stringify({ mode: m.sharedBudgetMode(), pending: m.__testing.pending.size }));
    });
  `], { cwd: process.cwd(), encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out.trim()), { mode: 'off', pending: 0 });
});
