/**
 * Tests — one SFTP listing per (campaign, date) folder per tick
 * scripts/test-ci-listing-cache.js
 *
 * WHAT WAS MEASURED. stageFetchRecording listed a directory for EVERY call it
 * advanced, and every list() is its own SFTP connect. A batch of 50 sharing
 * three campaign/date folders paid for fifty listings over folders holding 48,
 * 228, 336 and 758 files. 65 calls were observed holding a 300s lease on the
 * fetch stage: the tick outlived its own lease and handed the same rows back.
 *
 * THE FOUR TRAPS THESE GUARD, in the order they would hurt:
 *
 * 1. A CACHED ERROR IS FIFTY LOST CALLS. One transient SFTP failure, cached as
 *    "this folder is empty", parks every remaining call in the batch on
 *    `recording_missing`. A thrown listing must never become an answer.
 * 2. A CACHE THAT OUTLIVES THE TICK IS DATA LOSS. Audio lands on the archive
 *    continuously. A stale listing reports a file that HAS arrived as absent,
 *    and the call is parked. Each tick gets its own memo — no TTL, no module
 *    singleton.
 * 3. A COLLIDING KEY SERVES ONE CAMPAIGN'S FILES TO ANOTHER. Campaign names
 *    carry spaces and hyphens ('Data - Hot Leads less than 7'), so any
 *    separator that can occur inside a key folds two folders into one. The
 *    separator is NUL for exactly that reason.
 * 4. AN EMPTY FOLDER IS AN ANSWER. Caching [] is the point — most of the
 *    saving is folders with nothing in them for a given call.
 *
 * No network, no SFTP, no storage: the adapter is a counting double and the
 * Supabase client is a double. Every call in these tests lands on the DEFER
 * branch (no candidate, younger than CI_RECORDING_WAIT_HOURS), which touches
 * one ci_calls update and nothing else.
 *
 * Run: node --test scripts/test-ci-listing-cache.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createListingCache, listingCacheKey } from '../src/ci/recordings.js';
import { stageFetchRecording, runTick, bestRecordingForCall } from '../src/ci/worker.js';
import { parseConfig } from '../src/ci/config.js';

const CFG = parseConfig({});

/** Frozen "now", 10 minutes after every call below — inside the wait window. */
const NOW = new Date('2026-08-05T21:40:00.000Z');

/** An adapter double that counts the directories it was asked to list. */
function countingAdapter({ result = () => [], fail = null } = {}) {
  const seen = [];
  return {
    seen,
    get count() { return seen.length; },
    async list({ campaign, date }) {
      seen.push(`${campaign}/${date}`);
      if (fail && fail(campaign, date, seen.length)) {
        throw new Error(`SFTP read failed for ${campaign}/${date}`);
      }
      return result(campaign, date);
    },
    async fetch() { throw new Error('fetch must not be reached by these tests'); },
  };
}

/**
 * PostgREST-shaped double. The defer branch only ever updates ci_calls; an
 * insert or a storage call would mean the test drifted off that branch.
 */
function fakeDb() {
  const log = [];
  return {
    log,
    from(table) {
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        limit() { return chain; },
        maybeSingle: async () => ({ data: null, error: null }),
        insert: async (row) => { log.push({ table, op: 'insert', row }); return { error: null }; },
        update(patch) {
          const thenable = {
            eq() { return thenable; },
            then: (res, rej) => {
              log.push({ table, op: 'update', patch });
              return Promise.resolve({ error: null }).then(res, rej);
            },
          };
          return thenable;
        },
        then: (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej),
      };
      return chain;
    },
  };
}

/** A ci_calls row in `discovered`, 10 minutes old, on a named campaign. */
function call(id, campaign, start = '2026-08-05T21:30:00.000Z') {
  return {
    id: `call-${id}`,
    five9_call_id: `3000000${id}`,
    status: 'discovered',
    campaign,
    ani: '9419203087',
    customer_phone: '9419203087',
    call_start: start,
    duration_seconds: 135,
    attempts: 0,
  };
}

/** A parsed recording, as describeRecording would produce it. */
function rec({ ani = '9419203087', campaignDir = 'Main Number', at = '2026-08-05T21:30:12.000Z' } = {}) {
  return {
    ani,
    campaignDir,
    recordedAt: new Date(at),
    durationSeconds: null,
    sourcePath: `/Five9/Recordings/${campaignDir}/8_5_2026/f.wav`,
    sourceFilename: 'f.wav',
    excluded: false,
  };
}

