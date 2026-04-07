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
 *   - Queue-based backpressure: if no tokens, callers wait in FIFO queue
 *   - On 429: drain bucket + pause ALL requests for 30 seconds
 *   - Singleton: one instance shared across the entire process
 * 
 * Usage:
 *   import { acquireToken, report429, getRateLimiterStats } from './ghl-rate-limiter.js';
 *   
 *   await acquireToken();          // Wait for a token (may block)
 *   const res = await fetch(url);  // Make the GHL API call
 *   if (res.status === 429) {
 *     report429();                 // Drain bucket + pause
 *   }
 * 
 * Why 40 and not 50?
 *   GHL's rate limit is shared with GHL workflows, the HL MCP server,
 *   and any other API consumers. 40/min leaves ~60/min of headroom
 *   for GHL's own internal operations.
 * 
 * v1.0 — Initial implementation
 */

const BUCKET_CAPACITY = 40;
const REFILL_RATE = 40;          // tokens per minute
const REFILL_INTERVAL_MS = (60 * 1000) / REFILL_RATE;  // ~1500ms per token
const PAUSE_ON_429_MS = 30000;   // 30 seconds pause on 429

let tokens = BUCKET_CAPACITY;
let lastRefill = Date.now();
let paused = false;
let pauseUntil = 0;
const waitQueue = [];

// Stats tracking
let stats = {
  totalAcquired: 0,
  totalWaited: 0,
  total429s: 0,
  longestWaitMs: 0,
  lastReset: Date.now(),
};

/**
 * Refill tokens based on elapsed time since last refill.
 * Called before every acquire attempt.
 */
function refill() {
  const now = Date.now();
  const elapsed = now - lastRefill;
  const newTokens = Math.floor(elapsed / REFILL_INTERVAL_MS);
  if (newTokens > 0) {
    tokens = Math.min(BUCKET_CAPACITY, tokens + newTokens);
    lastRefill = now;
  }
}

/**
 * Process the wait queue — grant tokens to waiting callers in FIFO order.
 */
function processQueue() {
  while (waitQueue.length > 0 && tokens > 0 && !isPaused()) {
    tokens--;
    const { resolve, queuedAt } = waitQueue.shift();
    const waitMs = Date.now() - queuedAt;
    stats.totalWaited++;
    if (waitMs > stats.longestWaitMs) stats.longestWaitMs = waitMs;
    resolve();
  }
}

/**
 * Check if we're in a 429 pause period.
 */
function isPaused() {
  if (!paused) return false;
  if (Date.now() >= pauseUntil) {
    paused = false;
    tokens = Math.min(10, BUCKET_CAPACITY); // Cautious restart with partial tokens
    console.log(`[RateLimiter] 429 pause ended. Resuming with ${tokens} tokens.`);
    // Process any queued requests
    processQueue();
    return false;
  }
  return true;
}

/**
 * Acquire a token before making a GHL API call.
 * If tokens are available, returns immediately.
 * If not, the caller waits in a FIFO queue until a token is available.
 * 
 * @returns {Promise<void>} Resolves when a token is granted
 */
export function acquireToken() {
  refill();

  // If paused due to 429, wait in queue
  if (isPaused()) {
    return new Promise((resolve) => {
      waitQueue.push({ resolve, queuedAt: Date.now() });
      // Set a timer to check when pause ends
      const checkInterval = setInterval(() => {
        if (!isPaused()) {
          clearInterval(checkInterval);
          refill();
          processQueue();
        }
      }, 1000);
    });
  }

  // Token available — grant immediately
  if (tokens > 0) {
    tokens--;
    stats.totalAcquired++;
    return Promise.resolve();
  }

  // No tokens — wait in queue
  return new Promise((resolve) => {
    waitQueue.push({ resolve, queuedAt: Date.now() });
    // Set a timer to refill and process queue
    const checkInterval = setInterval(() => {
      refill();
      if (tokens > 0 || !isPaused()) {
        clearInterval(checkInterval);
        processQueue();
      }
    }, REFILL_INTERVAL_MS);
  });
}

/**
 * Report a 429 response from GHL. Drains the bucket and pauses
 * all requests for PAUSE_ON_429_MS.
 * 
 * Call this whenever ANY GHL API call returns 429.
 */
export function report429() {
  stats.total429s++;
  tokens = 0;
  paused = true;
  pauseUntil = Date.now() + PAUSE_ON_429_MS;
  console.warn(`[RateLimiter] 429 received! Pausing ALL GHL requests for ${PAUSE_ON_429_MS / 1000}s. Queue depth: ${waitQueue.length}. Total 429s: ${stats.total429s}`);
}

/**
 * Get current rate limiter statistics.
 * Useful for monitoring and debugging.
 */
export function getRateLimiterStats() {
  refill();
  return {
    tokens,
    capacity: BUCKET_CAPACITY,
    paused: isPaused(),
    pauseRemainingMs: paused ? Math.max(0, pauseUntil - Date.now()) : 0,
    queueDepth: waitQueue.length,
    ...stats,
  };
}

/**
 * Express route handler for rate limiter stats.
 * Mount at GET /n8n/rate-limiter/stats
 */
export function registerRateLimiterRoutes(app) {
  app.get('/n8n/rate-limiter/stats', (req, res) => {
    res.json(getRateLimiterStats());
  });
}
