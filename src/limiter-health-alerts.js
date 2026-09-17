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
 *      deep queue means refill can't keep up. Also flags a SUSTAINED 429
 *      burst or an ESCALATED pause (see the 2026-09-17 note below).
 *   2. Failed-action rate — a spike in agent_actions failures over a short
 *      window, independent of cause (limiter, GHL 5xx, handler bug).
 *
 * 2026-09-17 — THRESHOLDS REALIGNED TO RATE-LIMITER v1.4.
 * ───────────────────────────────────────────────────────
 * The 429 branch used to fire on `total429s > prev.total429s` — ANY single
 * new 429, unconditionally critical. That was correct in June, when
 * report429() paused ALL GHL traffic for a BASE_PAUSE_MS of 300s escalating
 * to a MAX_PAUSE_MS of 900s: one 429 really did mean a multi-minute
 * blackout worth waking someone for.
 *
 * Rate limiter v1.4 (2026-09-14) cut those to 60s base / 180s ceiling after
 * the same 5-minute pause caused a 47-hour agentic outage. A first-step 429
 * pause is now ~60s and clears inside a single heartbeat — ordinary
 * backpressure, not an incident. This file's threshold was never moved with
 * it, so from that date on routine throttling paged like a storm.
 *
 * Observed 2026-09-16/17 overnight, roughly every 35 min, each pair opening
 * and clearing within ~4 minutes:
 *     queue: 2 | tokens: 38/120 | timedOut: 15 | 429s: 2
 * and the live service the next morning, 7.3h uptime, entirely healthy:
 *     tokens 106/120, queueDepth 0, consecutive429Cycles 0,
 *     total429s 2, timedOut 47, msSinceLast429 6.7h
 *
 * A contributing factor worth naming, because it is the reason the bursts
 * happen at all: GHL_RATE_CAPACITY is ramped to 120 while
 * GHL_RATE_REFILL_PER_MIN is 65. A burst can drain 120 tokens far faster
 * than 65/min refills them, so waiters queue, some reach the 30s fail-open
 * timeout and call GHL WITHOUT a token, and a couple of those ungoverned
 * calls earn a 429. Retuning that ratio is a separate change; this one
 * stops the symptom paging.
 *
 * What changed here:
 *   - new 429s must reach `new429Delta` (default 3) in one check, OR the
 *     pause must exceed `pauseAlertMs` (default 150s — past the first
 *     escalation step, so the backoff is genuinely climbing).
 *   - a STANDING pause only alerts once it is longer than `pauseAlertMs`;
 *     a routine 60s pause carried across one check is not an incident.
 *   - `timedOutDelta` default raised 3 → 25. Fail-open timeouts are normal
 *     bursty behaviour under a capacity/refill mismatch; the Jun 4/5 storm
 *     is caught by queue depth, not by this counter.
 *
 * What deliberately did NOT change: the queue-depth threshold (15). That is
 * the signal that actually distinguishes a storm (23-29 deep, sustained)
 * from backpressure (2 deep, clears in minutes), and it stayed correctly
 * silent all night.
 *
 * ⚠️ WHICH DEFAULTS ACTUALLY REACH THE LIVE HEARTBEAT
 * ───────────────────────────────────────────────────
 * Read this before changing a default below and expecting it to take effect.
 * executor-heartbeat.js does NOT omit these thresholds — it passes two of
 * them explicitly, from its own env-backed constants:
 *
 *     shouldAlertLimiter(curr, lastLimiterSnapshot, {
 *       queueDepth:    LIMITER_QUEUE_ALERT_THRESHOLD,   // env || '15'
 *       timedOutDelta: LIMITER_TIMEOUT_DELTA_ALERT,     // env || '3'
 *     })
 *
 * Because `thresholds?.x ?? envInt(...)` honours anything the caller
 * supplies, the caller's value WINS for those two on the heartbeat path.
 * DEFAULT_TIMEOUT_DELTA below is therefore NOT self-activating:
 *
 *   → LIMITER_TIMEOUT_DELTA_ALERT=25 must be set in Railway for the raised
 *     timeout threshold to apply. That is a REQUIRED step, not optional
 *     tuning. Without it the caller keeps passing 3 and the timeout branch
 *     fires exactly as it did before this change.
 *
 * The other two ARE self-activating — the caller passes neither, so they
 * come from here (or their env var) the moment this merges:
 *   LIMITER_NEW_429_DELTA_ALERT   default 3        ← no env var needed
 *   LIMITER_PAUSE_ALERT_MS        default 150000   ← no env var needed
 *
 * The module defaults for queueDepth/timedOutDelta still apply on paths that
 * omit them: this file's tests, and any future caller.
 */

