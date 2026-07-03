/**
 * Handler-result → action status mapping — src/actions/result-status.js
 *
 * Issue #99: the action executor used to mark EVERY non-throwing handler
 * return as `status: 'completed'` with a null `error_message`. That silently
 * buried AI-generation failures: executeSendMessage caught a thrown
 * generation error and RETURNED a result object, so the executor recorded a
 * "completed" send that never actually reached the contact.
 *
 * June 2026 (Mark Test repro): the same masking hid lock-suppressed sends.
 * executeSendMessageWithLock returns `{ skipped: true, reason: ... }` when a
 * send is blocked by the outbound lock (or universal suppression), yet that was
 * still recorded `completed` — making suppressed sends look delivered and
 * masking the entire silence bug. A skipped result now maps to `status:
 * 'skipped'` (already a valid agent_actions.status enum value) so dashboards
 * and action history stop counting it as a delivered send.
 *
 * This pure predicate centralizes the rule:
 *   - AI generation failure (legacy `action: 'send_message_ai_generation_failed'`
 *     or `_fallback_send: true`)        → `failed`
 *   - explicitly skipped (`skipped: true`, e.g. outbound_lock_held / suppressed)
 *                                        → `skipped`
 *   - everything else                    → `completed`
 *
 * Dependency-free + pure so it is unit-testable in isolation.
 */

/**
 * @param {any} result  the value returned by an action handler
 * @returns {{ status: 'completed'|'failed'|'skipped', error_message: (string|null) }}
 */
export function classifyHandlerResult(result) {
  const generationFailed =
    result?.action === 'send_message_ai_generation_failed' ||
    result?._fallback_send === true;

  if (generationFailed) {
    return {
      status: 'failed',
      error_message:
        result?._generation_error ||
        result?.error ||
        'AI generation failed — fallback sent',
    };
  }

  // 2026-07-03 (pipeline-integrity breach): a stage move refused by the
  // stage-transition evidence validator records as `blocked_by_validator`
  // so illegitimate move requests are countable
  // (SELECT count(*) ... WHERE status='blocked_by_validator').
  if (result?.blocked_by_validator === true) {
    return {
      status: 'blocked_by_validator',
      error_message: result?.reason || 'blocked by stage-transition validator',
    };
  }

  // Honest accounting: a handler that explicitly skipped (lock held, suppressed)
  // never reached the contact — record it as `skipped`, not `completed`.
  if (result?.skipped === true) {
    return { status: 'skipped', error_message: result?.reason || 'skipped' };
  }

  return { status: 'completed', error_message: null };
}

export default { classifyHandlerResult };
