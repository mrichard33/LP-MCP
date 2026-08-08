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
 * 2026-08-07 — DATABASE LOAD REDUCTION.
 *   pg_stat_statements showed this file was the single largest consumer
 *   of LP Supabase execution time: two of its queries accounted for 85
 *   of the database's 244 total hours since 2026-06-04, or 35% of
 *   everything the database did.
 *
 *     194,032 s over  90,290 calls — getRecentFailedCount() exact count
 *     111,146 s over  91,698 calls — getMostRecentExecutionAt()
 *
 *   Neither is a slow query. Run by hand the failed count plans as an
 *   Index Only Scan and returns in 0.113 ms. Three things compounded:
 *
 *     1. Frequency. The Phase 2 change below dropped the interval to 60s
 *        so the executor could drain the queue continuously. Correct for
 *        execution — but it also multiplied six observability queries by
 *        the same factor, feeding alerts whose cooldowns are 15 and 30
 *        minutes. Most of those readings were discarded unread.
 *
 *     2. Query shape. PostgREST renders .not('col','is',null) as
 *        NOT (col IS NULL). idx_aa_executed_at is a PARTIAL index
 *        (WHERE executed_at IS NOT NULL) and Postgres's predicate prover
 *        does not reliably match a negated NullTest against that
 *        predicate — so the plan degraded to a sequential scan of all
 *        289,272 rows. A strict comparison (>= epoch) does imply
 *        IS NOT NULL and matches the partial index.
 *
 *     3. Cache pressure. The LP instance is a Micro — 256 MB
 *        shared_buffers against a 6.1 GB database, 67% table cache hit
 *        rate. Those two statements dragged ~33 TB off disk. Warm they
 *        run in 0.02 ms; IO-starved they have hit 119,863 ms. That
 *        two-minute tail is the same event that surfaces as sync
 *        timeouts and analyzer silent drops.
 *
 *   Changes made here (execution cadence deliberately NOT touched — the
 *   executor still runs every 60s):
 *     a. hasPendingActions() uses a LIMIT 1 existence probe instead of
 *        an exact count. It only ever asked "> 0".
 *     b. getMostRecentExecutionAt() uses .gte(executed_at, EPOCH) so the
 *        partial index applies.
 *     c. getQueueStats() and getRecentFailedCount() sample every 5 min
 *        (HEARTBEAT_OBSERVABILITY_INTERVAL_MS) instead of every cycle,
 *        with last-known values cached and returned in between. No alert
 *        can be missed: every alert cooldown is longer than the sample
 *        interval. The limiter check reads in-process state, not the
 *        database, so it still runs every cycle.
 *
 *   Still outstanding after this change (tracked separately):
 *     - The same NOT (col IS NULL) pattern on system_events.processed_at
 *       in decision-engine.js — 68,325 s over 89,838 calls.
 *     - The Micro instance itself. This change removes the load that was
 *       making the undersizing acute; it does not fix the undersizing.
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
 *   HEARTBEAT_OBSERVABILITY_INTERVAL_MS — how often the DB-backed queue
 *                           stats + failed-action count are sampled.
 *                           Default 5min. Set to 0 to sample every cycle
 *                           (pre-2026-08-07 behavior).
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
 *     force: true also forces a fresh observability sample.
 *
 * OBSERVABILITY
 * ─────────────
 *   - Logs every heartbeat decision at info level
 *   - On failover-fire: logs the staleness duration and the executor
 *     result summary (completed/failed/retrying counts)
 *   - On skip: logs the reason (`no_pending_actions` or `n8n_healthy`)
 *     and most-recent executed_at age in seconds when applicable
 *   - queue_stats carries `sampled_at` and `stale` so a cached reading
 *     is never mistaken for a live one
 */

import supabase from './supabase.js';
import { executeActions } from './action-executor.js';
import { reapStaleLocks } from './actions/reaper.js';
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

// 2026-08-07 — decouple observability sampling from execution cadence.
// The 60s interval above is right for DRAINING the queue. It is not right
// for the DB-backed telemetry queries wrapped around it: those feed alerts
// with 15- and 30-minute cooldowns, so a once-per-minute sample produced
// readings nothing consumed while accounting for ~35% of all LP database
// execution time. Sampling every 5 minutes cannot delay an alert by more
// than one sample, which is well inside every cooldown.
//
// Set to 0 to restore per-cycle sampling without a redeploy.
const OBSERVABILITY_INTERVAL_MS = parseInt(
  process.env.HEARTBEAT_OBSERVABILITY_INTERVAL_MS || `${5 * 60 * 1000}`, 10
);

