/**
 * Tests — Bot Review increment 2 pure core
 * scripts/test-bot-review-inc2-core.js
 *
 *   node --test scripts/test-bot-review-inc2-core.js
 *
 * Pure-function tests — no DB, no network. These pin the rules the DB also
 * enforces in sql/106 (a retraction needs a reason; a dismissal needs the
 * target its scope implies) and the permission matrix from handoff §5.
 *
 * Why test what Postgres also enforces: the trigger and the CHECK protect the
 * DATA, this protects the PERSON. A retraction rejected by the trigger surfaces
 * as a constraint violation nobody can act on; rejected here it says "Tell us
 * why this review is being removed." Both gates have to hold, and the DB one is
 * the one that cannot be bypassed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateFeedback,
  validateRetract,
  validateDismissal,
  canRetract,
  canDismiss,
  canUndoDismiss,
  RETRACT_REASON_MAX,
  DISMISS_REASON_MAX,
  REVIEW_LANES,
} from '../src/bot-feedback/feedback-core.js';

// ─── retraction ─────────────────────────────────────────────────────

test('a retraction needs a reason', () => {
  const r = validateRetract({});
  assert.equal(r.ok, false);
  assert.equal(r.field, 'reason');
  assert.match(r.error, /why this review is being removed/i);
});

test('whitespace is not a reason', () => {
  assert.equal(validateRetract({ reason: '   \n  ' }).ok, false);
});

test('a reason is trimmed and kept', () => {
  const r = validateRetract({ reason: '  scored the wrong message  ' });
  assert.equal(r.ok, true);
  assert.equal(r.value.reason, 'scored the wrong message');
});

test('an overlong reason is refused rather than silently truncated', () => {
  const r = validateRetract({ reason: 'x'.repeat(RETRACT_REASON_MAX + 1) });
  assert.equal(r.ok, false);
  assert.equal(r.field, 'reason');
});

test('the review author may retract, another reviewer may not, an admin always may', () => {
  const row = { reviewer_email: 'Kim@reecewindows.com' };

  // Case-insensitively the same person — emails are not case sensitive and a
  // reviewer signed in as kim@ must not be locked out of kim's own review.
  assert.equal(canRetract({ email: 'kim@reecewindows.com', role: 'team' }, row), true);
  assert.equal(canRetract({ email: 'someone-else@reecewindows.com', role: 'team' }, row), false);
  assert.equal(canRetract({ email: 'someone-else@reecewindows.com', role: 'operator' }, row), false);
  assert.equal(canRetract({ email: 'mark@reecewindows.com', role: 'team', isAdmin: true }, row), true);
});

test('there is nothing to retract on a missing row', () => {
  assert.equal(canRetract({ email: 'mark@reecewindows.com', isAdmin: true }, null), false);
});

// ─── dismissals ─────────────────────────────────────────────────────

test('a message dismissal needs a context id', () => {
  const r = validateDismissal({ scope: 'message' });
  assert.equal(r.ok, false);
  assert.equal(r.field, 'context_id');
});

test('a conversation dismissal needs a contact id', () => {
  const r = validateDismissal({ scope: 'conversation' });
  assert.equal(r.ok, false);
  assert.equal(r.field, 'ghl_contact_id');
});

test('an unknown scope is refused', () => {
  assert.equal(validateDismissal({ scope: 'everything', context_id: 1 }).field, 'scope');
});

test('a message dismissal drops any contact id it was sent', () => {
  // A row claiming to be both would sit under two different unique indexes.
  const r = validateDismissal({ scope: 'message', context_id: 7, ghl_contact_id: 'abc' });
  assert.equal(r.ok, true);
  assert.equal(r.value.context_id, 7);
  assert.equal(r.value.ghl_contact_id, null);
});

test('a conversation dismissal drops any context id it was sent', () => {
  const r = validateDismissal({ scope: 'conversation', ghl_contact_id: 'abc', context_id: 7 });
  assert.equal(r.ok, true);
  assert.equal(r.value.ghl_contact_id, 'abc');
  assert.equal(r.value.context_id, null);
});

test('a non-integer context id is refused', () => {
  assert.equal(validateDismissal({ scope: 'message', context_id: '12abc' }).field, 'context_id');
  assert.equal(validateDismissal({ scope: 'message', context_id: 0 }).field, 'context_id');
  assert.equal(validateDismissal({ scope: 'message', context_id: -3 }).field, 'context_id');
});

test('the reason is optional on a dismissal and bounded when given', () => {
  assert.equal(validateDismissal({ scope: 'message', context_id: 1 }).value.reason, null);
  assert.equal(validateDismissal({ scope: 'message', context_id: 1, reason: ' ok ' }).value.reason, 'ok');
  assert.equal(
    validateDismissal({ scope: 'message', context_id: 1, reason: 'x'.repeat(DISMISS_REASON_MAX + 1) }).field,
    'reason',
  );
});

test('anyone who may review may dismiss; only operators and admins may undo one', () => {
  // Dismissing is narrower in effect than a verdict, so it is not gated harder.
  assert.equal(canDismiss({ role: 'team' }), true);
  assert.equal(canDismiss({ role: 'operator' }), true);
  assert.equal(canDismiss({ role: 'exec', isAdmin: true }), true);
  assert.equal(canDismiss({ role: 'exec' }), false);

  // Undoing un-hides a message for EVERYONE, so it needs the wider role.
  assert.equal(canUndoDismiss({ role: 'team' }), false);
  assert.equal(canUndoDismiss({ role: 'operator' }), true);
  assert.equal(canUndoDismiss({ role: 'team', isAdmin: true }), true);
});

// ─── seen_before is no longer a client input (handoff §6B) ──────────

test('seen_before is always written false, whatever the client sends', () => {
  const base = { message_type: 'reply', message_ref: '4711', verdict: 'good' };
  assert.equal(validateFeedback(base).value.seen_before, false);
  assert.equal(validateFeedback({ ...base, seen_before: true }).value.seen_before, false);
});

test('the gold rejection says "teaching example", not "gold example"', () => {
  const r = validateFeedback({ message_type: 'reply', message_ref: '1', verdict: 'unsafe', note: 'n', reason_codes: ['compliance'], gold: true });
  assert.equal(r.ok, false);
  assert.equal(r.field, 'gold');
  assert.match(r.error, /teaching example/i);
  assert.doesNotMatch(r.error, /gold/i);
});

// ─── lanes ──────────────────────────────────────────────────────────

test('the lane vocabulary matches sql/106', () => {
  assert.deepEqual([...REVIEW_LANES], ['must_review', 'spot_check', 'none']);
});
