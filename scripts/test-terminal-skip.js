/**
 * test-terminal-skip.js — deliberate silence is terminal, not a failure.
 *
 * Exercises buildAnalyzeResponse() from src/message-analyzer.js: the mapping
 * from analyzeMessage()'s return value onto the /n8n/analyze-message response
 * body. That mapping is the entire contract between the analyzer and
 * behavioral-emitter's pipeline, and getting it wrong has now caused two
 * separate production incidents:
 *
 *   - 2026-07-03: a dedup skip reported success:false, so the reply buffer
 *     retried a deliberate no-op and re-drove its source events.
 *   - 2026-08-02: an unconfirmed dedup was trusted as terminal success, and the
 *     reply was silently dropped (the Engelke incident).
 *
 * And the case this file adds:
 *
 *   - stop-bot returned null, which every caller reads as "genuine failure".
 *     A kill-switch hit therefore burned both BUFFER_MAX_RETRIES plus a
 *     decision-engine cycle, and — because markAnalyzed() claims the dedup slot
 *     BEFORE the guard runs — every retry came back 'recently_analyzed', which
 *     post-2026-08-02 logged a DEDUP UNCONFIRMED error for a completely normal
 *     event. Confirmed live at 01:09:42Z on contact 0kk3xz6XatILy8jajymX.
 *
 * The three outcomes must stay distinct. Collapsing any two of them re-creates
 * one of the incidents above.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// No supabase client — buildAnalyzeResponse is pure and must not touch one.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const { buildAnalyzeResponse } = await import('../src/message-analyzer.js');

test('stop-bot is a TERMINAL skip — success, but never dedup-confirmed', () => {
  const res = buildAnalyzeResponse({ skipped: true, terminal: true, reason: 'stop_bot' });

  assert.equal(res.success, true, 'terminal success — the buffer must not retry');
  assert.equal(res.terminal_skip, true);
  assert.equal(res.deduped, false, 'MUST be false — a dedup-confirm lookup here finds no analysis and wrongly escalates');
  assert.equal(res.reason, 'stop_bot');
  assert.equal(res.analysis, null);
});

test('a terminal suppression tag is also a terminal skip, reason carries the tag', () => {
  const res = buildAnalyzeResponse({
    skipped: true, terminal: true, reason: 'terminal_suppression:hard-disqualified',
  });

  assert.equal(res.success, true);
  assert.equal(res.terminal_skip, true);
  assert.equal(res.deduped, false);
  assert.match(res.reason, /hard-disqualified/, 'which tag fired is greppable');
});

test('REGRESSION: a real dedup still reports deduped, so the 2026-08-02 confirm check still runs', () => {
  const res = buildAnalyzeResponse({ skipped: true, reason: 'recently_analyzed' });

  assert.equal(res.success, true);
  assert.equal(res.deduped, true, 'must stay true — this is what triggers recentAnalysisExists()');
  assert.equal(res.terminal_skip, false, 'a dedup is NOT deliberate silence');
  assert.equal(res.reason, 'recently_analyzed');
});

test('REGRESSION: a genuine failure stays retryable', () => {
  // analyzeMessage returns null for the hourly rate limit and for an invalid
  // LLM response. Those must NOT become terminal — the reply still needs an
  // answer, and the buffer's retry plus the durable backstop are what deliver it.
  const res = buildAnalyzeResponse(null);

  assert.equal(res.success, false);
  assert.equal(res.analysis, null);
  assert.ok(!res.terminal_skip, 'a failure must never look terminal');
  assert.ok(!res.deduped, 'a failure must never look deduped');
});

test('a successful analysis sets neither flag', () => {
  const analysis = { buyer_stage: 3, objection_type: 'price' };
  const res = buildAnalyzeResponse(analysis);

  assert.equal(res.success, true);
  assert.deepEqual(res.analysis, analysis);
  assert.ok(!res.terminal_skip);
  assert.ok(!res.deduped);
});

test('the three terminal-ish outcomes are mutually exclusive', () => {
  // The invariant that keeps the pipeline branches unambiguous: deduped and
  // terminal_skip can never both be true, and neither is ever set on a failure.
  const cases = [
    { skipped: true, terminal: true, reason: 'stop_bot' },
    { skipped: true, reason: 'recently_analyzed' },
    null,
    { buyer_stage: 1 },
  ];
  for (const c of cases) {
    const r = buildAnalyzeResponse(c);
    assert.ok(!(r.deduped && r.terminal_skip), 'deduped and terminal_skip are mutually exclusive');
    if (!r.success) {
      assert.ok(!r.deduped && !r.terminal_skip, 'failures carry no terminal flags');
    }
  }
});
