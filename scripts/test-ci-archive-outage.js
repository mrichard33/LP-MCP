/**
 * Tests for src/ci/archive-outage.js and its wiring into advanceOne.
 *
 * 2026-09-27: the recording archive (nas1.etgts.com:2282) has reset every
 * connection since 2026-08-27 ~18:00 UTC. The worker counted each reset as the
 * CALL's failure, so one outage parked 16,771 calls as permanently `failed`,
 * wrote ~3,000 ci_events rows a day, re-connected every 30 seconds, and told
 * nobody. The decisions pinned below are what stop each of those.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isArchiveUnreachable,
  createArchiveBreaker,
  archiveOutageVerdict,
  formatArchiveOutageAlert,
  inheritedOutageStart,
  ARCHIVE_EVENT_DOWN,
  ARCHIVE_EVENT_UP,
  ARCHIVE_BASE_COOLDOWN_MS,
  ARCHIVE_MAX_COOLDOWN_MS,
  ARCHIVE_ALERT_AFTER_MS,
} from '../src/ci/archive-outage.js';
import { advanceOne } from '../src/ci/worker.js';

const LIVE_RESET = new Error('connect: Remote host has reset the connection: getConnection: read ECONNRESET');
const LIVE_HANDSHAKE = new Error('connect: getConnection: Timed out while waiting for handshake');

// ─── classification ─────────────────────────────────────────────────────────

test('the live errors are outages', () => {
  assert.ok(isArchiveUnreachable(LIVE_RESET));
  assert.ok(isArchiveUnreachable(LIVE_HANDSHAKE));
  assert.ok(isArchiveUnreachable(new Error('connect: getConnection: Connection lost before handshake')));
  assert.ok(isArchiveUnreachable(new Error('connect ECONNREFUSED 8.18.11.248:2282')));
  assert.ok(isArchiveUnreachable(new Error('getaddrinfo ENOTFOUND nas1.etgts.com')));
});

test("a call's own problems are NOT outages — they keep failing the call as before", () => {
  assert.equal(isArchiveUnreachable(new Error('No such file: /Five9/Recordings/x.wav')), false);
  assert.equal(isArchiveUnreachable(new Error('CI_SFTP_PASSWORD is not set')), false);
  assert.equal(isArchiveUnreachable(new Error('storage upload failed: 413')), false);
});

// ─── the breaker ────────────────────────────────────────────────────────────

test('breaker: opens on a reset, backs off 5 → 10 → 20 … capped at 60 minutes, closes on success', () => {
  let t = 1_000_000;
  const b = createArchiveBreaker({ now: () => t });
  assert.equal(b.isOpen(), false);

  const cools = [];
  for (let i = 0; i < 6; i++) cools.push(b.recordUnreachable(LIVE_RESET).cooldownMs);
  assert.deepEqual(cools.map((ms) => ms / 60000), [5, 10, 20, 40, 60, 60]);
  assert.equal(b.isOpen(), true);
  assert.equal(b.state().since, 1_000_000, 'the outage start is the FIRST reset, not the latest');

  t += ARCHIVE_MAX_COOLDOWN_MS + 1;
  assert.equal(b.isOpen(), false, 'after the cool-down the next fetch is the probe');

  assert.equal(b.recordReachable(), 1_000_000, 'reports when the outage began');
  assert.deepEqual([b.state().failures, b.state().since, b.isOpen()], [0, null, false]);
  assert.equal(b.recordUnreachable(LIVE_RESET).cooldownMs, ARCHIVE_BASE_COOLDOWN_MS, 'a new outage starts small again');
});

// ─── the alert verdict (three-way) ──────────────────────────────────────────

test('verdict: alert only after the outage has lasted 30 minutes', () => {
  const since = 0;
  const early = archiveOutageVerdict({ unreachable: 1, breaker: { since }, nowMs: ARCHIVE_ALERT_AFTER_MS - 1 });
  assert.equal(early.active, null, 'a blip is not paged');
  const late = archiveOutageVerdict({ paused: 3, breaker: { since }, nowMs: ARCHIVE_ALERT_AFTER_MS });
  assert.equal(late.verdict, 'alert');
  assert.equal(late.active, true);
});

test('verdict: healthy ONLY when a listing actually worked this tick', () => {
  assert.equal(archiveOutageVerdict({ reachable: 2, breaker: { since: null }, nowMs: 1 }).active, false);
});

test('verdict: a tick with no fetch-stage calls checked nothing — never clears', () => {
  assert.equal(archiveOutageVerdict({ breaker: { since: 0 }, nowMs: 10 * ARCHIVE_ALERT_AFTER_MS }).active, null);
  assert.equal(archiveOutageVerdict({ breaker: { since: null }, nowMs: 1 }).active, null);
});

test('the card says paused-not-failed and where to look', () => {
  const card = formatArchiveOutageAlert({ host: 'nas1.etgts.com', port: 2282, outageMs: 3 * 86400000, lastError: LIVE_RESET.message, waiting: 36, nextTryMs: 3600000 });
  assert.match(card, /nas1\.etgts\.com:2282/);
  assert.match(card, /3 days/);
  assert.match(card, /36 call\(s\) waiting/);
  assert.match(card, /PAUSED, not failed/);
  assert.match(card, /allowlist/);
});

// ─── wiring: advanceOne ─────────────────────────────────────────────────────

// `markers` is what a read of the newest ci_events outage marker returns;
// `readError` makes that read fail the way PostgREST does (resolved { error }).
function fakeDb({ markers = [], readError = null } = {}) {
  const log = [];
  return {
    log,
    from(table) {
      let filtered = false;
      const chain = {
        select() { return chain; }, eq() { return chain; }, limit() { return chain; },
        is() { filtered = true; return chain; }, in() { return chain; }, order() { return chain; },
        maybeSingle: async () => ({ data: null, error: null }),
        insert: async (row) => { log.push({ table, op: 'insert', row }); return { error: null }; },
        update(patch) {
          const thenable = { eq() { return thenable; }, then: (res, rej) => { log.push({ table, op: 'update', patch }); return Promise.resolve({ error: null }).then(res, rej); } };
          return thenable;
        },
        then: (res, rej) => Promise.resolve(
          table === 'ci_events' && filtered
            ? (readError ? { data: null, error: { message: readError } } : { data: markers, error: null })
            : { data: [], error: null },
        ).then(res, rej),
      };
      return chain;
    },
  };
}

const CALL = {
  id: 'call-1', five9_call_id: '30000001', status: 'discovered', campaign: 'Data - Hot Leads',
  ani: '9419203087', customer_phone: '9419203087', call_start: '2026-09-27T14:00:00.000Z',
  duration_seconds: 135, attempts: 2,
};

test('a reset pauses the call WITHOUT touching its attempts, and writes no ci_events row', async () => {
  const db = fakeDb();
  const breaker = createArchiveBreaker();
  const adapter = { list: async () => { throw LIVE_RESET; }, fetch: async () => { throw new Error('not reached'); } };
  const r = await advanceOne({ ...CALL }, { db, adapter, breaker, now: new Date('2026-09-27T15:00:00Z') });

  assert.equal(r.outcome, 'archive_unreachable');
  const updates = db.log.filter((l) => l.op === 'update');
  assert.equal(updates.length, 1);
  assert.equal('attempts' in updates[0].patch, false, 'an outage is not the call\'s failure');
  assert.equal('status' in updates[0].patch, false, 'never parked as failed');
  assert.ok(updates[0].patch.next_retry_at, 'comes back after the cool-down');
  const events = db.log.filter((l) => l.table === 'ci_events');
  assert.equal(events.filter((l) => l.row.call_id != null).length, 0, 'no per-call row');
  assert.deepEqual(events.map((l) => [l.row.call_id, l.row.event]), [[null, ARCHIVE_EVENT_DOWN]], 'one durable outage-start marker');
  assert.equal(breaker.isOpen(), true);
});

test('while the breaker is open, the next call does not connect at all', async () => {
  const db = fakeDb();
  const breaker = createArchiveBreaker();
  breaker.recordUnreachable(LIVE_RESET);
  let listed = 0;
  const adapter = { list: async () => { listed++; return []; }, fetch: async () => Buffer.alloc(0) };
  const r = await advanceOne({ ...CALL }, { db, adapter, breaker });
  assert.equal(r.outcome, 'archive_paused');
  assert.equal(listed, 0, 'no SFTP connection while paused');
});

test('a non-outage error still fails the call exactly as before', async () => {
  const db = fakeDb();
  const breaker = createArchiveBreaker();
  const adapter = { list: async () => { throw new Error('No such file'); }, fetch: async () => Buffer.alloc(0) };
  const r = await advanceOne({ ...CALL }, { db, adapter, breaker });
  assert.equal(r.outcome, 'failed');
  const upd = db.log.find((l) => l.op === 'update');
  assert.equal(upd.patch.attempts, 3);
  assert.equal(breaker.isOpen(), false);
});

// ─── the outage clock survives a restart (2026-09-28) ───────────────────────
//
// Eight deploys in an hour reset the per-process clock every time, so the
// 30-minute card never went out. These pin the durable markers.

test('seedSince only moves the outage start earlier, and leaves the cool-down alone', () => {
  let t = 10_000_000;
  const b = createArchiveBreaker({ now: () => t });
  assert.equal(b.seedSince(1), null, 'no outage in this process → nothing to seed');
  const { openUntil } = b.recordUnreachable(LIVE_RESET);
  assert.equal(b.seedSince(t - 60_000), t - 60_000);
  assert.equal(b.seedSince(t + 60_000), t - 60_000, 'never later');
  assert.equal(b.openUntil(), openUntil);
  assert.equal(b.state().failures, 1);
});

test('inheritedOutageStart: only a DOWN marker is proof of an unbroken outage', () => {
  const now = Date.parse('2026-09-28T17:30:00Z');
  assert.equal(inheritedOutageStart({ event: ARCHIVE_EVENT_DOWN, created_at: '2026-09-28T16:39:54Z' }, now), Date.parse('2026-09-28T16:39:54Z'));
  assert.equal(inheritedOutageStart({ event: ARCHIVE_EVENT_UP, created_at: '2026-09-28T16:39:54Z' }, now), null);
  assert.equal(inheritedOutageStart(null, now), null);
  assert.equal(inheritedOutageStart({ event: ARCHIVE_EVENT_DOWN, created_at: 'garbage' }, now), null);
  assert.equal(inheritedOutageStart({ event: ARCHIVE_EVENT_DOWN, created_at: '2026-09-29T00:00:00Z' }, now), null, 'a future marker is not evidence');
});

test('restart: a fresh process inherits the outage start and alerts on its FIRST reset', async () => {
  const fortyMinAgo = new Date(Date.now() - 40 * 60 * 1000).toISOString();
  const db = fakeDb({ markers: [{ event: ARCHIVE_EVENT_DOWN, created_at: fortyMinAgo }] });
  const breaker = createArchiveBreaker();
  const adapter = { list: async () => { throw LIVE_RESET; }, fetch: async () => Buffer.alloc(0) };
  const r = await advanceOne({ ...CALL }, { db, adapter, breaker });
  assert.equal(r.outcome, 'archive_unreachable');
  assert.equal(breaker.state().since, Date.parse(fortyMinAgo));
  assert.equal(archiveOutageVerdict({ unreachable: 1, breaker: breaker.state(), nowMs: Date.now() }).verdict, 'alert');
  assert.equal(db.log.filter((l) => l.table === 'ci_events').length, 0, 'an inherited outage writes no second marker');
});

test('newest marker is UP: a new outage writes DOWN and starts its clock now', async () => {
  const db = fakeDb({ markers: [{ event: ARCHIVE_EVENT_UP, created_at: '2026-09-01T00:00:00Z' }] });
  const breaker = createArchiveBreaker();
  const before = Date.now();
  await advanceOne({ ...CALL }, { db, adapter: { list: async () => { throw LIVE_RESET; } }, breaker });
  assert.ok(breaker.state().since >= before);
  assert.deepEqual(db.log.filter((l) => l.table === 'ci_events').map((l) => l.row.event), [ARCHIVE_EVENT_DOWN]);
});

test('marker read fails: the process clock is used, the call is still paused, nothing throws', async () => {
  const db = fakeDb({ readError: 'statement timeout' });
  const breaker = createArchiveBreaker();
  const before = Date.now();
  const r = await advanceOne({ ...CALL }, { db, adapter: { list: async () => { throw LIVE_RESET; } }, breaker });
  assert.equal(r.outcome, 'archive_unreachable');
  assert.ok(breaker.state().since >= before);
  assert.equal(db.log.filter((l) => l.op === 'update').length, 1, 'lease released as usual');
});

test('a working listing after an outage writes exactly one UP marker', async () => {
  const db = fakeDb();
  let t = 0;
  const breaker = createArchiveBreaker({ now: () => t });
  breaker.recordUnreachable(LIVE_RESET);
  t = ARCHIVE_MAX_COOLDOWN_MS + 1; // cool-down over: the next fetch is the probe
  const adapter = { list: async () => [], fetch: async () => Buffer.alloc(0) };
  await advanceOne({ ...CALL }, { db, adapter, breaker });
  await advanceOne({ ...CALL, id: 'call-2' }, { db, adapter, breaker });
  const ups = db.log.filter((l) => l.table === 'ci_events' && l.row.event === ARCHIVE_EVENT_UP);
  assert.equal(ups.length, 1);
  assert.equal(ups[0].row.call_id, null);
  assert.equal(breaker.state().since, null);
});

test('a new process whose first listing works closes a DOWN left by an earlier process — once', async () => {
  const db = fakeDb({ markers: [{ event: ARCHIVE_EVENT_DOWN, created_at: '2026-09-28T16:39:54Z' }] });
  const breaker = createArchiveBreaker();
  const adapter = { list: async () => [], fetch: async () => Buffer.alloc(0) };
  await advanceOne({ ...CALL }, { db, adapter, breaker });
  await advanceOne({ ...CALL, id: 'call-2' }, { db, adapter, breaker });
  assert.equal(db.log.filter((l) => l.table === 'ci_events' && l.row.event === ARCHIVE_EVENT_UP).length, 1);
});

test('the card names when the outage was first seen', () => {
  const card = formatArchiveOutageAlert({ host: 'h', port: 1, outageMs: 3600000, sinceMs: Date.parse('2026-09-28T16:39:54Z'), waiting: 1, nextTryMs: 60000 });
  assert.match(card, /first seen 2026-09-28 16:39 UTC, 1h 0m so far/);
});
