/**
 * Omi Developer API client — src/memory/omi-client.js
 *
 * Outbound half of the Omi integration. src/memory/omi-routes.js receives what
 * Omi pushes; this file fetches what Omi does not push, and pushes tasks back.
 *
 * WHAT THE API ACTUALLY DOES (checked against the live API on 2026-09-14 —
 * these are measurements, not assumptions, and they are why the pull is shaped
 * the way it is):
 *
 *   • `transcript_segments` is ALWAYS null — on the conversation list AND on
 *     GET /user/conversations/{id}. There is no transcript available through
 *     this API at all. So there is no transcript handling here, no character
 *     cap, and no extraction call: `structured` is the content.
 *
 *   • GET /user/action-items returns [] even though conversations plainly carry
 *     action items. Omi writes extracted items as candidates that never reach
 *     the task store and expire after about two days. Across 100 conversations
 *     dated 2026-09-11→09-14 there were 61 embedded action items and 0 from the
 *     endpoint. An empty array from that endpoint is therefore the NORMAL,
 *     HEALTHY answer and must never be treated as a failure.
 *
 *   • POST /user/action-items works, and is the only way anything appears on
 *     Mark's Tasks page.
 *
 *   • The list endpoint is newest-first and has no `since` parameter. Paging is
 *     by `offset`, and the caller stops when it recognises something.
 *
 * Rate limits are 100 requests/minute per key and 10,000/day. We self-throttle
 * to 60/min so a pull can never be the thing that exhausts the budget for the
 * webhook path or for Mark's own app.
 *
 * Everything that reaches the network goes through `deps.fetch`, so the puller
 * and its tests never need a key.
 *
 * v1.0 — 2026-09-14 (sql/112).
 */

import { withRetry } from './with-retry.js';

export class OmiApiError extends Error {
  constructor(message, { status = 0, body = null, retryable = false } = {}) {
    super(message);
    this.name = 'OmiApiError';
    this.status = status;
    this.body = body;
    // Read by withRetry's isTransientError via err.transient.
    this.transient = retryable;
  }
}

/**
 * A rejected key is not a blip. Retrying it burns the rate limit and delays the
 * only message that helps, so 401/403 carries this and stops the run.
 */
export class OmiAuthError extends OmiApiError {
  constructor(status, body) {
    super(
      'Omi key rejected — create a new key in the Omi web app under Developer → API Keys '
      + 'and update OMI_DEV_API_KEY',
      { status, body, retryable: false },
    );
    this.name = 'OmiAuthError';
  }
}

export const OMI_API_BASE_DEFAULT = 'https://api.omi.me/v1/dev';
const TIMEOUT_MS = 20_000;
/** 1s → 4s → 15s. Slower than the memory default because Omi's 429 window is a minute. */
const BACKOFF_MS = [1000, 4000, 15000];
/** Ours, not Omi's: they allow 100/min, we take 60 and leave the rest. */
const SELF_THROTTLE_PER_MIN = 60;

