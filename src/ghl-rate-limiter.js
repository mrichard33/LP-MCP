/**
 * GHL Rate Limiter — src/ghl-rate-limiter.js
 *
 * Token bucket rate limiter shared by ALL GHL API consumers in the LP MCP.
 * Entry points, in order of how much traffic they carry:
 *   - withGhlToken(fn)      — wraps a raw fetch at its call site (v1.4)
 *   - acquireToken()/report429() — the manual pair, for clients that need to
 *     inspect the response themselves (src/actions/helpers.js ghlFetch,
 *     src/send-message-handler.js, src/actions/approval-path.js)
 *   - src/ghl.js (axios — sync engine)
 *
 * EVERY call reaching services.leadconnectorhq.com's v2 API must go through one
 * of those. scripts/test-ghl-rate-limiter-coverage.js enforces that as a test:
 * a new raw fetch() in a module that talks to GHL either joins the bucket or
 * carries a `// rate-limiter-exempt: <reason>` comment saying why it does not.
 *
 * Design:
 *   - Bucket capacity: 40 tokens (conservative under GHL's ~100/min limit)
 *   - Refill rate: 40 tokens per minute (~1 every 1.5 seconds)
 *   - Single global drainer interval (no per-caller intervals)
 *   - Hard timeout on each wait — fail-open after 30s rather than hang, or
 *     after GHL_RATE_PAUSE_WAIT_MS (5s) when the bucket is PAUSED
 *   - On 429: drain bucket + pause ALL requests for 60 SECONDS
 *   - Exponential backoff on consecutive 429s: 1min → 2min → 3min (cap)
 *   - Singleton: one instance shared across the entire process
 *
 * Headroom (env-driven, default 40):
 *   GHL_RATE_CAPACITY        — bucket capacity (tokens)
 *   GHL_RATE_REFILL_PER_MIN  — refill rate (tokens/min)
 *   Ramp conservatively: 40 → 50 first, watch /n8n/rate-limiter/stats and keep
 *   total429s and timedOut at 0; hold ~15–30 min, then optionally 50 → 60. Stop
 *   the instant total429s rises — a 429 triggers a 60s full pause (escalating
 *   to 3 min), costlier than the throughput gained. Do not exceed ~60–70
 *   without confirming GHL's per-location sustained limit, which is SHARED with
 *   the HL MCP (both servers draw on the same budget).
 *
 * v1.4 — 2026-09-14 — Coverage + pause economics (GHL 60s client timeouts)
 *   Two defects, one symptom. POST /webhook/ghl/set-lp-appointment was being
 *   hung up on by GoHighLevel at its own 60s client timeout — 41 of 161
 *   requests over 72h, invisible to every error metric because a 499 is not a
 *   5xx (PR #921 worked the latency around; this is the cause).
 *
 *   (a) COVERAGE. ~40 GHL call sites across 22 files called fetch() directly
 *   and never entered the bucket; n8n-helpers.js's ghlRequest did not even
 *   DETECT a 429. That is why every pause log read `tokens=50, paused=true`:
 *   the bucket was FULL at the moment of the pause, because the callers
 *   holding tokens were not the ones driving GHL over its limit. The limiter
 *   was throttling the well-behaved half on behalf of load it could not see.
 *   withGhlToken() below closes that, one line per call site.
 *
 *   (b) PAUSE ECONOMICS. processQueue() is gated on !isPaused(), so during a
 *   pause NOTHING is dequeued by token — every waiter is guaranteed to reach
 *   the fail-open timeout, which resolves it WITHOUT a token, and it calls GHL
 *   anyway. The pause never reduced load on GHL; it only added 30s to every
 *   call, and 6-10 sequential calls is 60s. Paused waits are now capped at
 *   GHL_RATE_PAUSE_WAIT_MS (5s), and the pause itself cut 5min → 60s with the
 *   ceiling 15min → 3min, matching HL-MCP (same GHL budget, same conclusion —
 *   see its v1.2). The ordinary empty-bucket wait is UNCHANGED at 30s: that
 *   queue can drain by token, so waiting in it is productive.
 *
 * v1.3 — 2026-08-02 — Cycle decay + admin reset (47-hour agentic outage)
 *   consecutive429Cycles had no reset path in practice: reportSuccess() was
 *   exported in v1.1 and never called from any of the 11 report429() call
 *   sites. The counter reached 5 in production, pinning currentPauseMs at the
 *   900000ms MAX_PAUSE_MS ceiling — every 429 blacked out ALL GHL traffic for
 *   15 minutes, acquireToken timed out 637 times at the full 30s each, and the
 *   message analyzer emitted ZERO ai.analysis_completed events between
 *   2026-07-31 23:42Z and 2026-08-02 23:05Z. The agentic bot answered nothing
 *   for ~47 hours.
 *
 *   Fix: decayCycles() steps the counter back toward 0 after CYCLE_DECAY_MS
 *   (default 10 min) with no new 429, one step per window, driven from both
 *   the drainer and acquireToken so it runs whether or not anything queues.
 *   Deliberately NOT wired through the 11 report429() call sites — a
 *   single-module time-based decay cannot be forgotten at a call site, which
 *   is precisely how v1.1 failed. reportSuccess() is retained and still works
 *   if anyone wires it later.
 *
 *   Added admin: resetCycles() + POST /n8n/rate-limiter/reset-cycles to clear
 *   a pinned counter and lift a stuck pause without bouncing the service.
 *
 *   ENV: GHL_RATE_CYCLE_DECAY_MS (default 600000, floor 60000).
 *
 * v1.2 — 2026-05-23 — Global drainer + hard timeout (Scott Gies recovery)
 *   Previous version (v1.1): each caller spawned its own setInterval.
 *   The non-paused branch's interval cleared on first tick because its
 *   exit condition `tokens > 0 || !isPaused()` evaluated to `... || true`
 *   (we were NOT paused; that's why we entered this branch). If THIS
 *   caller wasn't first in queue when processQueue ran, their interval
 *   cleared without their promise resolving — orphan waiter forever.
 *
 *   Discovered when action 68268 (remove_tag buyer:decision for Scott
 *   Gies, KkvMyszPPcr5uGIMcFiW, OPPFDN $48K-avg) hung the executor for
 *   22+ min. Rate limiter showed queueDepth=28 with longestWaitMs=32min
 *   while tokens=40 and paused=false — orphan promises that no interval
 *   would ever resolve.
 *
 *   Fix: single module-scoped drainer interval (fires every 1.5s) is
 *   responsible for refill + processQueue. Per-caller intervals removed.
 *   Each waiter has a 30s hard timeout — on fire, the caller is removed
 *   from the queue and resolved without a token (fail-open). The
 *   downstream fetch in ghlFetch has its own 15s AbortSignal timeout
 *   so worst case is a downstream error rather than an indefinite hang.
 *
 *   resolved-flag on each entry prevents double-resolve race between
 *   processQueue and the timeout firing simultaneously.
 *
 *   Behavior compat: happy path (tokens available, no pause) is
 *   unchanged. Wait path returns within 30s max instead of potentially
 *   forever. API signature unchanged.
 *
 *   Added admin: drainStuckWaiters() + POST /n8n/rate-limiter/drain-stuck
 *   endpoint to fail-open all queued waiters on demand. Used to recover
 *   orphan promises from the prior buggy state without bouncing the
 *   service.
 *
 * v1.1 — 5min base pause with exponential backoff (matches HL MCP)
 *   GHL rate limits are per-location, not per-API-key. Both MCP servers
 *   share the same rate limit budget and must coordinate long pauses.
 *
 * v1.0 — Initial implementation (30s pause — too short)
 */

