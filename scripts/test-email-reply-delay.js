/**
 * test-email-reply-delay.js — an email reply never lands sooner than 90s after
 * the lead's message arrived.
 *
 * Mark's ruling, 2026-09-18: an email answered in seconds reads as a machine.
 * The floor is measured from when the INBOUND arrived, not from when
 * generation finished — the latter is an accident of queue depth and says
 * nothing about how the exchange looks to the person reading it.
 *
 * SMS is deliberately exempt: a text answered quickly reads as attentive.
 */
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';
process.env.EMAIL_REPLY_MIN_DELAY_MS = '90000';

import test from 'node:test';
import assert from 'node:assert/strict';

const { _internal } = await import('../src/send-message-handler.js');
const { decideEmailSendDelay } = _internal;

const T = Date.parse('2026-09-18T21:38:02.000Z');   // Catherine Crosier's inbound
const s = (n) => n * 1000;

test('reply ready at T+20s defers to exactly T+90s', () => {
  const d = decideEmailSendDelay({ channel: 'email', inboundAtMs: T, nowMs: T + s(20) });
  assert.equal(d.defer, true);
  assert.equal(d.reason, 'email_min_delay');
  assert.equal(d.retryAtMs, T + s(90));
  assert.equal(new Date(d.retryAtMs).toISOString(), '2026-09-18T21:39:32.000Z');
});

test('reply ready at T+120s sends immediately', () => {
  const d = decideEmailSendDelay({ channel: 'email', inboundAtMs: T, nowMs: T + s(120) });
  assert.equal(d.defer, false);
  assert.equal(d.reason, 'min_delay_elapsed');
  assert.equal(d.retryAtMs, null);
});

test('exactly at the boundary sends — the floor is a minimum, not an exclusion', () => {
  const d = decideEmailSendDelay({ channel: 'email', inboundAtMs: T, nowMs: T + s(90) });
  assert.equal(d.defer, false);
});

test('one millisecond short still waits', () => {
  const d = decideEmailSendDelay({ channel: 'email', inboundAtMs: T, nowMs: T + s(90) - 1 });
  assert.equal(d.defer, true);
  assert.equal(d.retryAtMs, T + s(90));
});

test('SMS and livechat are never delayed', () => {
  for (const channel of ['sms', 'livechat']) {
    const d = decideEmailSendDelay({ channel, inboundAtMs: T, nowMs: T + s(1) });
    assert.equal(d.defer, false, channel);
    assert.equal(d.reason, 'not_email', channel);
  }
});

test('an unreadable inbound time never holds the reply', () => {
  for (const inboundAtMs of [NaN, undefined, null, Date.parse('not a date')]) {
    const d = decideEmailSendDelay({ channel: 'email', inboundAtMs, nowMs: T });
    assert.equal(d.defer, false, String(inboundAtMs));
    assert.equal(d.reason, 'inbound_time_unknown', String(inboundAtMs));
  }
});

test('the gate is idempotent — a deferred action re-run past the floor sends', () => {
  // The executor re-claims at retry_at. The second pass must not defer again,
  // or the reply loops forever.
  const first = decideEmailSendDelay({ channel: 'email', inboundAtMs: T, nowMs: T + s(5) });
  assert.equal(first.defer, true);
  const second = decideEmailSendDelay({ channel: 'email', inboundAtMs: T, nowMs: first.retryAtMs });
  assert.equal(second.defer, false);
});

test('a zero or negative floor disables the gate', () => {
  for (const minDelayMs of [0, -1]) {
    const d = decideEmailSendDelay({ channel: 'email', inboundAtMs: T, nowMs: T, minDelayMs });
    assert.equal(d.defer, false, String(minDelayMs));
    assert.equal(d.reason, 'disabled', String(minDelayMs));
  }
});

test('the floor is configurable', () => {
  const d = decideEmailSendDelay({ channel: 'email', inboundAtMs: T, nowMs: T, minDelayMs: 30000 });
  assert.equal(d.retryAtMs, T + s(30));
});

