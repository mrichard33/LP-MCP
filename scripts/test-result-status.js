/**
 * scripts/test-result-status.js
 *
 * Unit coverage for classifyHandlerResult — the handler-result → action status
 * mapping. Guards two invariants:
 *   - Issue #99: AI-generation failures map to `failed` (not silently completed).
 *   - June 2026 (Mark Test repro): lock-suppressed / suppressed sends map to
 *     `skipped` (not `completed`), so dashboards stop counting blocked sends as
 *     delivered.
 *
 * Pure-function test — no DB, no network.
 * Run: node --test scripts/test-result-status.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyHandlerResult } from '../src/actions/result-status.js';

test('a normal successful send is completed', () => {
  assert.deepEqual(
    classifyHandlerResult({ success: true, sent: true }),
    { status: 'completed', error_message: null },
  );
});

test('outbound_lock_held → skipped (was masked as completed)', () => {
  const r = classifyHandlerResult({ skipped: true, reason: 'outbound_lock_held', held_by: 'agent_executor' });
  assert.equal(r.status, 'skipped');
  assert.equal(r.error_message, 'outbound_lock_held');
});

test('superseded (unsent) → skipped, not a completed send (2026-07-03)', () => {
  const r = classifyHandlerResult({
    action: 'send_message_superseded',
    skipped: true,
    reason: 'superseded_by_newer_job',
    superseded_by: '165770',
  });
  assert.equal(r.status, 'skipped');
  assert.equal(r.error_message, 'superseded_by_newer_job');
});

test('rescheduled lock-held skip still records as skipped with the lock reason', () => {
  const r = classifyHandlerResult({
    skipped: true,
    reason: 'outbound_lock_held',
    rescheduled: true,
    retry_at: '2026-07-03T21:08:52.594Z',
  });
  assert.equal(r.status, 'skipped');
  assert.equal(r.error_message, 'outbound_lock_held');
});

test('universal suppression → skipped', () => {
  const r = classifyHandlerResult({ skipped: true, reason: 'suppressed', matched_tag: 'suppress-outbound' });
  assert.equal(r.status, 'skipped');
  assert.equal(r.error_message, 'suppressed');
});

test('skipped without a reason still maps to skipped with a default message', () => {
  const r = classifyHandlerResult({ skipped: true });
  assert.equal(r.status, 'skipped');
  assert.equal(r.error_message, 'skipped');
});

test('legacy AI generation failure → failed', () => {
  const r = classifyHandlerResult({ action: 'send_message_ai_generation_failed', _generation_error: 'boom' });
  assert.equal(r.status, 'failed');
  assert.equal(r.error_message, 'boom');
});

test('fallback-was-sent shape → failed', () => {
  const r = classifyHandlerResult({ _fallback_send: true, error: 'model timeout' });
  assert.equal(r.status, 'failed');
  assert.equal(r.error_message, 'model timeout');
});

test('generation failure takes precedence over skipped flag', () => {
  // A fallback send that also carried skipped should still surface as failed.
  const r = classifyHandlerResult({ _fallback_send: true, skipped: true, reason: 'x' });
  assert.equal(r.status, 'failed');
});

test('null / undefined result → completed (back-compat)', () => {
  assert.equal(classifyHandlerResult(null).status, 'completed');
  assert.equal(classifyHandlerResult(undefined).status, 'completed');
});
