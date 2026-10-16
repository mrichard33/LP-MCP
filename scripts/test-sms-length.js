/**
 * scripts/test-sms-length.js — the 320-character SMS ceiling (2026-10-10).
 *
 * The prompt says "320 max" (CHANNEL CONSTRAINTS) and nothing checked it: 4 of
 * 261 sent SMS in 30 days ran over, max 411 (audit 2026-10-09). Two places now
 * do: the reply invariants (sms_too_long, on SMS only) and the generation
 * guard's decision (decideSmsLength: shadow logs, live re-writes once, never
 * truncates; a booking link or the disclosure script is exempt).
 *
 *   node --test scripts/test-sms-length.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const { checkReply, INVARIANTS_VERSION, SMS_MAX_CHARS } = await import('../src/eval/reply-invariants.js');
const { decideSmsLength } = await import('../src/response-generator.js');
const { APPROVED_DISCLOSURE_VARIANTS } = await import('../src/prompts/response-generator/system-core.js');

/** A plain reply of exactly `n` characters that trips no other check. */
const ofLength = (n) => 'We can go over that at the visit. '.repeat(20).slice(0, n).trimEnd().padEnd(n, 'x');

test('the version was bumped for the new check and the cap is the prompt\'s 320', () => {
  // 2026-10-10.2: money_figure now allows the ruled "0% APR" (scripts/test-zero-apr-ruling.js).
  // 2026-10-13.1: job_scope (no rentals, no commercial, the minimum, impact-only).
  // 2026-10-13.2: times_after_sign_off and repeat_slot_offer (Erica Hilts).
  // 2026-10-15.1: warranty_claim_without_file (Jeff Clark).
  // 2026-10-15.2: post_demo_rebuttal / _unbacked_follow_up / question_after_post_demo_stop (Shawn Eastman).
  assert.equal(INVARIANTS_VERSION, '2026-10-16.1');
  assert.equal(SMS_MAX_CHARS, 320);
});

test('invariants: an SMS of 320 characters passes; 321 fails as sms_too_long', () => {
  assert.equal(ofLength(320).length, 320);
  assert.equal(ofLength(321).length, 321);
  const ok = checkReply(ofLength(320), { channel: 'sms' });
  assert.ok(!ok.violations.some((v) => v.code === 'sms_too_long'), JSON.stringify(ok.violations));
  const long = checkReply(ofLength(321), { channel: 'sms' });
  const hit = long.violations.find((v) => v.code === 'sms_too_long');
  assert.ok(hit, JSON.stringify(long.violations));
  assert.equal(hit.detail, '321 chars (max 320)');
  assert.equal(long.metrics.chars, 321);
});

test('invariants: email and live chat never fail on length', () => {
  for (const channel of ['email', 'livechat']) {
    const r = checkReply(ofLength(600), { channel });
    assert.ok(!r.violations.some((v) => v.code === 'sms_too_long'), `${channel}: ${JSON.stringify(r.violations)}`);
  }
  // No channel at all: unknown, so not failed either.
  assert.ok(!checkReply(ofLength(600), {}).violations.some((v) => v.code === 'sms_too_long'));
});

test('decideSmsLength: at or under the cap is not over, whatever the mode', () => {
  for (const mode of ['off', 'shadow', 'live']) {
    assert.deepEqual(decideSmsLength(ofLength(320), { mode }), { over: false, chars: 320, action: 'none' });
    assert.deepEqual(decideSmsLength('', { mode }), { over: false, chars: 0, action: 'none' });
  }
});

test('decideSmsLength: shadow and off ship the draft; live re-writes once, then ships as written', () => {
  const draft = ofLength(411);
  assert.deepEqual(decideSmsLength(draft, { mode: 'shadow' }), { over: true, chars: 411, action: 'shadow' });
  assert.deepEqual(decideSmsLength(draft, { mode: 'off' }), { over: true, chars: 411, action: 'off' });
  const first = decideSmsLength(draft, { mode: 'live', retry: false });
  assert.equal(first.action, 'regenerate');
  assert.equal(first.note, 'Your SMS was 411 characters. Rewrite it under 320 characters: same move, same facts, nothing added.');
  const second = decideSmsLength(draft, { mode: 'live', retry: true });
  assert.deepEqual(second, { over: true, chars: 411, action: 'ship_after_retry' });
});

test('decideSmsLength: a booking link or the approved AI-disclosure script is exempt, in live too', () => {
  const withTag = ofLength(300) + ' Book here: {{trigger_link.abc123}}';
  const withUrl = ofLength(300) + ' Book here: https://book.reecewindows.com/visit';
  const withDisclosure = `${APPROVED_DISCLOSURE_VARIANTS.standard} ${ofLength(200)}`;
  assert.ok(withTag.length > 320 && withUrl.length > 320 && withDisclosure.length > 320);
  assert.equal(decideSmsLength(withTag, { mode: 'live' }).action, 'exempt');
  assert.equal(decideSmsLength(withTag, { mode: 'live' }).reason, 'booking_link');
  assert.equal(decideSmsLength(withUrl, { mode: 'live' }).reason, 'booking_link');
  assert.equal(decideSmsLength(withDisclosure, { mode: 'live' }).reason, 'ai_disclosure');
  // The default mode read at load is shadow (nothing set in this process).
  assert.equal(decideSmsLength(ofLength(321)).action, 'shadow');
});

test('decideSmsLength never shortens the text: the decision carries no replacement', () => {
  for (const mode of ['off', 'shadow', 'live']) {
    for (const retry of [false, true]) {
      const d = decideSmsLength(ofLength(500), { mode, retry });
      assert.ok(!('text' in d) && !('message' in d), 'no truncated text may come out of the guard');
    }
  }
});
