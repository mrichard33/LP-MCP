/**
 * Tests — PR 6: reconciliation and health (§6/§15)
 * scripts/test-ci-reconcile.js
 *
 * Reconciliation exists because the pipeline cannot audit itself: a call that
 * was never discovered is invisible to every health view, and the system
 * reports itself healthy precisely because the missing work is missing. So
 * these tests are about the two ways reconciliation can be useless —
 *
 *   1. IT MISSES A REAL GAP (a call Five9 says had audio, which we do not hold)
 *   2. IT CRIES WOLF (counting deliberate exclusions, or re-recording the same
 *      gap on every run until the log is meaningless)
 *
 * The handoff names both: "reconciliation inserts a seeded gap; no duplicate
 * insert on re-run".
 *
 * Run: node --test scripts/test-ci-reconcile.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  reconcileDay,
  classifyCall,
  expectedSegments,
  beforeTransferRecording,
  GAP_STAGE,
  GAP_EVENT,
} from '../src/ci/reconcile.js';
import { parseConfig } from '../src/ci/config.js';

const CFG = parseConfig({});
const DATE = '2026-08-21';

const call = (over = {}) => ({
  id: `call-${over.n ?? 1}`,
  five9_call_id: '300000010270763',
  call_start: `${DATE}T16:00:06.000Z`,
  campaign: 'Rehash',
  ani: '7273302574',
  was_transferred: false,
  status: 'completed',
  raw_metadata: { recording_segments: [{ at: '09:00:25', duration: '0:43' }], expected_recording_count: 1 },
  ...over,
});

const ingested = [{ id: 'r1', excluded: false, storage_path: 'call/abc.wav' }];

/**
 * Minimal PostgREST-shaped fake over in-memory tables, honouring the filters
 * reconcileDay actually uses.
 */
function fakeDb({ calls = [], recordings = {}, events = [] } = {}) {
  const inserted = [];
  return {
    events,
    inserted,
    from(table) {
      const filters = {};
      const chain = {
        select() { return chain; },
        eq(c, v) { filters[c] = v; return chain; },
        gte(c, v) { filters[`${c}__gte`] = v; return chain; },
        lte(c, v) { filters[`${c}__lte`] = v; return chain; },
        limit() {
          if (table === 'ci_calls') {
            const rows = calls.filter((r) =>
              (!filters.call_start__gte || r.call_start >= filters.call_start__gte)
              && (!filters.call_start__lte || r.call_start <= filters.call_start__lte));
            return Promise.resolve({ data: rows, error: null });
          }
          if (table === 'ci_events') {
            const rows = events.filter((e) =>
              e.call_id === filters.call_id && e.stage === filters.stage && e.event === filters.event);
            return Promise.resolve({ data: rows, error: null });
          }
          return Promise.resolve({ data: [], error: null });
        },
        then(res, rej) {
          if (table === 'ci_recordings') {
            return Promise.resolve({ data: recordings[filters.call_id] || [], error: null }).then(res, rej);
          }
          return Promise.resolve({ data: [], error: null }).then(res, rej);
        },
        insert(row) {
          inserted.push({ table, row });
          if (table === 'ci_events') events.push(row);
          return Promise.resolve({ error: null });
        },
      };
      return chain;
    },
  };
}

// ─── what counts as expected audio ──────────────────────────────────────────

test('the segments array is the authority, with the count as a fallback', () => {
  assert.equal(expectedSegments(call()), 1);
  assert.equal(expectedSegments({ raw_metadata: { recording_segments: [] } }), 0);
  assert.equal(expectedSegments({ raw_metadata: { expected_recording_count: 3 } }), 3);
  assert.equal(expectedSegments({}), 0);
  // A call the log says had SEVEN segments (the observed hold-heavy case).
  assert.equal(expectedSegments({ raw_metadata: { recording_segments: new Array(7).fill({}) } }), 7);
});

// ─── 1. a real gap is found ─────────────────────────────────────────────────

test('GAP: the log says there was audio and we hold none', () => {
  const v = classifyCall(call(), [], CFG);
  assert.equal(v.gap, true);
  assert.equal(v.reason, 'no_recording_ingested');
});

test('GAP: a recording row exists but carries no stored audio', () => {
  // The row was created and the fetch then failed — the most deceptive case,
  // because a naive "does a ci_recordings row exist?" check calls this fine.
  const v = classifyCall(call(), [{ id: 'r1', excluded: false, storage_path: null }], CFG);
  assert.equal(v.gap, true);
  assert.equal(v.reason, 'recording_row_without_audio');
});

test('reconcileDay records a seeded gap and reports it', async () => {
  const db = fakeDb({ calls: [call()], recordings: {} });
  const r = await reconcileDay({ db, cfg: CFG, date: DATE });

  assert.equal(r.examined, 1);
  assert.equal(r.gaps, 1);
  assert.equal(r.recorded, 1);

  assert.equal(db.inserted.length, 1);
  const ev = db.inserted[0].row;
  assert.equal(ev.stage, GAP_STAGE);
  assert.equal(ev.event, GAP_EVENT);
  assert.equal(ev.detail.expected_segments, 1);
  // §10: last-4 only, in the house masked form, never the full number.
  assert.equal(ev.detail.phone, 'x2574');
  assert.equal(JSON.stringify(ev).includes('7273302574'), false);
});

