/**
 * test-send-deferral.js — defer-don't-drop result classification
 * (2026-07-03 evening hotfix, dropped-replies incident).
 *
 * A send blocked by the agentic cooldown or a live outbound lock returns
 * { deferred: true, retry_at } and must be parked as status='pending' with a
 * DB-persisted retry_at — the old in-process setTimeout reschedules died on
 * every Railway redeploy, which is exactly how the incident's replies were
 * stranded. Deferral is not a failure: no retry_count semantics, no timeout
 * error_message.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const { classifyHandlerResult } = await import('../src/actions/result-status.js');
const { decideLockHeldReschedule } = await import('../src/services/outbound-locks.js');

const NOW = Date.parse('2026-07-03T21:45:00Z');
const iso = (offsetSec) => new Date(NOW + offsetSec * 1000).toISOString();

test('deferred result → status pending + retry_at, error_message is a deferral marker', () => {
  const c = classifyHandlerResult({
    deferred: true,
    reason: 'agentic_cooldown',
    retry_at: iso(60),
  });
  assert.equal(c.status, 'pending');
  assert.equal(c.retry_at, iso(60));
  assert.equal(c.error_message, 'deferred: agentic_cooldown');
});

test('deferred lock-held result carries retry_at and never a timeout string', () => {
  const c = classifyHandlerResult({
    deferred: true,
    reason: 'outbound_lock_held',
    retry_at: iso(10),
    lock_held_attempts: 3,
  });
  assert.equal(c.status, 'pending');
  assert.equal(c.retry_at, iso(10));
  assert.ok(!/timed out/i.test(c.error_message));
});

test('deferred without retry_at → pending with null retry_at (claimable now, degraded not dropped)', () => {
  const c = classifyHandlerResult({ deferred: true, reason: 'outbound_lock_held' });
  assert.equal(c.status, 'pending');
  assert.equal(c.retry_at, null);
});

test('skipped still classifies as skipped (deferral does not change terminal skips)', () => {
  const c = classifyHandlerResult({ skipped: true, reason: 'superseded_by_newer_job' });
  assert.equal(c.status, 'skipped');
  assert.equal(c.retry_at, undefined);
});

test('completed dedup result (prior zombie send) classifies completed with no error', () => {
  const c = classifyHandlerResult({ action: 'message_sent', deduped_prior_send: true, message_id: 'm1' });
  assert.equal(c.status, 'completed');
  assert.equal(c.error_message, null);
});

test('deferred takes precedence over generation-failure only when generation did not fail', () => {
  // A fallback send that DID deliver still classifies failed (Issue #99
  // honest accounting) — deferral only applies to results that sent nothing.
  const c = classifyHandlerResult({ action: 'message_sent', _fallback_send: true });
  assert.equal(c.status, 'failed');
});

test('lock-held deferral cadence: attempt budget spans the full 300s outbound TTL', () => {
  // Persisted-attempt walk: each re-run feeds the prior attempt count back
  // in (execution_result.lock_held_attempts survives restarts, unlike the
  // old in-memory Map). Total deferable window must cover a full lock TTL.
  let now = NOW;
  let attempt = 0;
  let coveredMs = 0;
  const expiresAt = iso(300);
  for (;;) {
    const d = decideLockHeldReschedule(expiresAt, now, { attempt });
    if (!d.reschedule) break;
    coveredMs += d.delayMs;
    now += d.delayMs;
    attempt += 1;
  }
  assert.ok(coveredMs >= 300_000, `attempt budget covers ${coveredMs}ms < 300s TTL`);
  assert.equal(attempt, 8); // maxAttempts default
});

test('cooldown deferral retry_at equals the cooldown expiry, not an attempt-relative time', () => {
  // The flow passes slot.retry_at (= cooldown_until, armed only by a
  // SUCCESSFUL send) straight through — cooldown never keys on attempts.
  const slot = { acquired: false, reason: 'cooldown', retry_at: iso(90) };
  const c = classifyHandlerResult({ deferred: true, reason: 'agentic_cooldown', retry_at: slot.retry_at });
  assert.equal(c.retry_at, iso(90));
});
