/**
 * Executor Heartbeat — src/executor-heartbeat.js
 *
 * In-process failover scheduler for the Action Executor. Sits dormant
 * while n8n's external heartbeat is healthy, takes over automatically
 * if n8n stops firing.
 *
 * BACKGROUND
 * ──────────
 * Layer 2 of the agentic system relies on a 5-minute n8n cron hitting
 * POST /n8n/decision-engine/execute to drain the agent_actions queue.
 * When n8n goes down or its heartbeat workflow fails, the queue stalls
 * indefinitely — actions pile up, customer-facing operations (booking
 * confirmations, tag-driven workflow exits, GroupMe alerts) silently
 * block.
 *
 * Cited incident: 2026-05-02. n8n Railway service became unreachable;
 * agent_actions pending count climbed to 5,627 and a customer-facing
 * appointment-recovery action sat in queue for hours. Discovered when
 * Mark asked Claude to recover a Bot 4 OUT_OF_AREA misfire (Jeanne
 * Jewell, contact Pb19irZgit7Gpqj80fI3).
 *
 * DESIGN
 * ──────
 * Failover, not parallel. The scheduler:
 *   1. Checks the most recent executed_at across agent_actions
 *   2. If < STALE_THRESHOLD_MS old: skip (n8n is doing its job)
 *   3. If >= STALE_THRESHOLD_MS old: run executeActions
 *
 * Why failover rather than always-on:
 *   - The executor's SELECT doesn't claim/lock rows. Two concurrent
 *     runs would both grab the same pending action, both flip it to
 *     'executing', both invoke the handler. Idempotent action types
 *     (add_tag, remove_tag) tolerate this; non-idempotent ones
 *     (book_appointment, send_message) would double-fire. Failover
 *     guarantees only one driver at any moment.
 *   - Keeps n8n authoritative when healthy. The internal heartbeat
 *     doesn't interfere with n8n's normal operation, only fills gaps.
 *
 * KILL SWITCH
 * ───────────
 *   EXECUTOR_HEARTBEAT_DISABLED=true   — disables the scheduler entirely
 *
 * TUNING
 * ──────
 *   STALE_THRESHOLD_MS — how stale "no executor run in X ms" means
 *                        before failover fires. Default 6min — gives
 *                        n8n's 5-min cadence a 1-min buffer.
 *   HEARTBEAT_INTERVAL_MS — how often this scheduler wakes up. Default
 *                           5min — same as n8n cadence.
 *   FIRST_RUN_DELAY_MS — initial wait on boot. Default 3min — gives
 *                        the server time to settle, n8n a chance to
 *                        fire first if it's healthy, and the reaper
 *                        a chance to clean up startup state.
 *
 * MANUAL TRIGGER
 * ──────────────
 *   POST /n8n/decision-engine/heartbeat
 *     Forces a heartbeat check immediately (subject to staleness gate).
 *     Pass { force: true } in body to bypass the staleness gate and
 *     run executeActions unconditionally.
 *
 * OBSERVABILITY
 * ─────────────
 *   - Logs every heartbeat decision at info level
 *   - On failover-fire: logs the staleness duration and the executor
 *     result summary (completed/failed/retrying counts)
 *   - On skip: logs the most-recent executed_at age in seconds
 */

import supabase from './supabase.js';
import { executeActions } from './action-executor.js';

const STALE_THRESHOLD_MS = parseInt(
  process.env.EXECUTOR_STALE_THRESHOLD_MS || `${6 * 60 * 1000}`, 10
);
const HEARTBEAT_INTERVAL_MS = parseInt(
  process.env.EXECUTOR_HEARTBEAT_INTERVAL_MS || `${5 * 60 * 1000}`, 10
);
const FIRST_RUN_DELAY_MS = parseInt(
  process.env.EXECUTOR_HEARTBEAT_FIRST_RUN_DELAY_MS || `${3 * 60 * 1000}`, 10
);

let intervalHandle = null;

/**
 * Find the most recent executed_at timestamp across all agent_actions.
 * Returns ISO string or null if no actions have ever executed.
 */
async function getMostRecentExecutionAt() {
  const { data, error } = await supabase
    .from('agent_actions')
    .select('executed_at')
    .not('executed_at', 'is', null)
    .order('executed_at', { ascending: false })
    .limit(1);
  if (error) {
    console.warn(`[ExecutorHeartbeat] executed_at query failed: ${error.message}`);
    return null;
  }
  return data?.[0]?.executed_at || null;
}

/**
 * Check if the executor needs a failover kick. Returns:
 *   { needs_run: bool, last_executed_at, age_ms }
 */
