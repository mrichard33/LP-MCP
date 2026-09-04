/**
 * test/alert-state.smoke.test.js
 *
 * Module-load smoke test for src/alert-state.js.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Same class of defect as test/executor-heartbeat.smoke.test.js documents:
 * PR #648 dropped a `const` declaration, `node --check` passed because an
 * undeclared identifier is a runtime ReferenceError rather than a parse error,
 * and the whole LP MCP process went down for 52 minutes on boot.
 *
 * alert-state.js is imported by four modules that the heartbeats and the n8n
 * capacity poller all reach on their normal path, so a dropped declaration
 * here takes the same blast radius. A parse check structurally cannot catch
 * that; only importing the module and actually calling its exports can.
 *
 * These assertions stay deliberately shallow — the behavior is covered in
 * scripts/test-alert-state.js. What is proven here is that every export
 * EXISTS and EXECUTES.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const mod = await import('../src/alert-state.js');

test('every export exists', () => {
  for (const name of [
    'reportAlertCondition', 'formatRecovered', 'humanDuration',
    '__setAlertStateClientForTests', '__resetAlertStateFallback',
  ]) {
    assert.equal(typeof mod[name], 'function', `${name} is exported`);
  }
});

test('the pure helpers execute', () => {
  assert.equal(typeof humanDurationOf(0), 'string');
  assert.match(mod.formatRecovered('thing', new Date()), /RECOVERED/);
  function humanDurationOf(ms) { return mod.humanDuration(ms); }
});

test('reportAlertCondition executes on the paths that need no client', async () => {
  // null is the hottest path in production: most sweeps observe nothing.
  assert.equal((await mod.reportAlertCondition({ key: 'k', active: null })).action, 'noop');
  assert.equal((await mod.reportAlertCondition({})).action, 'noop');
  // No supabase env here, so the singleton is absent — this must degrade,
  // never throw, because it runs inside a heartbeat with no try/catch above it.
  const res = await mod.reportAlertCondition({
    key: 'smoke:key', active: true, text: () => 'body',
    send: async () => ({ sent: true }),
  });
  assert.ok(typeof res.action === 'string');
});

test('the test seams execute', () => {
  mod.__setAlertStateClientForTests(null);
  mod.__resetAlertStateFallback();
});
