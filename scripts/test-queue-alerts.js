/**
 * Tests — executor queue-depth alert logic (Phase 4)
 * scripts/test-queue-alerts.js
 *
 *   node --test scripts/test-queue-alerts.js
 *
 * Pure-function tests for shouldAlertQueueDepth / formatQueueAlert — no DB,
 * no network, no env. Guards the alert trigger conditions (pending > 500 OR
 * oldest pending > 30min) and the message body.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldAlertQueueDepth, formatQueueAlert } from '../src/executor-queue-alerts.js';

const TH = { pendingThreshold: 500, oldestAgeThresholdMs: 30 * 60 * 1000 };

test('no alert when healthy (under both thresholds)', () => {
  const r = shouldAlertQueueDepth({ pendingCount: 120, oldestAgeMs: 5 * 60 * 1000 }, TH);
  assert.equal(r.alert, false);
  assert.deepEqual(r.reasons, []);
});

test('alerts on pending depth over threshold', () => {
  const r = shouldAlertQueueDepth({ pendingCount: 999, oldestAgeMs: 60 * 1000 }, TH);
  assert.equal(r.alert, true);
  assert.equal(r.reasons.length, 1);
  assert.match(r.reasons[0], /pending 999 > 500/);
});

test('alerts on oldest-pending age over threshold', () => {
  const r = shouldAlertQueueDepth({ pendingCount: 10, oldestAgeMs: 45 * 60 * 1000 }, TH);
  assert.equal(r.alert, true);
  assert.match(r.reasons[0], /oldest pending 45min > 30min/);
});

test('reports both reasons when both breached', () => {
  const r = shouldAlertQueueDepth({ pendingCount: 700, oldestAgeMs: 60 * 60 * 1000 }, TH);
  assert.equal(r.alert, true);
  assert.equal(r.reasons.length, 2);
});

test('boundary: exactly at threshold does NOT alert (strictly greater)', () => {
  const r = shouldAlertQueueDepth({ pendingCount: 500, oldestAgeMs: 30 * 60 * 1000 }, TH);
  assert.equal(r.alert, false);
});

test('null oldestAgeMs (empty queue) is not treated as old', () => {
  const r = shouldAlertQueueDepth({ pendingCount: 0, oldestAgeMs: null }, TH);
  assert.equal(r.alert, false);
});

test('defaults applied when thresholds omitted', () => {
  const r = shouldAlertQueueDepth({ pendingCount: 501, oldestAgeMs: null }, {});
  assert.equal(r.alert, true);
});

test('formatQueueAlert includes counts, oldest age, and reasons', () => {
  const msg = formatQueueAlert(
    { pendingCount: 999, oldestAgeMs: 45 * 60 * 1000, executingCount: 1 },
    ['pending 999 > 500', 'oldest pending 45min > 30min'],
  );
  assert.match(msg, /pending: 999/);
  assert.match(msg, /executing: 1/);
  assert.match(msg, /oldest pending: 45min/);
  assert.match(msg, /pending 999 > 500; oldest pending 45min > 30min/);
});

test('formatQueueAlert handles null oldest age', () => {
  const msg = formatQueueAlert({ pendingCount: 600, oldestAgeMs: null }, ['pending 600 > 500']);
  assert.match(msg, /oldest pending: n\/a/);
});
