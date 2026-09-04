/**
 * Tests — per-handler executor watchdog overrides (2026-08-02)
 * scripts/test-handler-timeout-overrides.js
 *
 * Run: node --test scripts/test-handler-timeout-overrides.js
 *
 * Pure-function tests for resolveHandlerTimeoutMs — no DB, no network. Guards
 * the invariant that raising the ceiling for set_lp_appointment does NOT
 * weaken hang detection for any other handler.
 *
 * NOTE: the resolver closes over env read at import time. Run with BOTH
 * EXECUTOR_HANDLER_TIMEOUT_MS and EXECUTOR_LP_APPOINTMENT_TIMEOUT_MS unset,
 * or these assertions read those values instead of the defaults under test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHandlerTimeoutMs } from '../src/actions/index.js';

test('set_lp_appointment gets the raised ceiling', () => {
  assert.equal(resolveHandlerTimeoutMs('set_lp_appointment'), 120000);
});

test('send_message gets the raised ceiling too', () => {
  // Added 2026-09-02, after action 401270 (gpPQYhCsqdGy10wU14Rp) hit the 60s
  // watchdog, the zombie delivered the SMS 39s later, and the row stayed
  // `pending` — a customer reply recorded as unsent. send_message was still
  // listed in the 60s loop below until 2026-09-04, so the override shipped
  // with a test asserting the opposite of what it does.
  assert.equal(resolveHandlerTimeoutMs('send_message'), 120000);
});

test('every other handler keeps the 60s global default', () => {
  for (const t of ['add_tag', 'add_to_workflow', 'book_appointment']) {
    assert.equal(resolveHandlerTimeoutMs(t), 60000);
  }
});

test('the override list is exactly the two handlers that earned it', () => {
  // A guard on the guard: raising the ceiling weakens hang detection, so a
  // third entry appearing here should be a deliberate, reviewed decision rather
  // than something that rides in unnoticed.
  const raised = ['set_lp_appointment', 'send_message', 'add_tag', 'add_to_workflow',
    'book_appointment', 'create_task', 'send_notification', 'lp_callback_requeue']
    .filter((t) => resolveHandlerTimeoutMs(t) > 60000);
  assert.deepEqual(raised, ['set_lp_appointment', 'send_message']);
});

test('unknown / empty action types fall back to the global default', () => {
  assert.equal(resolveHandlerTimeoutMs('not_a_real_action'), 60000);
  assert.equal(resolveHandlerTimeoutMs(''), 60000);
  assert.equal(resolveHandlerTimeoutMs(undefined), 60000);
});

test('the override is never BELOW the global ceiling', () => {
  assert.ok(resolveHandlerTimeoutMs('set_lp_appointment') >= resolveHandlerTimeoutMs('add_tag'));
});