async function checkExecutorHealth() {
  const lastIso = await getMostRecentExecutionAt();
  if (!lastIso) {
    // No execution history at all — either fresh deploy or empty queue.
    // Treat as needs_run so we can drain whatever's pending.
    return { needs_run: true, last_executed_at: null, age_ms: null };
  }
  const ageMs = Date.now() - Date.parse(lastIso);
  return {
    needs_run: ageMs >= STALE_THRESHOLD_MS,
    last_executed_at: lastIso,
    age_ms: ageMs,
  };
}

/**
 * One heartbeat cycle. Checks staleness, fires executor if needed.
 * Returns the result for logging / route response.
 */
export async function runHeartbeat({ force = false } = {}) {
  if (process.env.EXECUTOR_HEARTBEAT_DISABLED === 'true') {
    return { skipped: true, reason: 'EXECUTOR_HEARTBEAT_DISABLED=true' };
  }

  const health = await checkExecutorHealth();

  if (!force && !health.needs_run) {
    const ageSeconds = health.age_ms != null ? Math.round(health.age_ms / 1000) : null;
    console.log(`[ExecutorHeartbeat] Skip — n8n healthy (last run ${ageSeconds}s ago)`);
    return {
      skipped: true,
      reason: 'n8n_healthy',
      last_executed_at: health.last_executed_at,
      age_ms: health.age_ms,
      stale_threshold_ms: STALE_THRESHOLD_MS,
    };
  }

  const ageDescription = health.age_ms != null
    ? `${Math.round(health.age_ms / 1000)}s stale`
    : 'no prior execution';
  console.log(
    `[ExecutorHeartbeat] FAILOVER — firing executor (${ageDescription}, threshold ${STALE_THRESHOLD_MS}ms${force ? ', forced' : ''})`
  );

  const startedAt = Date.now();
  let result;
  try {
    result = await executeActions({ limit: 50 });
  } catch (err) {
    console.error(`[ExecutorHeartbeat] executeActions threw: ${err.message}`);
    return {
      skipped: false,
      fired: true,
      forced: !!force,
      error: err.message,
      last_executed_at_before: health.last_executed_at,
      age_ms_before: health.age_ms,
      elapsed_ms: Date.now() - startedAt,
    };
  }

  console.log(
    `[ExecutorHeartbeat] Done — ${result.actions_executed || 0} executed (${result.completed || 0} completed, ${result.failed || 0} failed, ${result.retrying || 0} retrying), ${result.stuck_actions_reaped || 0} reaped, ${result.elapsed_ms}ms`
  );
  return {
    skipped: false,
    fired: true,
    forced: !!force,
    last_executed_at_before: health.last_executed_at,
    age_ms_before: health.age_ms,
    executor_result: result,
    elapsed_ms: Date.now() - startedAt,
  };
}

/**
 * Start the in-process heartbeat scheduler. Idempotent — calling twice
 * is a no-op.
 */
export function startExecutorHeartbeatScheduler() {
  if (intervalHandle) return;
  if (process.env.EXECUTOR_HEARTBEAT_DISABLED === 'true') {
    console.log('[ExecutorHeartbeat] Disabled via EXECUTOR_HEARTBEAT_DISABLED=true — scheduler not armed');
    return;
  }

  setTimeout(() => {
    runHeartbeat().catch(err => {
      console.error('[ExecutorHeartbeat] Initial run failed:', err.message);
    });
    intervalHandle = setInterval(() => {
      runHeartbeat().catch(err => {
        console.error('[ExecutorHeartbeat] Scheduled run failed:', err.message);
      });
    }, HEARTBEAT_INTERVAL_MS);
  }, FIRST_RUN_DELAY_MS);

  console.log(
    `[ExecutorHeartbeat] Scheduler armed: stale_threshold=${STALE_THRESHOLD_MS}ms, interval=${HEARTBEAT_INTERVAL_MS}ms, first_run_delay=${FIRST_RUN_DELAY_MS}ms`
  );
}

/**
 * Express routes:
 *   POST /n8n/decision-engine/heartbeat
 *     Manually trigger a heartbeat check. Body: { force?: boolean }.
 *     If force=true, bypasses the staleness gate and runs unconditionally.
 *
 *   GET /n8n/decision-engine/heartbeat-status
 *     Returns the current health state without firing the executor.
 */
export function registerExecutorHeartbeatRoutes(app) {
  app.post('/n8n/decision-engine/heartbeat', async (req, res) => {
    try {
      const force = req.body?.force === true;
      const result = await runHeartbeat({ force });
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('[ExecutorHeartbeat] /heartbeat error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/n8n/decision-engine/heartbeat-status', async (req, res) => {
    try {
      const health = await checkExecutorHealth();
      res.json({
        success: true,
        ...health,
        stale_threshold_ms: STALE_THRESHOLD_MS,
        heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
        disabled: process.env.EXECUTOR_HEARTBEAT_DISABLED === 'true',
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}
