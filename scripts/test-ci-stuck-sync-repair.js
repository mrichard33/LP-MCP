/**
 * Tests — the stuck-sync repair must refuse everything but the one error
 * scripts/test-ci-stuck-sync-repair.js
 *
 * scripts/repair-ci-stuck-syncs.js deletes ci_syncs rows, which releases their
 * UNIQUE idempotency_key. That is the one thing markSyncFailed() refuses to do,
 * and for a good reason: a released key lets a retry re-post a note that may
 * already have landed. The exception is legitimate for exactly one error — the
 * missing-client TypeError, which is thrown by the line that calls the client
 * and therefore precedes the request.
 *
 * So the entire safety of that script is its filter, and these tests are about
 * what it must NOT release. A widened filter is a double-posted note on a
 * customer's record.
 *
 * No network, no DB — the planners are pure.
 *
 * Run: node --test scripts/test-ci-stuck-sync-repair.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyRow, planRepair, planParentReset, parseArgs,
  RELEASABLE_STATUSES, PARENT_RESET_PATCH,
} from './repair-ci-stuck-syncs.js';

/** The row shape the live table actually holds, as observed 2026-08-24. */
const STUCK_LP = {
  id: 'ca9d75cb-92f6-4b86-b372-da560fe9f724',
  call_id: '8fff91b7-ed35-4adb-8f00-bb049d154bd8',
  target: 'lp',
  status: 'pending',
  external_ref: null,
  response: null,
  error: "Cannot read properties of undefined (reading 'addNote')",
  attempts: 1,
};

const STUCK_GHL = {
  ...STUCK_LP,
  id: 'sync-ghl-1',
  target: 'ghl',
  error: "Cannot read properties of undefined (reading 'addGHLNote')",
};

// ─── what IS releasable ─────────────────────────────────────────────────────

test('the live LP row — the exact one the incident produced — is releasable', () => {
  assert.equal(classifyRow(STUCK_LP).releasable, true);
});

test('the GHL equivalent is releasable too, and a terminal failure as well', () => {
  assert.equal(classifyRow(STUCK_GHL).releasable, true);
  assert.equal(classifyRow({ ...STUCK_LP, status: 'failed', attempts: 5 }).releasable, true);
  // A client injected as null fails identically and equally provably.
  assert.equal(
    classifyRow({ ...STUCK_LP, error: "Cannot read properties of null (reading 'addNote')" }).releasable,
    true,
  );
});

// ─── what must NEVER be released ────────────────────────────────────────────

test('a row with an external_ref is REFUSED — a CRM accepted that write', () => {
  const v = classifyRow({ ...STUCK_LP, external_ref: '99123' });
  assert.equal(v.releasable, false);
  assert.match(v.reason, /external_ref/);
});

test('a row with a recorded CRM response is REFUSED — the request was made', () => {
  const v = classifyRow({ ...STUCK_LP, response: { shape: 'object', keys: ['note_id'] } });
  assert.equal(v.releasable, false);
  assert.match(v.reason, /response/);
});

test('ANY other error is REFUSED — it may have landed', () => {
  // These are the failures that make deleting a sync row dangerous in general:
  // every one of them can happen AFTER the request reached the CRM.
  const others = [
    'LP API 500: Internal Server Error',
    'The operation was aborted due to timeout',
    'fetch failed',
    'LP API 401: token expired',
    'addNote: recid is required',
    null,
    '',
  ];
  for (const error of others) {
    const v = classifyRow({ ...STUCK_LP, error });
    assert.equal(v.releasable, false, `released on: ${error}`);
  }
});

test('an error that merely CONTAINS the phrase is REFUSED — the match is anchored', () => {
  // A wrapper that swallowed the TypeError and kept going could have made the
  // request. Only the bare message proves the throw preceded it.
  const wrapped = [
    "LP API 500 after Cannot read properties of undefined (reading 'addNote')",
    "Cannot read properties of undefined (reading 'addNote') — retried and posted",
    "Cannot read properties of undefined (reading 'addNotes')",
  ];
  for (const error of wrapped) {
    assert.equal(classifyRow({ ...STUCK_LP, error }).releasable, false, `released on: ${error}`);
  }
});

test('the error must name THIS row\'s own client', () => {
  // An 'lp' row carrying the addGHLNote message did not come from the LP write
  // site, so nothing about it proves the LP request was never made.
  assert.equal(classifyRow({ ...STUCK_LP, error: STUCK_GHL.error }).releasable, false);
  assert.equal(classifyRow({ ...STUCK_GHL, error: STUCK_LP.error }).releasable, false);
});

