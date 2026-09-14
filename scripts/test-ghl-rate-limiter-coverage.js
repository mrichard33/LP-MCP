/**
 * test-ghl-rate-limiter-coverage.js — v1.4 of src/ghl-rate-limiter.js.
 *
 * Three defects are locked down here, all discovered 2026-09-13/14 while
 * root-causing why POST /webhook/ghl/set-lp-appointment kept blowing past
 * GoHighLevel's own 60s client timeout (PR #921 worked around the symptom;
 * this suite guards the cause).
 *
 * 1. COVERAGE. ~half of LP-MCP's GHL traffic never entered the bucket — about
 *    40 call sites called fetch() directly, and n8n-helpers.js's ghlRequest did
 *    not even DETECT a 429. That is why every pause log read `tokens=50,
 *    paused=true`: the bucket was FULL at the moment of the pause, because the
 *    callers holding tokens were not the ones driving GHL over its limit. The
 *    limiter was throttling the well-behaved half on behalf of load it could
 *    not see. `scanGhlFetchSites` below is the guard that stops this returning
 *    the next time somebody adds a call site.
 *
 * 2. PAUSE COST. processQueue() is gated on !isPaused(), so during a pause
 *    NOTHING is dequeued by token and every waiter is guaranteed to reach
 *    acquireToken's fail-open timeout — which resolves it WITHOUT a token, and
 *    the caller then calls GHL anyway. The 30s wait therefore bought nothing
 *    and cost everything. It is now capped at PAUSE_WAIT_MS while paused.
 *
 * 3. PAUSE LENGTH. The 300s base pause was over-corrected in v1.1 and never
 *    walked back. HL-MCP hit the identical problem and settled on 60s (see
 *    HL-MCP src/clients/ghl-rate-limiter.ts v1.2, after the same 5-minute pause
 *    caused a 47-hour agentic outage). LP-MCP now matches.
 *
 * Clock: PAUSE_WAIT_MS has a 250ms floor, so it is set below the default here
 * rather than mocked — a real short wait keeps the fail-open path honest. The
 * limiter is a process singleton, so cases share module state and run in
 * declaration order; resetCycles() gives a clean slate where it matters.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Set BEFORE importing — the module reads these once, at import time.
process.env.GHL_RATE_PAUSE_WAIT_MS = '300';   // vs the 5000 default
// NOT set — the pause-length case below asserts the SHIPPED DEFAULT. Setting it
// here would make that assertion test the env plumbing instead of the default,
// and a revert to the old 300s value would sail straight through it.
delete process.env.GHL_RATE_PAUSE_MS;
delete process.env.GHL_RATE_MAX_PAUSE_MS;

const {
  acquireToken,
  withGhlToken,
  report429,
  resetCycles,
  getRateLimiterStats,
} = await import('../src/ghl-rate-limiter.js');

// ═══════════════════════════════════════════════════════════════════
// 1. withGhlToken — the wrapper every previously-ungoverned site now uses
// ═══════════════════════════════════════════════════════════════════

test('withGhlToken holds a token before invoking the thunk', async () => {
  resetCycles();
  const before = getRateLimiterStats().totalAcquired;
  const order = [];
  await withGhlToken(() => { order.push('fetch'); return { status: 200 }; });
  assert.equal(getRateLimiterStats().totalAcquired, before + 1,
    'the wrapper must spend a token — that is its entire purpose');
  assert.deepEqual(order, ['fetch'], 'thunk ran exactly once');
});

test('withGhlToken returns the thunk value untouched', async () => {
  resetCycles();
  const sentinel = { status: 200, body: 'original', nested: { a: 1 } };
  const out = await withGhlToken(() => sentinel);
  assert.equal(out, sentinel, 'must be the SAME object, not a copy or a rewrap');

  // Async thunks (the real shape: () => fetch(...)) resolve through it too.
  const awaited = await withGhlToken(async () => ({ status: 201 }));
  assert.equal(awaited.status, 201);
});

test('withGhlToken reports a 429 so the limiter can see it', async () => {
  resetCycles();
  assert.equal(getRateLimiterStats().consecutive429Cycles, 0, 'precondition');
  await withGhlToken(() => ({ status: 429 }));
  assert.equal(getRateLimiterStats().consecutive429Cycles, 1,
    'a 429 that the limiter cannot see is the whole coverage bug');
  assert.equal(getRateLimiterStats().paused, true, 'and it must trigger the pause');
});

test('withGhlToken never throws on a value that is not a Response', async () => {
  resetCycles();
  // Wrapped call sites return whatever their fetch returns; a defensive wrapper
  // must not be the thing that breaks a caller with an unusual return shape.
  for (const v of [undefined, null, 0, '', 'string', [], { noStatus: true }]) {
    const out = await withGhlToken(() => v);
    assert.deepEqual(out, v, `passthrough failed for ${JSON.stringify(v)}`);
  }
  assert.equal(getRateLimiterStats().consecutive429Cycles, 0,
    'none of those are a 429');
});

// ═══════════════════════════════════════════════════════════════════
// 2. Pause economics
// ═══════════════════════════════════════════════════════════════════

test('the base pause is 60s, not the 300s that caused the timeouts', () => {
  resetCycles();
  report429();
  const s = getRateLimiterStats();
  assert.equal(s.basePauseMs, 60000,
    'the SHIPPED DEFAULT for BASE_PAUSE_MS — not an env override; 300000 here is ' +
    'the 5-minute pause that caused the 60s GHL client timeouts');
  assert.equal(s.currentPauseMs, 60000, 'one 429 → one base pause, not five minutes');
  assert.ok(s.maxPauseMs >= s.basePauseMs, 'ceiling cannot sit below the floor');
});

test('a waiter inside a pause fails open in PAUSE_WAIT_MS, not WAIT_TIMEOUT_MS', async () => {
  resetCycles();
  report429();
  const s = getRateLimiterStats();
  assert.equal(s.paused, true, 'precondition: bucket is paused');
  assert.equal(s.pauseWaitMs, 300, 'env override took effect');
  assert.equal(s.waitTimeoutMs, 30000,
    'precondition: the ordinary empty-bucket wait is UNCHANGED at 30s');

  // No opts at all — this is what an ordinary call site passes, and before the
  // fix it sat here for the full 30s while the queue could not drain by token.
  const started = Date.now();
  await acquireToken();
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 5000,
    `paused waiter took ${elapsed}ms; must fail open near pauseWaitMs (300ms), not waitTimeoutMs (30000ms)`);
  assert.ok(elapsed >= 250,
    `took ${elapsed}ms — it should still WAIT, just briefly; an instant return means the pause is not being honoured at all`);
});

test('the pause cap does not lengthen a caller-supplied shorter wait', async () => {
  resetCycles();
  report429();
  const started = Date.now();
  await acquireToken({ maxWaitMs: 250 });   // 250 is the module's legal minimum
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1500,
    `a caller asking for 250ms waited ${elapsed}ms — the cap must be a MIN of the two, never a floor`);
});

test('an unpaused empty bucket still uses the full 30s wait', () => {
  resetCycles();
  // resetCycles() lifts the pause and restarts with 2 tokens.
  const s = getRateLimiterStats();
  assert.equal(s.paused, false);
  assert.equal(s.waitTimeoutMs, 30000,
    'the fix must be scoped to the PAUSED case — a merely-empty bucket drains by ' +
    'token, so waiting there is productive and must not be shortened');
});

// ═══════════════════════════════════════════════════════════════════
// 3. Coverage guard — the one that stops this regressing
// ═══════════════════════════════════════════════════════════════════

const GHL_V2_HOST = 'services.leadconnectorhq.com';
const EXEMPT_MARKER = 'rate-limiter-exempt:';

/**
 * Every fetch() inside a module that talks to the GHL v2 API must be one of:
 *   - wrapped:  withGhlToken(() => fetch(...))
 *   - manual:   an `await acquireToken(...)` in the same function above it
 *   - exempt:   a `// rate-limiter-exempt: <reason>` comment on the line above
 *
 * The third is the point of the design: a new call site cannot pass silently.
 * It either joins the bucket or states, in the source, why it does not.
 */