import { recordGhlRequest } from './ghl-shared-budget.js';

// Env-driven (default 40) so headroom can be ramped via Railway env vars
// without a deploy — see the header note for ramp guidance.
const BUCKET_CAPACITY = Math.max(1, parseInt(process.env.GHL_RATE_CAPACITY || '40', 10));
const REFILL_RATE = Math.max(1, parseInt(process.env.GHL_RATE_REFILL_PER_MIN || '40', 10));  // tokens per minute
const REFILL_INTERVAL_MS = (60 * 1000) / REFILL_RATE;  // ~1500ms per token at 40/min
// v1.4 — 2026-09-14 — PAUSE ECONOMICS.
//
// The 5-minute pause was doing none of the backing-off it was written for, at
// full cost. processQueue() is gated on !isPaused(), so during a pause NOTHING
// is dequeued by token; the only exit is acquireToken's fail-open timeout,
// which resolves the caller WITHOUT a token and the caller then calls GHL
// anyway. So a pause never reduced load on GHL — it only added the full wait
// to every call. Measured 2026-09-13/14: 3 separate 429s produced hundreds of
// 30s stalls, and a route making 6-10 sequential GHL calls blew past
// GoHighLevel's own 60s client timeout (see PR #921).
//
// Both knobs are env-tunable so this is reversible without a deploy.
const BASE_PAUSE_MS = Math.max(
  5000,
  parseInt(process.env.GHL_RATE_PAUSE_MS || '60000', 10)
);
// 180s, not the old 900s. The ceiling has to move with the base or the shape of
// the escalation changes: 300s base + 900s ceiling was a THREE-step ramp, but
// 60s base + 900s ceiling would be a FIFTEEN-step one, and would still end in a
// 15-minute blackout. 60/180 keeps the three steps and caps the worst case at
// three minutes — and is exactly what HL-MCP settled on (its v1.2, after the
// same 5-minute pause caused a 47-hour agentic outage). The two services share
// one GHL budget, so they should not disagree about how hard to brake.
const MAX_PAUSE_MS = Math.max(
  BASE_PAUSE_MS,
  parseInt(process.env.GHL_RATE_MAX_PAUSE_MS || '180000', 10)
);

