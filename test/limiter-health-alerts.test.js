/**
 * test/limiter-health-alerts.test.js
 *
 * Threshold regression tests for src/limiter-health-alerts.js.
 *
 * WHY THIS EXISTS
 * ───────────────
 * 2026-09-17. The limiter alert fired 11 unhealthy/RECOVERED pairs in 18h on
 * 2026-09-03/04 and did it again overnight 2026-09-16/17, roughly every 35
 * minutes, each pair clearing within ~4 minutes. The alert was already
 * edge-triggered (src/alert-state.js, 2026-09-04), so that was not alert
 * spam — the CONDITION was genuinely re-opening on ordinary GHL backpressure,
 * because the 429 branch fired on ANY single new 429 with no minimum.
 *
 * Every SILENT case below is a real snapshot that DID page. Every PAGES case
 * is a shape that must survive the raise. The point of the file is that the
 * next person tuning these numbers can see immediately whether they have
 * re-armed the hair trigger or blinded the storm detector.
 *
 * Run: node --test test/limiter-health-alerts.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  shouldAlertLimiter,
  formatLimiterAlert,
  shouldAlertFailedActions,
} from '../src/limiter-health-alerts.js';

// Thresholds as they will be in production AFTER merge + the required env
// var. Passed explicitly so these tests do not depend on ambient env.
const PROD = {
  queueDepth: 15,
  timedOutDelta: 25,
  new429Delta: 3,
  pauseAlertMs: 150000,
};

// ── SILENT: the actual overnight alerts ────────────────────────────────────
// Source: GroupMe "Reece Lead Intelligence", 2026-09-16/17, 12:13-01:32 ET.
// Each of these opened the alert under the old thresholds.

test('overnight 00:49 snapshot — 2 new 429, 71s pause, queue 2 — stays silent', () => {
  const curr = {
    queueDepth: 2, tokens: 38, capacity: 120,
    timedOut: 15, total429s: 2,
    paused: true, pauseRemainingMs: 71000,
  };
  const prev = { timedOut: 0, total429s: 0 };
  const res = shouldAlertLimiter(curr, prev, PROD);
  assert.equal(res.alert, false, `expected silence, got: ${res.reasons.join('; ')}`);
  assert.equal(res.critical, false);
});

test('overnight 01:29 snapshot — 2 new 429, 68s pause, queue 2 — stays silent', () => {
  const curr = {
    queueDepth: 2, tokens: 45, capacity: 120,
    timedOut: 15, total429s: 2,
    paused: true, pauseRemainingMs: 68000,
  };
  const prev = { timedOut: 0, total429s: 0 };
  assert.equal(shouldAlertLimiter(curr, prev, PROD).alert, false);
});

test('overnight snapshot with the larger 41-timeout delta — stays silent', () => {
  const curr = {
    queueDepth: 2, tokens: 40, capacity: 120,
    timedOut: 41, total429s: 2,
    paused: true, pauseRemainingMs: 69000,
  };
  const prev = { timedOut: 0, total429s: 0 };
  const res = shouldAlertLimiter(curr, prev, PROD);
  assert.equal(res.alert, false, `expected silence, got: ${res.reasons.join('; ')}`);
});

test('healthy morning snapshot (7.3h uptime, live 12:10Z) — stays silent', () => {
  const curr = {
    queueDepth: 0, tokens: 106, capacity: 120,
    timedOut: 47, total429s: 2,
    paused: false, pauseRemainingMs: 0,
  };
  const prev = { timedOut: 47, total429s: 2 };
  assert.equal(shouldAlertLimiter(curr, prev, PROD).alert, false);
});

test('routine standing 60s pause, no new 429 — stays silent', () => {
  const curr = {
    queueDepth: 3, tokens: 12, capacity: 120,
    timedOut: 20, total429s: 2,
    paused: true, pauseRemainingMs: 60000,
  };
  const prev = { timedOut: 20, total429s: 2 };
  assert.equal(shouldAlertLimiter(curr, prev, PROD).alert, false);
});

// ── PAGES: shapes that must still wake someone ─────────────────────────────

test('Jun 4/5 storm shape — deep sustained queue still pages', () => {
  // The incident this file was written for: 23-29 deep wait queue, ~550
  // timeouts, ran ~12h. Caught by the UNCHANGED queue-depth threshold, which
  // is why raising the 429 and timeout thresholds does not blind it.
  const curr = {
    queueDepth: 27, tokens: 0, capacity: 120,
    timedOut: 550, total429s: 6,
    paused: false, pauseRemainingMs: 0,
  };
  const prev = { timedOut: 500, total429s: 6 };
  const res = shouldAlertLimiter(curr, prev, PROD);
  assert.equal(res.alert, true);
  assert.ok(
    res.reasons.some(r => r.includes('refill starved')),
    `expected the queue-depth reason, got: ${res.reasons.join('; ')}`
  );
});

test('sustained burst — 3 new 429 in one check pages as critical', () => {
  const curr = {
    queueDepth: 4, tokens: 0, capacity: 120,
    timedOut: 30, total429s: 5,
    paused: true, pauseRemainingMs: 120000,
  };
  const prev = { timedOut: 30, total429s: 2 };
  const res = shouldAlertLimiter(curr, prev, PROD);
  assert.equal(res.alert, true);
  assert.equal(res.critical, true);
  assert.ok(res.reasons.some(r => r.includes('in one check')));
});

test('escalated backoff — 1 new 429 but pause past 150s pages as critical', () => {
  // One 429 is normally routine. A 180s pause means consecutive429Cycles has
  // climbed to the MAX_PAUSE_MS ceiling — the shape of a real storm.
  const curr = {
    queueDepth: 5, tokens: 0, capacity: 120,
    timedOut: 30, total429s: 3,
    paused: true, pauseRemainingMs: 180000,
  };
  const prev = { timedOut: 30, total429s: 2 };
  const res = shouldAlertLimiter(curr, prev, PROD);
  assert.equal(res.alert, true);
  assert.equal(res.critical, true);
  assert.ok(res.reasons.some(r => r.includes('escalated pause')));
});

test('standing pause at the 180s ceiling, no new 429 — still pages', () => {
  const curr = {
    queueDepth: 8, tokens: 0, capacity: 120,
    timedOut: 40, total429s: 4,
    paused: true, pauseRemainingMs: 175000,
  };
  const prev = { timedOut: 40, total429s: 4 };
  const res = shouldAlertLimiter(curr, prev, PROD);
  assert.equal(res.alert, true);
  assert.ok(res.reasons.some(r => r.includes('limiter paused')));
});

test('large timeout burst past 25 still pages', () => {
  const curr = {
    queueDepth: 2, tokens: 5, capacity: 120,
    timedOut: 90, total429s: 2,
    paused: false, pauseRemainingMs: 0,
  };
  const prev = { timedOut: 40, total429s: 2 };
  const res = shouldAlertLimiter(curr, prev, PROD);
  assert.equal(res.alert, true);
  assert.ok(res.reasons.some(r => r.includes('token timeouts')));
});

// ── Edge cases ─────────────────────────────────────────────────────────────

test('first run (prev = null) computes no deltas and does not alert', () => {
  const curr = {
    queueDepth: 2, tokens: 38, capacity: 120,
    timedOut: 15, total429s: 2,
    paused: true, pauseRemainingMs: 60000,
  };
  assert.equal(shouldAlertLimiter(curr, null, PROD).alert, false);
});

test('first run still pages on a deep queue — depth needs no prev', () => {
  const curr = {
    queueDepth: 27, tokens: 0, capacity: 120,
    timedOut: 550, total429s: 6,
    paused: false, pauseRemainingMs: 0,
  };
  assert.equal(shouldAlertLimiter(curr, null, PROD).alert, true);
});

test('missing/garbage snapshot does not throw', () => {
  assert.doesNotThrow(() => shouldAlertLimiter(undefined, undefined, PROD));
  assert.equal(shouldAlertLimiter({}, null, PROD).alert, false);
});

// ── Caller-override contract ───────────────────────────────────────────────
// This is the trap documented in the module header. executor-heartbeat.js
// passes timedOutDelta explicitly from `process.env.LIMITER_TIMEOUT_DELTA_ALERT
// || '3'`. A supplied value WINS over the module default of 25 — which is why
// LIMITER_TIMEOUT_DELTA_ALERT=25 must be set in Railway. If that env var is
// ever removed on the assumption that the code default covers it, this test
// spells out what actually happens.

test('a caller-supplied timedOutDelta of 3 overrides the module default of 25', () => {
  const curr = {
    queueDepth: 2, tokens: 38, capacity: 120,
    timedOut: 15, total429s: 2,
    paused: false, pauseRemainingMs: 0,
  };
  const prev = { timedOut: 0, total429s: 2 };

  // Legacy caller value — the pre-env-var state. Still fires, by design.
  const legacy = shouldAlertLimiter(curr, prev, { ...PROD, timedOutDelta: 3 });
  assert.equal(legacy.alert, true, 'caller value must win — this is the documented trap');

  // With the env var set, the caller passes 25 and the same snapshot is quiet.
  assert.equal(shouldAlertLimiter(curr, prev, PROD).alert, false);
});

test('omitted thresholds fall back to module defaults', () => {
  const curr = {
    queueDepth: 2, tokens: 38, capacity: 120,
    timedOut: 15, total429s: 2,
    paused: true, pauseRemainingMs: 71000,
  };
  const prev = { timedOut: 0, total429s: 0 };
  // No thresholds object at all — must match the PROD expectation (silent),
  // provided no LIMITER_* env vars are set in the test environment.
  assert.equal(shouldAlertLimiter(curr, prev).alert, false);
});

// ── Message formatting is unchanged ────────────────────────────────────────

test('formatLimiterAlert keeps its shape and icon', () => {
  const curr = {
    queueDepth: 27, tokens: 0, capacity: 120,
    timedOut: 550, total429s: 6,
  };
  const body = formatLimiterAlert(curr, ['27 requests queued, 0 tokens — refill starved'], true);
  assert.ok(body.startsWith('🔴 GHL rate limiter unhealthy'));
  assert.ok(body.includes('queue: 27 | tokens: 0/120 | timedOut: 550 | 429s: 6'));
  assert.ok(body.includes('triggered: '));
  assert.ok(formatLimiterAlert(curr, [], false).startsWith('⚠️'));
});

// ── Untouched sibling helper — guard against collateral damage ─────────────

test('shouldAlertFailedActions is unaffected by this change', () => {
  assert.equal(shouldAlertFailedActions(21, 15, 20).alert, true);
  assert.equal(shouldAlertFailedActions(20, 15, 20).alert, false);
  assert.equal(shouldAlertFailedActions(null, 15, 20).alert, false);
});
