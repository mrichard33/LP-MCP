/**
 * Graceful shutdown — scripts/test-graceful-shutdown.js
 *
 * Proves the drain window is real. Each case spawns a CHILD node process
 * running a tiny express app wired exactly like src/index.js (trackInflight
 * middleware + installGracefulShutdown on the listen handle), sends it a real
 * SIGTERM, and asserts on what the client got and when the child exited.
 *
 * A child process is the only honest way to test this: the module installs
 * process-level signal handlers and calls process.exit(0), neither of which
 * can be exercised in-process without killing the test runner.
 *
 * Why these four cases:
 *   1. in-flight request  — the original defect: SIGTERM killed it mid-response.
 *   2. tracked background — the SILENT loss: sender already had its 200.
 *   3. grace expiry       — a hung request must not hold the container past
 *                           SHUTDOWN_GRACE_MS (Railway kills at 120s).
 *   4. long-lived stream  — GET /mcp never finishes; counting it would pin
 *                           every deploy to the full grace period.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// The child lives in a tmpdir, so bare specifiers ('express') will not resolve
// from there. Both imports are handed to it as absolute paths instead.
const SHUTDOWN_MODULE = JSON.stringify(join(ROOT, 'src/graceful-shutdown.js'));
const EXPRESS_MODULE = JSON.stringify(join(ROOT, 'node_modules/express/index.js'));

// The child app. Kept in one string so every case boots identical wiring and
// only the env (SHUTDOWN_GRACE_MS) and the route exercised differ.
const CHILD_APP = `
import express from ${EXPRESS_MODULE};
import { trackInflight, trackBackground, installGracefulShutdown } from ${SHUTDOWN_MODULE};

const app = express();
app.use(trackInflight);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Slow in-flight request.
app.get('/slow', async (req, res) => {
  await sleep(2000);
  res.json({ ok: true, route: 'slow' });
});

// 2. Ack immediately, then tracked background work.
app.get('/ack-then-work', (req, res) => {
  res.json({ ok: true, route: 'ack-then-work' });
  trackBackground(sleep(1500).then(() => console.log('BACKGROUND_DONE')));
});

// 3. Never finishes — must be cut off by the grace timer.
app.get('/hang', async (req, res) => {
  await sleep(8000);
  res.json({ ok: true, route: 'hang' });
});

// 4. Long-lived stream, the /mcp shape. Headers flush, body never ends.
app.get('/mcp', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.write(': open\\n\\n');
  // deliberately never res.end()
});

const server = app.listen(0, () => {
  console.log('LISTENING ' + server.address().port);
});
installGracefulShutdown(server);
`;

const tmp = mkdtempSync(join(tmpdir(), 'gshut-'));
const CHILD_PATH = join(tmp, 'child-app.mjs');
writeFileSync(CHILD_PATH, CHILD_APP);

/**
 * Boot the child app, wait for its port, and return handles plus a promise
 * that resolves with {code, ms} when it exits. stdout is captured whole so a
 * case can assert on ordering of log lines.
 */
function startChild(env = {}) {
  const child = spawn(process.execPath, [CHILD_PATH], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const startedAt = Date.now();
  const exited = new Promise((resolve) => {
    child.on('exit', (code) => resolve({ code, ms: Date.now() - startedAt }));
  });

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child never listened. stderr:\n${stderr}`)), 10000);
    child.stdout.on('data', () => {
      const m = /LISTENING (\d+)/.exec(stdout);
      if (m) { clearTimeout(timer); resolve(parseInt(m[1], 10)); }
    });
  });

  return { child, ready, exited, out: () => stdout, err: () => stderr };
}

// A plain GET that resolves with the full body — or rejects if the socket dies
// before the response completed, which is exactly the failure this suite hunts.
function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
      res.on('aborted', () => reject(new Error('response aborted mid-flight')));
    });
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('an in-flight request completes after SIGTERM, and the child exits after it', async () => {
  const { child, ready, exited, out } = startChild({ SHUTDOWN_GRACE_MS: '5000' });
  const port = await ready;

  const pending = get(port, '/slow');
  await sleep(300);
  child.kill('SIGTERM');

  // The original defect: process.exit(0) here, so this rejected with ECONNRESET.
  const res = await pending;
  assert.equal(res.status, 200, 'in-flight request must still get its response');
  assert.equal(JSON.parse(res.body).route, 'slow');

  const { code } = await exited;
  assert.equal(code, 0);
  assert.match(out(), /\[Shutdown\] SIGTERM received — draining/);
  assert.match(out(), /Drained cleanly/, 'must drain cleanly, not expire');
});

test('tracked background work finishes before exit, even though the client was already acked', async () => {
  const { child, ready, exited, out } = startChild({ SHUTDOWN_GRACE_MS: '5000' });
  const port = await ready;

  const res = await get(port, '/ack-then-work');
  assert.equal(res.status, 200);

  await sleep(200);
  child.kill('SIGTERM');

  const { code } = await exited;
  assert.equal(code, 0);
  // The whole point: post-ack work is NOT silently discarded.
  assert.match(out(), /BACKGROUND_DONE/, 'background work must run to completion');
  assert.match(out(), /Drained cleanly/);
  assert.ok(
    out().indexOf('BACKGROUND_DONE') < out().indexOf('Drained cleanly'),
    'background work must complete before the drain reports clean'
  );
});

test('a request that never finishes cannot hold the container past the grace window', async () => {
  const { child, ready, exited, out } = startChild({ SHUTDOWN_GRACE_MS: '1000' });
  const port = await ready;

  // The 8s route outlives the 1s grace. Its socket dies with the process; that
  // rejection is expected and must not fail the test.
  get(port, '/hang').catch(() => {});
  await sleep(300);

  const killedAt = Date.now();
  child.kill('SIGTERM');

  const { code } = await exited;
  const drainMs = Date.now() - killedAt;
  assert.equal(code, 0);
  assert.ok(drainMs < 3000, `must exit on the grace timer, took ${drainMs}ms`);
  assert.ok(drainMs >= 900, `must not exit before the grace window, took ${drainMs}ms`);
  assert.match(out(), /GRACE EXPIRED with inflight=1/, 'must name what held the drain');
});

test('an open long-lived /mcp stream does not delay exit', async () => {
  const { child, ready, exited, out } = startChild({ SHUTDOWN_GRACE_MS: '5000' });
  const port = await ready;

  // Open the stream and keep the socket alive — headers arrive, body never ends.
  const streamOpen = new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/mcp' }, (res) => {
      res.on('data', () => resolve());
      res.on('error', () => {});
    });
    req.on('error', reject);
    setTimeout(() => reject(new Error('stream never opened')), 5000);
  });
  await streamOpen;

  const killedAt = Date.now();
  child.kill('SIGTERM');

  const { code } = await exited;
  const drainMs = Date.now() - killedAt;
  assert.equal(code, 0);
  // Without the isLongLived() exemption this pins to the full 5s grace.
  assert.ok(drainMs < 2000, `open stream must not pin the drain, took ${drainMs}ms`);
  assert.match(out(), /Drained cleanly/, 'stream must not be counted as in-flight');
});
