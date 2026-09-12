/**
 * Tests — the LP circuit breaker closes itself
 * scripts/test-lp-circuit-breaker.js
 *
 * WHAT THIS PROTECTS. The breaker's job is to stop us hammering Lead
 * Perfection while LP is unwell. It is NOT supposed to take our own jobs down
 * with it, and until 2026-09-12 it did exactly that: once `circuitOpen` was
 * true, `checkCircuit()` threw BEFORE the wrapped call ran, so `recordSuccess()`
 * was unreachable and the flag could never clear. `resetCircuit()` had no
 * production caller. The only remedy was a redeploy.
 *
 * WHAT THAT COST. The appointment capacity board's freshness stamp only
 * advances on a successful LP fetch. On 2026-09-12 LP went slow, the breaker
 * latched, every 5-minute sweep threw instantly, and the board painted
 * "DATA STALE — last update 9:56 AM (80 min ago)" over numbers that were still
 * correct. It cleared only when an unrelated deploy landed at 15:18 UTC.
 *
 * THE INVARIANT: a breaker that opens must be able to close itself, without a
 * deploy, once LP recovers. Everything below pins some part of that.
 *
 * NO REAL HTTP and no timers — the cooldown is set to 0ms via env so the
 * half-open transition is reachable synchronously, and the wrapped function is
 * a plain stub. Env is restored in after().
 *
 * Run: node --test scripts/test-lp-circuit-breaker.js
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const THRESHOLD = 10;   // CIRCUIT_THRESHOLD in src/lp-client.js
const CEILING_MS = 2000; // must match LP_CIRCUIT_COOLDOWN_MAX_MS below
const PROBE_TIMEOUT_MS = 1500; // must match LP_CIRCUIT_PROBE_TIMEOUT_MS below

let withCircuit, resetCircuit, getCircuitStatus;
const savedEnv = {};

// Env LP-MCP reads at import time. The breaker module is imported once per
// process, so the cooldown has to be in place before the first import.
const ENV = {
  LP_CIRCUIT_COOLDOWN_MS: '1',      // clamped to 1000 floor; see note in the reopen test
  LP_CIRCUIT_COOLDOWN_MAX_MS: '2000', // one doubling off the 1000ms floor, so case 8 stays fast
  LP_CIRCUIT_PROBE_TIMEOUT_MS: '1500', // short enough to exercise the slot watchdog
  LP_API_BASE_URL: 'https://lp.invalid',
  LP_APP_KEY: 'test', LP_CLIENT_ID: '1', LP_USERNAME: 'u', LP_PASSWORD: 'p',
  SUPABASE_URL: 'https://supabase.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test',
};

const fail = () => { throw new Error('LP is down'); };
const ok = async () => 'payload';

/** Walk the breaker to open by failing THRESHOLD times. */
async function openBreaker() {
  for (let i = 0; i < THRESHOLD; i++) {
    await assert.rejects(() => withCircuit(fail));
  }
}

before(async () => {
  for (const [k, v] of Object.entries(ENV)) { savedEnv[k] = process.env[k]; process.env[k] = v; }
  ({ withCircuit, resetCircuit, getCircuitStatus } = await import('../src/lp-client.js'));
});

after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

beforeEach(() => resetCircuit());

test('case 1: a healthy call reports closed and zero failures', async () => {
  assert.equal(await withCircuit(ok), 'payload');
  const s = getCircuitStatus();
  assert.equal(s.state, 'closed');
  assert.equal(s.circuitOpen, false);
  assert.equal(s.consecutiveFailures, 0);
});

test('case 2: failures below the threshold do NOT open the breaker', async () => {
  for (let i = 0; i < THRESHOLD - 1; i++) await assert.rejects(() => withCircuit(fail));
  const s = getCircuitStatus();
  assert.equal(s.circuitOpen, false, 'opened early — the threshold is the whole point of the tolerance');
  assert.equal(s.consecutiveFailures, THRESHOLD - 1);
});

test('case 3: one success resets the counter, so intermittent flakiness never opens it', async () => {
  for (let i = 0; i < THRESHOLD - 1; i++) await assert.rejects(() => withCircuit(fail));
  await withCircuit(ok);
  assert.equal(getCircuitStatus().consecutiveFailures, 0);
  // Another near-miss run must still not open it.
  for (let i = 0; i < THRESHOLD - 1; i++) await assert.rejects(() => withCircuit(fail));
  assert.equal(getCircuitStatus().circuitOpen, false);
});

