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
 * 2026-05-15 — PENDING-ACTION GATE.
 *   The original failover used the most-recent `executed_at` timestamp
 *   as a proxy for "is n8n healthy?". During a healthy quiet period,
 *   n8n fires every 5 min and finds nothing to execute, so no
 *   `executed_at` advances. The failover then read MAX(executed_at)
 *   as stale and fired the executor — which also found nothing.
 *   Result: noisy log lines every 5 min ("FAILOVER ... Done — 0 executed")
 *   that look like a malfunction but are just a tautological false
 *   positive when the queue is empty.
 *
 *   Fix: gate failover on the presence of pending actions, mirroring
 *   the pattern already used by decision-engine-heartbeat.js (gates on
 *   `hasPendingEvents`). Now:
 *     - queue empty → skip with `no_pending_actions` reason
 *     - queue has work + last run recent → skip with `n8n_healthy` reason
 *     - queue has work + last run stale → fire failover
 *
 *   The fix preserves the original safety net: if n8n stops firing
 *   while the queue has pending work, the failover still triggers
 *   within 6 minutes. The only change is we no longer fire when there
 *   is provably nothing to execute.
 *
 * 2026-06-05 — LIMITER-HEALTH + FAILURE-RATE ALERTS.
 *   The Jun 4/5 GHL token-starvation storm ran ~12h silently. The rate
 *   limiter failed open on a 23-29 deep wait queue (~550 timeouts, ~169
 *   failed actions) but the agent_actions queue itself never saturated
 *   (actions failed fast rather than backing up), so the Phase 4
 *   queue-depth alert below could not see it. The heartbeat now also runs
 *   two throttled, best-effort checks every cycle: limiter health (deep
 *   wait queue / fresh 429 / standing pause) and the executor's failure
 *   rate over a rolling window. See src/limiter-health-alerts.js.
 *
 * DESIGN
 * ──────
 * Failover, not parallel. The scheduler:
 *   1. Checks for pending actions in the queue
 *   2. If none: skip (nothing to do regardless of n8n state)
 *   3. If pending and most recent executed_at < STALE_THRESHOLD_MS old:
 *      skip (n8n is doing its job)
 *   4. Otherwise: run executeActions
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
 *     Pass { force: true } in body to bypass both the pending-action
 *     gate AND the staleness gate and run executeActions unconditionally.
 *
 * OBSERVABILITY
 * ─────────────
 *   - Logs every heartbeat decision at info level
 *   - On failover-fire: logs the staleness duration and the executor
 *     result summary (completed/failed/retrying counts)
 *   - On skip: logs the reason (`no_pending_actions` or `n8n_healthy`)
 *     and most-recent executed_at age in seconds when applicable
 */

import supabase from './supabase.js';
import { executeActions } from './action-executor.js';
import { sendGroupMeMessage } from './groupme.js';
import { shouldAlertQueueDepth, formatQueueAlert } from './executor-queue-alerts.js';
import { getRateLimiterStats } from './ghl-rate-limiter.js';
import {
  shouldAlertLimiter,
  formatLimiterAlert,
  shouldAlertFailedActions,
  formatFailedActionsAlert,
} from './limiter-health-alerts.js';

// Phase 4 (2026-06-02) — queue-depth observability + alerting. A silent
// multi-hour backlog used to be invisible; the heartbeat now surfaces
// pending depth + oldest-pending age on /heartbeat-status and raises a
// throttled GroupMe alert when the queue is unhealthy.
const PENDING_ALERT_THRESHOLD = parseInt(
  process.env.EXECUTOR_PENDING_ALERT_THRESHOLD || '500', 10
);
const OLDEST_AGE_ALERT_MS = parseInt(
  process.env.EXECUTOR_OLDEST_AGE_ALERT_MS || `${30 * 60 * 1000}`, 10
);
const ALERT_COOLDOWN_MS = parseInt(
  process.env.EXECUTOR_ALERT_COOLDOWN_MS || `${30 * 60 * 1000}`, 10
);

