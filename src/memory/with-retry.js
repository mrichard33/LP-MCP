/**
 * withRetry — src/memory/with-retry.js  (issue #1627, 2026-09-06)
 *
 * Bounded retry for TRANSIENT failures only: network drops (ECONNRESET,
 * ECONNREFUSED, ETIMEDOUT, "fetch failed", socket hang up), timeouts and
 * HTTP 5xx. Validation errors (CheckpointError), 4xx and Postgres constraint
 * errors are thrown straight through — retrying them can only repeat the
 * same failure or, worse, duplicate a write.
 *
 * Default schedule: 3 attempts, backoff 250 ms → 1 s → 3 s (≈4.25 s worst
 * case). Callers pass `sleep` in tests so nothing actually waits.
 */

const TRANSIENT_CODES = /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|UND_ERR_|ABORT_ERR|ERR_NETWORK)/;
const TRANSIENT_TEXT = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|ENOTFOUND|socket hang up|fetch failed|network (error|request failed)|timed out|timeout|\b(HTTP|status|GitHub|Supabase SQL error: (?:HTTP )?)\s*5\d\d\b|Bad Gateway|Gateway Time-?out|Service Unavailable|Internal Server Error|connection (reset|refused|terminated|closed)|too many connections|could not connect/i;

/** True when the error looks like a transport blip worth retrying. */
export function isTransientError(err) {
  if (!err) return false;
  if (err.name === 'CheckpointError' || err.kind === 'validation' || err.transient === false) return false;
  if (err.transient === true) return true;
  const status = Number(err.status ?? err.statusCode ?? err.response?.status ?? NaN);
  if (Number.isFinite(status) && status > 0) {
    if (status >= 500) return true;
    if (status === 408 || status === 429) return true;
    if (status >= 400) return false;
  }
  const code = String(err.code ?? err.cause?.code ?? '');
  if (code && TRANSIENT_CODES.test(code)) return true;
  // Postgres SQLSTATE class 08 = connection exception, 57P0x = shutdown/crash.
  if (/^(08\w{3}|57P0[1-3]|53300)$/.test(code)) return true;
  const text = [err.message, err.details, err.cause?.message].filter(Boolean).join(' | ');
  return TRANSIENT_TEXT.test(text);
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn(attempt)` up to `attempts` times, sleeping backoffMs[i] between tries.
 * Only errors for which `isRetryable(err)` is true are retried. The last error
 * is rethrown with `err.attempts` set to the number of tries made.
 */
export async function withRetry(fn, {
  attempts = 3,
  backoffMs = [250, 1000, 3000],
  isRetryable = isTransientError,
  onRetry = null,
  sleep = defaultSleep,
} = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      try { err.attempts = attempt; } catch { /* frozen / primitive error */ }
      if (attempt >= attempts || !isRetryable(err)) throw err;
      const delay = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 0;
      if (typeof onRetry === 'function') onRetry(err, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastErr;
}

export const CHECKPOINT_RETRY = Object.freeze({ attempts: 3, backoffMs: Object.freeze([250, 1000, 3000]) });
