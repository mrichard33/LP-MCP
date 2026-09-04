/**
 * Tests — lp_callback_requeue idempotency
 * scripts/test-lp-requeue-idempotency.js
 *
 * Node's built-in test runner. No DB, no network. Run with:
 *
 *   node --test scripts/test-lp-requeue-idempotency.js
 *
 * THE REGRESSION THIS FILE EXISTS FOR (case 1 below):
 * 2026-09-03, contact eqjK58AwEZ1juYJH6szE (Tom Messick, LP prospect 314141).
 * Action 418351 (lp_callback_requeue) completed with retry_count 2 — three
 * handler attempts, each of which ran executeLpCallbackRequeue from the top and
 * each of which posted a fresh LP LeadAdd. LP issued 572927, 572928 and 572929
 * inside 70 seconds, all Data, no appointment.
 *
 * recentRequeueExists() filtered `.eq('status','completed')`, so an action's OWN
 * in-flight attempt was invisible to it: a row mid-retry is 'executing' or
 * 'failed', never 'completed'. The retries sailed straight past the guard.
 *
 * The binding rule is now: a retry of the same action row is duplicate BY
 * DEFINITION, checked before any query. Case 1 asserts exactly that, and fails
 * against the pre-fix code (which returned duplicate:false for this shape).
 *
 * Cases 2-6 pin the rest of the dedup contract, including the fail-CLOSED path
 * that must survive every future edit. Case 7 pins the bounded queue scan, whose
 * unbounded predecessor is what blew the executor's 60s handler budget and
 * caused the retries in the first place.
 */

// Supabase client construction in src/supabase.js reads env at import time.
// Set harmless dummies so the module graph loads without a live config.
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';

import test from 'node:test';
import assert from 'node:assert/strict';

import { recentRequeueExists } from '../src/services/lp-callback-requeue.js';
import { findLeadInDataQueuesBounded } from '../src/actions/handlers/lp-requeue.js';

const CONTACT = 'eqjK58AwEZ1juYJH6szE';

/**
 * Minimal PostgREST chain stand-in. Every filter method returns the chain; the
 * terminal .limit() resolves to the { data, error } shape the real client gives.
 */
function supabaseChainMock(result) {
  const chain = {};
  const self = () => chain;
  for (const m of ['from', 'select', 'eq', 'gte', 'order']) chain[m] = self;
  chain.limit = async () => result;
  return chain;
}

const nowIso = () => new Date().toISOString();

// ─── 1. THE TOM REGRESSION ─────────────────────────────────────────────────

test('a retry of the SAME action row is a duplicate (the Tom regression)', async () => {
  // No rows are returned at all: the point is that the retry short-circuits
  // BEFORE the query, so a query that finds nothing cannot rescue it. Against
  // the pre-fix code this returned duplicate:false and posted a second LeadAdd.
  let queried = false;
  const db = supabaseChainMock({ data: [], error: null });
  const limit = db.limit;
  db.limit = async (...args) => { queried = true; return limit(...args); };

  const res = await recentRequeueExists(CONTACT, {
    supabase: db,
    currentActionId: 'A',
    retryCount: 1,
  });

  assert.equal(res.duplicate, true, 'a retried action MUST be treated as a duplicate');
  assert.equal(res.reason, 'same_action_retry');
  assert.equal(res.prior_action_id, 'A');
  assert.equal(res.retry_count, 1);
  assert.equal(queried, false, 'the retry rule binds before any query — no DB round trip');
});

test('the retry rule holds for retry_count 2 (action 418351 exactly)', async () => {
  const res = await recentRequeueExists(CONTACT, {
    supabase: supabaseChainMock({ data: [], error: null }),
    currentActionId: 418351,
    retryCount: 2,
  });
  assert.equal(res.duplicate, true);
  assert.equal(res.reason, 'same_action_retry');
  assert.equal(res.prior_action_id, '418351', 'the id is normalised to a string');
});

// ─── 2. A first attempt must never self-deduplicate ────────────────────────

test('a first attempt does not deduplicate against its own row', async () => {
  // Row A is this action, already written as 'executing' by the executor before
  // the handler runs. On attempt 0 it must be excluded, or NO re-queue would
  // ever go out and the customer never gets the call they were promised.
  const res = await recentRequeueExists(CONTACT, {
    supabase: supabaseChainMock({
      data: [{ id: 'A', created_at: nowIso(), status: 'executing', execution_result: null }],
      error: null,
    }),
    currentActionId: 'A',
    retryCount: 0,
  });
  assert.equal(res.duplicate, false, 'the first, legitimate re-queue must proceed');
  assert.equal(res.prior_action_id, null);
});

// ─── 3-5. Other rows in the window ─────────────────────────────────────────

test('ANOTHER in-flight re-queue row is a duplicate (zombie handler may have posted)', async () => {
  const res = await recentRequeueExists(CONTACT, {
    supabase: supabaseChainMock({
      data: [{ id: 'B', created_at: nowIso(), status: 'executing', execution_result: null }],
      error: null,
    }),
    currentActionId: 'A',
    retryCount: 0,
  });
  assert.equal(res.duplicate, true);
  assert.equal(res.reason, 'prior_requeue_in_flight');
  assert.equal(res.prior_action_id, 'B');
  assert.equal(res.prior_status, 'executing');
});

