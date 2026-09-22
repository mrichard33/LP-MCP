/**
 * L.6 auto-call — src/loss-routing/l6.js, and the reverse lost-reason map in
 * src/lp-lost-reasons.js.
 *
 * 2026-09-22. Every GHL write and the webhook POST go through injected fakes;
 * the tests assert on the calls they record.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { LOST_REASON_IDS, lostReasonNameForId } from '../src/lp-lost-reasons.js';
import {
  LOST_TYPE_BY_LABEL, lostTypeForLabel, buildL6Body, maybePostL6, postL6AfterP2Loss, P2_TERMINAL_RULE_KEY,
} from '../src/loss-routing/l6.js';

const CUSTOMER_CANCELLED = LOST_REASON_IDS['Customer Cancelled'];

function fakes({ tags = ['source:internet'], posted = false, httpOk = true } = {}) {
  const calls = { posts: [], logs: [], ghl: [] };
  const deps = {
    ghlFetch: async (method, path) => {
      calls.ghl.push([method, path]);
      return { contact: { id: 'c1', email: 'a@b.c', phone: '+15550000000', tags } };
    },
    hasPostedL6: async () => (typeof posted === 'function' ? posted() : posted),
    logHygiene: async (row) => { calls.logs.push(row); return { logged: true }; },
    fetch: async (url, init) => {
      calls.posts.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return { ok: httpOk, status: httpOk ? 200 : 500, text: async () => 'x' };
    },
    webhookUrl: 'https://example.invalid/l6',
  };
  return { deps, calls };
}

test('every lost reason id reverse-maps to its label; unknown → null', () => {
  for (const [name, id] of Object.entries(LOST_REASON_IDS)) {
    assert.equal(lostReasonNameForId(id), name);
  }
  assert.equal(lostReasonNameForId('000000000000000000000000'), null);
  assert.equal(lostReasonNameForId(''), null);
  assert.equal(lostReasonNameForId(undefined), null);
});

test('lost type map matches the handoff', () => {
  assert.equal(lostTypeForLabel('Customer Cancelled'), 'Soft');
  assert.equal(lostTypeForLabel('Ghosted / Unresponsive'), 'Soft');
  for (const l of ['Deferred / Timing', 'Not Interested (Now)', 'Price / Shopping', 'Bad Fit (Preference)']) {
    assert.equal(lostTypeForLabel(l), 'Soft', l);
  }
  assert.equal(lostTypeForLabel('Financing Denied'), 'Hard (Recoverable)');
  for (const l of ['Collections / Attorney', 'Cannot Qualify', 'Out of Service Area', 'DNC']) {
    assert.equal(lostTypeForLabel(l), 'Hard (Permanent)', l);
  }
  assert.equal(lostTypeForLabel('Invalid Lead'), null);
  // Every mapped label is a real GHL lost reason.
  for (const label of Object.keys(LOST_TYPE_BY_LABEL)) assert.ok(LOST_REASON_IDS[label], label);
});

test('the body carries all eight fields', () => {
  const body = buildL6Body({ contactId: 'c1', email: 'e', phone: 'p', opportunityId: 'o1', lostType: 'Soft', lostReasonLabel: 'Customer Cancelled' });
  assert.deepEqual(Object.keys(body).sort(),
    ['contactId', 'contact_id', 'email', 'holdReason', 'lostReasonLabel', 'lostType', 'opportunityId', 'phone']);
  assert.equal(body.holdReason, '');
  assert.equal(body.contact_id, body.contactId);
});

test('posts once, then the second call for the same opportunity does not post', async () => {
  let posted = false;
  const { deps, calls } = fakes({ posted: () => posted });
  const args = { contactId: 'c1', opportunityId: 'o1', lostReasonId: CUSTOMER_CANCELLED, runType: 'l6_auto', runId: 'r1' };
  const first = await maybePostL6(args, deps);
  assert.equal(first.action, 'posted_l6');
  assert.equal(calls.posts.length, 1);
  assert.equal(calls.posts[0].body.lostType, 'Soft');
  assert.equal(calls.posts[0].body.lostReasonLabel, 'Customer Cancelled');
  assert.equal(calls.posts[0].headers['Content-Type'], 'application/json');
  assert.equal(calls.logs.at(-1).action, 'posted_l6');
  assert.equal(calls.logs.at(-1).mode, 'apply');
  posted = true;  // what the log now says
  const second = await maybePostL6(args, deps);
  assert.equal(second.action, 'skipped');
  assert.equal(second.reason, 'already_posted');
  assert.equal(calls.posts.length, 1);
});

test('no post when the live contact already has a p3:* tag', async () => {
  const { deps, calls } = fakes({ tags: ['P3:Ghosted'] });
  const r = await maybePostL6({ contactId: 'c1', opportunityId: 'o1', lostReasonId: CUSTOMER_CANCELLED, runType: 'l6_auto', runId: 'r' }, deps);
  assert.equal(r.reason, 'already_has_p3_tag');
  assert.equal(calls.posts.length, 0);
});

test('an unreadable idempotency record means no post', async () => {
  const { deps, calls } = fakes({ posted: null });
  const r = await maybePostL6({ contactId: 'c1', opportunityId: 'o1', lostReasonId: CUSTOMER_CANCELLED, runType: 'l6_auto', runId: 'r' }, deps);
  assert.equal(r.reason, 'idempotency_unreadable');
  assert.equal(calls.posts.length, 0);
});

test('unknown or unmapped lost reason → needs_review, no post', async () => {
  for (const lostReasonId of ['000000000000000000000000', LOST_REASON_IDS['Invalid Lead'], null]) {
    const { deps, calls } = fakes();
    const r = await maybePostL6({ contactId: 'c1', opportunityId: 'o1', lostReasonId, runType: 'backfill_p2', runId: 'r' }, deps);
    assert.equal(r.action, 'needs_review', String(lostReasonId));
    assert.equal(calls.posts.length, 0);
    assert.equal(calls.logs[0].action, 'needs_review');
  }
});

test('dry run decides and logs under mode=report, never posts', async () => {
  const { deps, calls } = fakes();
  const r = await maybePostL6({ contactId: 'c1', opportunityId: 'o1', lostReasonId: CUSTOMER_CANCELLED, runType: 'backfill_p2', runId: 'r', apply: false }, deps);
  assert.equal(r.reason, 'dry_run');
  assert.equal(calls.posts.length, 0);
  assert.equal(calls.logs[0].mode, 'report');
});

test('no L6_WEBHOOK_URL → skipped, never posted', async () => {
  const { deps, calls } = fakes();
  deps.webhookUrl = '';
  const r = await maybePostL6({ contactId: 'c1', opportunityId: 'o1', lostReasonId: CUSTOMER_CANCELLED, runType: 'l6_auto', runId: 'r' }, deps);
  assert.equal(r.action, 'skipped');
  assert.equal(calls.posts.length, 0);
});

test('an L.6 HTTP error is reported as failed, not as posted', async () => {
  const { deps, calls } = fakes({ httpOk: false });
  const r = await maybePostL6({ contactId: 'c1', opportunityId: 'o1', lostReasonId: CUSTOMER_CANCELLED, runType: 'l6_auto', runId: 'r' }, deps);
  assert.equal(r.action, 'failed');
  assert.ok(!calls.logs.some((l) => l.action === 'posted_l6'));
});

test('the executor hook fires only for P2_JOB_TERMINAL_LOST after a successful update', async () => {
  const ok = { action: 'opportunity_updated', opportunity_id: 'o1', contact_id: 'c1' };
  {
    const { deps, calls } = fakes();
    assert.equal(await postL6AfterP2Loss({ id: 1, rule_applied: 'SOME_OTHER_RULE', target_id: 'c1' }, ok, CUSTOMER_CANCELLED, deps), null);
    assert.equal(await postL6AfterP2Loss({ id: 1, rule_applied: P2_TERMINAL_RULE_KEY, target_id: 'c1' }, { action: 'no_op' }, CUSTOMER_CANCELLED, deps), null);
    assert.equal(calls.posts.length, 0);
  }
  {
    const { deps, calls } = fakes();
    const r = await postL6AfterP2Loss({ id: 42, rule_applied: P2_TERMINAL_RULE_KEY, target_id: 'c1' }, ok, CUSTOMER_CANCELLED, deps);
    assert.equal(r.action, 'posted_l6');
    assert.equal(calls.posts.length, 1);
    assert.equal(calls.logs.at(-1).run_type, 'l6_auto');
    assert.equal(calls.logs.at(-1).run_id, 'l6_auto:42');
  }
});

test('the executor hook never throws', async () => {
  const deps = {
    ghlFetch: async () => { throw new Error('GHL down'); },
    hasPostedL6: async () => false,
    logHygiene: async () => { throw new Error('log down'); },
    fetch: async () => { throw new Error('unreachable'); },
    webhookUrl: 'https://example.invalid/l6',
  };
  const r = await postL6AfterP2Loss(
    { id: 1, rule_applied: P2_TERMINAL_RULE_KEY, target_id: 'c1' },
    { action: 'opportunity_updated', opportunity_id: 'o1', contact_id: 'c1' },
    CUSTOMER_CANCELLED, deps,
  );
  assert.equal(r.action, 'failed');
});
