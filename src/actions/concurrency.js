/**
 * Executor concurrency helpers — src/actions/concurrency.js
 *
 * Pure, dependency-free utilities used by executeActions (src/actions/index.js)
 * for Phase 2 bounded-concurrency execution. Kept in their own module so they
 * can be unit-tested without importing the full executor graph (supabase,
 * handlers, rate limiter). See scripts/test-executor-pool.js.
 *
 * Phase 2 (2026-06-02): the executor claims pending actions atomically
 * (claim_agent_actions RPC, FOR UPDATE SKIP LOCKED), groups them into batches,
 * and runs independent batches concurrently — a batch's own actions stay
 * serial (sequence_order dependencies). These two helpers are the grouping +
 * the worker pool.
 */

/**
 * Minimal bounded-concurrency pool. Runs `worker(item, idx)` over `items`
 * with at most `concurrency` promises in flight, preserving result order by
 * index. No external dependency.
 *
 * Never rejects on a worker error by design intent: callers pass a worker
 * (executeSingleAction wrapper) that records failure to the DB row and returns
 * a result object rather than throwing. If a worker does throw, the rejection
 * propagates out of the returned promise.
 *
 * 2026-09-15 — `shouldStop` makes the pool deadline-aware. It is checked
 * BEFORE a runner claims its next item, never mid-item: an action already
 * executing always runs to completion, so this can never interrupt a GHL or LP
 * write halfway. Items never claimed are handed to `onNotStarted` so the caller
 * can put them back where it got them — see executeActions, which releases them
 * to 'pending' rather than letting them sit in 'executing' for the reaper (the
 * reaper DROPS non-idempotent types, so stranding them loses work).
 *
 * The return value stays a plain results-by-index array: callers deep-equal it.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, idx: number) => Promise<R>} worker
 * @param {object} [opts]
 * @param {() => boolean} [opts.shouldStop]     stop claiming new items once true
 * @param {(notStarted: T[]) => void} [opts.onNotStarted]  called once, only when
 *        `shouldStop` fired, with the items never dispatched
 * @returns {Promise<R[]>}
 */
export async function runPool(items, concurrency, worker, opts = {}) {
  const list = items || [];
  const results = new Array(list.length);
  if (list.length === 0) return results;

  const shouldStop = typeof opts.shouldStop === 'function' ? opts.shouldStop : null;
  let next = 0;
  let stopped = false;
  const workers = Math.max(1, Math.min(concurrency || 1, list.length));
  const runners = Array.from({ length: workers }, async () => {
    while (next < list.length) {
      if (shouldStop && shouldStop()) { stopped = true; return; }
      const idx = next++;
      results[idx] = await worker(list[idx], idx);
    }
  });
  await Promise.all(runners);
  // `next` is the high-water mark of claimed indices; everything from it on was
  // never handed to a worker.
  if (stopped && typeof opts.onNotStarted === 'function') {
    opts.onNotStarted(list.slice(next));
  }
  return results;
}

/**
 * Group claimed action rows into batches keyed by `batch_id` (singletons get a
 * synthetic `s_<id>` key), each sorted by `sequence_order`. Returns an array
 * of batches (arrays). The grouping guarantees all actions sharing a batch_id
 * land in ONE batch, so running batches concurrently never runs two actions of
 * the same batch in parallel — preserving intra-batch ordering.
 *
 * @param {Array<{id:any, batch_id?:any, sequence_order?:number}>} actions
 * @returns {Array<Array<object>>}
 */
export function groupByBatch(actions) {
  const batches = new Map();
  for (const a of actions || []) {
    const k = a.batch_id || `s_${a.id}`;
    if (!batches.has(k)) batches.set(k, []);
    batches.get(k).push(a);
  }
  for (const b of batches.values()) {
    b.sort((x, y) => (x.sequence_order || 0) - (y.sequence_order || 0));
  }
  return [...batches.values()];
}