function scanGhlFetchSites(dir = 'src') {
  const offenders = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!entry.name.endsWith('.js')) continue;

      const src = fs.readFileSync(p, 'utf8');
      if (!src.includes(GHL_V2_HOST)) continue;
      const lines = src.split('\n');

      for (const m of src.matchAll(/\bfetch\s*\(/g)) {
        const i = m.index;
        const lineNo = src.slice(0, i).split('\n').length - 1;
        const line = lines[lineNo];
        const col = i - (src.lastIndexOf('\n', i) + 1);

        // Ignore the word appearing inside a comment or a doc block.
        if (line.slice(0, col).includes('//') || line.trim().startsWith('*')) continue;

        if (src.slice(Math.max(0, i - 40), i).includes('withGhlToken(() => ')) continue;
        if (lines.slice(Math.max(0, lineNo - 25), lineNo).join('\n').includes('acquireToken(')) continue;
        if (lineNo > 0 && lines[lineNo - 1].includes(EXEMPT_MARKER)) continue;

        offenders.push(`${p}:${lineNo + 1}  ${line.trim().slice(0, 90)}`);
      }
    }
  };
  walk(dir);
  return offenders;
}

test('no GHL call site bypasses the rate limiter', () => {
  const offenders = scanGhlFetchSites();
  assert.deepEqual(offenders, [],
    'Ungoverned fetch() in a module that talks to the GHL v2 API:\n  ' +
    offenders.join('\n  ') +
    `\n\nWrap it as withGhlToken(() => fetch(...)), or — if it does NOT spend the ` +
    `GHL v2 API budget (a /hooks webhook trigger, a self-call, GroupMe, Lead ` +
    `Perfection) — put a "// ${EXEMPT_MARKER} <reason>" comment on the line above.`);
});

test('the coverage guard actually detects a bypass', () => {
  // A guard that cannot fail is not a guard. Prove the scanner sees an
  // unwrapped GHL fetch by running it against a fixture directory.
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'limiter-guard-'));
  fs.writeFileSync(path.join(tmp, 'bad.js'),
    'const r = await fetch(`https://services.leadconnectorhq.com/contacts/${id}`, {});\n');
  assert.equal(scanGhlFetchSites(tmp).length, 1, 'scanner missed an obvious bypass');

  fs.writeFileSync(path.join(tmp, 'bad.js'),
    'const r = await withGhlToken(() => fetch(`https://services.leadconnectorhq.com/contacts/${id}`, {}));\n');
  assert.equal(scanGhlFetchSites(tmp).length, 0, 'scanner false-positives on a wrapped call');

  fs.writeFileSync(path.join(tmp, 'bad.js'),
    '// rate-limiter-exempt: test fixture.\n' +
    'const r = await fetch(`https://services.leadconnectorhq.com/x`, {});\n');
  assert.equal(scanGhlFetchSites(tmp).length, 0, 'scanner ignores the exemption marker');

  fs.rmSync(tmp, { recursive: true, force: true });
});
