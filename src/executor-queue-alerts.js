/**
 * Executor queue-depth alerting — src/executor-queue-alerts.js
 *
 * Phase 4 (2026-06-02). Pure helpers for turning queue stats into an alert
 * decision + a GroupMe message body. Kept dependency-free so they can be
 * unit-tested without importing the executor/supabase/groupme graph.
 *
 * A silent multi-hour backlog (the original ~960-pending, ~12h-latency
 * incident) used to be invisible. These helpers let the in-process heartbeat
 * raise a throttled GroupMe alert when the queue is unhealthy:
 *   - pending depth over a threshold (default 500), OR
 *   - oldest pending action older than a threshold (default 30 min).
 */

/**
 * Decide whether the queue is unhealthy enough to alert.
 *
 * @param {{pendingCount:number, oldestAgeMs:(number|null)}} stats
 * @param {{pendingThreshold:number, oldestAgeThresholdMs:number}} thresholds
 * @returns {{alert:boolean, reasons:string[]}}
 */
export function shouldAlertQueueDepth(stats, thresholds) {
  const pendingCount = stats?.pendingCount ?? 0;
  const oldestAgeMs = stats?.oldestAgeMs ?? null;
  const pendingThreshold = thresholds?.pendingThreshold ?? 500;
  const oldestAgeThresholdMs = thresholds?.oldestAgeThresholdMs ?? 30 * 60 * 1000;

  const reasons = [];
  if (pendingCount > pendingThreshold) {
    reasons.push(`pending ${pendingCount} > ${pendingThreshold}`);
  }
  if (oldestAgeMs != null && oldestAgeMs > oldestAgeThresholdMs) {
    reasons.push(
      `oldest pending ${Math.round(oldestAgeMs / 60000)}min > ${Math.round(oldestAgeThresholdMs / 60000)}min`
    );
  }
  return { alert: reasons.length > 0, reasons };
}

/**
 * Build the GroupMe alert body from queue stats + the trigger reasons.
 *
 * @param {{pendingCount:number, oldestAgeMs:(number|null), executingCount?:number}} stats
 * @param {string[]} reasons
 * @returns {string}
 */
export function formatQueueAlert(stats, reasons) {
  const pendingCount = stats?.pendingCount ?? 0;
  const oldestAgeMs = stats?.oldestAgeMs ?? null;
  const executingCount = stats?.executingCount ?? 0;
  const oldestLine = oldestAgeMs != null
    ? `${Math.round(oldestAgeMs / 60000)}min`
    : 'n/a';
  return (
    `⚠️ Action queue backlog\n` +
    `pending: ${pendingCount} | executing: ${executingCount} | oldest pending: ${oldestLine}\n` +
    `triggered: ${(reasons || []).join('; ') || 'unspecified'}`
  );
}