// Epoch sentinel. Used in place of .not('executed_at','is',null) — a strict
// comparison implies IS NOT NULL, which lets Postgres match the partial index
// idx_aa_executed_at (WHERE executed_at IS NOT NULL). The negated-NullTest
// form that PostgREST generates does not match it and degrades to a seq scan.
const EPOCH_ISO = '1970-01-01T00:00:00.000Z';

let intervalHandle = null;

// Cached observability sample. Returned between DB samples so callers always
// have a reading; `sampled_at` / `stale` let them tell fresh from cached.
let lastQueueStats = null;
let lastQueueStatsAt = 0;
let lastFailedCount = null;
let lastFailedCountAt = 0;

/**
 * Should the DB-backed observability queries run this cycle?
 * Always true when the interval is 0 (per-cycle mode) or on first run.
 */
function shouldSampleObservability(lastSampleAt) {
  if (OBSERVABILITY_INTERVAL_MS <= 0) return true;
  if (!lastSampleAt) return true;
  return Date.now() - lastSampleAt >= OBSERVABILITY_INTERVAL_MS;
}

/**
 * Find the most recent executed_at timestamp across all agent_actions.
 * Returns ISO string or null if no actions have ever executed.
 *
 * 2026-08-07 — was .not('executed_at','is',null), which PostgREST renders
 * as NOT (executed_at IS NULL). That form does not match the partial index
 * idx_aa_executed_at and the planner fell back to a sequential scan of
 * 289,272 rows, ~91,700 times (111,146 s of database time). A strict
 * comparison against the epoch is logically identical — any non-null
 * timestamp is >= 1970-01-01 — and Postgres proves it implies IS NOT NULL,
 * so the partial index applies and this becomes an index scan with LIMIT 1.
 */