let lastQueueAlertAt = 0;

// 2026-06-05 — limiter-health + failure-rate alerting. The Jun 4/5 GHL
// token-starvation storm ran silently for hours: the limiter failed open
// on a deep wait queue while the agent_actions queue itself never
// saturated, so the queue-depth alert above couldn't see it. These watch
// the limiter directly + the executor failure rate. All thresholds are
// env-tunable; the defaults give clear separation from normal operation
// (baseline failed-action rate is ~1/hr; the storm peaked ~109/hr, and a
// healthy limiter has an empty wait queue).
const LIMITER_QUEUE_ALERT_THRESHOLD = parseInt(
  process.env.LIMITER_QUEUE_ALERT_THRESHOLD || '15', 10
);
const LIMITER_TIMEOUT_DELTA_ALERT = parseInt(
  process.env.LIMITER_TIMEOUT_DELTA_ALERT || '3', 10
);
const LIMITER_ALERT_COOLDOWN_MS = parseInt(
  process.env.LIMITER_ALERT_COOLDOWN_MS || `${15 * 60 * 1000}`, 10
);
const FAILED_ACTION_WINDOW_MIN = parseInt(
  process.env.FAILED_ACTION_WINDOW_MIN || '15', 10
);
const FAILED_ACTION_ALERT_THRESHOLD = parseInt(
  process.env.FAILED_ACTION_ALERT_THRESHOLD || '20', 10
);
const FAILED_ACTION_ALERT_COOLDOWN_MS = parseInt(
  process.env.FAILED_ACTION_ALERT_COOLDOWN_MS || `${15 * 60 * 1000}`, 10
);

let lastLimiterAlertAt = 0;
let lastLimiterSnapshot = null; // { timedOut, total429s } — for delta math
let lastFailedActionAlertAt = 0;

const STALE_THRESHOLD_MS = parseInt(
  process.env.EXECUTOR_STALE_THRESHOLD_MS || `${6 * 60 * 1000}`, 10
);
const HEARTBEAT_INTERVAL_MS = parseInt(
  // Phase 2 (2026-06-02): in-process driver is now PRIMARY (not failover-only)
  // — default 60s so the executor runs near-continuously and can spend GHL
  // rate-limiter tokens as they refill. Safe because executeActions claims
  // rows atomically (claim_agent_actions RPC), so overlap with the n8n cron
  // backup can't double-fire. The module-level in-flight guard inside
  // executeActions prevents the route + timer from stacking.
  process.env.EXECUTOR_HEARTBEAT_INTERVAL_MS || '60000', 10
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
 * 2026-05-15 — gate. Are there any actions that the executor would
 * actually pick up if it ran right now? Status 'pending' is the normal
 * executable state. Status 'executing' is included so a stuck row that
 * needs the reaper still triggers a failover when n8n is dead. Other
 * statuses (pending_approval, completed, failed, rejected, cancelled)
 * are not executor work — pending_approval waits for GroupMe approval,
 * the others are terminal.
 */
async function hasPendingActions() {
  const { count, error } = await supabase
    .from('agent_actions')
    .select('id', { count: 'exact', head: true })
    .in('status', ['pending', 'executing']);
  if (error) {
    console.warn(`[ExecutorHeartbeat] pending count failed: ${error.message}`);
    // Fail-open: assume there might be work. Worst case is a benign
    // failover fire that finds nothing — same as old behavior.
    return true;
  }
  return (count || 0) > 0;
}

/**
 * Phase 4 — queue health snapshot for observability + alerting.
 * Returns pending depth, oldest-pending age, and executing count.
 */
async function getQueueStats() {
  const [pendingRes, oldestRes, executingRes] = await Promise.all([
    supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('agent_actions').select('created_at').eq('status', 'pending')
      .order('created_at', { ascending: true }).limit(1),
    supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'executing'),
  ]);

  const pendingCount = pendingRes.count || 0;
  const oldestPendingAt = oldestRes.data?.[0]?.created_at || null;
  const oldestAgeMs = oldestPendingAt ? Date.now() - Date.parse(oldestPendingAt) : null;
  const executingCount = executingRes.count || 0;

  return { pendingCount, oldestPendingAt, oldestAgeMs, executingCount };
}

