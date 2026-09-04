#!/usr/bin/env node
/**
 * Sync status classification + single-flight lock — WO-6 / PR A.
 *
 * WHAT THIS PINS
 *
 * The defect these tests exist for is a metric that lied. `failed_syncs`
 * counted container kills as sync failures: over the 48h to 2026-09-04,
 * 192 of 198 "failures" were SIGTERM rows written when Railway shut a
 * container down during a deploy, and 6 were real record failures. A 23%
 * failure rate that is really a deploy count is worse than no metric,
 * because it looks actionable and isn't.
 *
 * So the contract is:
 *   - a container kill lands as `interrupted`, never `failed`
 *   - a record failure still lands as `failed`
 *   - get_sync_health reports the three terminal states separately, and
 *     `failed_syncs` counts ONLY real failures
 *   - a worker that loses the sweep lock skips and leaves NO lp_sync_log row
 *   - the lock is held by lease, so a killed holder is superseded on expiry
 *     rather than needing a boot cleanup step
 *
 * TEST SHAPE
 *
 * Tests 1-4 are behavioural — they run the real functions against a
 * recording supabase stub. Two assertions are deliberately source-level
 * and labelled as such: the SIGTERM handler's wiring, and the lease
 * predicate inside the SQL acquire function. Both are one-line changes
 * that would silently restore the original defect while every behavioural
 * test still passed, which is exactly the kind of regression worth pinning
 * directly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ─── Seam ────────────────────────────────────────────────────────
// Same approach as test-child-sync-batching.js: force dummy env BEFORE
// importing src/supabase.js (it returns null without both vars, and a real
// SUPABASE_URL in the dev's shell must never reach this suite), then shadow
// `from` and `rpc` on the client instance. Every module holds the same
// object reference, so the stub is what runs.
process.env.SUPABASE_URL = 'http://sb.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
delete process.env.GHL_API_KEY;

// Network tripwire. Records rather than throws — an unhandled rejection from
// a background tick would kill the process.
const networkCalls = [];
globalThis.fetch = async (url) => {
  networkCalls.push(String(url));
  return {
    ok: false, status: 599, statusText: 'blocked-by-test',
    headers: { get: () => null }, text: async () => '', json: async () => ({}),
  };
};

const rec = createRecorder();

const supabase = (await import('../src/supabase.js')).default;
assert.ok(supabase, 'supabase client must exist — check the env writes above');
Object.defineProperty(supabase, 'from', {
  value: (table) => rec.from(table), writable: true, configurable: true,
});
Object.defineProperty(supabase, 'rpc', {
  value: (fn, args) => rec.rpc(fn, args), writable: true, configurable: true,
});

const {
  activeLogIds, syncLogFail, syncLogComplete,
  markRunningLogsAsInterrupted, markRunningLogsAsFailed, SYNC_STATUS,
} = await import('../src/sync-log.js');

const { acquireSyncLock } = await import('../src/sync-lock.js');

// ─── Recorder ────────────────────────────────────────────────────
// One from(table) call → one fresh thenable chain. The op is recorded in
// then(), so a chain built but never awaited is never counted.
function createRecorder() {
  const calls = [];
  const rpcCalls = [];
  const rpcReplies = new Map();  // fn → (args) => { data, error }
  const selectRows = new Map();  // table → rows returned by a non-head select
  const counts = new Map();      // table → exact-count reply

  function settle(s) {
    calls.push({ table: s.table, op: s.op, payload: s.payload, options: s.options, filters: s.filters });
    if (s.op === 'select') {
      if (s.options?.head) return { data: null, count: counts.get(s.table) ?? 0, error: null };
      const rows = selectRows.get(s.table) ?? [];
      return s.single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
    }
    return { data: s.op === 'insert' ? { id: `log-${calls.length}` } : null, error: null };
  }

  function from(table) {
    const s = { table, op: null, payload: null, options: null, filters: [], single: false };
    const chain = {
      select(cols, opts) { s.op ??= 'select'; if (opts) s.options = opts; return chain; },
      insert(p)    { s.op = 'insert'; s.payload = p; return chain; },
      upsert(p, o) { s.op = 'upsert'; s.payload = p; s.options = o ?? null; return chain; },
      update(p)    { s.op = 'update'; s.payload = p; return chain; },
      eq(c, v)     { s.filters.push(['eq', c, v]);  return chain; },
      in(c, v)     { s.filters.push(['in', c, v]);  return chain; },
      gt(c, v)     { s.filters.push(['gt', c, v]);  return chain; },
      lt(c, v)     { s.filters.push(['lt', c, v]);  return chain; },
      lte(c, v)    { s.filters.push(['lte', c, v]); return chain; },
      gte(c, v)    { s.filters.push(['gte', c, v]); return chain; },
      is(c, v)     { s.filters.push(['is', c, v]);  return chain; },
      not(c, o, v) { s.filters.push(['not', c, o, v]); return chain; },
      order(c, o)  { s.filters.push(['order', c, o]); return chain; },
      limit(n)     { s.filters.push(['limit', n]); return chain; },
      single()      { s.single = true; return chain; },
      maybeSingle() { s.single = true; return chain; },
      then(resolve, reject) { return Promise.resolve().then(() => settle(s)).then(resolve, reject); },
    };
    return chain;
  }

  async function rpc(fn, args) {
    rpcCalls.push({ fn, args });
    const reply = rpcReplies.get(fn);
    return reply ? reply(args) : { data: null, error: null };
  }

  return {
    from, rpc, calls, rpcCalls,
    ops: (t, op) => calls.filter(c => c.table === t && (!op || c.op === op)),
    setRpc: (fn, handler) => rpcReplies.set(fn, handler),
    setRows: (t, rows) => selectRows.set(t, rows),
    setCount: (t, n) => counts.set(t, n),
    reset() {
      calls.length = 0; rpcCalls.length = 0;
      rpcReplies.clear(); selectRows.clear(); counts.clear();
      activeLogIds.clear();
    },
  };
}

const updatesTo = (table) => rec.ops(table, 'update').map(c => c.payload);

// ─── 1. A container kill lands as `interrupted`, not `failed` ────

test('SIGTERM cleanup marks in-flight rows interrupted, never failed', async () => {
  rec.reset();
  activeLogIds.add('row-a');
  activeLogIds.add('row-b');

  await markRunningLogsAsInterrupted('SIGTERM — container terminated');

  const patches = updatesTo('lp_sync_log');
  assert.equal(patches.length, 1, 'one bulk update for all owned rows');
  assert.equal(patches[0].status, SYNC_STATUS.INTERRUPTED);
  assert.notEqual(patches[0].status, SYNC_STATUS.FAILED,
    'a container kill must never be written as a sync failure — this is the whole defect');
  assert.equal(patches[0].error_message, 'SIGTERM — container terminated',
    'the reason is preserved so the cause stays readable in the table');
  assert.ok(patches[0].completed_at, 'row must be closed, not left running');

  // Scoped to THIS process's rows — a shutting-down container must not
  // poison rows a freshly-booted one already owns.
  const [{ filters }] = rec.ops('lp_sync_log', 'update');
  assert.deepEqual(filters, [['in', 'id', ['row-a', 'row-b']]]);
});

test('SIGTERM/SIGINT handlers are wired to the interrupted path [source-level]', () => {
  // Pinned at source because flipping this one call back to
  // markRunningLogsAsFailed restores the original defect in full while
  // every behavioural test in this file still passes.
  const src = readFileSync(join(ROOT, 'src/sync-engine.js'), 'utf8');

  for (const sig of ['SIGTERM', 'SIGINT']) {
    const handler = src.slice(src.indexOf(`process.on('${sig}'`));
    const body = handler.slice(0, handler.indexOf('});'));
    assert.match(body, /markRunningLogsAsInterrupted/,
      `${sig} handler must mark rows interrupted`);
    assert.doesNotMatch(body, /markRunningLogsAsFailed/,
      `${sig} handler must not write rows as failed`);
  }

  // The boot reclaim of orphaned rows is the same infrastructure event one
  // boot later, and reclassifies with the rest.
  assert.match(
    src,
    /status: SYNC_STATUS\.INTERRUPTED, error_message: 'Stale lock — cleaned up on boot'/,
    'boot stale-row reclaim must also write interrupted'
  );
});

// ─── 2. A genuine record failure is still `failed` ───────────────

test('a real record-level failure still lands as failed', async () => {
  rec.reset();
  await syncLogFail('row-c', 12, '2 records failed');

  const patches = updatesTo('lp_sync_log');
  assert.equal(patches.length, 1);
  assert.equal(patches[0].status, SYNC_STATUS.FAILED,
    'record failures are the thing `failed` is FOR — they must not be softened');
  assert.equal(patches[0].error_message, '2 records failed');
  assert.equal(patches[0].records_synced, 12,
    'partial progress before the failure is retained');
});

test('a clean completion is still completed', async () => {
  rec.reset();
  await syncLogComplete('row-d', 500);
  assert.equal(updatesTo('lp_sync_log')[0].status, SYNC_STATUS.COMPLETED);
});

test('markRunningLogsAsFailed still exists and still writes failed', async () => {
  // Back-compat: the timeout path calls it deliberately, and a sweep that
  // blew its timeout IS a failure — only the signal handlers moved.
  rec.reset();
  activeLogIds.add('row-e');
  await markRunningLogsAsFailed('Sweep timed out');
  assert.equal(updatesTo('lp_sync_log')[0].status, SYNC_STATUS.FAILED);
});

// ─── 2b. The cursor must still see partial progress ──────────────

test('getLastSyncTimestamp still counts interrupted sweeps as partial progress', async () => {
  rec.reset();
  const { getLastSyncTimestamp } = await import('../src/sync-log.js');
  delete process.env.FORCE_SYNC_SINCE;
  await getLastSyncTimestamp();

  // Two lookups: completed-with-records, then partial progress.
  const selects = rec.ops('lp_sync_log', 'select');
  const partial = selects.find(s => s.filters.some(f => f[0] === 'in' && f[1] === 'status'));
  assert.ok(partial,
    'the partial-progress lookup must match a SET of statuses, not status=failed alone');
  const [, , statuses] = partial.filters.find(f => f[0] === 'in');
  assert.deepEqual(statuses.slice().sort(), ['failed', 'interrupted'],
    'a sweep killed mid-run after writing rows is the commonest partial-progress case there is — reclassifying it must not hide it from the cursor');
});

// ─── 3. get_sync_health counts the three states separately ───────

test('get_sync_health: failed counts only real failures, interrupted is separate', async () => {
  rec.reset();

  // A realistic 24h window from the incident: mostly clean, one burst of
  // deploy kills, one genuine record failure.
  const window = [
    ...Array.from({ length: 90 }, () => ({ entity_type: 'leads', records_synced: 10, status: 'completed' })),
    ...Array.from({ length: 18 }, () => ({ entity_type: 'leads', records_synced: 0,  status: 'interrupted' })),
    { entity_type: 'leads', records_synced: 3, status: 'failed' },
  ];
  rec.setRows('lp_sync_log', window);
  rec.setCount('lp_unmapped_sources', 7);
  rec.setCount('lp_job_milestones', 15487);
  rec.setCount('lp_leads', 195121);

  const { registerSyncTools } = await import('../src/tools/sync-tools.js');
  const handlers = {};
  registerSyncTools({ tool: (name, _d, _s, fn) => { handlers[name] = fn; } });
  assert.ok(handlers.get_sync_health, 'get_sync_health must be registered');

  const res = await handlers.get_sync_health();
  const out = JSON.parse(res.content[0].text);

  assert.equal(out.last_24h.failed, 1,
    'exactly one real record failure in the window');
  assert.equal(out.last_24h.interrupted, 18,
    'the 18 container kills are reported, separately');
  assert.equal(out.last_24h.completed, 90);
  assert.equal(out.last_24h.failed_syncs, 1,
    'the back-compat key must equal `failed` — NOT failed + interrupted, which is the old lying number (19)');
  assert.equal(out.last_24h.syncs_run, 109);
});

// ─── 4. Losing the lock means skip, and no log row ───────────────

test('a worker that loses the lock skips and writes no lp_sync_log row', async () => {
  rec.reset();
  // The acquire function RETURNs true on a win and no row on a loss.
  rec.setRpc('lp_acquire_sync_lock', () => ({ data: null, error: null }));

  const lock = await acquireSyncLock('lp_sync:sweep');
  assert.equal(lock.acquired, false, 'a live incumbent lease must block the acquire');
  assert.equal(lock.degraded, false, 'a clean loss is not a degraded acquire');

  assert.equal(rec.ops('lp_sync_log').length, 0,
    'a losing worker must leave NO trace in lp_sync_log — phantom rows are how the health metric got polluted in the first place');

  // Skip, never queue and never wait: exactly one acquire attempt, no retry
  // loop, no heartbeat timer started.
  assert.equal(rec.rpcCalls.filter(c => c.fn === 'lp_acquire_sync_lock').length, 1);
  assert.equal(lock._timer, null, 'no heartbeat may run for a lock we do not hold');
});

test('incrementalSync returns early and opens no rows when the lock is held', async () => {
  rec.reset();
  rec.setRpc('lp_acquire_sync_lock', () => ({ data: null, error: null }));

  const { incrementalSync } = await import('../src/sync-engine.js');
  const result = await incrementalSync();

  assert.equal(result, null, 'a skipped sweep returns null, it does not run');
  assert.equal(rec.ops('lp_sync_log', 'insert').length, 0,
    'the lock is acquired BEFORE syncLogStartAll, so a skip creates no rows');
});

// ─── 5. The lease supersedes a dead holder with no cleanup step ──

test('an expired lease is acquired cleanly, with no boot cleanup', async () => {
  rec.reset();
  // Postgres side: the incumbent holder was SIGKILLed, its lease has since
  // expired, so the ON CONFLICT ... WHERE lease_expires_at <= now() fires
  // and this caller wins.
  rec.setRpc('lp_acquire_sync_lock', () => ({ data: true, error: null }));

  const lock = await acquireSyncLock('lp_sync:sweep');
  assert.equal(lock.acquired, true);
  assert.equal(lock.degraded, false);

  assert.equal(rec.ops('lp_sync_log').length, 0,
    'acquiring after a kill must not require reclaiming rows first — that boot-cleanup dependency is what the lease replaces');
  assert.ok(lock._timer, 'a held lock heartbeats to extend its lease');

  await lock.release();
  assert.equal(lock._timer, null, 'release stops the heartbeat');
  const released = rec.rpcCalls.filter(c => c.fn === 'lp_release_sync_lock');
  assert.equal(released.length, 1);
  assert.equal(released[0].args.p_holder, lock.holder,
    'release is holder-scoped — a zombie must not release its successor\'s lock');
});

test('the lock is leased, not a boolean [source-level]', () => {
  // Pinned at source: the lease predicate IS the fix. Without the
  // `lease_expires_at <= now()` guard the acquire would steal a live lock;
  // without an expiry at all we are back to a lock that needs a clean
  // shutdown to release, which a SIGKILL never gives us.
  const sql = readFileSync(join(ROOT, 'sql/082_sync_interrupted_status_and_lease_lock.sql'), 'utf8');

  assert.match(sql, /WHERE lp_sync_lock\.lease_expires_at <= now\(\)/,
    'acquire must take the lock only when the incumbent lease has expired');
  assert.match(sql, /lease_expires_at\s+timestamptz NOT NULL/,
    'the lease expiry must be mandatory');
  assert.match(sql, /CREATE OR REPLACE FUNCTION lp_heartbeat_sync_lock/,
    'a live holder must be able to extend its lease');

  // The backfill must move rows, never delete them.
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+lp_sync_log/i,
    'the backfill reclassifies rows; it must never remove sync history');
});

test('a degraded acquire fails open rather than stopping all syncing', async () => {
  rec.reset();
  rec.setRpc('lp_acquire_sync_lock', () => ({ data: null, error: new Error('supabase unreachable') }));

  const lock = await acquireSyncLock('lp_sync:sweep');
  assert.equal(lock.acquired, true,
    'a Supabase outage must not become an LP data-freshness outage — the in-memory guard still holds within the process');
  assert.equal(lock.degraded, true, 'and it must say so');
  assert.equal(lock._timer, null, 'a degraded lock heartbeats nothing');
});

// ─── 6. Stale-lock rows are container kills too (WO-14/G2) ───────
//
// A row orphaned in `running` because its holder was killed hard enough that
// no handler ran is the SAME class of event as a SIGTERM row: infrastructure,
// never a data defect. It was still landing as `failed`, which is why
// get_sync_health kept reading 127 instead of single digits.

test('boot-time stale-row cleanup writes interrupted, not failed [source-level]', () => {
  const src = readFileSync(join(ROOT, 'src', 'sync-engine.js'), 'utf8');
  const idx = src.indexOf('Stale lock — cleaned up on boot');
  assert.ok(idx > 0, 'the stale-row cleanup must still exist');
  // The status is set in the same .update() literal as the message.
  const stmt = src.slice(Math.max(0, idx - 400), idx);
  assert.match(stmt, /SYNC_STATUS\.INTERRUPTED/,
    'an orphaned row is a container kill — classifying it failed is the metric defect WO-6 set out to end');
});

// ─── 7. The 085 backfill reclassifies history, and only history ──
//
// 082 fixed classification going forward and never backfilled. Measured
// 2026-09-04: 8,805 'Process terminated' + 2,298 'SIGTERM — container
// terminated' + 1,204 'Stale lock — cleaned up on boot' rows still sat in
// `failed`. The migration must move exactly those and nothing else — a
// backfill that also swallowed 'N records failed' would destroy the only
// number worth alerting on.

test('sql/085 backfills the three container-kill reasons and no others', () => {
  const sql = readFileSync(join(ROOT, 'sql', '085_sync_watermark_window_complete.sql'), 'utf8');
  const update = sql.slice(sql.indexOf('UPDATE lp_sync_log'));
  assert.match(update, /SET status = 'interrupted'/);
  assert.match(update, /WHERE status = 'failed'/,
    'the backfill must be scoped to failed rows so it cannot disturb completed ones');

  for (const reason of [
    'SIGTERM — container terminated',
    'Process terminated',
    'Stale lock — cleaned up on boot',
  ]) {
    assert.ok(update.includes(`'${reason}'`), `backfill must cover: ${reason}`);
  }

  // Real record failures and sweep timeouts stay visible.
  assert.ok(!/records failed/.test(update),
    'record-level failures are the true signal — the backfill must never touch them');
  assert.ok(!/timed out/.test(update),
    'a sweep that ran out of budget is a capacity problem, not a container kill');
});

// ─── Tripwire ────────────────────────────────────────────────────

test('no network calls escaped the suite', () => {
  assert.deepEqual(networkCalls, []);
});
