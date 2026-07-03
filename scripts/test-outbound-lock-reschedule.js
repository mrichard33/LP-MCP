/**
 * test-outbound-lock-reschedule.js — lock-held reschedule decision + lock
 * retention rule (2026-07-03 P0: agentic dispatcher single-flight deadlock,
 * agent_actions 165762/165770, contact VZ52xEN3bsCUDWLMCHnk).
 *
 * decideLockHeldReschedule is the pure decision the executor runs when a
 * send is blocked by a live outbound lock: poll (clamped delay anchored to
 * the holder's expires_at) until the lock is released or expires, bounded
 * by an attempt cap. shouldKeepOutboundLock pins which handler outcomes
 * keep their lock until TTL (inbound consumed) vs release it immediately
 * (nothing sent — releasing is what un-deadlocks superseding jobs).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const { decideLockHeldReschedule, shouldKeepOutboundLock } =
  await import('../src/services/outbound-locks.js');

const NOW = Date.parse('2026-07-03T21:06:34Z');
const iso = (offsetSec) => new Date(NOW + offsetSec * 1000).toISOString();

// ── decideLockHeldReschedule ──────────────────────────────────────────

test('expiry 30s out → reschedule just past it (expiry + buffer)', () => {
  const d = decideLockHeldReschedule(iso(30), NOW);
  assert.equal(d.reschedule, true);
  assert.equal(d.delayMs, 31_500); // 30s + 1.5s buffer
  assert.equal(d.reason, 'until_lock_expiry');
  assert.equal(d.retryAt, new Date(NOW + 31_500).toISOString());
});

test('expiry far out (300s TTL) → clamped to maxMs polling, not a 5-min sleep', () => {
  // The holder may release early (supersede/skip exits now release) — the
  // 2026-07-03 repro lock expired at 21:08:51, 137s after the skip. Polling
  // at 60s converges on the release within a minute instead of anchoring
  // the reply to the full TTL.
  const d = decideLockHeldReschedule(iso(300), NOW);
  assert.equal(d.reschedule, true);
  assert.equal(d.delayMs, 60_000);
});

test('expiry already past → floor at minMs (immediate-ish retry, not 1ms spin)', () => {
  const d = decideLockHeldReschedule(iso(-10), NOW);
  assert.equal(d.reschedule, true);
  assert.equal(d.delayMs, 5_000);
});

test('missing expires_at → fallback delay', () => {
  const d = decideLockHeldReschedule(null, NOW);
  assert.equal(d.reschedule, true);
  assert.equal(d.delayMs, 30_000);
  assert.equal(d.reason, 'no_expiry_fallback');
});

test('garbage expires_at → fallback delay, never NaN', () => {
  const d = decideLockHeldReschedule('not-a-date', NOW);
  assert.equal(d.reschedule, true);
  assert.equal(d.delayMs, 30_000);
  assert.ok(Number.isFinite(d.delayMs));
});

test('attempt below cap → still reschedules; at cap → gives up', () => {
  assert.equal(decideLockHeldReschedule(iso(30), NOW, { attempt: 7 }).reschedule, true);
  const d = decideLockHeldReschedule(iso(30), NOW, { attempt: 8 });
  assert.equal(d.reschedule, false);
  assert.equal(d.reason, 'retry_exhausted');
});

test('attempt budget spans a full 300s lock TTL (cap × maxMs > TTL)', () => {
  // 8 polls × ≤60s ≥ 300s: a challenger always outlives any live lock, so
  // "retry past lock_expires_at" holds even when every poll hits maxMs.
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    const d = decideLockHeldReschedule(iso(300), NOW + waited, { attempt });
    if (!d.reschedule) break;
    waited += d.delayMs;
  }
  assert.ok(waited > 300_000, `total polling budget ${waited}ms must exceed the 300s TTL`);
});

// ── shouldKeepOutboundLock ────────────────────────────────────────────

test('message_sent keeps the lock (post-send dedup until TTL)', () => {
  assert.equal(shouldKeepOutboundLock('message_sent'), true);
});

test('handed_off keeps the lock — inbound consumed, human/workflow owns the reply', () => {
  assert.equal(shouldKeepOutboundLock('send_message_handed_off'), true);
});

test('non-send outcomes release the lock (the 2026-07-03 leak)', () => {
  for (const action of [
    'send_message_superseded',
    'send_message_blocked',
    'send_message_suppressed',
    'send_message_no_channel',
    'send_message_no_trigger_message',
    undefined,
    null,
  ]) {
    assert.equal(shouldKeepOutboundLock(action), false, `expected release for ${action}`);
  }
});