/**
 * 2026-06-05 — recent failed-action count for the failure-rate alert.
 * Counts agent_actions that moved to 'failed' within the window. Returns
 * null on query error (caller treats null as "no signal").
 */
async function getRecentFailedCount(windowMin) {
  const cutoffIso = new Date(Date.now() - windowMin * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from('agent_actions')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'failed')
    .gte('updated_at', cutoffIso);
  if (error) {
    console.warn(`[ExecutorHeartbeat] failed-count query failed: ${error.message}`);
    return null;
  }
  return count || 0;
}

/**
 * Phase 4 — raise a throttled GroupMe alert when the queue is unhealthy
 * (pending over threshold OR oldest pending too old). Cooldown prevents
 * spamming every 60s heartbeat while a backlog persists. Best-effort: a
 * send failure is logged, never thrown.
 */
async function maybeAlertQueueDepth(stats) {
  const { alert, reasons } = shouldAlertQueueDepth(stats, {
    pendingThreshold: PENDING_ALERT_THRESHOLD,
    oldestAgeThresholdMs: OLDEST_AGE_ALERT_MS,
  });
  if (!alert) return { alerted: false };
  if (Date.now() - lastQueueAlertAt < ALERT_COOLDOWN_MS) {
    return { alerted: false, suppressed: 'cooldown', reasons };
  }
  lastQueueAlertAt = Date.now();
  try {
    await sendGroupMeMessage(formatQueueAlert(stats, reasons));
    console.warn(`[ExecutorHeartbeat] queue-depth alert sent — ${reasons.join('; ')}`);
  } catch (err) {
    console.error(`[ExecutorHeartbeat] queue-depth alert send failed: ${err.message}`);
  }
  return { alerted: true, reasons };
}

/**
 * 2026-06-05 — throttled GroupMe alert when the GHL rate limiter is
 * starved (deep wait queue, a fresh 429, or a standing pause). The
 * snapshot is updated every cycle (even under cooldown) so the
 * cumulative-counter deltas (timedOut, total429s) stay accurate.
 * Best-effort: a send failure is logged, never thrown. Returns the live
 * stats for the status route.
 */
async function maybeAlertLimiter() {
  let curr;
  try {
    curr = getRateLimiterStats();
  } catch (err) {
    console.warn(`[ExecutorHeartbeat] limiter stats failed: ${err.message}`);
    return { alerted: false, error: err.message };
  }
  const { alert, reasons, critical } = shouldAlertLimiter(curr, lastLimiterSnapshot, {
    queueDepth: LIMITER_QUEUE_ALERT_THRESHOLD,
    timedOutDelta: LIMITER_TIMEOUT_DELTA_ALERT,
  });
  // Update snapshot regardless of alert/cooldown so deltas stay correct.
  lastLimiterSnapshot = { timedOut: curr?.timedOut ?? 0, total429s: curr?.total429s ?? 0 };

  if (!alert) return { alerted: false, stats: curr };
  if (Date.now() - lastLimiterAlertAt < LIMITER_ALERT_COOLDOWN_MS) {
    return { alerted: false, suppressed: 'cooldown', reasons, stats: curr };
  }
  lastLimiterAlertAt = Date.now();
  try {
    await sendGroupMeMessage(formatLimiterAlert(curr, reasons, critical));
    console.warn(`[ExecutorHeartbeat] limiter alert sent — ${reasons.join('; ')}`);
  } catch (err) {
    console.error(`[ExecutorHeartbeat] limiter alert send failed: ${err.message}`);
  }
  return { alerted: true, reasons, stats: curr };
}

/**
 * 2026-06-05 — throttled GroupMe alert when the executor's failure rate
 * spikes over a short rolling window, independent of cause (limiter, GHL
 * 5xx, handler bug). Best-effort.
 */