function num(env, name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(env?.[name]);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function getOmiClientConfig(env = process.env) {
  return {
    base: String(env.OMI_API_BASE || OMI_API_BASE_DEFAULT).replace(/\/+$/, ''),
    key: env.OMI_DEV_API_KEY || null,
    maxRequests: num(env, 'OMI_PULL_MAX_REQUESTS', 40, { min: 1, max: 5000 }),
  };
}

/**
 * Honour Retry-After when Omi sends one. A server that tells you when to come
 * back knows better than a fixed schedule, and ignoring it is how a client gets
 * itself rate-limited for longer.
 */
function retryAfterMs(headers) {
  const raw = headers?.get?.('retry-after');
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.min(60_000, Math.max(0, secs * 1000));
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.min(60_000, Math.max(0, when - Date.now()));
  return null;
}

/**
 * @param {object} deps
 *   fetch  (url, init) => Response — required in tests, defaults to global fetch
 *   env    defaults to process.env
 *   sleep  injected so tests never wait
 *   now    injected so the throttle is testable
 */
export function createOmiClient({ fetch: fetchImpl, env = process.env, sleep, now } = {}) {
  const cfg = getOmiClientConfig(env);
  const doFetch = fetchImpl || globalThis.fetch;
  const doSleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const clock = now || (() => Date.now());

  let requests = 0;
  let windowStart = clock();
  let windowCount = 0;

  async function throttle() {
    const t = clock();
    if (t - windowStart >= 60_000) { windowStart = t; windowCount = 0; }
    if (windowCount >= SELF_THROTTLE_PER_MIN) {
      const wait = 60_000 - (t - windowStart);
      if (wait > 0) await doSleep(wait);
      windowStart = clock();
      windowCount = 0;
    }
    windowCount += 1;
  }

  async function call(path, { method = 'GET', query = null, body = null } = {}) {
    if (!cfg.key) {
      throw new OmiApiError(
        'OMI_DEV_API_KEY is not set — the Omi pull cannot run without a Developer API key',
        { status: 0, retryable: false },
      );
    }
    if (requests >= cfg.maxRequests) {
      // Not an error: the run is over for this tick and the cursor is kept, so
      // the next tick picks up exactly where this one stopped.
      const err = new OmiApiError(
        `omi pull request budget spent (${cfg.maxRequests}) — stopping this run`,
        { status: 0, retryable: false },
      );
      err.budgetExhausted = true;
      throw err;
    }

    const url = new URL(`${cfg.base}${path}`);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }

    let pause = null;
    const run = async () => {
      if (pause != null) { await doSleep(pause); pause = null; }
      await throttle();
      requests += 1;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      let res;
      try {
        res = await doFetch(url.toString(), {
          method,
          headers: {
            Authorization: `Bearer ${cfg.key}`,
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (res.status === 401 || res.status === 403) {
        throw new OmiAuthError(res.status, await safeText(res));
      }
      if (res.status === 429 || res.status >= 500) {
        pause = retryAfterMs(res.headers);
        throw new OmiApiError(`omi ${method} ${path} failed: HTTP ${res.status}`, {
          status: res.status, body: await safeText(res), retryable: true,
        });
      }
      if (!res.ok) {
        // Every other 4xx is us, not them. Retrying repeats the same mistake.
        throw new OmiApiError(`omi ${method} ${path} failed: HTTP ${res.status}`, {
          status: res.status, body: await safeText(res), retryable: false,
        });
      }
      return res.status === 204 ? null : res.json();
    };

    return withRetry(run, {
      attempts: 3,
      backoffMs: BACKOFF_MS,
      // withRetry's default already stops on 4xx, but spell it out: an auth
      // failure and a budget stop must never be retried whatever else changes.
      isRetryable: (err) => err?.transient === true && !err?.budgetExhausted,
      sleep: doSleep,
    });
  }

  async function safeText(res) {
    try { return String(await res.text()).slice(0, 500); } catch { return null; }
  }

  const asArray = (d) => (Array.isArray(d) ? d : (Array.isArray(d?.items) ? d.items : []));

  return {
    /** Newest first. No `since` parameter exists — page with offset and stop on a known id. */
    listConversations: ({ limit = 100, offset = 0 } = {}) =>
      call('/user/conversations', { query: { limit, offset } }).then(asArray),

    getConversation: (id) => call(`/user/conversations/${encodeURIComponent(id)}`),

    listMemories: ({ limit = 100, offset = 0 } = {}) =>
      call('/user/memories', { query: { limit, offset } }).then(asArray),

    /**
     * Expect []. See the header: Omi's extracted items never reach the task
     * store. The caller must treat an empty array as healthy.
     */
    listActionItems: ({ completed } = {}) =>
      call('/user/action-items', {
        query: completed === undefined ? null : { completed: completed ? 'true' : 'false' },
      }).then(asArray),

    /** The only thing that puts a row on Mark's Tasks page. */
    createActionItem: ({ description, due_at = null }) =>
      call('/user/action-items', {
        method: 'POST',
        body: { description, ...(due_at ? { due_at } : {}) },
      }),

    /** For the sync row: how much of the budget this run spent. */
    stats: () => ({ requests, maxRequests: cfg.maxRequests }),
  };
}

export default { createOmiClient, getOmiClientConfig, OmiApiError, OmiAuthError };
