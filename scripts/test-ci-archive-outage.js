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

function fakeDb() {
  const log = [];
  return {
    log,
    from(table) {
      const chain = {
        select() { return chain; }, eq() { return chain; }, limit() { return chain; },
        maybeSingle: async () => ({ data: null, error: null }),
        insert: async (row) => { log.push({ table, op: 'insert', row }); return { error: null }; },
        update(patch) {
          const thenable = { eq() { return thenable; }, then: (res, rej) => { log.push({ table, op: 'update', patch }); return Promise.resolve({ error: null }).then(res, rej); } };
          return thenable;
        },
        then: (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej),
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
  assert.equal(db.log.filter((l) => l.table === 'ci_events').length, 0);
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