test('ANOTHER failed re-queue row is a duplicate (the LeadAdd may still have landed)', async () => {
  const res = await recentRequeueExists(CONTACT, {
    supabase: supabaseChainMock({
      data: [{ id: 'B', created_at: nowIso(), status: 'failed', execution_result: null }],
      error: null,
    }),
    currentActionId: 'A',
    retryCount: 0,
  });
  assert.equal(res.duplicate, true);
  assert.equal(res.reason, 'prior_requeue_in_flight');
  assert.equal(res.prior_status, 'failed');
});

test('ANOTHER completed re-queue is a duplicate (original behaviour preserved)', async () => {
  const res = await recentRequeueExists(CONTACT, {
    supabase: supabaseChainMock({
      data: [{
        id: 'B',
        created_at: '2026-09-03T23:39:27.000Z',
        status: 'completed',
        execution_result: { requeued: true },
      }],
      error: null,
    }),
    currentActionId: 'A',
    retryCount: 0,
  });
  assert.equal(res.duplicate, true);
  assert.equal(res.reason, 'prior_requeue_completed');
  assert.equal(res.prior_action_id, 'B');
  assert.equal(res.prior_at, '2026-09-03T23:39:27.000Z');
});

test('a completed re-queue outranks an in-flight one (most certain signal wins)', async () => {
  const res = await recentRequeueExists(CONTACT, {
    supabase: supabaseChainMock({
      data: [
        { id: 'C', created_at: nowIso(), status: 'executing', execution_result: null },
        { id: 'B', created_at: nowIso(), status: 'completed', execution_result: { requeued: true } },
      ],
      error: null,
    }),
    currentActionId: 'A',
    retryCount: 0,
  });
  assert.equal(res.reason, 'prior_requeue_completed');
  assert.equal(res.prior_action_id, 'B');
});

test('a prior re-queue that SKIPPED is not a duplicate', async () => {
  // A completed row whose result was requeue_skipped_already_dialable never
  // posted a LeadAdd, so it must not block a later genuine re-queue.
  const res = await recentRequeueExists(CONTACT, {
    supabase: supabaseChainMock({
      data: [{
        id: 'B',
        created_at: nowIso(),
        status: 'completed',
        execution_result: { requeued: false, action: 'requeue_skipped_already_dialable' },
      }],
      error: null,
    }),
    currentActionId: 'A',
    retryCount: 0,
  });
  assert.equal(res.duplicate, false);
});

test('an empty window is not a duplicate', async () => {
  const res = await recentRequeueExists(CONTACT, {
    supabase: supabaseChainMock({ data: [], error: null }),
    currentActionId: 'A',
    retryCount: 0,
  });
  assert.equal(res.duplicate, false);
  assert.equal(res.prior_action_id, null);
  assert.ok(res.window_minutes > 0);
});

// ─── 6. Fail-CLOSED on a query error ───────────────────────────────────────

test('a dedup lookup error fails CLOSED (duplication is the worse failure)', async () => {
  const res = await recentRequeueExists(CONTACT, {
    supabase: supabaseChainMock({ data: null, error: { message: 'boom' } }),
    currentActionId: 'A',
    retryCount: 0,
  });
  assert.equal(res.duplicate, true);
  assert.equal(res.reason, 'dedup_lookup_error');
});

// ─── 7. The bounded queue scan ─────────────────────────────────────────────

test('findLeadInDataQueuesBounded times out instead of blowing the handler budget', async () => {
  // The unbounded scan is what pushed action 418351 past the executor's 60s
  // handler limit and triggered the retries. On timeout it must resolve as
  // "not present" — the scan is an optimisation, not the safety net — and it
  // must NOT throw, or the executor would retry the whole handler again.
  const started = Date.now();
  const neverResolves = () => new Promise(() => {});

  const res = await findLeadInDataQueuesBounded(['567746'], {
    scan: neverResolves,
    timeoutMs: 50,
  });

  const elapsed = Date.now() - started;
  assert.equal(res.present, false, 'a timed-out scan proceeds as "not present"');
  assert.equal(res.scan_timed_out, true, 'the timeout is recorded for forensics');
  assert.equal(res.row, null);
  assert.equal(res.lds_id, null);
  assert.ok(elapsed < 1000, `bounded scan should return promptly, took ${elapsed}ms`);
});

test('findLeadInDataQueuesBounded passes a fast scan result straight through', async () => {
  const hit = { present: true, row: { Cqd_ID: 8 }, lds_id: '567746', truncated_queues: [], cache_age_ms: 0 };
  const res = await findLeadInDataQueuesBounded(['567746'], {
    scan: async () => hit,
    timeoutMs: 5000,
  });
  assert.equal(res.present, true);
  assert.equal(res.lds_id, '567746');
  assert.equal(res.scan_timed_out, undefined, 'a scan that finished is not marked timed out');
});
