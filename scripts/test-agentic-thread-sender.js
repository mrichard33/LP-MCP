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

// Default allowlist for these cases: the people who work the agentic inbox.
const AL = ['Mark'];
const typeOf = (t) => classifyThreadSenderText(t, { allowlist: AL }).type;

/** Mimic the runtime prep: tags → spaces, lowercased. */
const prep = (html) => `${html}`.replace(/<[^>]+>/g, ' ').toLowerCase();

// ── Randy sign-offs — BOTH shapes must classify as 'randy' ───────────

test('Randy first-name sign-off → randy', () => {
  assert.equal(typeOf(prep('Talk soon,<br>Randy<br>Reece Windows &amp; Doors')), 'randy');
});

test('Randy FULL-name sign-off → randy (the 85-email regression)', () => {
  // "Randy Reece\n\nReece Windows & Doors" — 85 of 99 Randy-signed threads in
  // 90 days used this shape and were misclassified 'rep' before 2026-08-13.
  assert.equal(typeOf(prep('Talk soon,<br>Randy Reece<br>Reece Windows &amp; Doors')), 'randy');
});

test('Randy full-name sign-off with newlines rather than tags → randy', () => {
  assert.equal(typeOf('talk soon,\n\nrandy reece\n\nreece windows & doors'), 'randy');
});

// ── Allowlisted person sign-off ──────────────────────────────────────

test('Mark sign-off → person named Mark', () => {
  const v = classifyThreadSenderText(prep('Talk soon,<br>Mark<br>Reece Windows &amp; Doors'), { allowlist: AL });
  assert.deepEqual(v, { type: 'person', name: 'Mark' });
});

test('an allowlisted person with a surname in the sign-off still resolves', () => {
  const v = classifyThreadSenderText(prep('Talk soon,<br>Mark Richard<br>Reece Windows &amp; Doors'), { allowlist: AL });
  assert.deepEqual(v, { type: 'person', name: 'Mark' });
});

test('a NON-allowlisted person is not inherited — falls through, never impersonated', () => {
  // A field rep's name reaching a template must not make her the author:
  // Beverly does not read this inbox and cannot answer the reply.
  const t = prep('Talk soon,<br>Beverly<br>Reece Windows &amp; Doors');
  assert.notEqual(typeOf(t), 'person');
});

// ── The bot's own bridge wins over any sign-off ──────────────────────

test('prior bot bridge reply → rep, so the bridge never repeats', () => {
  const t = prep('Mark here — Randy asked me to reach out personally after seeing your message.<br>Mark<br>Reece Windows &amp; Doors');
  assert.equal(typeOf(t), 'rep');
});

// ── False positives that must NOT fire ───────────────────────────────

test('the P.S. anecdote about Randy does not make it Randy-signed', () => {
  // Real Mark-signed nurture tail. This exact shape caused the 2026-06-18
  // misfire when the detector searched for "randy reece" anywhere.
  const t = prep(
    'Talk soon,<br>Mark<br>Reece Windows &amp; Doors<br>(Working with David Carter)<br>' +
    'P.S. Randy Reece&rsquo;s father started this company in 1972.'
  );
  assert.equal(typeOf(t), 'person');
});

test('company mentions without a personal sign-off → rep', () => {
  for (const t of [
    'your ai employee has handled another call for reece windows & doors!',
    'a message from reece windows & doors',
    '• © 2026 reece windows & doors',
  ]) {
    assert.equal(typeOf(t), 'rep', `misclassified: ${t}`);
  }
});

test('transactional notices carry no signature → rep', () => {
  assert.equal(
    typeOf(prep('YOUR MEASUREMENT VERIFICATION IS SCHEDULED<br>Calendar: Window Estimate')),
    'rep'
  );
});

test('empty and nullish input → rep (fail-open)', () => {
  for (const t of ['', null, undefined]) {
    assert.equal(typeOf(t), 'rep');
  }
});

// ── Company-signed broadcasts → nobody to inherit ────────────────────

test('"Reece Home Protection" broadcast → company voice', () => {
  // 101 emails in 90 days carry this brand with no personal signature.
  const t = prep('Reece Home Protection<br>Storm Season Update<br>Underwriting tightens when storms rise.');
  assert.deepEqual(classifyThreadSenderText(t, { allowlist: AL }), { type: 'company', name: null });
});

test('a team signature → company voice', () => {
  const t = prep('Talk soon,<br>The Reece Team');
  assert.deepEqual(classifyThreadSenderText(t, { allowlist: AL }), { type: 'company', name: null });
});

// ── Randy can never be inherited as an author ────────────────────────

test('Randy on the allowlist still classifies as randy, never person', () => {
  // The Randy check runs first, so no allowlist configuration can promote him
  // to an author. He is only ever the third-person subject of the bridge.
  const t = prep('Talk soon,<br>Randy Reece<br>Reece Windows &amp; Doors');
  const v = classifyThreadSenderText(t, { allowlist: ['Randy', 'Mark'] });
  assert.equal(v.type, 'randy');
});

// ── Dual-signature emails keep their pre-existing verdict ────────────

test('an email carrying BOTH sign-offs stays randy (unchanged behavior)', () => {
  // 5 emails in 90 days render two signature blocks — a template artifact.
  // They matched the old Randy pattern too, so the widened pattern changes
  // nothing for them; asserting it so the order stays deliberate.
  const t = 'talk soon, randy reece windows & doors talk soon, mark reece windows & doors';
  assert.equal(typeOf(t), 'randy');
});
