/**
 * Tests — the CRM clients must have a PRODUCTION default
 * scripts/test-ci-production-defaults.js
 *
 * THE BUG THIS LOCKS OUT. syncToLp/syncToGhl took `lpClient`/`ghlClient` with
 * no default, and nothing in production ever constructed one: worker.runTick()
 * supplies defaults for adapter, transcriber and loadAudio, but passed these
 * two straight through as undefined. The first live tick (2026-08-24 22:0x UTC)
 * threw on six calls at the write site:
 *
 *   Cannot read properties of undefined (reading 'addNote')
 *
 * No HTTP request was made — the throw precedes it — so ZERO notes reached
 * Lead Perfection while six idempotency keys were burned holding the failure.
 *
 * WHY THE SUITE COULD NOT SEE IT. Every existing test injects a client. The
 * shadow-mode test even injects one that THROWS IF CALLED, and passes — because
 * shadow returns before the client is touched. It proves no write happens in
 * shadow; it proves nothing whatsoever about live. A dependency that is only
 * ever supplied by the caller is never exercised as it ships.
 *
 * SO THESE TESTS INJECT NOTHING. Each entry point is called with NO client and
 * liveWrites true, and the assertion is that the write is ATTEMPTED — that the
 * failure, if any, comes from the real client's own transport, never from
 * reading a property of undefined.
 *
 * ── NO HTTP, AND NOT BY POLITENESS ─────────────────────────────────────────
 * The LP credentials are removed from the environment for the duration of each
 * live test, so the real addNote fails inside getToken()/lpPost() at the
 * "LP_API_BASE_URL not configured" check, which is BEFORE the fetch. That is
 * what makes this test both hermetic and safe to run on a developer machine
 * that happens to have live LP credentials exported: it cannot post a note to a
 * real customer record, and it still proves the real client function ran.
 *
 * Run: node --test scripts/test-ci-production-defaults.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { addNote as realAddNote } from '../src/lp-client.js';
import { addGHLNote as realAddGHLNote } from '../src/ghl.js';
import {
  syncToLp as syncToLpAt,
  syncToGhl as syncToGhlAt,
  syncCall as syncCallAt,
  defaultLpClient,
  defaultGhlClient,
} from '../src/ci/sync.js';
import { stageSync as stageSyncAt, advanceOne as advanceOneAt, runTick } from '../src/ci/worker.js';
import { parseConfig } from '../src/ci/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const LIVE_LP = parseConfig({ CALL_INTEL_MODE: 'live', CALL_INTEL_LP_WRITES: 'true' });
const LIVE_BOTH = parseConfig({
  CALL_INTEL_MODE: 'live', CALL_INTEL_LP_WRITES: 'true', CALL_INTEL_GHL_WRITES: 'true',
});

/** The shape of the failure this whole file exists to prevent. */
const MISSING_DEPENDENCY = /Cannot read properties of (undefined|null)|is not a function/;

const CALL = {
  id: '8fff91b7-ed35-4adb-8f00-bb049d154bd8',
  five9_call_id: '300000010259758',
  call_start: '2026-08-24T21:55:00.000Z',
  direction: 'Outbound',
  ani: '7273302574',
  agent_name: 'John Manieri',
  team: 'reece',
  attempts: 0,
  status: 'matched',
};

// The clock is pinned to the fixture — see the long note in test-ci-sync.js.
// This file asserts what the PRODUCTION defaults do, so the age gate skipping
// every write would make it assert nothing at all. Derived from CALL; `...o`
// last so an individual test can still override it.
const NOW = new Date(Date.parse(CALL.call_start) + 60 * 60 * 1000);
const syncToLp  = (c, s, m, o = {}) => syncToLpAt(c, s, m, { now: NOW, ...o });
const syncToGhl = (c, s, m, o = {}) => syncToGhlAt(c, s, m, { now: NOW, ...o });
const syncCall  = (c, s, m, o = {}) => syncCallAt(c, s, m, { now: NOW, ...o });
// The worker entry points reach syncToLp/syncToGhl underneath, so they need the
// same pinned clock or the age gate skips the write these tests are asserting.
const stageSync  = (c, o = {}) => stageSyncAt(c, { now: NOW, ...o });
const advanceOne = (c, o = {}) => advanceOneAt(c, { now: NOW, ...o });

const SUMMARY = {
  call_id: CALL.id,
  is_current: true,
  output: {
    summary: 'The agent reached the customer and confirmed the appointment.',
    outcome: 'appointment_confirmed',
    key_details: [],
    follow_up: { required: false },
  },
};

const MATCH = {
  call_id: CALL.id,
  tier: 'high',
  ghl_contact_id: 'ghl-contact-1',
  evidence: { note_target: { rectype: 'cst', recid: 435833 } },
};

/**
 * Run `fn` with every LP credential removed, then put them back.
 *
 * Deliberately unconditional: the point is that this test can never reach the
 * LP API, whatever the developer's shell holds.
 */
