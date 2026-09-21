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

// v1.5 — 2026-09-21 — LEAD INTAKE MUST NOT QUEUE BEHIND BATCH WORK.
//
// POST /intake/ap-resolve timed out on four consecutive probes at its 1200ms
// ceiling while the GHL search it makes measured 101-270ms. It was not waiting
// on GoHighLevel: the action executor was mid-batch, and the two share this
// bucket. That window's logs read `20 executed ... [budget exhausted]
// (61464ms)` and `limiter alert sent — 12 token timeouts`.
//
// FIFO is the wrong discipline when the callers are not equals. An executor
// action that waits 30s retries on the next tick and loses nothing. A lead
// intake that waits 30s is a lead ActiveProspect has already given up on, and
// Lead Perfection accepts `lognumber` only at AddLead and never again — so the
// id is not late, it is gone.
//
// Two changes, and BOTH are needed:
//
//   PRIORITY  a high-priority waiter jumps ahead of every normal waiter, so it
//             never queues behind a batch that is already enqueued.
//   RESERVE   normal callers stop drawing at RESERVE tokens, so a high-priority
//             caller finds the FAST PATH open rather than a queue to jump.
//             Priority alone would still leave intake waiting for the next
//             refill (~750ms at 80/min) whenever a batch had drained the
//             bucket to zero — which is exactly the observed failure.
//
// The reserve costs the executor almost nothing: intake volume is a few leads
// an hour, so these tokens sit unused and refill continuously, while the
// executor keeps capacity-minus-reserve and simply stops a little earlier.
//
// Default is 10% of capacity, floor 4 — 12 at the live capacity of 120. Clamped
// below capacity so a misconfigured reserve can never starve normal callers
// completely.
const RESERVE_TOKENS = Math.max(0, Math.min(
  BUCKET_CAPACITY - 1,
  parseInt(process.env.GHL_RATE_RESERVE || String(Math.max(4, Math.floor(BUCKET_CAPACITY * 0.1))), 10),
));

/** Tokens a caller of this priority may draw down to. */
function floorFor(priority) {
  return priority === 'high' ? 0 : RESERVE_TOKENS;
}
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
/** Drained before waitQueue, and only by callers that passed priority:'high'. */
const priorityQueue = [];

// v1.2 — single global drainer handle. Started lazily on first wait.
let drainerHandle = null;