// How long a waiter blocks while the bucket is PAUSED, as opposed to merely
// empty. Kept far below WAIT_TIMEOUT_MS: the wait cannot prevent the call (we
// fail open either way), so a long one buys nothing and costs everything. A
// short one still spaces repeat callers out across the pause window.
const PAUSE_WAIT_MS = Math.max(
  250,
  parseInt(process.env.GHL_RATE_PAUSE_WAIT_MS || '5000', 10)
);

// v1.2 — hard timeout on each waiter. Fail-open if the drainer somehow
// stops firing. Downstream ghlFetch has its own 15s AbortSignal timeout,
// so worst case is a downstream error rather than an indefinite hang.
const WAIT_TIMEOUT_MS = parseInt(
  process.env.RATE_LIMITER_WAIT_TIMEOUT_MS || '30000', 10
);

// v1.3 — 2026-08-02 — Time-based decay of consecutive429Cycles.
// reportSuccess() was exported in v1.1 but never wired into ANY of the 11
// report429() call sites, so the counter was monotonically increasing. It
// reached 5 in production, pinning every subsequent pause at the 15-minute
// MAX_PAUSE_MS ceiling and blacking out all GHL traffic for the agentic
// pipeline. Decay is time-based and lives entirely inside this module, so
// recovery no longer depends on call-site wiring that can be forgotten.
const CYCLE_DECAY_MS = Math.max(
  60000,
  parseInt(process.env.GHL_RATE_CYCLE_DECAY_MS || '600000', 10)
);

let tokens = BUCKET_CAPACITY;
let lastRefill = Date.now();
let paused = false;
let pauseUntil = 0;
let consecutive429Cycles = 0;
let last429At = 0;
let lastCycleDecayAt = Date.now();
const waitQueue = [];

// v1.2 — single global drainer handle. Started lazily on first wait.
let drainerHandle = null;

// Stats tracking
let stats = {
  totalAcquired: 0,
  totalWaited: 0,
  total429s: 0,
  longestWaitMs: 0,
  timedOut: 0,        // v1.2 — count of fail-open timeouts
  lastReset: Date.now(),
};

// v1.3 — Step consecutive429Cycles back toward 0 once a full CYCLE_DECAY_MS
// has elapsed with no new 429, and at most one step per window. Called from
// both the drainer and acquireToken's entry point, so decay runs whether or
// not anything is queued (the drainer only starts lazily on the first wait).
function decayCycles() {
  if (consecutive429Cycles <= 0) return;
  const now = Date.now();
  const since429 = now - last429At;
  if (since429 < CYCLE_DECAY_MS) return;
  if (now - lastCycleDecayAt < CYCLE_DECAY_MS) return;
  lastCycleDecayAt = now;
  consecutive429Cycles--;
  const nextPauseMs = Math.min(BASE_PAUSE_MS * Math.max(consecutive429Cycles, 1), MAX_PAUSE_MS);
  console.log(
    `[RateLimiter] No 429 in ${Math.round(since429 / 1000)}s — decayed consecutive429Cycles to ` +
    `${consecutive429Cycles} (next pause would be ${Math.round(nextPauseMs / 1000)}s)`
  );
}

