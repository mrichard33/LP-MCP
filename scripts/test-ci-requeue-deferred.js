/**
 * Tests — the DNC / cancellation backlog gets BOTH, not one or the other
 * scripts/test-ci-requeue-deferred.js
 *
 * WHAT THIS SCRIPT IS FOR. sql/073 made a DNC or cancellation request deliver
 * its note and THEN queue for a human. That is driven by
 * ci_calls.pending_review_reason, which stageAnalyze sets — and a requeued
 * backlog call never re-runs stageAnalyze. resumeStatusFor resolves these 85
 * calls to 'analyzed' (they all have a current summary), which dispatches
 * MATCH. So a plain `requeue-ci-review.js --reason=dnc_request` delivers the
 * notes and then COMPLETES every call, while applyResolve clears
 * review_reason — the backlog empties out of the review queue and nobody is
 * left prompted to action "take me off your list".
 *
 * THE THREE TRAPS:
 *
 * 1. ORDER. Column first, requeue second. Interrupted between them the call is
 *    still parked with a pending reason — harmless, and re-running is
 *    idempotent. Interrupted the other way the call is in flight with NO
 *    reason, completes, and the request is gone from the queue with nothing to
 *    show it existed. A failed column write must therefore SKIP the requeue.
 * 2. THE REASON SET IS CLOSED. Copying any other review_reason into
 *    pending_review_reason would make stageSync park a call on a reason the
 *    pipeline never deferred — re-parking a low-confidence transcript AFTER
 *    writing the note it was parked to prevent.
 * 3. ONE BAD CALL MUST NOT ABANDON THE BATCH. Per-call failures are collected,
 *    not thrown.
 *
 * No network, no DB — Supabase and applyResolve are doubles.
 *
 * Run: node --test scripts/test-ci-requeue-deferred.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs, planSelection, requeueOne, ELIGIBLE_REASONS } from './requeue-ci-deferred.js';
import { DEFER_REVIEW_UNTIL_SYNCED } from '../src/ci/analysis-schema.js';

// ─── flags ──────────────────────────────────────────────────────────────────

test('the flags parse, and nothing writes without --execute', () => {
  assert.deepEqual(parseArgs([]), { reasons: [], execute: false, limit: null });
  const a = parseArgs(['--reason=dnc_request', '--limit=5', '--execute']);
  assert.deepEqual(a.reasons, ['dnc_request']);
  assert.equal(a.limit, 5);
  assert.equal(a.execute, true);
  // Junk limits are ignored rather than becoming 0 or NaN.
  assert.equal(parseArgs(['--limit=0']).limit, null);
  assert.equal(parseArgs(['--limit=abc']).limit, null);
});

// ─── the reason set is closed ───────────────────────────────────────────────

test('no --reason selects the WHOLE deferred set — the intended use', () => {
  const p = planSelection(parseArgs([]));
  assert.equal(p.ok, true);
  assert.deepEqual(p.reasons.slice().sort(), ['cancellation_request', 'dnc_request']);
  assert.deepEqual(ELIGIBLE_REASONS.slice().sort(), [...DEFER_REVIEW_UNTIL_SYNCED].sort());
});

test('a reason OUTSIDE the deferred set is refused, with the reason why', () => {
  // Carrying this one would park the call on it AFTER writing the note it was
  // parked to prevent — the quality gate inverted.
  const p = planSelection(parseArgs(['--reason=low_confidence_transcript']));
  assert.equal(p.ok, false);
  assert.match(p.error, /low_confidence_transcript/);
  assert.match(p.error, /never deferred/);
});

test('one good reason and one bad refuses the whole run', () => {
  const p = planSelection(parseArgs(['--reason=dnc_request', '--reason=unknown_team']));
  assert.equal(p.ok, false, 'partial acceptance would silently do half of what was asked');
  assert.match(p.error, /unknown_team/);
});

test('unknown_team is specifically NOT eligible', () => {
  // It is deliver-and-complete (NON_BLOCKING_REVIEW_FLAGS), not
  // deliver-and-queue. Carrying it would re-queue 84 calls nobody can clear.
  assert.equal(DEFER_REVIEW_UNTIL_SYNCED.has('unknown_team'), false);
  assert.equal(planSelection({ reasons: ['unknown_team'] }).ok, false);
});

// ─── the order ──────────────────────────────────────────────────────────────

/** A db double whose ci_calls update can be made to fail. */
function fakeDb({ updateError = null } = {}) {
  const log = [];
  return {
    log,
    from(table) {
      const chain = {
        update(patch) {
          const thenable = {
            eq(col, val) { log.push({ table, op: 'update', patch, id: val }); return thenable; },
            then: (res, rej) => Promise.resolve({ error: updateError }).then(res, rej),
          };
          return thenable;
        },
      };
      return chain;
    },
  };
}

