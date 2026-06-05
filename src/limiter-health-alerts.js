/**
 * Limiter & failure-rate alerting — src/limiter-health-alerts.js
 *
 * 2026-06-05. Pure, dependency-free helpers that turn a GHL rate-limiter
 * stats snapshot (and a recent failed-action count) into an alert decision
 * + a GroupMe message body. Kept dependency-free — like
 * executor-queue-alerts.js — so they unit-test without importing the
 * limiter / supabase / groupme graph. The in-process executor heartbeat
 * (executor-heartbeat.js) calls these every cycle and owns the snapshot
 * state + throttle.
 *
 * WHY
 * ───
 * The 2026-06-04/05 token-starvation storm ran ~12h on Jun 4 and resumed
 * Jun 5 before anyone noticed — the limiter was failing open on a 23-29
 * deep wait queue (~550 timeouts) and ~169 actions failed, all silently.
 * The executor's queue-depth alert didn't catch it because the
 * agent_actions queue itself never saturated (actions failed fast rather
 * than backing up). These helpers watch the limiter directly + the
 * executor's failure rate, so the next storm pages within a heartbeat
 * instead of a half-day.
 *
 * Two independent signals:
 *   1. Rate-limiter health — a non-empty wait queue implies tokens are
 *      exhausted (processQueue drains until queue empty OR tokens 0), so a
 *      deep queue means refill can't keep up. Also flags a fresh 429 (each
 *      429 triggers a 5-15 min FULL pause, far costlier than throttling)
 *      and a standing pause carried across checks.
 *   2. Failed-action rate — a spike in agent_actions failures over a short
 *      window, independent of cause (limiter, GHL 5xx, handler bug).
 */

/**
 * Decide whether the GHL rate limiter is unhealthy enough to alert.
 *
 * @param {object} curr  Snapshot from getRateLimiterStats():
 *   { queueDepth, tokens, capacity, timedOut, total429s, paused, pauseRemainingMs }
 * @param {object|null} prev  Previous snapshot { timedOut, total429s } or null
 *   on first run. Cumulative counters are compared as deltas so a standing
 *   total doesn't re-alert forever.
 * @param {{queueDepth:number, timedOutDelta:number}} thresholds
 * @returns {{alert:boolean, reasons:string[], critical:boolean}}
 */
export function shouldAlertLimiter(curr, prev, thresholds) {
  const queueDepth = curr?.queueDepth ?? 0;
  const tokens = curr?.tokens ?? 0;
  const timedOut = curr?.timedOut ?? 0;
  const total429s = curr?.total429s ?? 0;
  const paused = !!curr?.paused;
  const pauseRemainingMs = curr?.pauseRemainingMs ?? 0;

  const queueThreshold = thresholds?.queueDepth ?? 15;
  const timedOutDeltaThreshold = thresholds?.timedOutDelta ?? 3;

  const reasons = [];
  let critical = false;

  // A 429 pauses ALL GHL traffic for 5-15 min — the worst outcome. Fire on
  // any new 429 since the last check.
  if (prev && total429s > (prev.total429s ?? 0)) {
    const d = total429s - (prev.total429s ?? 0);
    reasons.push(`${d} new GHL 429 — full pause ${Math.round(pauseRemainingMs / 1000)}s`);
    critical = true;
  } else if (paused) {
    // Standing pause carried across checks (no fresh 429 this cycle).
    reasons.push(`limiter paused — ${Math.round(pauseRemainingMs / 1000)}s remaining`);
    critical = true;
  }

  // Deep wait queue = refill can't keep up. A non-empty queue implies
  // tokens are exhausted, so the depth alone is the signal.
  if (queueDepth >= queueThreshold) {
    reasons.push(`${queueDepth} requests queued, ${tokens} tokens — refill starved`);
  }

  // Bursty fail-open timeouts even if the queue snapshot is momentarily
  // shallow. Delta since the last check.
  if (prev && (timedOut - (prev.timedOut ?? 0)) >= timedOutDeltaThreshold) {
    reasons.push(`${timedOut - (prev.timedOut ?? 0)} token timeouts since last check`);
  }

  return { alert: reasons.length > 0, reasons, critical };
}

/**
 * Build the GroupMe alert body for a limiter-health trigger.
 *
 * @param {object} curr  Snapshot from getRateLimiterStats()
 * @param {string[]} reasons
 * @param {boolean} critical
 * @returns {string}
 */
export function formatLimiterAlert(curr, reasons, critical) {
  const queueDepth = curr?.queueDepth ?? 0;
  const tokens = curr?.tokens ?? 0;
  const capacity = curr?.capacity ?? 0;
  const timedOut = curr?.timedOut ?? 0;
  const total429s = curr?.total429s ?? 0;
  const icon = critical ? '🔴' : '⚠️';
  return (
    `${icon} GHL rate limiter unhealthy\n` +
    `queue: ${queueDepth} | tokens: ${tokens}/${capacity} | timedOut: ${timedOut} | 429s: ${total429s}\n` +
    `triggered: ${(reasons || []).join('; ') || 'unspecified'}`
  );
}

/**
 * Decide whether the executor's recent failure rate warrants an alert.
 *
 * @param {number} failedCount  failed agent_actions in the window
 * @param {number} windowMin    window length in minutes (for the message)
 * @param {number} threshold    alert if failedCount > threshold
 * @returns {{alert:boolean, reasons:string[]}}
 */
export function shouldAlertFailedActions(failedCount, windowMin, threshold) {
  const count = failedCount ?? 0;
  const limit = threshold ?? 20;
  const reasons = [];
  if (count > limit) {
    reasons.push(`${count} failed actions in ${windowMin}min > ${limit}`);
  }
  return { alert: reasons.length > 0, reasons };
}

/**
 * Build the GroupMe alert body for a failed-action spike.
 *
 * @param {number} failedCount
 * @param {number} windowMin
 * @param {string[]} reasons
 * @returns {string}
 */
export function formatFailedActionsAlert(failedCount, windowMin, reasons) {
  return (
    `🔴 Action failure spike\n` +
    `${failedCount ?? 0} failed in the last ${windowMin}min\n` +
    `triggered: ${(reasons || []).join('; ') || 'unspecified'}\n` +
    `check /n8n/rate-limiter/stats and Railway logs`
  );
}