function refill() {
  const now = Date.now();
  const elapsed = now - lastRefill;
  const newTokens = Math.floor(elapsed / REFILL_INTERVAL_MS);
  if (newTokens > 0) {
    tokens = Math.min(BUCKET_CAPACITY, tokens + newTokens);
    lastRefill = now;
  }
}

function processQueue() {
  while (waitQueue.length > 0 && tokens > 0 && !isPaused()) {
    tokens--;
    const entry = waitQueue.shift();
    const waitMs = Date.now() - entry.queuedAt;
    stats.totalWaited++;
    if (waitMs > stats.longestWaitMs) stats.longestWaitMs = waitMs;
    // entry.resolve is the wrapped version that clears the timeout and
    // sets entry.resolved = true to block any double-resolve race with
    // the timeout firing simultaneously.
    entry.resolve();
  }
}

function isPaused() {
  if (!paused) return false;
  if (Date.now() >= pauseUntil) {
    paused = false;
    tokens = Math.min(2, BUCKET_CAPACITY); // Very cautious restart
    console.log(`[RateLimiter] Pause ended. Resuming with ${tokens} tokens. Consecutive 429 cycles: ${consecutive429Cycles}`);
    processQueue();
    return false;
  }
  return true;
}

/**
 * v1.2 — Single global drainer. Started lazily on the first call that
 * has to wait. Replaces the per-caller intervals from v1.1 which
 * orphaned promises whose owners weren't first in queue when their
 * interval fired.
 *
 * Runs every REFILL_INTERVAL_MS (1.5s). Work is trivial when the queue
 * is empty (just a refill call). Idempotent — early-return if already
 * started. `.unref()` so the interval doesn't block process exit.
 */
function ensureDrainer() {
  if (drainerHandle) return;
  drainerHandle = setInterval(() => {
    refill();
    decayCycles();
    if (waitQueue.length > 0) {
      processQueue();
    }
  }, REFILL_INTERVAL_MS);
  if (typeof drainerHandle.unref === 'function') drainerHandle.unref();
  console.log(`[RateLimiter] Drainer started (interval=${REFILL_INTERVAL_MS}ms, wait_timeout=${WAIT_TIMEOUT_MS}ms)`);
}

/**
 * @param {object} [opts]
 * @param {number} [opts.maxWaitMs]  per-caller cap on the queue wait
 *   (2026-07-03 hotfix). Handlers that make several sequential GHL calls
 *   (e.g. resolveReplyContext's 2-3 reads) pass a short cap so a starved /
 *   429-paused bucket cannot stack 30s waits past the executor's 60s
 *   handler watchdog. Default: WAIT_TIMEOUT_MS (30s), behavior unchanged
 *   for existing callers. Fail-open either way.
 */