test('a synced or shadow row is REFUSED whatever its error says', () => {
  for (const status of ['synced', 'shadow', 'skipped']) {
    const v = classifyRow({ ...STUCK_LP, status });
    assert.equal(v.releasable, false, `released a '${status}' row`);
    assert.match(v.reason, /status/);
  }
  assert.deepEqual(RELEASABLE_STATUSES, ['pending', 'failed']);
});

test('an unknown target is REFUSED rather than pattern-matched loosely', () => {
  assert.equal(classifyRow({ ...STUCK_LP, target: 'salesforce' }).releasable, false);
  assert.equal(classifyRow({ ...STUCK_LP, target: null }).releasable, false);
});

// ─── planning over a mixed page ─────────────────────────────────────────────

test('a mixed page splits into release and refuse, and loses nothing', () => {
  const rows = [
    STUCK_LP,
    STUCK_GHL,
    { ...STUCK_LP, id: 'r3', error: 'LP API 503' },
    { ...STUCK_LP, id: 'r4', external_ref: '77' },
  ];
  const { release, refuse } = planRepair(rows);
  assert.deepEqual(release.map((r) => r.row.id), [STUCK_LP.id, 'sync-ghl-1']);
  assert.deepEqual(refuse.map((r) => r.row.id), ['r3', 'r4']);
  assert.equal(release.length + refuse.length, rows.length, 'every row examined is accounted for');
});

test('an empty or absent page is not an error', () => {
  assert.deepEqual(planRepair([]), { release: [], refuse: [] });
  assert.deepEqual(planRepair(undefined), { release: [], refuse: [] });
});

// ─── the parent reset ───────────────────────────────────────────────────────

const RELEASED_IDS = ['call-1', 'call-2'];

test('only a sync_failed call whose key was released is reset', () => {
  const calls = [
    { id: 'call-1', status: 'review', review_reason: 'sync_failed' },
    { id: 'call-2', status: 'completed', review_reason: 'sync_failed' },
    // Parked for a different reason — the sync is not why it is in review.
    { id: 'call-3', status: 'review', review_reason: 'recording_missing' },
    // A key we did NOT release: none of this script's business.
    { id: 'call-9', status: 'review', review_reason: 'sync_failed' },
  ];
  const reset = planParentReset(calls, [...RELEASED_IDS, 'call-3']);
  assert.deepEqual(reset.map((c) => c.id), ['call-1', 'call-2']);
});

test('a call still mid-pipeline is left exactly where it is', () => {
  // The live rows on 2026-08-24 were all still 'matched' with attempts=0: the
  // deferred-retry path, not the review path. Releasing the key is enough;
  // rewriting the status would be a change with no reason behind it.
  const calls = [
    { id: 'call-1', status: 'matched', review_reason: null },
    { id: 'call-2', status: 'syncing', review_reason: null },
  ];
  assert.deepEqual(planParentReset(calls, RELEASED_IDS), []);
});

test('the reset clears the lease and the retry timer, or the call never runs', () => {
  // A call left holding next_retry_at or a lease sits there after the repair,
  // which looks exactly like the repair not working.
  // 'syncing', not 'matched': stageSync claims 'syncing'. Since the early
  // match gate moved matching ahead of transcription, 'matched' is the
  // TRANSCRIBE rung — resetting there would put a call whose note merely
  // needs re-sending back through analysis.
  assert.equal(PARENT_RESET_PATCH.status, 'syncing');
  assert.equal(PARENT_RESET_PATCH.attempts, 0);
  assert.equal(PARENT_RESET_PATCH.next_retry_at, null);
  assert.equal(PARENT_RESET_PATCH.locked_until, null);
  assert.equal(PARENT_RESET_PATCH.locked_by, null);
  assert.equal(PARENT_RESET_PATCH.review_reason, null);
});

// ─── flags ──────────────────────────────────────────────────────────────────

test('it is dry-run unless --execute is passed', () => {
  assert.equal(parseArgs([]).execute, false);
  assert.equal(parseArgs(['--limit=10']).execute, false);
  assert.equal(parseArgs(['--execute']).execute, true);
  assert.equal(parseArgs(['--limit=25']).limit, 25);
  assert.equal(parseArgs(['--limit=nonsense']).limit, null);
  assert.equal(parseArgs(['--limit=-4']).limit, null);
});