async function maybeAlertFailedActions() {
  const failedCount = await getRecentFailedCount(FAILED_ACTION_WINDOW_MIN);
  if (failedCount == null) return { alerted: false };
  const { alert, reasons } = shouldAlertFailedActions(
    failedCount, FAILED_ACTION_WINDOW_MIN, FAILED_ACTION_ALERT_THRESHOLD
  );
  if (!alert) return { alerted: false, failedCount };
  if (Date.now() - lastFailedActionAlertAt < FAILED_ACTION_ALERT_COOLDOWN_MS) {
    return { alerted: false, suppressed: 'cooldown', failedCount, reasons };
  }
  lastFailedActionAlertAt = Date.now();
  try {
    await sendGroupMeMessage(formatFailedActionsAlert(failedCount, FAILED_ACTION_WINDOW_MIN, reasons));
    console.warn(`[ExecutorHeartbeat] failed-action alert sent — ${reasons.join('; ')}`);
  } catch (err) {
    console.error(`[ExecutorHeartbeat] failed-action alert send failed: ${err.message}`);
  }
  return { alerted: true, failedCount, reasons };
}

/**
 * Check if the executor needs a failover kick. Returns:
 *   { needs_run, last_executed_at, age_ms, has_pending }
 *
 * 2026-05-15 — `has_pending` added to the contract. When false, the
 * heartbeat skips regardless of staleness.
 */
async function checkExecutorHealth() {
  const [lastIso, hasPending] = await Promise.all([
    getMostRecentExecutionAt(),
    hasPendingActions(),
  ]);

  if (!hasPending) {
    // Queue is empty — nothing for the executor to do regardless of
    // how stale the last execution was.
    return {
      needs_run: false,
      last_executed_at: lastIso,
      age_ms: lastIso ? Date.now() - Date.parse(lastIso) : null,
      has_pending: false,
    };
  }

  if (!lastIso) {
    // Pending work exists but no execution history at all (fresh deploy
    // or all-time empty). Fire to drain.
    return { needs_run: true, last_executed_at: null, age_ms: null, has_pending: true };
  }

  // Phase 2: PRIMARY driver. Whenever there is pending work, run — the old
  // STALE_THRESHOLD "only if n8n looks dead" gate is dropped (claiming makes
  // concurrent n8n + in-process runs safe). age_ms is still reported for
  // observability.
  const ageMs = Date.now() - Date.parse(lastIso);
  return {
    needs_run: true,
    last_executed_at: lastIso,
    age_ms: ageMs,
    has_pending: true,
  };
}

/**
 * One heartbeat cycle. Checks staleness + pending-work gate, fires
 * executor if needed. Returns the result for logging / route response.
 */
