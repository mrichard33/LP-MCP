/**
 * GHL-note pipeline: what to do with a note that has no LP prospect yet.
 * Pure — unit-tested in scripts/test-ghl-note-defer-policy.js.
 *
 * 2026-09-29 — `missing_fields_deferred` is terminal on the FIRST attempt.
 * It used to be retried like the self-healing outcomes, every ~90s up to
 * MAX_ATTEMPTS (5). A contact with no phone or no first name does not gain one
 * in six minutes, so all 30 such rows in the week to 2026-09-29 ran five full
 * LP lookups each and still failed, and each posted two or three cards for one
 * problem: create_lp_lead's own "LP CREATE SKIP" card (the handler alerts; the
 * GroupMe dedup swallowed its four repeats, hit_count 5 on
 * dXsXdNUELFQSNNaWUWnd), then "deferred", then "gave up after 5 attempts".
 * Now: one attempt, the handler's card, nothing else.
 *
 * Every other outcome keeps its old rule: `created_deferred` and
 * `lp_unavailable` resolve on their own and alert only when they exhaust
 * their attempts; `ambiguous_deferred` alerts once and then waits.
 */

// Outcomes a retry cannot fix, and whose alert the create handler already sent.
const TERMINAL_HANDLER_ALERTED = new Set(['missing_fields_deferred']);
// Outcomes a person must look at — alert once, the first time they occur.
const ALERT_ONCE = new Set(['ambiguous_deferred']);

/**
 * @param {object} p
 * @param {string} p.outcome      resolveOrCreateLpLead outcome
 * @param {number} p.attempts     attempts INCLUDING this one
 * @param {string|null} p.lastError  the row's previous last_error
 * @param {number} p.maxAttempts
 * @returns {{ failed: boolean, alert: boolean, verb: string }}
 */
export function decideDefer({ outcome, attempts, lastError = null, maxAttempts = 5 }) {
  if (TERMINAL_HANDLER_ALERTED.has(outcome)) {
    return { failed: true, alert: false, verb: 'stopped (missing fields — fix the contact in GHL)' };
  }
  const failed = attempts >= maxAttempts;
  const alert = failed || (ALERT_ONCE.has(outcome) && lastError !== outcome);
  return { failed, alert, verb: failed ? `gave up after ${attempts} attempts` : 'deferred' };
}
