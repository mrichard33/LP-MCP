/**
 * test/executor-heartbeat.smoke.test.js
 *
 * Module-load smoke test for src/executor-heartbeat.js.
 *
 * WHY THIS EXISTS
 * ───────────────
 * 2026-08-08. PR #648 rewrote executor-heartbeat.js whole-file and dropped
 * the `const FIRST_RUN_DELAY_MS` declaration while leaving both of its use
 * sites intact. Deploy b493f767 crashed on boot:
 *
 *   ReferenceError: FIRST_RUN_DELAY_MS is not defined
 *       at startExecutorHeartbeatScheduler (src/executor-heartbeat.js:672:6)
 *       at Server.<anonymous> (src/index.js:1102:3)
 *
 * The whole LP MCP process went down for 52 minutes — MCP server, sync
 * engine, Decision Engine, Action Executor, every route — because index.js
 * arms the scheduler from the server's listen callback with no try/catch.
 *
 * CI passed. The required check is `node --check`, which is a parse. An
 * undeclared identifier is a runtime ReferenceError, not a syntax error, so
 * the file parsed clean. A parse check structurally CANNOT catch a dropped
 * declaration. Only importing the module and calling its exported entry
 * points can.
 *
 * WHAT THIS COVERS
 * ────────────────
 * Every exported entry point, plus the deferred timer callback — because
 * the crash was inside the setTimeout scheduling path, which a bare import
 * would not have reached.
 *
 * This is deliberately a dependency-free smoke test, not a behavioral one.
 * It stubs every import and asserts only that the module loads and its
 * exports execute without throwing. Its job is to catch "you deleted a
 * declaration / renamed an import / typo'd an identifier" — the class of
 * defect that takes the whole service down and that a parse check misses.
 *
 * HOW TO RUN
 * ──────────
 *   node test/executor-heartbeat.smoke.test.js
 *
 * Exits 0 on pass, 1 on failure with the offending error. Intended to run
 * in the PR check alongside `node --check`.
 */

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.join(HERE, '..', 'src', 'executor-heartbeat.js');

// Stubs for every module executor-heartbeat.js imports. Each returns the
// minimal shape the real module consumes. supabase returns a thenable chain
// so any query-builder sequence resolves to an empty result.
const STUBS = {
  'supabase.js': `
const chain = () => {
  const o = {};
  for (const m of ['from','select','eq','in','gte','lte','not','is','order','limit']) o[m] = () => chain();
  o.then = (resolve) => resolve({ data: [], error: null, count: 0 });
  return o;
};
export default { from: () => chain() };
`,
  'action-executor.js': `
export async function executeActions() {
  return { actions_executed: 0, completed: 0, failed: 0, retrying: 0, stuck_actions_reaped: 0, elapsed_ms: 1 };
}
`,
  'actions/reaper.js': `export async function reapStaleLocks() { return { reaped: 0 }; }`,
  'groupme.js': `export async function sendGroupMeMessage() { return true; }`,
  'executor-queue-alerts.js': `
export function shouldAlertQueueDepth() { return { alert: false, reasons: [] }; }
export function formatQueueAlert() { return 'stub'; }
`,
  'ghl-rate-limiter.js': `
export function getRateLimiterStats() { return { timedOut: 0, total429s: 0, waitQueueDepth: 0 }; }
`,
  'limiter-health-alerts.js': `
export function shouldAlertLimiter() { return { alert: false, reasons: [], critical: false }; }
export function formatLimiterAlert() { return 'stub'; }
export function shouldAlertFailedActions() { return { alert: false, reasons: [] }; }
export function formatFailedActionsAlert() { return 'stub'; }
`,
  // 2026-09-04 — the durable edge-trigger layer. Every alert path now goes
  // through it, so the smoke test has to satisfy the import or the module it
  // is guarding cannot even load.
  'alert-state.js': `
export async function reportAlertCondition() { return { action: 'noop', sent: false }; }
`,
};