export async function runHeartbeat({ force = false } = {}) {
  if (process.env.EXECUTOR_HEARTBEAT_DISABLED === 'true') {
    return { skipped: true, reason: 'EXECUTOR_HEARTBEAT_DISABLED=true' };
  }

  // Phase 4 — queue observability + throttled backlog alert, every cycle
  // (independent of whether we fire the executor). Best-effort.
  let queueStats = null;
  try {
    queueStats = await getQueueStats();
    await maybeAlertQueueDepth(queueStats);
  } catch (err) {
    console.warn(`[ExecutorHeartbeat] queue stats/alert failed: ${err.message}`);
  }

  // 2026-06-05 — limiter-health + failure-rate alerts, every cycle. Kept
  // in independent best-effort blocks so one failing source can't suppress
  // the others or affect action execution below.
  try {
    await maybeAlertLimiter();
  } catch (err) {
    console.warn(`[ExecutorHeartbeat] limiter alert check failed: ${err.message}`);
  }
  try {
    await maybeAlertFailedActions();
  } catch (err) {
    console.warn(`[ExecutorHeartbeat] failed-action alert check failed: ${err.message}`);
  }

  const health = await checkExecutorHealth();

  if (!force && !health.needs_run) {
    const ageSeconds = health.age_ms != null ? Math.round(health.age_ms / 1000) : null;
    const reason = !health.has_pending ? 'no_pending_actions' : 'n8n_healthy';
    const ageSuffix = ageSeconds !== null ? ` (last run ${ageSeconds}s ago)` : '';
    console.log(`[ExecutorHeartbeat] Skip — ${reason}${ageSuffix}`);
    return {
      skipped: true,
      reason,
      last_executed_at: health.last_executed_at,
      age_ms: health.age_ms,
      has_pending: health.has_pending,
      stale_threshold_ms: STALE_THRESHOLD_MS,
      queue_stats: queueStats,
    };
  }

  const ageDescription = health.age_ms != null
    ? `last run ${Math.round(health.age_ms / 1000)}s ago`
    : 'no prior execution';
  console.log(
    `[ExecutorHeartbeat] Firing executor (primary; ${ageDescription}${force ? ', forced' : ''})`
  );

  const startedAt = Date.now();
  let result;
  try {
    result = await executeActions();
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
    queue_stats: queueStats,
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
 *     If force=true, bypasses both the pending-action gate and the
 *     staleness gate and runs executeActions unconditionally.
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
      const [health, queueStats, failedRecent] = await Promise.all([
        checkExecutorHealth(),
        getQueueStats().catch((err) => {
          console.warn(`[ExecutorHeartbeat] queue stats failed: ${err.message}`);
          return null;
        }),
        getRecentFailedCount(FAILED_ACTION_WINDOW_MIN).catch(() => null),
      ]);
      const alertEval = queueStats
        ? shouldAlertQueueDepth(queueStats, {
            pendingThreshold: PENDING_ALERT_THRESHOLD,
            oldestAgeThresholdMs: OLDEST_AGE_ALERT_MS,
          })
        : { alert: false, reasons: [] };

      // 2026-06-05 — limiter + failure-rate snapshot for the status route.
      // Note: limiter_alert here is evaluated against lastLimiterSnapshot,
      // which the heartbeat cycle updates; an out-of-band GET does not
      // mutate it.
      let limiterStats = null;
      try { limiterStats = getRateLimiterStats(); } catch (e) { /* best-effort */ }
      const limiterAlert = limiterStats
        ? shouldAlertLimiter(limiterStats, lastLimiterSnapshot, {
            queueDepth: LIMITER_QUEUE_ALERT_THRESHOLD,
            timedOutDelta: LIMITER_TIMEOUT_DELTA_ALERT,
          })
        : { alert: false, reasons: [], critical: false };
      const failedAlert = shouldAlertFailedActions(
        failedRecent, FAILED_ACTION_WINDOW_MIN, FAILED_ACTION_ALERT_THRESHOLD
      );

      res.json({
        success: true,
        ...health,
        stale_threshold_ms: STALE_THRESHOLD_MS,
        heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
        disabled: process.env.EXECUTOR_HEARTBEAT_DISABLED === 'true',
        queue_stats: queueStats,
        queue_alert: alertEval,
        limiter_stats: limiterStats,
        limiter_alert: limiterAlert,
        failed_actions_recent: {
          window_min: FAILED_ACTION_WINDOW_MIN,
          count: failedRecent,
          threshold: FAILED_ACTION_ALERT_THRESHOLD,
          alert: failedAlert.alert,
        },
        alert_thresholds: {
          pending: PENDING_ALERT_THRESHOLD,
          oldest_age_ms: OLDEST_AGE_ALERT_MS,
          cooldown_ms: ALERT_COOLDOWN_MS,
          limiter_queue: LIMITER_QUEUE_ALERT_THRESHOLD,
          limiter_timeout_delta: LIMITER_TIMEOUT_DELTA_ALERT,
          limiter_cooldown_ms: LIMITER_ALERT_COOLDOWN_MS,
          failed_action_window_min: FAILED_ACTION_WINDOW_MIN,
          failed_action_threshold: FAILED_ACTION_ALERT_THRESHOLD,
          failed_action_cooldown_ms: FAILED_ACTION_ALERT_COOLDOWN_MS,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}