test('case 4: the threshold opens the breaker and it reports a retry time', async () => {
  await openBreaker();
  const s = getCircuitStatus();
  assert.equal(s.circuitOpen, true);
  assert.ok(s.openedAt, 'openedAt must be recorded — the cooldown is measured from it');
  assert.ok(s.cooldownMs > 0, 'an open breaker with no cooldown can never reach half-open');
  assert.equal(typeof s.retryInMs, 'number');
});

test('case 5: THE REGRESSION — an open breaker recovers without a restart', async () => {
  await openBreaker();
  assert.equal(getCircuitStatus().circuitOpen, true);

  // Wait out the cooldown. This is the step that was impossible before: the
  // old checkCircuit() threw unconditionally while circuitOpen was true, so no
  // amount of waiting or LP recovering could close it.
  await new Promise((r) => setTimeout(r, getCircuitStatus().cooldownMs + 50));
  assert.equal(getCircuitStatus().state, 'half_open', 'cooldown elapsed but still hard-open — this is the latch bug');

  // LP is healthy again: the half-open probe is allowed through and closes it.
  assert.equal(await withCircuit(ok), 'payload');
  const s = getCircuitStatus();
  assert.equal(s.state, 'closed');
  assert.equal(s.circuitOpen, false);
  assert.equal(s.consecutiveFailures, 0);
});

test('case 6: while cooling down, calls are rejected fast and name the wait', async () => {
  await openBreaker();
  await assert.rejects(
    () => withCircuit(ok),
    (err) => {
      assert.match(err.message, /Circuit breaker OPEN/);
      assert.match(err.message, /Retrying in \d+s/, 'the message must say when, or operators assume "never" and redeploy');
      return true;
    },
  );
});

test('case 7: a failing half-open probe reopens with a LONGER cooldown, capped', async () => {
  await openBreaker();
  const first = getCircuitStatus().cooldownMs;

  await new Promise((r) => setTimeout(r, first + 50));
  assert.equal(getCircuitStatus().state, 'half_open');
  await assert.rejects(() => withCircuit(fail)); // probe fails

  const second = getCircuitStatus();
  assert.equal(second.circuitOpen, true, 'a failed probe must not close the breaker');
  assert.ok(second.cooldownMs > first, `cooldown did not back off (${first} -> ${second.cooldownMs})`);
  assert.ok(second.cooldownMs <= CEILING_MS, 'cooldown exceeded LP_CIRCUIT_COOLDOWN_MAX_MS');
});

test('case 8: the cooldown backoff stops at the configured ceiling', async () => {
  await openBreaker();
  // Keep failing probes; the cooldown doubles each time and must plateau rather
  // than growing without bound (an hours-long cooldown is a latch by other means).
  for (let i = 0; i < 6; i++) {
    const { cooldownMs } = getCircuitStatus();
    if (cooldownMs >= CEILING_MS) break;
    await new Promise((r) => setTimeout(r, cooldownMs + 20));
    assert.equal(getCircuitStatus().state, 'half_open');
    await assert.rejects(() => withCircuit(fail));
    assert.ok(getCircuitStatus().cooldownMs <= CEILING_MS, 'backoff blew past the ceiling');
  }
  assert.equal(getCircuitStatus().cooldownMs, CEILING_MS, 'backoff should have reached the ceiling by now');
});

test('case 9: resetCircuit clears every part of the open state', async () => {
  await openBreaker();
  resetCircuit();
  const s = getCircuitStatus();
  assert.equal(s.state, 'closed');
  assert.equal(s.circuitOpen, false);
  assert.equal(s.consecutiveFailures, 0);
  assert.equal(s.openedAt, null);
  assert.equal(s.cooldownMs, null);
  assert.equal(s.retryInMs, null);
  // And the breaker is usable straight afterwards.
  assert.equal(await withCircuit(ok), 'payload');
});

test('case 10: getCircuitStatus keeps circuitOpen for existing callers', async () => {
  // get_sync_health reads .circuitOpen. Renaming it silently would blind ops.
  const closed = getCircuitStatus();
  assert.ok('circuitOpen' in closed && 'consecutiveFailures' in closed);
  await openBreaker();
  assert.equal(getCircuitStatus().circuitOpen, true);
});

// ─── The probe slot ───────────────────────────────────────────────────────
//
// Only one probe may be in flight, or a recovering LP gets a thundering herd.
// But the slot must never be held indefinitely: lpPost carries its own 120s
// timeout x 3 retries (~360s), and a promise that never settles would hold the
// slot forever — the latch bug again through a different door.
//
// This was observed live on 2026-09-12 at 16:14 UTC, on the very deploy that
// fixed the original latch: state half_open, retryInMs 0, openedAt and
// consecutiveFailures frozen across a minute while every caller was refused.
// A hung probe was sitting on the slot.