test('the incident timing is recorded honestly — 123s would NOT have been held', () => {
  // Catherine Crosier: inbound 21:38:02Z, sent 21:40:05Z. This floor is a
  // general pacing policy, not a fix for that send. Anyone reading this test
  // should not believe otherwise.
  const sentAt = Date.parse('2026-09-18T21:40:05.284Z');
  assert.ok(sentAt - T > s(90));
  assert.equal(decideEmailSendDelay({ channel: 'email', inboundAtMs: T, nowMs: sentAt }).defer, false);
});

// ─── 2026-10-19 (Mark; Thomas Geary): a natural, random wait ────────────────
const MIN = 360_000;   // 6 min
const MAX = 900_000;   // 15 min

test('the ready time falls inside the 6–15 minute window', () => {
  for (const seed of [4257716, 'syn-ff8b1b2ab8fbf4813e160a7709ce71fc6b86d2ce', 1, 2, 3, 99999, 'abc']) {
    const d = decideEmailSendDelay({ channel: 'email', inboundAtMs: T, nowMs: T + s(10), minDelayMs: MIN, maxDelayMs: MAX, seed });
    assert.equal(d.defer, true);
    assert.ok(d.readyAtMs >= T + MIN && d.readyAtMs < T + MAX, `${seed}: ${(d.readyAtMs - T) / 60000} min`);
  }
});

test('the same inbound gets the same ready time on retry (never re-rolled)', () => {
  const a = decideEmailSendDelay({ channel: 'email', inboundAtMs: T, nowMs: T + s(10), minDelayMs: MIN, maxDelayMs: MAX, seed: 4257716 });
  const b = decideEmailSendDelay({ channel: 'email', inboundAtMs: T, nowMs: T + s(200), minDelayMs: MIN, maxDelayMs: MAX, seed: 4257716 });
  assert.equal(a.readyAtMs, b.readyAtMs);
  // The stored value wins over everything, even a different seed.
  const c = decideEmailSendDelay({ channel: 'email', inboundAtMs: T, nowMs: T + s(10), minDelayMs: MIN, maxDelayMs: MAX, seed: 'other', storedReadyAtMs: a.readyAtMs });
  assert.equal(c.readyAtMs, a.readyAtMs);
  // At the stored time it sends.
  assert.equal(decideEmailSendDelay({ channel: 'email', inboundAtMs: T, nowMs: a.readyAtMs, minDelayMs: MIN, maxDelayMs: MAX, storedReadyAtMs: a.readyAtMs }).defer, false);
});

test('different inbounds spread across the window', () => {
  const minutes = new Set();
  for (let i = 0; i < 40; i++) {
    const d = decideEmailSendDelay({ channel: 'email', inboundAtMs: T, nowMs: T, minDelayMs: MIN, maxDelayMs: MAX, seed: 4257000 + i });
    minutes.add(Math.floor((d.readyAtMs - T) / 60000));
  }
  assert.ok(minutes.size >= 5, `only ${minutes.size} distinct minutes`);
});

test('MAX unset or not above MIN is the old fixed floor (the rollback)', () => {
  assert.equal(decideEmailSendDelay({ channel: 'email', inboundAtMs: T, nowMs: T, minDelayMs: 90_000, maxDelayMs: NaN, seed: 7 }).readyAtMs, T + 90_000);
  assert.equal(decideEmailSendDelay({ channel: 'email', inboundAtMs: T, nowMs: T, minDelayMs: MIN, maxDelayMs: MIN, seed: 7 }).readyAtMs, T + MIN);
});

test('SMS and live chat are unchanged by the window', () => {
  for (const channel of ['sms', 'livechat']) {
    assert.equal(decideEmailSendDelay({ channel, inboundAtMs: T, nowMs: T, minDelayMs: MIN, maxDelayMs: MAX, seed: 1 }).defer, false);
  }
});