// Stats tracking
let stats = {
  totalAcquired: 0,
  totalWaited: 0,
  total429s: 0,
  longestWaitMs: 0,
  timedOut: 0,        // v1.2 — count of fail-open timeouts
  highAcquired: 0,    // v1.5 — tokens taken by synchronous lead intake
  highTimedOut: 0,    // v1.5 — intakes that failed open anyway. Must stay 0.
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

// v1.5 — the cautious restart must clear the RESERVE, not sit under it.
//
// This used to seed two tokens flat, deliberately few, so the first calls after
// a pause trickle rather than stampede. But a normal caller needs tokens ABOVE
// the reserve, so seeding 2 against a reserve of 12 left every batch caller
// queued until refill climbed past 12 — ~9 seconds of total blockage after each
// recovery. Worse, it inverted the reserve's meaning, from "keep a little back
// for intake" into "only intake may run at all".
//
// Seeding RESERVE + 2 keeps both intents: normal callers get exactly the two
// cautious tokens they always had, and the reserve above them stays intact for
// intake. Clamped to capacity.
function cautiousRestartTokens() {
  return Math.min(BUCKET_CAPACITY, RESERVE_TOKENS + 2);
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

function releaseOne(queue) {
  tokens--;
  const entry = queue.shift();
  const waitMs = Date.now() - entry.queuedAt;
  stats.totalWaited++;
  if (waitMs > stats.longestWaitMs) stats.longestWaitMs = waitMs;
  // entry.resolve is the wrapped version that clears the timeout and
  // sets entry.resolved = true to block any double-resolve race with
  // the timeout firing simultaneously.
  entry.resolve();
}

function processQueue() {
  if (isPaused()) return;
  // Priority first, and down to the last token — the reserve exists FOR these
  // callers, so it would be self-defeating to withhold it from them.
  while (priorityQueue.length > 0 && tokens > 0) releaseOne(priorityQueue);
  // Normal callers stop at the reserve, leaving those tokens for an intake that
  // has not arrived yet. This is the half that keeps the FAST path open.
  while (waitQueue.length > 0 && tokens > RESERVE_TOKENS) releaseOne(waitQueue);
}

function isPaused() {
  if (!paused) return false;
  if (Date.now() >= pauseUntil) {
    paused = false;
    tokens = cautiousRestartTokens(); // Very cautious restart, above the reserve
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
    // v1.5 — BOTH queues. Gating on waitQueue alone would leave a lone
    // high-priority waiter parked until its fail-open timeout, which is the
    // exact failure this lane exists to prevent.
    if (priorityQueue.length > 0 || waitQueue.length > 0) {
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
 * @param {'high'|'normal'} [opts.priority]  'high' draws below the reserve and
 *   jumps every normal waiter (v1.5, 2026-09-21). It is for SYNCHRONOUS LEAD
 *   INTAKE only — a third party is on the line and the id cannot be obtained
 *   later. Batch and sweep callers must stay normal: if everything is high
 *   priority then nothing is, and the reserve protects no one.
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

  const high = opts.priority === 'high';
  if (high) stats.highAcquired++;

  // Fast path: token available above this caller's floor, not paused. No queue,
  // no waiting. A normal caller stops at RESERVE_TOKENS; a high-priority one
  // draws to zero. Keeping that gap is what makes this path — not the queue —
  // the one a lead intake takes while a batch is running.
  if (!isPaused() && tokens > floorFor(opts.priority)) {
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
      const queue = high ? priorityQueue : waitQueue;
      const idx = queue.indexOf(entry);
      if (idx >= 0) queue.splice(idx, 1);

      stats.timedOut++;
      if (high) stats.highTimedOut++;
      stats.totalAcquired++; // count as acquired (fail-open) for monitoring
      const waited = Date.now() - entry.queuedAt;
      console.warn(
        `[RateLimiter] acquireToken timed out after ${waited}ms `
        + `(priority=${high ? 'high' : 'normal'}, queue=${waitQueue.length}, `
        + `priorityQueue=${priorityQueue.length}, tokens=${tokens}, `
        + `reserve=${RESERVE_TOKENS}, paused=${isPaused()}) — failing open`
      );
      resolve();
    }, maxWaitMs);

    entry.resolve = () => {
      if (entry.resolved) return;
      entry.resolved = true;
      clearTimeout(timeoutHandle);
      resolve();
    };

    // A high-priority waiter only ever queues behind other high-priority
    // waiters, never behind the batch that is already in waitQueue.
    (high ? priorityQueue : waitQueue).push(entry);
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
  tokens = cautiousRestartTokens(); // same cautious restart as isPaused()
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
  // v1.5 — both queues. A priority waiter stuck behind a wedged drainer is the
  // MORE urgent of the two to release, so leaving it out would invert the point
  // of the lane.
  const stuck = [...priorityQueue.splice(0), ...waitQueue.splice(0)];
  const cleared = stuck.length;
  const ages = [];
  while (stuck.length > 0) {
    const entry = stuck.shift();
    ages.push(Date.now() - entry.queuedAt);
    if (!entry.resolved) {
      stats.timedOut++;
      stats.totalAcquired++;
      // 2026-09-21 — DO NOT set entry.resolved before calling entry.resolve.
      //
      // This block used to read `entry.resolved = true` first, and
      // entry.resolve opens with `if (entry.resolved) return`. So the call
      // below no-opped: the caller's promise was never resolved and
      // timeoutHandle was never cleared — and when that timeout later fired it
      // ALSO returned early on the same flag. The waiter's promise never
      // settled, at all, ever.
      //
      // The old comment here ("entry.resolve will be a no-op ... the gain is
      // small") knew about the no-op and missed what it cost: this is the admin
      // recovery for orphaned waiters, and it was permanently orphaning every
      // waiter it touched — the exact bug class v1.2 was written to eliminate.
      //
      // entry.resolve does all three things correctly on its own: sets the
      // flag, clears the timeout, resolves the promise. Just call it.
      try {
        if (typeof entry.resolve === 'function') entry.resolve();
        else entry.resolved = true;
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
    // 2026-09-15 — capacity was reported, refill was not, so the one number
    // that governs SUSTAINED throughput could only be read from the Railway
    // dashboard. That is how capacity got ramped to 120 while refill stayed
    // two digits and nobody spotted the mismatch for weeks. Report both.
    refillPerMin: REFILL_RATE,
    refillIntervalMs: REFILL_INTERVAL_MS,
    paused: isPaused(),
    pauseRemainingMs: paused ? Math.max(0, pauseUntil - Date.now()) : 0,
    queueDepth: waitQueue.length,
    // v1.5 — the two numbers that say whether intake is actually protected.
    // priorityQueueDepth should sit at 0: a high-priority caller that has to
    // queue at all means the reserve was exhausted, which is the signal to
    // raise GHL_RATE_RESERVE. highTimedOut must stay 0 — every one of those is
    // a lead whose GHL id was lost.
    priorityQueueDepth: priorityQueue.length,
    reserveTokens: RESERVE_TOKENS,
    highAcquired: stats.highAcquired,
    highTimedOut: stats.highTimedOut,
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