// ─── the key ────────────────────────────────────────────────────────────────

test('the key separator is NUL, not a character a campaign name can contain', () => {
  const key = listingCacheKey('Main Number', '8_5_2026');
  assert.ok(key.includes('\u0000'), 'the separator must be NUL');
  assert.equal(key, 'Main Number\u00008_5_2026');
  // The live campaign that makes ':' and ' ' unsafe. It survives verbatim.
  assert.equal(
    listingCacheKey('Data - Hot Leads less than 7', '8_5_2026'),
    'Data - Hot Leads less than 7\u00008_5_2026',
  );
});

test('two pairs that collide under a naive join do NOT collide here', () => {
  // Joined on a space these are the same string: 'Data - Hot 8_5_2026'.
  // Serving the second campaign the first one's file list would park its calls
  // on recording_missing, silently and forever.
  const a = listingCacheKey('Data - Hot', '8_5_2026');
  const b = listingCacheKey('Data', '- Hot 8_5_2026');
  assert.equal(['Data - Hot', '8_5_2026'].join(' '), ['Data', '- Hot 8_5_2026'].join(' '));
  assert.notEqual(a, b);
});

test('a campaign that is a PREFIX of another gets its own entry', async () => {
  const adapter = countingAdapter();
  const cache = createListingCache({ adapter, cfg: CFG });
  await cache.list({ campaign: 'Data - Hot Leads less than 7', date: '8_5_2026' });
  await cache.list({ campaign: 'Data - Hot Leads less than 70', date: '8_5_2026' });
  assert.equal(adapter.count, 2, 'a prefix campaign must not be served the longer one\'s listing');
});

// ─── the memo ───────────────────────────────────────────────────────────────

test('50 calls over 3 campaign/date pairs list exactly 3 directories', async () => {
  const db = fakeDb();
  const adapter = countingAdapter();
  const listings = createListingCache({ adapter, cfg: CFG });

  const campaigns = ['Main Number', 'Data - Hot Leads less than 7', 'Canvass Confirmation - Inbound'];
  for (let i = 0; i < 50; i += 1) {
    const r = await stageFetchRecording(call(i, campaigns[i % 3]), {
      db, cfg: CFG, adapter, listings, now: NOW,
    });
    assert.equal(r.outcome, 'deferred', 'an empty folder inside the wait window defers');
  }

  assert.equal(adapter.count, 3, `expected 3 listings, got ${adapter.count}: ${adapter.seen.join(', ')}`);
  const s = listings.stats();
  assert.equal(s.pairs, 3);
  assert.equal(s.calls, 50);
  assert.equal(s.hits, 47);
  assert.equal(s.errors, 0);
  assert.equal(s.hit_rate, 0.94);
  // The defer branch and nothing else: no ci_recordings, no ci_events, no fetch.
  assert.ok(db.log.every((e) => e.table === 'ci_calls' && e.op === 'update'), JSON.stringify(db.log[0]));
});

test('the NEXT tick re-lists — the memo never outlives the tick that made it', async () => {
  const db = fakeDb();
  const adapter = countingAdapter();

  for (const _tick of [1, 2]) {
    const listings = createListingCache({ adapter, cfg: CFG });
    await stageFetchRecording(call(1, 'Main Number'), { db, cfg: CFG, adapter, listings, now: NOW });
    await stageFetchRecording(call(2, 'Main Number'), { db, cfg: CFG, adapter, listings, now: NOW });
  }

  assert.equal(adapter.count, 2, 'one listing per tick, and the second tick must re-read the folder');
});

test('an empty folder is cached — that is most of the saving, not a bug', async () => {
  const adapter = countingAdapter({ result: () => [] });
  const cache = createListingCache({ adapter, cfg: CFG });
  assert.deepEqual(await cache.list({ campaign: 'Main Number', date: '8_5_2026' }), []);
  assert.deepEqual(await cache.list({ campaign: 'Main Number', date: '8_5_2026' }), []);
  assert.equal(adapter.count, 1);
});

