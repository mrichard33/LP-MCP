/**
 * Tests — Bot Review feedback pure core (Phase 1)
 * scripts/test-bot-feedback-core.js
 *
 *   node --test scripts/test-bot-feedback-core.js
 *
 * Pure-function tests — no DB, no network. These pin the three rules the DB
 * also enforces as CHECK constraints in sql/103 (a reason on anything but Good,
 * a note on Unsafe, gold only on Good), the permission matrix from handoff §7,
 * and the content of the Unsafe alert.
 *
 * Why test validation that Postgres already enforces: the CHECK constraint
 * protects the DATA, this protects the PERSON — it turns a constraint violation
 * into a sentence naming the control to fix. A regression here does not corrupt
 * anything; it just makes the queue unusable, which no constraint would catch.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VERDICTS,
  validateFeedback,
  resolveReviewerRole,
  canSubmitFeedback,
  canStopBot,
  canUndo,
  alreadyStopped,
  reviewDeepLink,
  buildUnsafeAlert,
  LIMITS,
} from '../src/bot-feedback/feedback-core.js';

const base = { message_type: 'reply', message_ref: '4711' };

// ─── verdict + message identity ─────────────────────────────────────

test('a good verdict needs nothing else', () => {
  const r = validateFeedback({ ...base, verdict: 'good' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.reason_codes, []);
  assert.equal(r.value.note, null);
  assert.equal(r.value.better_text, null);
});

test('an unknown verdict is refused with a reviewer-facing message', () => {
  const r = validateFeedback({ ...base, verdict: 'meh' });
  assert.equal(r.ok, false);
  assert.equal(r.field, 'verdict');
  assert.match(r.error, /Good, Needs work, or Unsafe/);
});

test('message_type and message_ref are required and bounded', () => {
  assert.equal(validateFeedback({ message_type: 'bogus', message_ref: '1', verdict: 'good' }).field, 'message_type');
  assert.equal(validateFeedback({ message_type: 'reply', message_ref: '  ', verdict: 'good' }).field, 'message_ref');
  const long = validateFeedback({ message_type: 'reply', message_ref: 'x'.repeat(LIMITS.message_ref + 1), verdict: 'good' });
  assert.equal(long.field, 'message_ref');
});

test('every verdict in VERDICTS is accepted with its own requirements met', () => {
  for (const verdict of VERDICTS) {
    const input = { ...base, verdict };
    if (verdict !== 'good') input.reason_codes = ['wrong_facts'];
    if (verdict === 'unsafe') input.note = 'Named a carrier.';
    assert.equal(validateFeedback(input).ok, true, `${verdict} should validate`);
  }
});

// ─── mirrors CHECK bf_reason_required ───────────────────────────────

test('needs_work without a reason is refused, pointing at the chips', () => {
  const r = validateFeedback({ ...base, verdict: 'needs_work' });
  assert.equal(r.ok, false);
  assert.equal(r.field, 'reason_codes');
  assert.match(r.error, /at least one reason/i);
});

test('unsafe without a reason names the alert as the reason why', () => {
  const r = validateFeedback({ ...base, verdict: 'unsafe', note: 'bad' });
  assert.equal(r.field, 'reason_codes');
  assert.match(r.error, /alert/i);
});

test('reason codes dedupe but keep selection order', () => {
  // The design reports on order of selection, so sorting would lose data.
  const r = validateFeedback({
    ...base, verdict: 'needs_work',
    reason_codes: ['booking_error', 'dodged_question', 'booking_error', '  '],
  });
  assert.deepEqual(r.value.reason_codes, ['booking_error', 'dodged_question']);
});

test('a reason code not on the active list is refused by name', () => {
  const r = validateFeedback(
    { ...base, verdict: 'needs_work', reason_codes: ['invented_reason'] },
    ['dodged_question', 'wrong_facts'],
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /invented_reason/);
});

test('an empty known-codes list does not block submission', () => {
  // bot_feedback_reasons unreadable must not stop a reviewer working.
  const r = validateFeedback({ ...base, verdict: 'needs_work', reason_codes: ['anything'] }, []);
  assert.equal(r.ok, true);
});

// ─── mirrors CHECK bf_unsafe_note ───────────────────────────────────

test('unsafe without a note is refused with the design\'s exact helper text', () => {
  const r = validateFeedback({ ...base, verdict: 'unsafe', reason_codes: ['compliance'] });
  assert.equal(r.ok, false);
  assert.equal(r.field, 'note');
  assert.equal(r.error, 'Tell us what could go wrong.');
});

test('a whitespace-only note does not satisfy the unsafe rule', () => {
  const r = validateFeedback({ ...base, verdict: 'unsafe', reason_codes: ['compliance'], note: '   \n ' });
  assert.equal(r.field, 'note');
});

test('needs_work does not require a note', () => {
  assert.equal(validateFeedback({ ...base, verdict: 'needs_work', reason_codes: ['tone_voice'] }).ok, true);
});

// ─── mirrors CHECK bf_gold_good_only ────────────────────────────────

test('gold is refused on anything but good', () => {
  const r = validateFeedback({ ...base, verdict: 'needs_work', reason_codes: ['tone_voice'], gold: true });
  assert.equal(r.ok, false);
  assert.equal(r.field, 'gold');
});

test('gold rides along on good', () => {
  assert.equal(validateFeedback({ ...base, verdict: 'good', gold: true }).value.gold, true);
});

// ─── field hygiene ──────────────────────────────────────────────────

test('blank rewrite and note normalise to null, not empty strings', () => {
  const r = validateFeedback({ ...base, verdict: 'good', better_text: '   ', note: '' });
  assert.equal(r.value.better_text, null);
  assert.equal(r.value.note, null);
});

test('oversized rewrite and note are refused', () => {
  assert.equal(validateFeedback({ ...base, verdict: 'good', better_text: 'x'.repeat(LIMITS.better_text + 1) }).field, 'better_text');
  assert.equal(validateFeedback({ ...base, verdict: 'good', note: 'x'.repeat(LIMITS.note + 1) }).field, 'note');
});

test('boolean flags default false rather than undefined', () => {
  const r = validateFeedback({ ...base, verdict: 'good' });
  assert.equal(r.value.seen_before, false);
  assert.equal(r.value.gold, false);
  assert.equal(r.value.is_calibration, false);
});

// ─── roles and permissions (handoff §7) ─────────────────────────────

test('an operator who is also an executive admin is recorded as admin', () => {
  // Otherwise the agreement view measures them against themselves.
  assert.equal(resolveReviewerRole({ role: 'operator', isAdmin: true }), 'admin');
  assert.equal(resolveReviewerRole({ role: 'operator', isAdmin: false }), 'operator');
  assert.equal(resolveReviewerRole({ role: 'team', isAdmin: false }), 'team');
});

test('team may review; only operators and admins may stop the bot', () => {
  const team = { role: 'team', isAdmin: false };
  const operator = { role: 'operator', isAdmin: false };
  const admin = { role: 'operator', isAdmin: true };

  assert.equal(canSubmitFeedback(team), true, 'team must be able to review — otherwise they can never calibrate');
  assert.equal(canSubmitFeedback(operator), true);
  assert.equal(canSubmitFeedback(admin), true);

  assert.equal(canStopBot(team), false);
  assert.equal(canStopBot(operator), true);
  assert.equal(canStopBot(admin), true);
});

test('nobody unknown gets in', () => {
  assert.equal(canSubmitFeedback(null), false);
  assert.equal(canSubmitFeedback({ role: 'exec-only' }), false);
  assert.equal(canStopBot({ role: 'team', isAdmin: false }), false);
});

test('undo is yours alone, unless you are an admin', () => {
  const row = { reviewer_email: 'Reviewer@Reece.com' };
  assert.equal(canUndo({ email: 'reviewer@reece.com', isAdmin: false }, row), true, 'case-insensitive');
  assert.equal(canUndo({ email: 'someone@reece.com', isAdmin: false }, row), false);
  assert.equal(canUndo({ email: 'someone@reece.com', isAdmin: true }, row), true);
  assert.equal(canUndo({ email: 'reviewer@reece.com' }, null), false);
});

// ─── stop-bot idempotency ───────────────────────────────────────────

test('alreadyStopped matches the tag however it is cased or padded', () => {
  assert.equal(alreadyStopped(['agentic-active', ' Stop-Bot ']), true);
  assert.equal(alreadyStopped(['agentic-active']), false);
  assert.equal(alreadyStopped(null), false);
  assert.equal(alreadyStopped([]), false);
});

// ─── unsafe alert ───────────────────────────────────────────────────

test('the deep link points at the exact message', () => {
  assert.equal(
    reviewDeepLink('https://dash.example.com/', 4711),
    'https://dash.example.com/bot-review?tab=review&ctx=4711',
  );
  assert.equal(reviewDeepLink('', 4711), null, 'no configured URL = no link, not a broken one');
  assert.equal(reviewDeepLink('https://d', null), null);
});

test('the unsafe alert carries the note — it is what the on-call reads first', () => {
  const text = buildUnsafeAlert({
    office: 'Tampa', channel: 'sms', ruleApplied: 'OBJ_PRICE_STRIKE1',
    replyText: 'We can definitely get your insurance to cover this.',
    reasonLabels: ['Compliance'], note: 'Promised an insurance outcome.',
    reviewerEmail: 'mark@reecewindows.com', link: 'https://d/bot-review?tab=review&ctx=9',
  });
  assert.match(text, /UNSAFE/);
  assert.match(text, /Tampa · sms · OBJ_PRICE_STRIKE1/);
  assert.match(text, /Note: Promised an insurance outcome\./);
  assert.match(text, /Reasons: Compliance/);
  assert.match(text, /mark@reecewindows\.com/);
  assert.match(text, /ctx=9/);
});

test('a silent-skip alert says so instead of quoting an empty message', () => {
  const text = buildUnsafeAlert({
    channel: 'sms', skipReason: 'rule condition not met',
    reasonLabels: ['Should have replied'], note: 'Lead asked a direct question.',
  });
  assert.match(text, /Bot stayed silent · Reason: rule condition not met/);
  assert.doesNotMatch(text, /Message: ""/);
});

test('a very long reply is truncated in the alert, not dumped whole', () => {
  const text = buildUnsafeAlert({ replyText: 'x'.repeat(900), reasonLabels: [], note: 'n' });
  assert.ok(text.length < 700, `alert was ${text.length} chars`);
  assert.match(text, /…/);
});
