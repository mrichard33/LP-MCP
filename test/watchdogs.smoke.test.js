/**
 * test/watchdogs.smoke.test.js
 *
 * Module-load smoke test for the watchdogs moved onto alert-state.js on
 * 2026-09-05: five9-silence-watchdog, fb-publish-watchdog, drift-detector,
 * data-freshness and backstop-notify.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Same class of defect as test/executor-heartbeat.smoke.test.js and
 * test/alert-state.smoke.test.js document: PR #648 dropped a `const`
 * declaration, `node --check` passed because an undeclared identifier is a
 * runtime ReferenceError rather than a parse error, and the LP MCP process went
 * down for 52 minutes on boot.
 *
 * Every module here is started from src/index.js at boot, and this change moved
 * a constant out of each one (`lastAlertMs`, the `alerted` Map, `lastAlertAt`)
 * while adding an import. That is exactly the shape of the #648 defect. A parse
 * check structurally cannot catch it; only importing and calling can.
 *
 * Deliberately shallow — behavior lives in scripts/test-alert-state-set.js,
 * scripts/test-drift-detector-alert-state.js and scripts/test-backstop-notify.js.
 * What is proven here is that each module LOADS, its exports EXIST, and the
 * paths that need no database EXECUTE rather than throwing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
// Keep every watchdog's own start() a no-op: this file must not arm timers.
process.env.FIVE9_SILENCE_WATCHDOG_ENABLED = 'false';
process.env.FB_WATCHDOG_ENABLED = 'false';
process.env.DRIFT_DETECTOR_DISABLED = 'true';

const five9 = await import('../src/five9-silence-watchdog.js');
const fb = await import('../src/fb-publish-watchdog.js');
const drift = await import('../src/services/drift-detector.js');
const freshness = await import('../src/admin/data-freshness.js');
const backstop = await import('../src/services/backstop-notify.js');

test('every migrated watchdog exports what src/index.js imports', () => {
  assert.equal(typeof five9.startFive9SilenceWatchdog, 'function');
  assert.equal(typeof five9.checkFive9Silence, 'function');
  assert.equal(typeof fb.startFbPublishWatchdog, 'function');
  assert.equal(typeof fb.checkOverdueFbPosts, 'function');
  assert.equal(typeof drift.startDriftDetectorScheduler, 'function');
  assert.equal(typeof drift.runDriftScan, 'function');
  assert.equal(typeof freshness.startDataFreshnessMonitorScheduler, 'function');
  assert.equal(typeof freshness.runFreshnessCheck, 'function');
  assert.equal(typeof backstop.notifyBackstopRun, 'function');
  assert.equal(typeof backstop.notifyBackstopFailure, 'function');
});

test('the new test seams exist and execute', () => {
  assert.equal(typeof fb.__resetFbWatchdogFallback, 'function');
  assert.equal(typeof drift.__resetDriftFallback, 'function');
  assert.equal(typeof backstop.__resetCooldowns, 'function');
  fb.__resetFbWatchdogFallback();
  drift.__resetDriftFallback();
  backstop.__resetCooldowns();
});

test('the disabled start() paths execute without arming a timer', () => {
  assert.doesNotThrow(() => five9.startFive9SilenceWatchdog());
  assert.doesNotThrow(() => fb.startFbPublishWatchdog());
  assert.doesNotThrow(() => drift.startDriftDetectorScheduler());
});

test('shouldNotify still answers with no database at all', () => {
  // The gate is pure as of 2026-09-05, so it must work with nothing wired up.
  const out = backstop.shouldNotify({ severity: 'degraded', sweepMode: 'intake' });
  assert.equal(out.send, true);
  assert.equal(out.kind, 'backlog');
});

test('a scan with no HL credentials degrades rather than throwing', async () => {
  const url = process.env.HL_MCP_URL;
  delete process.env.HL_MCP_URL;
  try {
    // Runs inside a setInterval with no try/catch above it, so a throw here
    // takes the process down. It must report failure instead.
    const res = await drift.runDriftScan();
    assert.equal(res.success, false);
    assert.equal(res.event_emitted, false);
  } finally {
    if (url === undefined) delete process.env.HL_MCP_URL; else process.env.HL_MCP_URL = url;
  }
});
