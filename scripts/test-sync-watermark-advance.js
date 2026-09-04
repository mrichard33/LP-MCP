#!/usr/bin/env node
/**
 * Incremental watermark advancement — scripts/test-sync-watermark-advance.js
 *
 * Covers 085 (WO-11 / WO-12).
 *
 * WHAT WO-11 FOUND
 * ----------------
 * The watermark was never stuck. getLastSyncTimestamp() reads lp_sync_log, not
 * max(synced_at) over written entity rows, and it advanced on every run of
 * 2026-09-04 (16:50:13 → 18:57:55Z). The window start was thrown away AFTER
 * the read, by resolveWindowStart() truncating the cursor to an ET calendar
 * DATE — a midnight-anchored window that grows all day and resets at midnight.
 *
 * WHAT WO-12 STILL HAS TO FIX
 * ---------------------------
 * The reported mechanism is real, just masked. #837/#846 stopped writing rows
 * whose payload hash was unchanged, so `records_synced` counts WRITES. The
 * pre-085 watermark gate required records_synced > 0. A since-midnight window
 * always writes something, so the gate always passed — but a true 15-minute
 * delta in which every row is unchanged writes NOTHING, and that gate would
 * have discarded the run and re-opened the window a little further each cycle.
 *
 * Narrowing the window without this change would therefore have reproduced the
 * exact symptom by another route. Both land together or neither does.
 *
 * The contract these tests pin:
 *   1. A run that PROCESSED its window advances the watermark even if it WROTE
 *      nothing.  (handoff test 1)
 *   2. The cursor anchors on started_at, not completed_at — a sweep reads
 *      across its own runtime, so completed_at skips anything that changed
 *      mid-sweep.  (handoff test 2)
 *   3. A run that stopped short — capped, ceilinged, or truncated by an errored
 *      page — must NOT advance it.  (handoff test 3)
 *   4. Consecutive quiet runs keep advancing, so the window stays a small
 *      constant delta instead of creeping open.  (handoff test 4)
 *   5. Advancement is monotonic: an older row can never pull it backwards.
 *      (handoff test 5)
 *   6. Legacy rows written before 085 still work, and can never out-rank a real
 *      drained-window row.
 *   7. SYNC_WATERMARK_FROM_PROCESSED=false restores the pre-085 rule.
 *   8. The MAX_INCREMENTAL_DAYS cap still applies to whatever is selected.
 *
 * Run: node scripts/test-sync-watermark-advance.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.SUPABASE_URL = 'http://sb.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
// A FORCE_SYNC_SINCE in the dev's shell would short-circuit every case here.
delete process.env.FORCE_SYNC_SINCE;
process.env.MAX_INCREMENTAL_DAYS = '1';

globalThis.fetch = async () => ({
  ok: false, status: 599, headers: { get: () => null }, text: async () => '', json: async () => ({}),
});

// ─── A tiny query evaluator over an in-memory lp_sync_log ────────────────────
// Faithful to the subset of PostgREST getLastSyncTimestamp actually uses, so a
// test failure means the QUERY is wrong rather than the stub.
let rows = [];

const supabase = (await import('../src/supabase.js')).default;
Object.defineProperty(supabase, 'from', {
  value: (table) => {
    assert.equal(table, 'lp_sync_log');
    let set = rows.slice();
    let order = null;
    const chain = {
      select() { return chain; },
      eq(col, val) { set = set.filter((r) => r[col] === val); return chain; },
      in(col, vals) { set = set.filter((r) => vals.includes(r[col])); return chain; },
      gt(col, val) { set = set.filter((r) => (r[col] ?? -Infinity) > val); return chain; },
      is(col, val) { assert.equal(val, null); set = set.filter((r) => r[col] == null); return chain; },
      not(col, op, val) {
        assert.equal(op, 'is'); assert.equal(val, null);
        set = set.filter((r) => r[col] != null);
        return chain;
      },
      order(col, { ascending }) { order = { col, ascending }; return chain; },
      limit(n) { chain._limit = n; return chain; },
      async maybeSingle() {
        if (order) {
          set.sort((a, b) => (a[order.col] < b[order.col] ? -1 : a[order.col] > b[order.col] ? 1 : 0));
          if (!order.ascending) set.reverse();
        }
        return { data: set.slice(0, chain._limit ?? 1)[0] ?? null, error: null };
      },
    };
    return chain;
  },
  writable: true, configurable: true,
});

const { getLastSyncTimestamp } = await import('../src/sync-log.js');

// Helpers. Times are close to NOW so the MAX_INCREMENTAL_DAYS cap never fires
// except where a test asks for it. NOW is frozen once — re-reading the clock
// per call makes every equality assertion drift by a millisecond.
const NOW = Date.now();
const T = (minutesAgo) => new Date(NOW - minutesAgo * 60000).toISOString();

function leadsRow(o) {
  return {
    entity_type: 'leads',
    status: 'completed',
    records_synced: 0,
    window_complete: null,
    started_at: null,
    completed_at: null,
    ...o,
  };
}

// A run that drained its window: started 20 min ago, took 5 min.
const drained = (startedMinAgo, extra = {}) => leadsRow({
  window_complete: true,
  started_at: T(startedMinAgo),
  completed_at: T(startedMinAgo - 5),
  ...extra,
});

// ─── 1. A quiet run WROTE nothing but PROCESSED its window ───────────────────
// The whole point of #837, and the case the old records_synced > 0 gate threw
// away. If this regresses, the window silently creeps back open.
test('advances on a drained window that wrote zero rows', async () => {
  rows = [drained(20, { records_synced: 0 })];
  const ts = await getLastSyncTimestamp();
  assert.equal(ts.toISOString(), T(20), 'a 0-write run still covered its window');
});

// ─── 2. Anchored at started_at, not completed_at ─────────────────────────────
// A sweep READS across [started_at..completed_at]. The 18:35Z run took 22.5
// min; a cursor at completed_at would skip anything that changed during it.
test('anchors on started_at so mid-sweep changes are not skipped', async () => {
  rows = [drained(30, { records_synced: 130 })];
  const ts = await getLastSyncTimestamp();
  assert.equal(ts.toISOString(), T(30));
  assert.notEqual(ts.toISOString(), T(25), 'completed_at would skip the 5min the sweep was running');
});

// ─── 3. A run that stopped short must not advance it ─────────────────────────
// Capped, ceilinged, or truncated by an errored page — all three set
// window_complete=false, and all three leave part of the window unread.
test('holds at the last drained run when a later run stopped short', async () => {
  rows = [
    drained(60, { records_synced: 500 }),
    // Later, but capped: `completed` for log purposes, window NOT covered.
    leadsRow({ window_complete: false, records_synced: 20000, started_at: T(20), completed_at: T(5) }),
  ];
  const ts = await getLastSyncTimestamp();
  assert.equal(ts.toISOString(), T(60), 'advancing past a capped run abandons its remainder');
});

// ─── 4. Consecutive quiet runs keep the window a small constant delta ────────
// The regression signature was a delta that grew every cycle. Two quiet runs
// 15 min apart must leave the cursor 15 min behind, not hours.
test('consecutive quiet runs keep the window small and constant', async () => {
  rows = [drained(35, { records_synced: 0 })];
  const first = await getLastSyncTimestamp();

  rows.push(drained(20, { records_synced: 0 }));
  const second = await getLastSyncTimestamp();

  assert.ok(second > first, 'the second quiet run must move the cursor');
  const deltaMin = (second.getTime() - first.getTime()) / 60000;
  assert.ok(Math.abs(deltaMin - 15) < 0.5, `expected a ~15min step, got ${deltaMin}`);
});

// ─── 5. Monotonic — an older row never pulls it backwards ────────────────────
test('replaying an older drained run does not move the watermark backwards', async () => {
  rows = [drained(20)];
  const before = await getLastSyncTimestamp();
  rows.push(drained(90));               // an older run arriving late
  rows.push(drained(20));               // and the same page replayed
  const after = await getLastSyncTimestamp();
  assert.equal(after.getTime(), before.getTime());
});

// ─── 6. Legacy rows still work, and never out-rank a drained row ─────────────
// Rows written before 085 have window_complete NULL and cannot know whether
// their window drained, so the pre-085 rule still serves them.
test('legacy NULL rows fall back to the pre-085 rule', async () => {
  rows = [leadsRow({ records_synced: 42, started_at: T(90), completed_at: T(80) })];
  const ts = await getLastSyncTimestamp();
  assert.equal(ts.toISOString(), T(80), 'legacy rows keep their completed_at anchor');
});

test('a drained row out-ranks a newer-looking legacy row', async () => {
  rows = [
    drained(40),
    leadsRow({ records_synced: 42, started_at: T(200), completed_at: T(190) }),
  ];
  const ts = await getLastSyncTimestamp();
  assert.equal(ts.toISOString(), T(40));
});

// ─── 7. The kill switch restores the old rule ────────────────────────────────
test('SYNC_WATERMARK_FROM_PROCESSED=false restores the pre-085 rule', async () => {
  process.env.SYNC_WATERMARK_FROM_PROCESSED = 'false';
  const fresh = await import(`../src/sync-log.js?kill=${Date.now()}`);
  // Only a legacy-shaped row is eligible under the old rule; the 0-write
  // drained run is invisible to it, which is precisely the bug it reverts to.
  rows = [
    drained(20, { records_synced: 0 }),
    leadsRow({ records_synced: 5, started_at: T(120), completed_at: T(110) }),
  ];
  const ts = await fresh.getLastSyncTimestamp();
  assert.equal(ts.toISOString(), T(110));
  delete process.env.SYNC_WATERMARK_FROM_PROCESSED;
});

// ─── 8. The MAX_INCREMENTAL_DAYS cap still applies ───────────────────────────
test('a drained run older than the cap is still capped', async () => {
  rows = [drained(60 * 24 * 3)]; // 3 days back, cap is 1 day
  const ts = await getLastSyncTimestamp();
  const ageHours = (Date.now() - ts.getTime()) / 3600000;
  assert.ok(Math.abs(ageHours - 24) < 0.1, `expected the 24h cap, got ${ageHours}h`);
});

// ─── 9. The window cursor default ────────────────────────────────────────────
// WO-11's actual finding. The timestamp path shipped dark and stayed dark, and
// that default IS the degradation. A source assertion is crude, but importing
// sync-engine.js pulls the whole service in; this guards the reversion that
// matters without that cost.
test('SYNC_WINDOW_MODE defaults to timestamp, not date', () => {
  const src = readFileSync(new URL('../src/sync-engine.js', import.meta.url), 'utf8');
  assert.match(
    src,
    /process\.env\.SYNC_WINDOW_MODE \|\| 'timestamp'/,
    'the midnight-truncated date window is what WO-11 diagnosed — it must not be the default again'
  );
});
