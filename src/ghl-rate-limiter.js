/**
 * GHL Rate Limiter — src/ghl-rate-limiter.js
 *
 * Token bucket rate limiter shared by ALL GHL API consumers in the LP MCP:
 *   - src/ghl.js (axios — sync engine)
 *   - src/action-executor.js (native fetch — action executor)
 *
 * Design:
 *   - Bucket capacity: 40 tokens (conservative under GHL's ~100/min limit)
 *   - Refill rate: 40 tokens per minute (~1 every 1.5 seconds)
 *   - Single global drainer interval (no per-caller intervals)
 *   - Hard timeout on each wait — fail-open after 30s rather than hang
 *   - On 429: drain bucket + pause ALL requests for 5 MINUTES
 *   - Exponential backoff on consecutive 429s: 5min → 10min → 15min (cap)
 *   - Singleton: one instance shared across the entire process
 *
 * Headroom (env-driven, default 40):
 *   GHL_RATE_CAPACITY        — bucket capacity (tokens)
 *   GHL_RATE_REFILL_PER_MIN  — refill rate (tokens/min)
 *   Ramp conservatively: 40 → 50 first, watch /n8n/rate-limiter/stats and keep
 *   total429s and timedOut at 0; hold ~15–30 min, then optionally 50 → 60. Stop
 *   the instant total429s rises — a 429 triggers a 5-min full pause (escalating
 *   to 15), far costlier than the throughput gained. Do not exceed ~60–70
 *   without confirming GHL's per-location sustained limit, which is SHARED with
 *   the HL MCP (both servers draw on the same budget).
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

// Env-driven (default 40) so headroom can be ramped via Railway env vars
// without a deploy — see the header note for ramp guidance.
const BUCKET_CAPACITY = Math.max(1, parseInt(process.env.GHL_RATE_CAPACITY || '40', 10));
const REFILL_RATE = Math.max(1, parseInt(process.env.GHL_RATE_REFILL_PER_MIN || '40', 10));  // tokens per minute
const REFILL_INTERVAL_MS = (60 * 1000) / REFILL_RATE;  // ~1500ms per token at 40/min
const BASE_PAUSE_MS = 300000;    // 5 minutes base pause
const MAX_PAUSE_MS = 900000;     // 15 minutes maximum pause

// v1.2 — hard timeout on each waiter. Fail-open if the drainer somehow
// stops firing. Downstream ghlFetch has its own 15s AbortSignal timeout,
// so worst case is a downstream error rather than an indefinite hang.
const WAIT_TIMEOUT_MS = parseInt(
  process.env.RATE_LIMITER_WAIT_TIMEOUT_MS || '30000', 10
);

let tokens = BUCKET_CAPACITY;
let lastRefill = Date.now();
let paused = false;
let pauseUntil = 0;
let consecutive429Cycles = 0;
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
  refill();

  const maxWaitMs = Number.isFinite(opts.maxWaitMs)
    ? Math.max(250, Math.min(opts.maxWaitMs, WAIT_TIMEOUT_MS))
    : WAIT_TIMEOUT_MS;

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
  const pauseMs = Math.min(BASE_PAUSE_MS * consecutive429Cycles, MAX_PAUSE_MS);
  pauseUntil = Date.now() + pauseMs;
  console.warn(
    `[RateLimiter] 429 received! Pausing ALL GHL requests for ${Math.round(pauseMs / 1000)}s. ` +
    `Queue depth: ${waitQueue.length}. Total 429s: ${stats.total429s}. ` +
    `Consecutive cycles: ${consecutive429Cycles}`
  );
}

/**
 * Call after a SUCCESSFUL GHL request to reset the consecutive 429 counter.
 */
export function reportSuccess() {
  if (consecutive429Cycles > 0) {
    console.log(`[RateLimiter] GHL request succeeded! Resetting consecutive 429 counter from ${consecutive429Cycles} to 0.`);
    consecutive429Cycles = 0;
  }
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
}
