/**
 * scripts/test-lp-lost-reasons.js
 *
 * The status → lost reason table is imported by TWO writers — the reconciler
 * (scripts/reconcile-p2-stages.js) and the update_opportunity wrapper
 * (src/actions/index.js) — and what it decides is written to GHL irreversibly.
 * GHL keeps no history that walks a lost reason back.
 *
 * The failure these guard against is a pre-sale reason on a post-contract death.
 * "Customer Cancelled" and "Collections / Attorney" were created specifically for
 * jobs that die after the contract is signed; every other reason in the account
 * says the sale never happened. Substituting one corrupts loss reporting
 * permanently.
 *
 * Pure-function test — no DB, no network.
 * Run: node --test scripts/test-lp-lost-reasons.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LOST_REASON_IDS, JOB_STATUS_LOST_REASON,
  isLostReasonId, lostReasonNameForJobStatus, lostReasonIdForJobStatus,
} from '../src/lp-lost-reasons.js';

test('every mapped status resolves to the id it is documented to', () => {
  // The pairing an operator types into --lost-reason-id, asserted literally.
  assert.equal(lostReasonIdForJobStatus('Cancelled'),        '6aad8dc01f2de24d878ec356');
  assert.equal(lostReasonIdForJobStatus('Cancelled By Mgt'), '6aad8dc01f2de24d878ec356');
  assert.equal(lostReasonIdForJobStatus('Dead Deal'),        '69cd4807e4ce65bc76877f98');
  assert.equal(lostReasonIdForJobStatus('Sent To Attorney'), '6aad8dc0f4cad9983ac319ce');
  assert.equal(lostReasonIdForJobStatus('Credit Decline'),   '69cd48077ac164325a355e36');
});

test('Cancelled and Cancelled By Mgt deliberately share one reason', () => {
  // Who pressed the button is an LP-side distinction. To GHL loss reporting both
  // are a customer cancellation after contract.
  assert.equal(
    lostReasonIdForJobStatus('Cancelled'),
    lostReasonIdForJobStatus('Cancelled By Mgt'),
  );
});

test('Credit Decline gets its OWN reason, not the cancellation one', () => {
  // This is the whole basis on which Credit Decline became a loss (2026-09-18).
  // Folding it in with cancellations would make recovery rate unmeasurable, and
  // that measurement is the thing that answered the original objection.
  assert.equal(lostReasonNameForJobStatus('Credit Decline'), 'Financing Denied');
  assert.notEqual(
    lostReasonIdForJobStatus('Credit Decline'),
    lostReasonIdForJobStatus('Cancelled'),
  );
});

test('every job status maps to a reason that actually exists in the location', () => {
  // A name with no id is a loss the executor refuses to write and the reconciler
  // refuses to plan — caught here instead of at 515 records.
  for (const [status, name] of Object.entries(JOB_STATUS_LOST_REASON)) {
    assert.ok(LOST_REASON_IDS[name], `"${status}" → "${name}" is not a configured reason`);
    assert.ok(lostReasonIdForJobStatus(status), `"${status}" resolved to no id`);
  }
});

test('every id in the table is a well-formed GHL id', () => {
  for (const [name, id] of Object.entries(LOST_REASON_IDS)) {
    assert.ok(isLostReasonId(id), `"${name}" has a malformed id: ${id}`);
  }
});

test('an unmapped status returns null — never a guess, never a default', () => {
  // 'Installed & Unpaid' is not a loss at all; 'Paid In Full' is a win. Neither
  // may borrow a reason. The callers turn this null into a refusal (reconciler)
  // or a thrown action (executor); both are better than a reasonless write.
  for (const status of ['Installed & Unpaid', 'Paid In Full', 'Awaiting Product', 'New', '', null, undefined]) {
    assert.equal(lostReasonIdForJobStatus(status), null, `${status} must not map`);
    assert.equal(lostReasonNameForJobStatus(status), null);
  }
});

test('a status resolves regardless of surrounding whitespace', () => {
  // LP pads its fields (see branch_code's TRIM in src/sync-children.js), and the
  // status arrives on an event subtype that has been through two systems.
  assert.equal(lostReasonIdForJobStatus('  Credit Decline  '), '69cd48077ac164325a355e36');
});

test('the id shape check rejects what a typo actually looks like', () => {
  assert.equal(isLostReasonId('6aad8dc01f2de24d878ec356'), true);
  assert.equal(isLostReasonId('6AAD8DC01F2DE24D878EC356'), true);  // case-insensitive
  assert.equal(isLostReasonId('6aad8dc01f2de24d878ec35'), false);  // 23
  assert.equal(isLostReasonId('6aad8dc01f2de24d878ec3566'), false); // 25
  assert.equal(isLostReasonId('6aad8dc01f2de24d878ec35g'), false);  // not hex
  assert.equal(isLostReasonId('Customer Cancelled'), false);        // a name
  assert.equal(isLostReasonId(null), false);
  assert.equal(isLostReasonId(123), false);
});

test('the tables are frozen — a caller cannot mutate the shared mapping', () => {
  // Two modules import this. A stray write in one would silently change what the
  // other writes to GHL.
  assert.throws(() => { JOB_STATUS_LOST_REASON['Cancelled'] = 'DNC'; }, TypeError);
  assert.throws(() => { LOST_REASON_IDS['DNC'] = 'x'; }, TypeError);
});