test('a THROWN listing is retried, never cached', async () => {
  // Fails once, then succeeds. A cached rejection would park every remaining
  // call in the batch on recording_missing over one transient SFTP blip.
  const adapter = countingAdapter({
    fail: (_c, _d, n) => n === 1,
    result: () => [rec()],
  });
  const cache = createListingCache({ adapter, cfg: CFG });

  await assert.rejects(
    cache.list({ campaign: 'Main Number', date: '8_5_2026' }),
    /SFTP read failed/,
    'the error must reach the caller, not be swallowed',
  );
  const second = await cache.list({ campaign: 'Main Number', date: '8_5_2026' });
  assert.equal(adapter.count, 2, 'the failed pair must be re-listed, not served from cache');
  assert.equal(second.length, 1);
  assert.equal(cache.stats().errors, 1);
});

test('a listing failure propagates out of the stage rather than parking the call', async () => {
  const db = fakeDb();
  const adapter = countingAdapter({ fail: () => true });
  const listings = createListingCache({ adapter, cfg: CFG });
  await assert.rejects(
    stageFetchRecording(call(1, 'Main Number'), { db, cfg: CFG, adapter, listings, now: NOW }),
    /SFTP read failed/,
  );
  assert.equal(db.log.length, 0, 'a call must not be parked because the archive was unreadable');
});

// ─── identical to the uncached path ─────────────────────────────────────────

test('the cache returns what the adapter returned, and the join picks the same file', async () => {
  const listing = [rec(), rec({ ani: '7275550000' })];
  const adapter = countingAdapter({ result: () => listing });
  const cache = createListingCache({ adapter, cfg: CFG });

  const direct = await adapter.list({ campaign: 'Main Number', date: '8_5_2026' });
  const cached = await cache.list({ campaign: 'Main Number', date: '8_5_2026' });
  assert.deepEqual(cached, direct);

  const c = call(1, 'Main Number');
  assert.deepEqual(
    bestRecordingForCall(c, cached.filter((x) => !x.excluded), CFG.recordingMatchWindowS),
    bestRecordingForCall(c, direct.filter((x) => !x.excluded), CFG.recordingMatchWindowS),
  );
});

test('each caller gets its own array — one caller cannot rewrite the memo', async () => {
  const adapter = countingAdapter({ result: () => [rec()] });
  const cache = createListingCache({ adapter, cfg: CFG });
  const first = await cache.list({ campaign: 'Main Number', date: '8_5_2026' });
  first.length = 0;
  const second = await cache.list({ campaign: 'Main Number', date: '8_5_2026' });
  assert.equal(second.length, 1, 'a mutated copy must not empty the folder for everyone else');
});

test('a Date and its date-directory string are the SAME entry', async () => {
  // stageFetchRecording passes a string, but a direct caller may pass a Date.
  // Keying the raw value would list the same folder twice.
  const adapter = countingAdapter();
  const cache = createListingCache({ adapter, cfg: CFG });
  await cache.list({ campaign: 'Main Number', date: new Date('2026-08-05T21:30:00.000Z') });
  await cache.list({ campaign: 'Main Number', date: '8_5_2026' });
  assert.equal(adapter.count, 1, `expected one listing, got: ${adapter.seen.join(', ')}`);
});

// ─── the wiring ─────────────────────────────────────────────────────────────

test('stageFetchRecording works standalone — a direct caller gets a cache of one', async () => {
  const db = fakeDb();
  const adapter = countingAdapter();
  const r = await stageFetchRecording(call(1, 'Main Number'), { db, cfg: CFG, adapter, now: NOW });
  assert.equal(r.outcome, 'deferred');
  assert.equal(adapter.count, 1, 'no threaded cache must still mean exactly one listing');
});

test('runTick builds the memo inside the tick and reports what it saved', () => {
  // Structural, because runTick cannot be driven without a live DB (claimBatch
  // goes through the SQL function). What matters is that the cache is built in
  // the tick body — a module-level one would be the stale-listing bug — and
  // that the stats reach the response.
  const src = runTick.toString();
  assert.match(src, /createListingCache\(/, 'runTick must build the per-tick listing memo');
  assert.match(src, /listings,/, 'the memo must be threaded into advanceOne');
  assert.match(src, /listings: listed/, 'the tick response must report the listing stats');
});
