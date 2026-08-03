/**
 * Agentic silence alerting — src/agentic-silence-alerts.js
 *
 * 2026-08-03. Pure, dependency-free helpers that turn a rolling-window count of
 * ai.analysis_completed vs inbound replies into an alert decision + a GroupMe
 * message body. Kept dependency-free — like limiter-health-alerts.js and
 * executor-queue-alerts.js — so they unit-test without importing supabase /
 * groupme. The decision-engine heartbeat owns the query, the state and the
 * throttle.
 *
 * WHY
 * ───
 * The 2026-07-31 → 2026-08-02 outage ran ~47 HOURS with the agentic bot
 * answering nothing, and nothing paged. A pinned consecutive429Cycles blacked
 * out GHL traffic, the analyzer's 45s budget blew, and ai.analysis_completed
 * went to exactly zero while 8 inbound replies arrived and were marked
 * processed. Every existing alarm watched a proxy — queue depth, action
 * failures, limiter health — and every one of them stayed quiet, because
 * nothing was backing up: replies were being consumed and silently dropped.
 * This watches the OUTPUT of the agentic pipeline directly. Zero analyses while
 * real replies arrive is the one signal that cannot be faked by a healthy-
 * looking queue.
 *
 * ELIGIBLE REPLIES, NOT ALL REPLIES
 * ─────────────────────────────────
 * A reply the bot is deliberately forbidden to answer is not a missed
 * analysis. On 2026-08-02 a live check found 4 replies / 0 analyses that were
 * entirely correct — every one came from a stop-bot / DNC contact. A watchdog
 * counting raw replies would have paged critical on a perfectly healthy night,
 * and an alarm that cries wolf on the normal case gets muted, which is how you
 * end up with another 47-hour outage.
 *
 * So the caller excludes events whose action_taken marks a deliberate silence
 * (`skipped: <reason>` from analyzePendingReplies, `bot_silenced: <reason>`
 * from the reply buffer) and passes them separately as skippedReplies — they
 * appear in the alert body as context, never as a trigger.
 */

/**
 * Decide whether the agentic pipeline has gone silent.
 *
 * @param {object} counts
 * @param {number} counts.analyses        ai.analysis_completed in the window
 * @param {number} counts.eligibleReplies inbound replies the bot was allowed to answer
 * @param {number} counts.windowHours     window length (for the message)
 * @param {{minReplies:number}} thresholds
 *   minReplies — how many eligible replies must go unanswered before this pages.
 *   The literal spec ("any non-zero reply count") would page on a single
 *   off-hours message; 2 keeps that quiet while still catching the real outage,
 *   which had 8 replies inside its first 6 hours.
 * @returns {{alert:boolean, reasons:string[], critical:boolean}}
 */
export function shouldAlertAgenticSilence(counts, thresholds) {
  const analyses = counts?.analyses ?? 0;
  const eligibleReplies = counts?.eligibleReplies ?? 0;
  const windowHours = counts?.windowHours ?? 6;
  const minReplies = thresholds?.minReplies ?? 2;

  const reasons = [];

  // The pipeline produced output — it is alive, whatever else may be wrong.
  if (analyses > 0) return { alert: false, reasons, critical: false };

  // Too quiet to conclude anything. Absence of traffic is not absence of health.
  if (eligibleReplies < minReplies) return { alert: false, reasons, critical: false };

  reasons.push(
    `0 ai.analysis_completed in ${windowHours}h while ${eligibleReplies} answerable ` +
    `repl${eligibleReplies === 1 ? 'y' : 'ies'} arrived`
  );
  // Always critical. This state means leads are being ghosted right now.
  return { alert: true, reasons, critical: true };
}

/**
 * Build the GroupMe alert body for an agentic-silence trigger.
 *
 * @param {object} counts { analyses, eligibleReplies, windowHours, skippedReplies }
 * @param {string[]} reasons
 * @returns {string}
 */
export function formatAgenticSilenceAlert(counts, reasons) {
  const analyses = counts?.analyses ?? 0;
  const eligibleReplies = counts?.eligibleReplies ?? 0;
  const windowHours = counts?.windowHours ?? 6;
  const skippedReplies = counts?.skippedReplies ?? 0;

  const skippedNote = skippedReplies > 0
    ? `\n(${skippedReplies} more repl${skippedReplies === 1 ? 'y' : 'ies'} excluded — bot deliberately silenced)`
    : '';

  return (
    `🔴 Agentic bot silent — leads are being ghosted\n` +
    `analyses: ${analyses} | answerable replies: ${eligibleReplies} | window: ${windowHours}h${skippedNote}\n` +
    `triggered: ${(reasons || []).join('; ') || 'unspecified'}\n` +
    `check /n8n/rate-limiter/stats and Railway logs for [MessageAnalyzer] / [AgenticPipeline]`
  );
}

export default { shouldAlertAgenticSilence, formatAgenticSilenceAlert };
