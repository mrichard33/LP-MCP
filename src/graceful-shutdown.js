// Graceful shutdown — makes Railway's drain window (drainingSeconds=120) real.
// Before this, SIGTERM → process.exit(0) at once, killing in-flight requests and
// any ack-then-process work mid-way (silent lead loss: the sender already got 200).
//
// Sequence on SIGTERM/SIGINT:
//   1. stop accepting new connections (server.close)
//   2. run 'start' hooks (stop schedulers so no NEW sweeps begin)
//   3. wait until in-flight requests AND tracked background work reach 0,
//      or SHUTDOWN_GRACE_MS elapses (default 90s — must stay < Railway's 120s)
//   4. run 'exit' hooks (e.g. mark running sync logs interrupted), then exit
//
// Long-lived MCP streams (GET /mcp, GET /sse) are NOT counted as in-flight —
// they never "finish" and would pin every drain to the full grace period.

const GRACE_MS = parseInt(process.env.SHUTDOWN_GRACE_MS || '90000', 10);
let shuttingDown = false;
let inflight = 0;
const background = new Set();
const hooks = { start: [], exit: [] };

export function isShuttingDown() { return shuttingDown; }

function isLongLived(req) {
  return (req.method === 'GET' && (req.path === '/mcp' || req.path === '/sse'));
}

export function trackInflight(req, res, next) {
  if (isLongLived(req)) return next();
  inflight++;
  let done = false;
  const finish = () => { if (!done) { done = true; inflight--; } };
  res.on('finish', finish);
  res.on('close', finish);
  next();
}

// Wrap fire-and-forget work started AFTER a response was sent, so shutdown waits for it.
export function trackBackground(promise) {
  const p = Promise.resolve(promise).catch(() => {}).finally(() => background.delete(p));
  background.add(p);
  return promise;
}

// Same intent as trackBackground, for the `setImmediate(async () => {...})` shape
// several intake routes use to defer work past the response. Drop-in: replace
// `setImmediate(` with `trackImmediate(` and the deferred work is drained too.
export function trackImmediate(fn) {
  return trackBackground(new Promise((resolve) => {
    setImmediate(() => { Promise.resolve().then(fn).catch(() => {}).finally(resolve); });
  }));
}

export function onShutdown(fn, phase = 'start') {
  (hooks[phase] || hooks.start).push(fn);
}

async function runHooks(phase, signal) {
  for (const fn of hooks[phase]) {
    try { await fn(signal); } catch (e) { console.warn(`[Shutdown] ${phase} hook failed:`, e.message); }
  }
}

export function installGracefulShutdown(server) {
  const handler = (signal) => async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const started = Date.now();
    console.log(`[Shutdown] ${signal} received — draining (inflight=${inflight}, background=${background.size}, grace=${GRACE_MS}ms)`);
    try { server.close(() => console.log('[Shutdown] HTTP server closed to new connections')); } catch (_) {}
    await runHooks('start', signal);
    while ((inflight > 0 || background.size > 0) && Date.now() - started < GRACE_MS) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const clean = inflight === 0 && background.size === 0;
    console.log(`[Shutdown] ${clean ? 'Drained cleanly' : `GRACE EXPIRED with inflight=${inflight}, background=${background.size}`} after ${Date.now() - started}ms`);
    await runHooks('exit', signal);
    process.exit(0);
  };
  process.on('SIGTERM', handler('SIGTERM'));
  process.on('SIGINT', handler('SIGINT'));
}

// test-only
export function _stateForTests() { return { shuttingDown, inflight, background: background.size }; }
