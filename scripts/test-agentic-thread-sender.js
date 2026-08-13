/**
 * test-agentic-thread-sender.js — who signed the email the lead is replying to.
 *
 * Feeds classifyThreadSenderText the shape it actually sees at runtime: the
 * prior outbound email's body+subject with HTML tags replaced by spaces and
 * the whole thing lowercased. Every fixture below is a real signature shape
 * sampled from production (90 days to 2026-08-13), not an invented one — the
 * 2026-06-18 incident (554 of 556 matches wrong) is what that discipline is
 * for.
 *
 * The classification decides whether the handoff bridge fires. A Randy-signed
 * nurture must produce 'randy' so the reply opens "Mark here — Randy asked me
 * to reach out"; Randy is referenced in third person and never authors.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const { classifyThreadSenderText } = await import('../src/send-message-handler.js');

/** Mimic the runtime prep: tags → spaces, lowercased. */
const prep = (html) => `${html}`.replace(/<[^>]+>/g, ' ').toLowerCase();

// ── Randy sign-offs — BOTH shapes must classify as 'randy' ───────────

test('Randy first-name sign-off → randy', () => {
  assert.equal(classifyThreadSenderText(prep('Talk soon,<br>Randy<br>Reece Windows &amp; Doors')), 'randy');
});

test('Randy FULL-name sign-off → randy (the 85-email regression)', () => {
  // "Randy Reece\n\nReece Windows & Doors" — 85 of 99 Randy-signed threads in
  // 90 days used this shape and were misclassified 'rep' before 2026-08-13.
  assert.equal(classifyThreadSenderText(prep('Talk soon,<br>Randy Reece<br>Reece Windows &amp; Doors')), 'randy');
});

test('Randy full-name sign-off with newlines rather than tags → randy', () => {
  assert.equal(classifyThreadSenderText('talk soon,\n\nrandy reece\n\nreece windows & doors'), 'randy');
});

// ── Mark sign-off — unchanged ────────────────────────────────────────

test('Mark sign-off → mark', () => {
  assert.equal(classifyThreadSenderText(prep('Talk soon,<br>Mark<br>Reece Windows &amp; Doors')), 'mark');
});

// ── The bot's own bridge wins over any sign-off ──────────────────────

test('prior bot bridge reply → rep, so the bridge never repeats', () => {
  const t = prep('Mark here — Randy asked me to reach out personally after seeing your message.<br>Mark<br>Reece Windows &amp; Doors');
  assert.equal(classifyThreadSenderText(t), 'rep');
});

// ── False positives that must NOT fire ───────────────────────────────

test('the P.S. anecdote about Randy does not make it Randy-signed', () => {
  // Real Mark-signed nurture tail. This exact shape caused the 2026-06-18
  // misfire when the detector searched for "randy reece" anywhere.
  const t = prep(
    'Talk soon,<br>Mark<br>Reece Windows &amp; Doors<br>(Working with David Carter)<br>' +
    'P.S. Randy Reece&rsquo;s father started this company in 1972.'
  );
  assert.equal(classifyThreadSenderText(t), 'mark');
});

test('company mentions without a personal sign-off → rep', () => {
  for (const t of [
    'your ai employee has handled another call for reece windows & doors!',
    'a message from reece windows & doors',
    '• © 2026 reece windows & doors',
  ]) {
    assert.equal(classifyThreadSenderText(t), 'rep', `misclassified: ${t}`);
  }
});

test('transactional notices carry no signature → rep', () => {
  assert.equal(
    classifyThreadSenderText(prep('YOUR MEASUREMENT VERIFICATION IS SCHEDULED<br>Calendar: Window Estimate')),
    'rep'
  );
});

test('empty and nullish input → rep (fail-open)', () => {
  for (const t of ['', null, undefined]) {
    assert.equal(classifyThreadSenderText(t), 'rep');
  }
});

// ── Dual-signature emails keep their pre-existing verdict ────────────

test('an email carrying BOTH sign-offs stays randy (unchanged behavior)', () => {
  // 5 emails in 90 days render two signature blocks — a template artifact.
  // They matched the old Randy pattern too, so the widened pattern changes
  // nothing for them; asserting it so the order stays deliberate.
  const t = 'talk soon, randy reece windows & doors talk soon, mark reece windows & doors';
  assert.equal(classifyThreadSenderText(t), 'randy');
});