const CALL = { id: 'c1', five9_call_id: '300000010270763', review_reason: 'dnc_request', attempts: 3 };

test('the reason is carried into pending_review_reason, THEN the call is requeued', async () => {
  const db = fakeDb();
  const order = [];
  const resolve = async () => { order.push('requeue'); return { status: 'analyzed' }; };

  const r = await requeueOne(db, CALL, { resolve });

  assert.equal(r.ok, true);
  assert.equal(r.requeued, true);
  assert.equal(r.carried, 'dnc_request');
  assert.equal(r.status, 'analyzed');

  assert.deepEqual(db.log[0].patch, { pending_review_reason: 'dnc_request' });
  assert.equal(db.log[0].id, 'c1');
  assert.deepEqual(order, ['requeue'], 'and the requeue happened after it');
});

test('A FAILED COLUMN WRITE DOES NOT REQUEUE THE CALL', async () => {
  // In flight with no reason is the one outcome worse than leaving the call
  // exactly where it is: it completes, and the customer's request vanishes
  // from the queue with nothing to show it existed.
  const db = fakeDb({ updateError: { message: 'column "pending_review_reason" does not exist' } });
  let requeued = false;
  const resolve = async () => { requeued = true; return { status: 'analyzed' }; };

  const r = await requeueOne(db, CALL, { resolve });

  assert.equal(r.ok, false);
  assert.equal(r.requeued, false);
  assert.equal(requeued, false, 'applyResolve must NOT have been reached');
  assert.match(r.error, /pending_review_reason write failed/);
  assert.match(r.error, /does not exist/, 'the real cause survives into the message');
});

test('a failed requeue leaves the column set and the call parked — re-runnable', async () => {
  const db = fakeDb();
  const resolve = async () => { throw new Error('ci_calls update failed: timeout'); };

  const r = await requeueOne(db, CALL, { resolve });

  assert.equal(r.ok, false);
  assert.equal(r.requeued, false);
  assert.match(r.error, /requeue failed: .*timeout/);
  // The carry DID happen. The call is still in review, so a re-run just sets
  // the same value again and retries the requeue.
  assert.deepEqual(db.log[0].patch, { pending_review_reason: 'dnc_request' });
});

test('a per-call failure is returned, never thrown', async () => {
  // One bad call must not abandon the rest of the batch half-done.
  const db = fakeDb({ updateError: { message: 'nope' } });
  await assert.doesNotReject(() => requeueOne(db, CALL, { resolve: async () => ({ status: 'analyzed' }) }));
});

test('a cancellation request carries its own reason, not a hardcoded one', async () => {
  const db = fakeDb();
  const r = await requeueOne(
    db,
    { ...CALL, review_reason: 'cancellation_request' },
    { resolve: async () => ({ status: 'analyzed' }) },
  );
  assert.equal(r.carried, 'cancellation_request');
  assert.deepEqual(db.log[0].patch, { pending_review_reason: 'cancellation_request' });
});

// ─── what the script must not contain ───────────────────────────────────────

test('the requeue goes through applyResolve, never a hand-rolled status UPDATE', async () => {
  const src = await import('node:fs').then((fs) => fs.readFileSync(
    new URL('./requeue-ci-deferred.js', import.meta.url), 'utf8',
  ));
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  assert.match(code, /applyResolve/, 'it must call the same function the endpoint calls');
  // The ONLY update this script writes itself is the carry. A hand-rolled
  // status/attempts update is how `attempts = 0` gets forgotten or a call is
  // sent back to the wrong stage — neither failure announces itself.
  const updates = [...code.matchAll(/\.update\(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(updates, ['{ pending_review_reason: call.review_reason }']);
  // And it must not action anything on the customer's behalf.
  assert.equal(/dnc_list|add_tag|addTags|cancel_appointment/i.test(code), false);
});
