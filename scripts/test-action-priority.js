/**
 * Tests — Rule-created action priority resolution (decision-engine v2.16)
 * scripts/test-action-priority.js
 *
 * Uses Node 18+ built-in test runner (`node:test`). Run with:
 *
 *   node --test scripts/test-action-priority.js
 *
 * Pure-function tests for resolveActionPriority — no DB, no network. Guards
 * the invariant that time-sensitive customer-facing actions get a lower
 * (higher-priority) lane than the bulk tag/stage backlog, and that an
 * explicit template priority always wins.
 */

// Supabase client construction in src/supabase.js reads env at import time.
// decision-engine.js imports it transitively; set harmless dummies so the
// module graph loads without a live config.
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';

import test from 'node:test';
import assert from 'node:assert/strict';

import { _internal } from '../src/decision-engine.js';

const { resolveActionPriority, TIME_SENSITIVE_PRIORITY, DEFAULT_ACTION_PRIORITY } = _internal;

test('time-sensitive action types resolve to the high-priority lane', () => {
  const timeSensitive = [
    'set_lp_appointment',
    'send_message',
    'book_appointment',
    'cancel_appointment',
    'reschedule_appointment',
    'update_lp_dnc_status',
    'send_notification',
  ];
  for (const action_type of timeSensitive) {
    assert.equal(
      resolveActionPriority({ action_type }),
      TIME_SENSITIVE_PRIORITY,
      `${action_type} should be priority ${TIME_SENSITIVE_PRIORITY}`,
    );
  }
});

test('bulk/non-time-sensitive action types keep the default priority', () => {
  for (const action_type of ['add_tag', 'remove_tag', 'move_opportunity', 'set_stage', 'transition_objection_state']) {
    assert.equal(
      resolveActionPriority({ action_type }),
      DEFAULT_ACTION_PRIORITY,
      `${action_type} should keep default priority ${DEFAULT_ACTION_PRIORITY}`,
    );
  }
});

test('time-sensitive lane is strictly ahead of the bulk lane (lower = pulled first)', () => {
  assert.ok(
    resolveActionPriority({ action_type: 'set_lp_appointment' }) <
      resolveActionPriority({ action_type: 'add_tag' }),
    'set_lp_appointment must sort before add_tag in the priority-ASC pull order',
  );
});

test('explicit template priority always wins over the type default', () => {
  // A time-sensitive type can be demoted...
  assert.equal(resolveActionPriority({ action_type: 'send_message', priority: 100 }), 100);
  // ...and a bulk type can be promoted.
  assert.equal(resolveActionPriority({ action_type: 'add_tag', priority: 5 }), 5);
  // Including an explicit 0 (falsy but valid).
  assert.equal(resolveActionPriority({ action_type: 'add_tag', priority: 0 }), 0);
});

test('unknown / missing action types fall back to the default priority', () => {
  assert.equal(resolveActionPriority({ action_type: 'something_new' }), DEFAULT_ACTION_PRIORITY);
  assert.equal(resolveActionPriority({}), DEFAULT_ACTION_PRIORITY);
});

test('null/undefined explicit priority falls through to the type default', () => {
  assert.equal(resolveActionPriority({ action_type: 'send_message', priority: null }), TIME_SENSITIVE_PRIORITY);
  assert.equal(resolveActionPriority({ action_type: 'send_message', priority: undefined }), TIME_SENSITIVE_PRIORITY);
});

test('2026-09-02 — layer3_dispatch runs in its own lane (15), ahead of bulk work', () => {
  const p = resolveActionPriority({ action_type: 'layer3_dispatch' });
  assert.equal(p, 15);
  assert.ok(p < TIME_SENSITIVE_PRIORITY, 'the fan-out must precede the replies it creates');
  assert.equal(resolveActionPriority({ action_type: 'layer3_dispatch', priority: 3 }), 3, 'explicit template priority still wins');
});