const checks = [];
function record(name, fn) { checks.push({ name, fn }); }

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), 'hb-smoke-'));
  const src = path.join(dir, 'src');
  await mkdir(path.join(src, 'actions'), { recursive: true });

  for (const [rel, body] of Object.entries(STUBS)) {
    await writeFile(path.join(src, rel), body, 'utf8');
  }
  await writeFile(path.join(src, 'executor-heartbeat.js'), await readFile(TARGET, 'utf8'), 'utf8');

  // Keep the deferred first run fast so the timer callback actually fires
  // inside the test — the PR #648 crash lived in that scheduling path.
  process.env.EXECUTOR_HEARTBEAT_FIRST_RUN_DELAY_MS = '25';
  process.env.EXECUTOR_HEARTBEAT_INTERVAL_MS = '3600000';

  let mod;

  record('module loads', async () => {
    mod = await import(pathToFileURL(path.join(src, 'executor-heartbeat.js')).href);
    for (const fn of ['runHeartbeat', 'startExecutorHeartbeatScheduler', 'registerExecutorHeartbeatRoutes']) {
      if (typeof mod[fn] !== 'function') throw new Error(`missing export: ${fn}`);
    }
  });

  // The exact call site that crashed production (src/index.js:1102).
  record('startExecutorHeartbeatScheduler() does not throw', async () => {
    mod.startExecutorHeartbeatScheduler();
  });

  // The crash was INSIDE the setTimeout arg evaluation — a bare import would
  // not reach it. Wait past the delay so the callback actually runs.
  record('deferred first run executes', async () => {
    await new Promise((r) => setTimeout(r, 200));
  });

  record('runHeartbeat() resolves', async () => {
    const r = await mod.runHeartbeat();
    if (typeof r !== 'object' || r === null) throw new Error('runHeartbeat returned non-object');
  });

  record('runHeartbeat({force:true}) resolves', async () => {
    const r = await mod.runHeartbeat({ force: true });
    if (typeof r !== 'object' || r === null) throw new Error('forced runHeartbeat returned non-object');
  });

  const routes = {};
  record('routes register', async () => {
    mod.registerExecutorHeartbeatRoutes({
      post: (p, h) => { routes[`POST ${p}`] = h; },
      get: (p, h) => { routes[`GET ${p}`] = h; },
    });
    if (Object.keys(routes).length !== 2) {
      throw new Error(`expected 2 routes, got ${Object.keys(routes).length}`);
    }
  });

  record('GET /heartbeat-status responds 200', async () => {
    let body, code = 200;
    await routes['GET /n8n/decision-engine/heartbeat-status'](
      {},
      { json: (o) => { body = o; }, status: (c) => { code = c; return { json: (o) => { body = o; } }; } }
    );
    if (code !== 200 || !body?.success) {
      throw new Error(`status route failed: code=${code} body=${JSON.stringify(body)}`);
    }
  });

  record('POST /heartbeat responds 200', async () => {
    let body, code = 200;
    await routes['POST /n8n/decision-engine/heartbeat'](
      { body: {} },
      { json: (o) => { body = o; }, status: (c) => { code = c; return { json: (o) => { body = o; } }; } }
    );
    if (code !== 200 || !body?.success) {
      throw new Error(`heartbeat route failed: code=${code} body=${JSON.stringify(body)}`);
    }
  });

  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`  ok   ${name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL ${name}`);
      console.error(`       ${err.stack || err.message}`);
      break; // later checks depend on earlier ones; the first failure is the signal
    }
  }

  await rm(dir, { recursive: true, force: true });

  if (failed > 0) {
    console.error(`\nexecutor-heartbeat smoke test FAILED (${failed})`);
    process.exit(1);
  }
  console.log(`\nexecutor-heartbeat smoke test passed (${checks.length} checks)`);
  process.exit(0);
}

main().catch((err) => {
  console.error('smoke test harness error:', err.stack || err.message);
  process.exit(1);
});
