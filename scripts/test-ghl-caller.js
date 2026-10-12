/**
 * Who made each GHL request (2026-10-12). LP-MCP made ~127,000 GHL requests in
 * 24h and the rehash sweep failed 1 pass in 4 on 429s, but nothing could say
 * which code made the calls. src/ghl-caller.js carries the caller in async
 * context; acquireToken counts per caller.
 *
 * Run: node --test scripts/test-ghl-caller.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  withGhlCaller, currentGhlCaller, stackLabel, normalizePath, ghlCallerStats,
  takeGhlCallerWindow, formatGhlCallerWindow, _resetGhlCallers,
} = await import('../src/ghl-caller.js');
const { acquireToken, report429, resetCycles, getRateLimiterStats } = await import('../src/ghl-rate-limiter.js');

const count = (label) => ghlCallerStats().since_boot.find((c) => c.label === label) || { requests: 0, r429: 0 };

test('the caller follows async work and an inner label wins', async () => {
  assert.equal(currentGhlCaller(), null);
  await withGhlCaller('job:outer', async () => {
    assert.equal(currentGhlCaller(), 'job:outer');
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(currentGhlCaller(), 'job:outer', 'survives a timer hop');
    await withGhlCaller('action:add_tag', async () => {
      assert.equal(currentGhlCaller(), 'action:add_tag');
    });
    assert.equal(currentGhlCaller(), 'job:outer');
  });
  assert.equal(currentGhlCaller(), null);
});

test('acquireToken counts each request against the current caller', async () => {
  _resetGhlCallers();
  resetCycles();
  await withGhlCaller('job:rehash-tag-sweep', async () => { await acquireToken(); await acquireToken(); });
  await acquireToken({ label: 'explicit' });
  assert.equal(count('job:rehash-tag-sweep').requests, 2);
  assert.equal(count('explicit').requests, 1);
  assert.ok(getRateLimiterStats().byCaller.since_boot.length >= 2, 'stats endpoint carries the split');
});

test('a 429 is charged to the caller that saw it', async () => {
  _resetGhlCallers();
  withGhlCaller('job:sale-p2-backstop', () => report429());
  assert.equal(count('job:sale-p2-backstop').r429, 1);
  resetCycles();
});

test('with no context label, the first non-plumbing source file is the caller', () => {
  const stack = [
    'Error',
    '    at acquireToken (/app/src/ghl-rate-limiter.js:470:3)',
    '    at ghlFetch (/app/src/actions/helpers.js:72:9)',
    '    at async getContact (/app/src/ghl.js:70:1)',
    '    at async processProspect (/app/src/sync-leads.js:799:12)',
  ].join('\n');
  assert.equal(stackLabel(stack), 'src:sync-leads.js');
  assert.equal(stackLabel('Error\n    at x (node:internal/foo:1:1)'), 'unlabeled');
  // A file whose name only STARTS with "ghl" is not plumbing.
  assert.equal(stackLabel('Error\n    at x (/app/src/ghl-field-sync.js:9:9)'), 'src:ghl-field-sync.js');
});

test('route labels fold ids out of the path', () => {
  assert.equal(normalizePath('/webhook/ghl/abc123XYZ/9?x=1'), '/webhook/ghl/:id/:id');
  assert.equal(normalizePath('/n8n/analyze-message'), '/n8n/analyze-message');
});

test('a window closes, resets, and prints busiest first', async () => {
  _resetGhlCallers();
  await withGhlCaller('job:a', async () => { await acquireToken(); });
  await withGhlCaller('job:b', async () => { await acquireToken(); await acquireToken(); });
  const win = takeGhlCallerWindow();
  assert.deepEqual(win.callers.map((c) => c.label), ['job:b', 'job:a']);
  assert.match(formatGhlCallerWindow(win), /^\[GhlCallers\] 3 GHL requests .*job:b=2, job:a=1$/);
  assert.equal(takeGhlCallerWindow().callers.length, 0, 'the next window starts empty');
});

test('runJob credits the job', async () => {
  _resetGhlCallers();
  const { runJob } = await import('../src/job-runner.js');
  await runJob('test-ghl-caller-job', async () => { await acquireToken(); return { ok: true }; }, { supabase: null });
  assert.equal(count('job:test-ghl-caller-job').requests, 1);
});

test('the call sites wrapped in this change still load (a missing import is a runtime crash)', async () => {
  await import('../src/notifications/appointment-notifications.js');
  await import('../src/notifications/cancellation-notifications.js');
});