// ─── 2. no duplicate insert on re-run ───────────────────────────────────────

test('NO DUPLICATE ON RE-RUN: a second pass over an unchanged day writes nothing', async () => {
  const db = fakeDb({ calls: [call()], recordings: {} });

  const first = await reconcileDay({ db, cfg: CFG, date: DATE });
  assert.equal(first.recorded, 1);

  const second = await reconcileDay({ db, cfg: CFG, date: DATE });
  // The gap is still REPORTED — it has not been fixed — but not re-recorded.
  assert.equal(second.gaps, 1, 'an unfixed gap must still be counted');
  assert.equal(second.recorded, 0, 'but it must not be written a second time');
  assert.equal(second.skipped.gap_already_recorded, 1);

  assert.equal(db.inserted.length, 1, 'exactly one event across both runs');
});

// ─── crying wolf: the three legitimate non-gaps ─────────────────────────────

test('NOT A GAP: the call log recorded no segments at all', () => {
  const v = classifyCall(call({ raw_metadata: { recording_segments: [] } }), [], CFG);
  assert.equal(v.gap, false);
  assert.equal(v.reason, 'no_segments_expected');
});

test('NOT A GAP: the audio was ingested', () => {
  assert.deepEqual(classifyCall(call(), ingested, CFG), { gap: false, reason: 'ingested' });
});

test('NOT A GAP: the recording was excluded on purpose', () => {
  // Transfer-module test calls and sub-min-bytes files are excluded by design;
  // counting them would bury the real gaps in noise.
  const v = classifyCall(call(), [{ id: 'r1', excluded: true, excluded_reason: 'below_min_bytes' }], CFG);
  assert.equal(v.gap, false);
  assert.equal(v.reason, 'excluded_on_purpose');
});

test('a call with BOTH an excluded and a good recording is ingested, not excluded', () => {
  const v = classifyCall(call(), [
    { id: 'r1', excluded: true, excluded_reason: 'below_min_bytes' },
    { id: 'r2', excluded: false, storage_path: 'call/good.wav' },
  ], CFG);
  assert.equal(v.reason, 'ingested');
});

// ─── the transfer-recording cutoff ──────────────────────────────────────────

test('a transfer leg before CI_TRANSFER_RECORDING_ENABLED_FROM is exempt', () => {
  const cfg = parseConfig({ CI_TRANSFER_RECORDING_ENABLED_FROM: '2026-08-15' });
  const before = call({ was_transferred: true, call_start: '2026-08-10T16:00:00.000Z' });
  const after = call({ was_transferred: true, call_start: '2026-08-20T16:00:00.000Z' });

  assert.equal(beforeTransferRecording(before, cfg), true);
  assert.equal(classifyCall(before, [], cfg).gap, false);
  assert.equal(classifyCall(before, [], cfg).reason, 'transfer_leg_before_recording_enabled');

  // After the cutoff it IS a gap — that is the whole point of having a date.
  assert.equal(beforeTransferRecording(after, cfg), false);
  assert.equal(classifyCall(after, [], cfg).gap, true);
});

test('AN UNSET CUTOFF EXEMPTS NOTHING — absent config must not excuse a gap', () => {
  // The dangerous reading: treat "no date configured" as "recording was never
  // on", which would silently forgive every transfer leg forever.
  const transfer = call({ was_transferred: true, call_start: '2020-01-01T00:00:00.000Z' });
  assert.equal(beforeTransferRecording(transfer, parseConfig({})), false);
  assert.equal(classifyCall(transfer, [], parseConfig({})).gap, true);

  // A malformed date is likewise not an exemption.
  const bad = parseConfig({ CI_TRANSFER_RECORDING_ENABLED_FROM: 'whenever' });
  assert.equal(beforeTransferRecording(transfer, bad), false);
});

test('the cutoff only applies to TRANSFER legs, not to ordinary calls', () => {
  const cfg = parseConfig({ CI_TRANSFER_RECORDING_ENABLED_FROM: '2026-08-15' });
  const ordinary = call({ was_transferred: false, call_start: '2026-08-10T16:00:00.000Z' });
  assert.equal(beforeTransferRecording(ordinary, cfg), false);
  assert.equal(classifyCall(ordinary, [], cfg).gap, true);
});

// ─── input guards ───────────────────────────────────────────────────────────

test('reconcileDay refuses anything that is not a YYYY-MM-DD date', async () => {
  const db = fakeDb({});
  for (const bad of ['', null, '08/21/2026', '2026-8-21', 'yesterday']) {
    await assert.rejects(() => reconcileDay({ db, cfg: CFG, date: bad }), /YYYY-MM-DD/);
  }
});

test('a day with a mix reports each skip reason separately', async () => {
  const db = fakeDb({
    calls: [
      call({ n: 1, id: 'c1' }),
      call({ n: 2, id: 'c2' }),
      call({ n: 3, id: 'c3', raw_metadata: { recording_segments: [] } }),
    ],
    recordings: { c2: ingested },
  });
  const r = await reconcileDay({ db, cfg: CFG, date: DATE });
  assert.equal(r.examined, 3);
  assert.equal(r.gaps, 1);
  assert.equal(r.skipped.ingested, 1);
  assert.equal(r.skipped.no_segments_expected, 1);
});