async function getMostRecentExecutionAt() {
  const { data, error } = await supabase
    .from('agent_actions')
    .select('executed_at')
    .gte('executed_at', EPOCH_ISO)
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
 *
 * 2026-08-07 — was `count: 'exact', head: true`. The caller only ever
 * asked whether the result was > 0, but an exact count makes Postgres
 * visit every matching row. A LIMIT 1 existence probe answers the same
 * question and stops at the first hit. Behavior is identical, including
 * the fail-open branch below.
 */
async function hasPendingActions() {
  const { data, error } = await supabase
    .from('agent_actions')
    .select('id')
    .in('status', ['pending', 'executing'])
    .limit(1);
  if (error) {
    console.warn(`[ExecutorHeartbeat] pending probe failed: ${error.message}`);
    // Fail-open: assume there might be work. Worst case is a benign
    // failover fire that finds nothing — same as old behavior.
    return true;
  }
  return (data?.length || 0) > 0;
}

/**
 * Phase 4 — queue health snapshot for observability + alerting.
 * Returns pending depth, oldest-pending age, and executing count.
 *
 * 2026-08-07 — now sampled on OBSERVABILITY_INTERVAL_MS rather than every
 * cycle. Pass { force: true } to bypass the sample gate (used by the
 * /heartbeat-status route and by forced heartbeats, which must be live).
 * Between samples the last reading is returned with stale: true.
 */
async function getQueueStats({ force = false } = {}) {
  if (!force && !shouldSampleObservability(lastQueueStatsAt) && lastQueueStats) {
    return {
      ...lastQueueStats,
      sampled_at: new Date(lastQueueStatsAt).toISOString(),
      stale: true,
    };
  }

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

  lastQueueStats = { pendingCount, oldestPendingAt, oldestAgeMs, executingCount };
  lastQueueStatsAt = Date.now();

  return {
    ...lastQueueStats,
    sampled_at: new Date(lastQueueStatsAt).toISOString(),
    stale: false,
  };
}

/**
 * 2026-06-05 — recent failed-action count for the failure-rate alert.
 * Counts agent_actions that moved to 'failed' within the window. Returns
 * null on query error (caller treats null as "no signal").
 *
 * 2026-08-07 — sampled on OBSERVABILITY_INTERVAL_MS. This was the single
 * most expensive statement on the LP database: 194,032 s across 90,290
 * calls. The query itself is fine (Index Only Scan via idx_aa_status_updated,
 * 0.113 ms warm) — it was the once-a-minute cadence against a cache-starved
 * instance that made it the top cost. The alert it feeds has a 15-minute
 * cooldown, so a 5-minute sample loses nothing.
 *
 * The window is measured from now() at sample time, so a cached reading is
 * only reused inside the sample interval and never stretches the window.
 */
async function getRecentFailedCount(windowMin, { force = false } = {}) {
  if (!force && !shouldSampleObservability(lastFailedCountAt) && lastFailedCount !== null) {
    return lastFailedCount;
  }

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

  lastFailedCount = count || 0;
  lastFailedCountAt = Date.now();
  return lastFailedCount;
}

/**
 * Phase 4 — raise a throttled GroupMe alert when the queue is unhealthy
 * (pending over threshold OR oldest pending too old). Cooldown prevents
 * spamming every 60s heartbeat while a backlog persists. Best-effort: a
 * send failure is logged, never thrown.
 */
async function maybeAlertQueueDepth(stats) {
  if (!stats) return { alerted: false };
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
 *
 * Note: getRateLimiterStats() reads in-process memory, not the database,
 * so this check is not part of the 2026-08-07 sampling change — it still
 * runs every cycle and costs nothing.
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
 *
 * 2026-08-07 — only evaluates on a fresh sample. A cached count is not
 * re-tested, so the alert cannot double-fire off one reading.
 */
async function maybeAlertFailedActions() {
  const sampledNow = shouldSampleObservability(lastFailedCountAt);
  const failedCount = await getRecentFailedCount(FAILED_ACTION_WINDOW_MIN);
  if (failedCount == null) return { alerted: false };
  if (!sampledNow) return { alerted: false, failedCount, cached: true };

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

  // Phase 4 — queue observability + throttled backlog alert. Best-effort.
  // 2026-08-07: sampled on OBSERVABILITY_INTERVAL_MS rather than every
  // cycle. A forced heartbeat always takes a live sample.
  let queueStats = null;
  try {
    queueStats = await getQueueStats({ force });
    if (!queueStats.stale) await maybeAlertQueueDepth(queueStats);
  } catch (err) {
    console.warn(`[ExecutorHeartbeat] queue stats/alert failed: ${err.message}`);
  }

  // 2026-06-05 — limiter-health + failure-rate alerts. Kept in independent
  // best-effort blocks so one failing source can't suppress the others or
  // affect action execution below. The limiter check reads in-process state
  // and stays on every cycle; the failure-rate check is DB-backed and
  // follows the sample interval.
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

  // 2026-07-03 hotfix — stale lock-table sweep, every cycle, INCLUDING when
  // the action queue is empty (the in-executeActions reaper only runs with
  // pending work, which is exactly when a leaked agentic_reply_locks row
  // has no acquirer to lazily reclaim it). Best-effort like the alerts.
  try {
    await reapStaleLocks();
  } catch (err) {
    console.warn(`[ExecutorHeartbeat] stale-lock sweep failed: ${err.message}`);
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
    `[ExecutorHeartbeat] Scheduler armed: stale_threshold=${STALE_THRESHOLD_MS}ms, interval=${HEARTBEAT_INTERVAL_MS}ms, observability_interval=${OBSERVABILITY_INTERVAL_MS}ms, first_run_delay=${FIRST_RUN_DELAY_MS}ms`
  );
}

/**
 * Express routes:
 *   POST /n8n/decision-engine/heartbeat
 *     Manually trigger a heartbeat check. Body: { force?: boolean }.
 *     If force=true, bypasses both the pending-action gate and the
 *     staleness gate and runs executeActions unconditionally. It also
 *     forces a live observability sample.
 *
 *   GET /n8n/decision-engine/heartbeat-status
 *     Returns the current health state without firing the executor.
 *     Always samples live — this route exists to answer "what is true
 *     right now", so it is deliberately exempt from the sample interval.
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
        getQueueStats({ force: true }).catch((err) => {
          console.warn(`[ExecutorHeartbeat] queue stats failed: ${err.message}`);
          return null;
        }),
        getRecentFailedCount(FAILED_ACTION_WINDOW_MIN, { force: true }).catch(() => null),
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
        observability_interval_ms: OBSERVABILITY_INTERVAL_MS,
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