// Defaults live here rather than in executor-heartbeat.js on purpose. That
// file is ~36KB and the MCP write path can only replace it whole — which is
// exactly how PR #648 dropped a const declaration and crashed the service on
// boot for 52 minutes (see its 2026-08-08 hotfix note). Keeping this change
// inside this small file means the caller's signature is untouched — at the
// cost documented above: the caller's explicit values win for two of the four.
const DEFAULT_QUEUE_DEPTH = 15;
const DEFAULT_TIMEOUT_DELTA = 25;
const DEFAULT_NEW_429_DELTA = 3;
const DEFAULT_PAUSE_ALERT_MS = 150000;

function envInt(name, fallback) {
  const raw = parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/**
 * Decide whether the GHL rate limiter is unhealthy enough to alert.
 *
 * @param {object} curr  Snapshot from getRateLimiterStats():
 *   { queueDepth, tokens, capacity, timedOut, total429s, paused, pauseRemainingMs }
 * @param {object|null} prev  Previous snapshot { timedOut, total429s } or null
 *   on first run. Cumulative counters are compared as deltas so a standing
 *   total doesn't re-alert forever.
 * @param {{queueDepth?:number, timedOutDelta?:number, new429Delta?:number,
 *          pauseAlertMs?:number}} [thresholds]
 *   Anything the caller supplies WINS. Any omitted key falls back to its env
 *   var, then to the module default. See the header note on which of these
 *   the live heartbeat supplies.
 * @returns {{alert:boolean, reasons:string[], critical:boolean}}
 */
export function shouldAlertLimiter(curr, prev, thresholds) {
  const queueDepth = curr?.queueDepth ?? 0;
  const tokens = curr?.tokens ?? 0;
  const timedOut = curr?.timedOut ?? 0;
  const total429s = curr?.total429s ?? 0;
  const paused = !!curr?.paused;
  const pauseRemainingMs = curr?.pauseRemainingMs ?? 0;

  const queueThreshold = thresholds?.queueDepth
    ?? envInt('LIMITER_QUEUE_ALERT_THRESHOLD', DEFAULT_QUEUE_DEPTH);
  const timedOutDeltaThreshold = thresholds?.timedOutDelta
    ?? envInt('LIMITER_TIMEOUT_DELTA_ALERT', DEFAULT_TIMEOUT_DELTA);
  const new429DeltaThreshold = thresholds?.new429Delta
    ?? envInt('LIMITER_NEW_429_DELTA_ALERT', DEFAULT_NEW_429_DELTA);
  const pauseAlertMs = thresholds?.pauseAlertMs
    ?? envInt('LIMITER_PAUSE_ALERT_MS', DEFAULT_PAUSE_ALERT_MS);

  const reasons = [];
  let critical = false;

  // 2026-09-17 — a 429 is only an incident when the burst is SUSTAINED or the
  // backoff has ESCALATED. Under rate-limiter v1.4 a first-step 429 pauses GHL
  // traffic for ~60s and clears on its own; paging on that is what produced the
  // overnight flapping. Two discriminators, either one sufficient:
  //   (a) several 429s inside one check — the bucket is being hammered, not
  //       brushed, and consecutive429Cycles is about to climb;
  //   (b) a pause longer than the first step — the exponential backoff has
  //       already escalated, which is the shape of a real storm.
  const new429s = prev ? total429s - (prev.total429s ?? 0) : 0;
  if (new429s >= new429DeltaThreshold) {
    reasons.push(
      `${new429s} new GHL 429 in one check — full pause ${Math.round(pauseRemainingMs / 1000)}s`
    );
    critical = true;
  } else if (new429s > 0 && pauseRemainingMs > pauseAlertMs) {
    reasons.push(
      `${new429s} new GHL 429 — escalated pause ${Math.round(pauseRemainingMs / 1000)}s ` +
      `(> ${Math.round(pauseAlertMs / 1000)}s)`
    );
    critical = true;
  } else if (paused && pauseRemainingMs > pauseAlertMs) {
    // Standing pause carried across checks, and long enough to mean the
    // backoff escalated rather than a routine first-step pause.
    reasons.push(`limiter paused — ${Math.round(pauseRemainingMs / 1000)}s remaining`);
    critical = true;
  }

  // Deep wait queue = refill can't keep up. A non-empty queue implies
  // tokens are exhausted, so the depth alone is the signal. UNCHANGED at 15:
  // this is the threshold that separates a storm (23-29 deep, sustained) from
  // backpressure (2 deep, self-clearing), and it is what caught Jun 4/5.
  if (queueDepth >= queueThreshold) {
    reasons.push(`${queueDepth} requests queued, ${tokens} tokens — refill starved`);
  }

  // Bursty fail-open timeouts even if the queue snapshot is momentarily
  // shallow. Delta since the last check. Module default raised 3 -> 25 on
  // 2026-09-17: with capacity 120 against a 65/min refill, small timeout
  // bursts are the normal cost of a drained bucket, not a signal. NOTE the
  // header — on the live heartbeat path this threshold comes from the caller,
  // so LIMITER_TIMEOUT_DELTA_ALERT=25 must be set in Railway for the raise to
  // actually apply.
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