// Both identities. addNote now authenticates as LP_NOTE_USERNAME when one is
// configured, so stripping only the primary credentials would leave the
// "no HTTP can escape" guarantee resting on LP_API_BASE_URL alone.
const LP_ENV = ['LP_API_BASE_URL', 'LP_USERNAME', 'LP_PASSWORD', 'LP_CLIENT_ID', 'LP_APP_KEY',
                'LP_NOTE_USERNAME', 'LP_NOTE_PASSWORD'];
async function withoutLpCredentials(fn) {
  const saved = Object.fromEntries(LP_ENV.map((k) => [k, process.env[k]]));
  for (const k of LP_ENV) delete process.env[k];
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/**
 * PostgREST-shaped double covering everything the sync path touches, honouring
 * UNIQUE(idempotency_key) so a claim behaves as it does live.
 */
function fakeDb({ match = MATCH, summary = SUMMARY, recordings = [] } = {}) {
  const syncs = [];
  const log = [];
  return {
    syncs,
    log,
    /** The patch written back onto the ci_syncs row, i.e. the recorded error. */
    syncPatch(target) {
      const row = syncs.find((r) => r.target === target);
      return log.find((l) => l.table === 'ci_syncs' && l.op === 'update' && l.where?.id === row?.id)?.patch ?? null;
    },
    from(table) {
      const chain = {
        _eq: {},
        select() { return chain; },
        eq(c, v) { chain._eq[c] = v; return chain; },
        order() { return chain; },
        limit() { return chain; },
        maybeSingle: async () => ({
          data: table === 'ci_matches' ? match : table === 'ci_summaries' ? summary : null,
          error: null,
        }),
        insert(row) {
          log.push({ table, op: 'insert', row });
          const api = {
            select: () => api,
            maybeSingle: async () => {
              if (table !== 'ci_syncs') return { data: null, error: null };
              if (syncs.some((r) => r.idempotency_key === row.idempotency_key)) {
                return { data: null, error: { code: '23505', message: 'duplicate key value' } };
              }
              const stored = { id: `sync-${syncs.length + 1}`, attempts: 0, ...row };
              syncs.push(stored);
              return { data: stored, error: null };
            },
            then: (res, rej) => Promise.resolve({ error: null }).then(res, rej),
          };
          return api;
        },
        update(patch) {
          const api = {
            eq(c, v) {
              log.push({ table, op: 'update', patch, where: { [c]: v } });
              const row = syncs.find((r) => r.id === v);
              if (row) Object.assign(row, patch);
              return Promise.resolve({ error: null });
            },
          };
          return api;
        },
        // ci_recordings resolves as a plain query.
        then: (res, rej) => Promise.resolve({ data: recordings, error: null }).then(res, rej),
      };
      return chain;
    },
  };
}

// ─── 1. the defaults exist, and they are the REAL clients ───────────────────

test('the LP write site defaults to the real lp-client.addNote', () => {
  // Identity, not shape: a hand-rolled stand-in that happens to expose an
  // addNote would satisfy `typeof === function` and still post nothing.
  assert.equal(typeof defaultLpClient?.addNote, 'function');
  assert.equal(defaultLpClient.addNote, realAddNote, 'the default must BE src/lp-client.js addNote');
});

test('the GHL write site defaults to the real ghl.addGHLNote', () => {
  assert.equal(typeof defaultGhlClient?.addGHLNote, 'function');
  assert.equal(defaultGhlClient.addGHLNote, realAddGHLNote, 'the default must BE src/ghl.js addGHLNote');
});

// ─── 2. with NO client injected, a live write is ATTEMPTED ──────────────────

test('syncToLp with NO lpClient attempts the write instead of throwing a TypeError', async () => {
  const db = fakeDb();
  const r = await withoutLpCredentials(() => syncToLp(CALL, SUMMARY, MATCH, { db, cfg: LIVE_LP }));

  // It got as far as the LP transport. Before the fix this was
  // "Cannot read properties of undefined (reading 'addNote')".
  assert.equal(r.skipped, undefined, 'the write must not be skipped — the tier and target are writable');
  const err = String(r.error || '');
  assert.doesNotMatch(err, MISSING_DEPENDENCY, `the production default is missing again: ${err}`);
  assert.match(err, /LP_API_BASE_URL not configured|Missing LP credentials/,
    'the failure must come from the real client’s own transport, not from an absent dependency');

  // And the row records that same transport failure, which is what the repair
  // script's narrow filter distinguishes from a burned key.
  assert.doesNotMatch(String(db.syncPatch('lp')?.error || ''), MISSING_DEPENDENCY);
});

test('syncToGhl with NO ghlClient reaches the real client rather than undefined', async () => {
  const db = fakeDb();
  const r = await syncToGhl(CALL, SUMMARY, MATCH, { db, cfg: LIVE_BOTH });

  assert.equal(r.skipped, undefined);
  assert.doesNotMatch(String(r.error || ''), MISSING_DEPENDENCY,
    'the production default is missing again for GHL');
  // With no GHL_API_KEY the real addGHLNote returns null WITHOUT any HTTP —
  // reaching that null is itself the proof the real function ran, because an
  // absent default would have thrown a TypeError before ever calling it.
  //
  // That null is now classified as a transient failure rather than recorded as
  // a delivered note (classifyGhlNoteResult — see test-ci-ghl-note-result.js).
  // An unconfigured or circuit-broken GHL used to read as 'synced' here, which
  // is what this assertion asserted before the semantics were fixed.
  assert.equal(r.synced, undefined, 'an unconfigured GHL is not a delivered note');
  assert.equal(r.failed, true);
  assert.equal(r.reason, 'ghl_unavailable');
  assert.equal(r.terminal, false, 'unconfigured/down is transient — it must retry');
  assert.equal(db.syncs.find((s) => s.target === 'ghl').status, 'pending');
});

test('syncCall with NO clients at all attempts BOTH writes', async () => {
  const db = fakeDb();
  const r = await withoutLpCredentials(() => syncCall(CALL, SUMMARY, MATCH, { db, cfg: LIVE_BOTH }));
  for (const target of ['lp', 'ghl']) {
    assert.doesNotMatch(String(r[target].error || ''), MISSING_DEPENDENCY,
      `${target} has no production default`);
  }
});

// ─── 3. the worker path, which is how production actually gets here ─────────

test('stageSync with NO clients attempts the write — the exact production path', async () => {
  const db = fakeDb();
  const r = await withoutLpCredentials(() => stageSync(CALL, { db, cfg: LIVE_LP }));

  const err = String(r.result?.lp?.error || '');
  assert.doesNotMatch(err, MISSING_DEPENDENCY,
    `stageSync reached the write site with no client: ${err}`);
  assert.match(err, /LP_API_BASE_URL not configured|Missing LP credentials/);
  // A transport failure with attempts left defers for retry rather than
  // parking the call — the same behaviour any LP outage gets.
  assert.equal(r.outcome, 'deferred');
});

test('advanceOne on a syncing call — the dispatch runTick uses — attempts the write', async () => {
  // status must be 'syncing', not 'matched'. This test exists to prove the
  // DISPATCH reaches the write site with production defaults, and advanceOne
  // routes 'matched' to stageTranscribe — only 'syncing' reaches stageSync. With
  // the stale status it was asserting on the transcribe stage failing for want
  // of a transcriber, which is a different test that happens to also be red.
  const db = fakeDb();
  const r = await withoutLpCredentials(() => advanceOne({ ...CALL, status: 'syncing' }, { db, cfg: LIVE_LP }));
  assert.doesNotMatch(String(r.result?.lp?.error || ''), MISSING_DEPENDENCY);
  assert.equal(r.outcome, 'deferred');
});

// ─── 4. the default stays at the write site, and only there ─────────────────

test('the worker declares NO client default of its own', () => {
  // Structural, because runTick cannot be driven without a live DB (claimBatch
  // calls the claim_ci_calls SQL function). The invariant is worth pinning
  // anyway: a default constructed in the worker would be a SECOND source of the
  // client above liveWrites(), and it would leave every direct caller of
  // syncToLp/syncToGhl still holding undefined — which is this bug again.
  for (const fn of [runTick, advanceOne, stageSync]) {
    const src = fn.toString();
    assert.equal(/lpClient\s*=/.test(src), false, `${fn.name} must pass lpClient through, not default it`);
    assert.equal(/ghlClient\s*=/.test(src), false, `${fn.name} must pass ghlClient through, not default it`);
  }
});

test('runTick still forwards both clients down to the write site', () => {
  // The pass-through is the other half of the invariant above: an injected
  // client (tests, a one-off backfill) must still win over the default.
  const src = runTick.toString();
  assert.match(src, /lpClient/, 'runTick must still accept and forward lpClient');
  assert.match(src, /ghlClient/, 'runTick must still accept and forward ghlClient');
});

test('the write site is still the ONLY place either client is called', () => {
  // §5/§9: one call site per target, both behind liveWrites(). A second one
  // would need its own default and its own gate, and would be missed by both.
  const sync = read('src/ci/sync.js');
  assert.equal((sync.match(/lpClient\.addNote\(/g) || []).length, 1);
  assert.equal((sync.match(/ghlClient\.addGHLNote\(/g) || []).length, 1);
  for (const rel of ['src/ci/worker.js', 'src/ci/routes.js', 'src/ci/reconcile.js']) {
    const src = read(rel);
    assert.equal(/\.addNote\(|\.addGHLNote\(/.test(src), false, `${rel} must not write to a CRM directly`);
  }
});