export function acquireToken(opts = {}) {
  // Shared-budget measurement (2026-09-14). Every governed GHL call passes
  // through here — withGhlToken and the manual acquireToken/report429 pairs
  // alike — so this is the one place that sees the true per-service request
  // rate. A Map increment, no I/O, and a no-op unless GHL_SHARED_BUDGET_MODE
  // is 'shadow'. It measures only; it never throttles.
  recordGhlRequest();

  refill();
  decayCycles();

  const requested = Number.isFinite(opts.maxWaitMs)
    ? Math.max(250, Math.min(opts.maxWaitMs, WAIT_TIMEOUT_MS))
    : WAIT_TIMEOUT_MS;

  // While PAUSED the queue cannot drain by token at all, so the waiter is
  // guaranteed to reach its timeout and fail open. Capping it at PAUSE_WAIT_MS
  // makes that inevitable outcome arrive in ~5s instead of ~30s. A request
  // making N sequential GHL calls inside a pause window therefore costs
  // N x 5s rather than N x 30s — the difference between finishing and being
  // hung up on by GoHighLevel at 60s.
  const maxWaitMs = isPaused() ? Math.min(requested, PAUSE_WAIT_MS) : requested;

  // Fast path: token available, not paused. No queue, no waiting.
  if (!isPaused() && tokens > 0) {
    tokens--;
    stats.totalAcquired++;
    return Promise.resolve();
  }

  // Slow path: enqueue. Single global drainer handles refill +
  // processQueue. Hard timeout protects against indefinite waits if
  // the drainer ever fails to fire for any reason.
  ensureDrainer();

  return new Promise((resolve) => {
    const entry = {
      queuedAt: Date.now(),
      resolved: false,
      resolve: null,
    };

    const timeoutHandle = setTimeout(() => {
      if (entry.resolved) return;
      entry.resolved = true;

      // Remove from queue if still present (race-safe — splice no-ops
      // on idx=-1).
      const idx = waitQueue.indexOf(entry);
      if (idx >= 0) waitQueue.splice(idx, 1);

      stats.timedOut++;
      stats.totalAcquired++; // count as acquired (fail-open) for monitoring
      const waited = Date.now() - entry.queuedAt;
      console.warn(
        `[RateLimiter] acquireToken timed out after ${waited}ms ` +
        `(queue=${waitQueue.length}, tokens=${tokens}, paused=${isPaused()}) — failing open`
      );
      resolve();
    }, maxWaitMs);

    entry.resolve = () => {
      if (entry.resolved) return;
      entry.resolved = true;
      clearTimeout(timeoutHandle);
      resolve();
    };

    waitQueue.push(entry);
  });
}

/**
 * Report a 429 response. Drains bucket and pauses all requests.
 * Uses exponential backoff: 5min → 10min → 15min on consecutive 429 cycles.
 */
export function report429() {
  stats.total429s++;
  tokens = 0;
  paused = true;
  consecutive429Cycles++;
  // v1.3 — decay clock. Both stamps reset here so a fresh 429 restarts the
  // full quiet window before any step-down is allowed.
  last429At = Date.now();
  lastCycleDecayAt = Date.now();
  const pauseMs = Math.min(BASE_PAUSE_MS * consecutive429Cycles, MAX_PAUSE_MS);
  pauseUntil = Date.now() + pauseMs;
  console.warn(
    `[RateLimiter] 429 received! Pausing ALL GHL requests for ${Math.round(pauseMs / 1000)}s. ` +
    `Queue depth: ${waitQueue.length}. Total 429s: ${stats.total429s}. ` +
    `Consecutive cycles: ${consecutive429Cycles}`
  );
}

/**
 * Govern a RAW GHL fetch that would otherwise bypass this bucket entirely.
 *
 * WHY THIS EXISTS (2026-09-14). Roughly half of LP-MCP's GHL traffic never
 * touched this limiter: ~40 call sites across 22 files called fetch() directly,
 * and n8n-helpers.js's ghlRequest did not even DETECT a 429. The governed
 * callers were therefore throttled and paused on behalf of load they were not
 * generating — which is exactly why every pause log reads `tokens=50,
 * paused=true`: the bucket is FULL because the callers holding tokens are not
 * the ones driving GHL over its limit.
 *
 * Deliberately a wrapper rather than a replacement client. Each call site keeps
 * its own headers, timeout, status handling and error semantics — the diff is
 * one line — so this cannot quietly change how any existing caller behaves:
 *
 *   const res = await withGhlToken(() => fetch(url, opts));
 *
 * @param {Function} fn   zero-arg thunk performing the fetch
 * @param {Object} [opts] forwarded to acquireToken (e.g. { maxWaitMs })
 * @returns whatever fn returns, untouched
 */
export async function withGhlToken(fn, opts = {}) {
  await acquireToken(opts);
  const res = await fn();
  // Response-shaped results report their own throttle. Anything else passes
  // through silently — this must never throw on an unexpected return value.
  if (res && typeof res === 'object' && res.status === 429) report429();
  return res;
}

/**
 * Call after a SUCCESSFUL GHL request to reset the consecutive 429 counter.
 */
export function reportSuccess() {
  if (consecutive429Cycles > 0) {
    console.log(`[RateLimiter] GHL request succeeded! Resetting consecutive 429 counter from ${consecutive429Cycles} to 0.`);
    consecutive429Cycles = 0;
    lastCycleDecayAt = Date.now();
  }
}

