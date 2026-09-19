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

// ═══════════════════════════════════════════════════════════════════
// 2026-09-19 — FAILING vs IDLE.
// The card used to report only successes, so an analyzer that was running and
// throwing read exactly like one that never ran: "analyses: 0", then a standing
// instruction to check the rate limiter. On 2026-09-18 that cost the whole
// diagnosis — 31 ai.analysis_failed rows already named the cause, in the same
// table the watchdog reads. These pin the split.
// ═══════════════════════════════════════════════════════════════════

const TOKEN_STARVATION =
  '[LLMClient:message_analyzer] model "claude-sonnet-5" returned no text content ' +
  '(stop_reason=max_tokens, blocks=[thinking], max_tokens=500) — raise maxTokens or check the model id';

test('a FAILING analyzer says so, and points at the rows that hold the cause', () => {
  const counts = {
    analyses: 0, eligibleReplies: 3, skippedReplies: 0, windowHours: 6,
    failures: 31, topError: TOKEN_STARVATION,
  };
  const { alert, reasons } = shouldAlertAgenticSilence(counts, T);
  assert.equal(alert, true, 'failures still mean leads are being ghosted');

  const body = formatAgenticSilenceAlert(counts, reasons);
  assert.match(body, /failed: 31/, 'the failure count is on the summary line');
  assert.match(body, /top error:/, 'the actual error reaches the card');
  assert.match(body, /max_tokens/, 'and it is the real text, not a category');
  assert.match(body, /FAILING, not idle/);
  assert.match(body, /ai\.analysis_failed/, 'names the table+type to query');
  assert.ok(!body.includes('rate-limiter/stats'),
    'the limiter is a suspect only when the analyzer never ran — sending an ' +
    'operator there while 31 failures name their own cause is the 2026-09-18 bug');
});

test('a genuinely IDLE analyzer keeps the original limiter guidance', () => {
  const counts = { analyses: 0, eligibleReplies: 3, skippedReplies: 0, windowHours: 6, failures: 0 };
  const body = formatAgenticSilenceAlert(counts, ['x']);
  assert.match(body, /rate-limiter\/stats/, 'nothing ran — the limiter is the right first look');
  assert.match(body, /\[MessageAnalyzer\] \/ \[AgenticPipeline\]/);
  assert.ok(!body.includes('failed:'), 'no zero-failure noise');
  assert.ok(!body.includes('FAILING'));
});

test('counts with no failure fields at all behave exactly as before', () => {
  // The heartbeat is the only caller, but a stale/partial counts object must
  // never throw or invent a failure — absent is not zero-with-detail.
  const counts = { analyses: 0, eligibleReplies: 5, skippedReplies: 0, windowHours: 6 };
  const body = formatAgenticSilenceAlert(counts, ['x']);
  assert.match(body, /analyses: 0 \| answerable replies: 5/, 'summary line unchanged');
  assert.match(body, /rate-limiter\/stats/);
});

test('verdicts are untouched by the failure count', () => {
  // The body changed; the DECISION must not. A healthy pipeline that also
  // logged a failure is still healthy, and a quiet night is still too quiet
  // to conclude — otherwise alert-state.js would clear or page wrongly.
  const healthy = shouldAlertAgenticSilence(
    { analyses: 4, eligibleReplies: 9, windowHours: 6, failures: 2 }, T);
  assert.equal(healthy.verdict, 'healthy', 'output is output, even alongside failures');

  const quiet = shouldAlertAgenticSilence(
    { analyses: 0, eligibleReplies: 1, windowHours: 6, failures: 1 }, { minReplies: 2 });
  assert.equal(quiet.verdict, 'insufficient_evidence',
    'a failure must not manufacture the evidence the reply count lacks');

  const bad = shouldAlertAgenticSilence(
    { analyses: 0, eligibleReplies: 5, windowHours: 6, failures: 5 }, T);
  assert.equal(bad.verdict, 'alert');
  assert.equal(bad.critical, true);
});

test('a long top error is truncated so the card stays readable', () => {
  const counts = {
    analyses: 0, eligibleReplies: 3, windowHours: 6,
    failures: 2, topError: 'E'.repeat(900),
  };
  const body = formatAgenticSilenceAlert(counts, ['x']);
  assert.ok(body.length < 800, `card stayed bounded (was ${body.length})`);
});
