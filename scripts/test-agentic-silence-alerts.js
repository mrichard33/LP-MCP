/**
 * test-agentic-silence-alerts.js — the watchdog that should have caught the
 * 2026-07-31 → 2026-08-02 47-hour agentic outage.
 *
 * Exercises src/agentic-silence-alerts.js, which is pure and dependency-free
 * (no supabase, no groupme) so the decision logic can be pinned down exactly.
 *
 * Two properties are in tension and both are tested:
 *
 *   1. It MUST fire on the real thing. The outage produced zero
 *      ai.analysis_completed while 8 inbound replies arrived and were marked
 *      processed. Every existing alarm watched a proxy — queue depth, action
 *      failures, limiter health — and all stayed silent, because nothing backed
 *      up: replies were being consumed and dropped.
 *
 *   2. It MUST NOT fire on deliberate silence. A live check on 2026-08-02 found
 *      4 replies / 0 analyses that were entirely CORRECT — every one came from
 *      a stop-bot / DNC contact. A watchdog counting raw replies would have
 *      paged critical on a healthy night, and an alarm that cries wolf on the
 *      normal case gets muted, which is how you get another 47-hour outage.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { shouldAlertAgenticSilence, formatAgenticSilenceAlert } = await import(
  '../src/agentic-silence-alerts.js'
);

const T = { minReplies: 2 };

test('THE OUTAGE: zero analyses while 8 answerable replies arrived → critical', () => {
  const counts = { analyses: 0, eligibleReplies: 8, windowHours: 6 };
  const res = shouldAlertAgenticSilence(counts, T);

  assert.equal(res.alert, true);
  assert.equal(res.critical, true, 'leads are being ghosted right now — always critical');
  assert.match(res.reasons.join(' '), /0 ai\.analysis_completed in 6h/);
  assert.match(res.reasons.join(' '), /8 answerable replies/);
});

test('THE FALSE POSITIVE: 4 replies, 0 analyses, all deliberately silenced → no alert', () => {
  // 2026-08-02 live state. Every reply came from a stop-bot/DNC contact, so
  // eligibleReplies is 0 and the skipped ones are context only. Firing here
  // would page on a perfectly healthy system.
  const counts = { analyses: 0, eligibleReplies: 0, skippedReplies: 4, windowHours: 6 };
  const res = shouldAlertAgenticSilence(counts, T);

  assert.equal(res.alert, false, 'deliberate silence is not a missed analysis');
  assert.equal(res.critical, false);
});

test('a single stray answerable reply does not page', () => {
  const res = shouldAlertAgenticSilence({ analyses: 0, eligibleReplies: 1, windowHours: 6 }, T);
  assert.equal(res.alert, false, 'below minReplies — one off-hours message is not an outage');
});

test('minReplies boundary: fires at exactly the threshold, not below', () => {
  const below = shouldAlertAgenticSilence({ analyses: 0, eligibleReplies: 2, windowHours: 6 }, { minReplies: 3 });
  assert.equal(below.alert, false);

  const at = shouldAlertAgenticSilence({ analyses: 0, eligibleReplies: 3, windowHours: 6 }, { minReplies: 3 });
  assert.equal(at.alert, true);
});

test('any analysis at all means the pipeline is alive — no alert', () => {
  // Even one analysis against many replies proves the path works end to end.
  // Partial degradation is deliberately NOT this alarm's job; conflating them
  // makes the zero-case noisier and the alarm less trusted.
  const res = shouldAlertAgenticSilence({ analyses: 1, eligibleReplies: 50, windowHours: 6 }, T);
  assert.equal(res.alert, false);
  assert.equal(res.reasons.length, 0);
});

test('a completely idle window is not an outage', () => {
  const res = shouldAlertAgenticSilence({ analyses: 0, eligibleReplies: 0, windowHours: 6 }, T);
  assert.equal(res.alert, false, 'absence of traffic is not absence of health');
});

test('defaults are safe when thresholds/counts are omitted', () => {
  assert.equal(shouldAlertAgenticSilence({}, {}).alert, false, 'empty input must not page');
  // Default minReplies is 2, so 2 unanswered replies fire without explicit config.
  assert.equal(shouldAlertAgenticSilence({ analyses: 0, eligibleReplies: 2 }, {}).alert, true);
});

test('the alert body carries the numbers a responder needs', () => {
  const counts = { analyses: 0, eligibleReplies: 8, skippedReplies: 4, windowHours: 6 };
  const { reasons } = shouldAlertAgenticSilence(counts, T);
  const body = formatAgenticSilenceAlert(counts, reasons);

  assert.match(body, /🔴/);
  assert.match(body, /analyses: 0/);
  assert.match(body, /answerable replies: 8/);
  assert.match(body, /window: 6h/);
  assert.match(body, /4 more replies excluded/, 'skipped count shown as context');
  assert.match(body, /rate-limiter\/stats/, 'points at the first thing to check');
});

test('the alert body omits the exclusion note when nothing was excluded', () => {
  const counts = { analyses: 0, eligibleReplies: 2, skippedReplies: 0, windowHours: 6 };
  const body = formatAgenticSilenceAlert(counts, ['x']);
  assert.ok(!body.includes('excluded'), 'no noise when there is nothing to explain');
});

test('singular/plural read correctly in both the reason and the body', () => {
  const one = shouldAlertAgenticSilence({ analyses: 0, eligibleReplies: 1, windowHours: 6 }, { minReplies: 1 });
  assert.match(one.reasons.join(' '), /1 answerable reply /, 'singular');

  const body = formatAgenticSilenceAlert(
    { analyses: 0, eligibleReplies: 1, skippedReplies: 1, windowHours: 6 }, one.reasons
  );
  assert.match(body, /1 more reply excluded/, 'singular');
});