/** A call that never settles — the shape that wedges the slot. */
const hang = () => new Promise(() => {});

test('case 11: only one probe is admitted at a time', async () => {
  await openBreaker();
  await new Promise((r) => setTimeout(r, getCircuitStatus().cooldownMs + 50));

  // First caller gets the slot and holds it (never settles).
  const held = withCircuit(hang);
  assert.equal(getCircuitStatus().probeInFlight, true);

  // A second caller must be refused rather than piling onto a sick LP.
  await assert.rejects(() => withCircuit(ok), /Circuit breaker OPEN/);
  void held;
});

test('case 12: THE REGRESSION — a wedged probe does not hold the slot forever', async () => {
  await openBreaker();
  await new Promise((r) => setTimeout(r, getCircuitStatus().cooldownMs + 50));

  const held = withCircuit(hang); // never settles
  assert.equal(getCircuitStatus().probeInFlight, true);

  // Past the probe watchdog, the slot is reclaimed and recovery resumes.
  await new Promise((r) => setTimeout(r, PROBE_TIMEOUT_MS + 100));
  assert.equal(await withCircuit(ok), 'payload', 'the abandoned probe blocked recovery — this is the latch bug again');
  assert.equal(getCircuitStatus().state, 'closed');
  void held;
});

test('case 13: an abandoned probe settling late cannot release a newer probe slot', async () => {
  await openBreaker();
  await new Promise((r) => setTimeout(r, getCircuitStatus().cooldownMs + 50));

  // Grant a probe, then let the watchdog abandon it.
  let release;
  const slow = withCircuit(() => new Promise((_, rej) => { release = rej; }));
  const firstProbeAt = getCircuitStatus().probeStartedAt;
  await new Promise((r) => setTimeout(r, PROBE_TIMEOUT_MS + 100));

  // A replacement probe takes the slot.
  const second = withCircuit(hang);
  const secondProbeAt = getCircuitStatus().probeStartedAt;
  assert.notEqual(secondProbeAt, firstProbeAt, 'the replacement probe should own a fresh slot');

  // The abandoned one now settles. It must NOT free the slot it no longer owns.
  release(new Error('late failure'));
  await slow.catch(() => {});
  assert.equal(getCircuitStatus().probeInFlight, true, 'a late straggler freed a live probe slot — two probes could now run');
  assert.equal(getCircuitStatus().probeStartedAt, secondProbeAt);
  void second;
});

test('case 14: state reports the PHASE, not whether the slot happens to be free', async () => {
  await openBreaker();
  await new Promise((r) => setTimeout(r, getCircuitStatus().cooldownMs + 50));
  const held = withCircuit(hang);
  const s = getCircuitStatus();
  // Conflating these is what made the live stuck-slot state unreadable.
  assert.equal(s.state, 'half_open');
  assert.equal(s.probeInFlight, true);
  assert.ok(s.probeStartedAt, 'probeStartedAt must be reported so a wedged slot is diagnosable');
  void held;
});

test('case 15: a successful probe leaves no slot behind', async () => {
  await openBreaker();
  await new Promise((r) => setTimeout(r, getCircuitStatus().cooldownMs + 50));
  await withCircuit(ok);
  const s = getCircuitStatus();
  assert.equal(s.state, 'closed');
  assert.equal(s.probeInFlight, false);
  assert.equal(s.probeStartedAt, null);
});

test('case 16: a failed probe leaves no slot behind either', async () => {
  await openBreaker();
  await new Promise((r) => setTimeout(r, getCircuitStatus().cooldownMs + 50));
  await assert.rejects(() => withCircuit(fail));
  const s = getCircuitStatus();
  assert.equal(s.circuitOpen, true);
  assert.equal(s.probeInFlight, false, 'a failed probe must free the slot immediately, not wait for the watchdog');
  assert.equal(s.probeStartedAt, null);
});

test('case 17: resetCircuit clears a wedged probe slot', async () => {
  await openBreaker();
  await new Promise((r) => setTimeout(r, getCircuitStatus().cooldownMs + 50));
  const held = withCircuit(hang);
  assert.equal(getCircuitStatus().probeInFlight, true);
  resetCircuit();
  const s = getCircuitStatus();
  assert.equal(s.probeInFlight, false);
  assert.equal(s.probeStartedAt, null);
  assert.equal(await withCircuit(ok), 'payload');
  void held;
});