/**
 * v1.3 — Admin: clear the escalation state without a redeploy. Before this
 * existed, the ONLY way to unstick a pinned consecutive429Cycles was to bounce
 * the service, because the counter is module state with no reset path wired to
 * any call site. Clears the cycle counter and lifts any active pause.
 */
export function resetCycles() {
  const previous = consecutive429Cycles;
  const wasPaused = isPaused();
  consecutive429Cycles = 0;
  lastCycleDecayAt = Date.now();
  paused = false;
  pauseUntil = 0;
  tokens = Math.min(2, BUCKET_CAPACITY); // same cautious restart as isPaused()
  processQueue();
  console.warn(
    `[RateLimiter] resetCycles: consecutive429Cycles ${previous} → 0, ` +
    `paused ${wasPaused} → false, tokens=${tokens}`
  );
  return { previous_cycles: previous, was_paused: wasPaused };
}

/**
 * v1.2 — Admin: drain all queued waiters immediately (fail-open). Used
 * to clean up orphan promises from a prior buggy code path without
 * redeploying or bouncing the service. Each cleared waiter is resolved
 * without a token; the downstream fetch in ghlFetch has its own 15s
 * timeout so worst case is a downstream error rather than success-
 * pretending.
 */
export function drainStuckWaiters() {
  const cleared = waitQueue.length;
  const ages = [];
  while (waitQueue.length > 0) {
    const entry = waitQueue.shift();
    ages.push(Date.now() - entry.queuedAt);
    if (!entry.resolved) {
      entry.resolved = true;
      stats.timedOut++;
      stats.totalAcquired++;
      // We can't access the original timeoutHandle here, but entry.resolve
      // will be a no-op due to entry.resolved=true. We could call it
      // anyway to clean up the timeout, but the gain is small.
      try {
        if (typeof entry.resolve === 'function') entry.resolve();
      } catch (e) { /* swallow */ }
    }
  }
  if (cleared > 0) {
    const maxAge = ages.length ? Math.max(...ages) : 0;
    console.warn(
      `[RateLimiter] drainStuckWaiters: cleared ${cleared} waiters ` +
      `(fail-open, oldest ${maxAge}ms)`
    );
  }
  return { cleared, oldest_age_ms: ages.length ? Math.max(...ages) : 0 };
}

export function getRateLimiterStats() {
  refill();
  return {
    tokens,
    capacity: BUCKET_CAPACITY,
    paused: isPaused(),
    pauseRemainingMs: paused ? Math.max(0, pauseUntil - Date.now()) : 0,
    queueDepth: waitQueue.length,
    consecutive429Cycles,
    currentPauseMs: Math.min(BASE_PAUSE_MS * Math.max(consecutive429Cycles, 1), MAX_PAUSE_MS),
    drainerActive: drainerHandle !== null,
    waitTimeoutMs: WAIT_TIMEOUT_MS,
    // v1.4 — surfaced so /n8n/rate-limiter/stats shows the pause economics
    // actually in force. These are env-tunable; reading them from a log line
    // is how you confirm a live tuning change took effect.
    basePauseMs: BASE_PAUSE_MS,
    maxPauseMs: MAX_PAUSE_MS,
    pauseWaitMs: PAUSE_WAIT_MS,
    cycleDecayMs: CYCLE_DECAY_MS,
    last429At: last429At || null,
    msSinceLast429: last429At ? Date.now() - last429At : null,
    ...stats,
  };
}

export function registerRateLimiterRoutes(app) {
  app.get('/n8n/rate-limiter/stats', (req, res) => {
    res.json(getRateLimiterStats());
  });

  // v1.2 — Admin: force-drain stuck waiters. Useful for cleaning up
  // orphan promises from a prior buggy state without bouncing the
  // service. Returns the count cleared + the new stats snapshot.
  app.post('/n8n/rate-limiter/drain-stuck', (req, res) => {
    const result = drainStuckWaiters();
    res.json({ success: true, ...result, stats: getRateLimiterStats() });
  });

  // v1.3 — Admin: clear a pinned consecutive429Cycles / stuck pause without
  // redeploying. Recovery lever for the 2026-08-02 47-hour agentic outage.
  app.post('/n8n/rate-limiter/reset-cycles', (req, res) => {
    const result = resetCycles();
    res.json({ success: true, ...result, stats: getRateLimiterStats() });
  });
}
