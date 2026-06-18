/**
 * Handler-result → action status mapping — src/actions/result-status.js
 *
 * Issue #99: the action executor used to mark EVERY non-throwing handler
 * return as `status: 'completed'` with a null `error_message`. That silently
 * buried AI-generation failures: executeSendMessage caught a thrown
 * generation error and RETURNED a result object, so the executor recorded a
 * "completed" send that never actually reached the contact.
 *
 * This pure predicate centralizes the rule: a result that represents an AI
 * generation failure — either the legacy early-return shape
 * (`action: 'send_message_ai_generation_failed'`) or the new
 * fallback-was-sent shape (`_fallback_send: true`) — maps to `failed` with a
 * populated `error_message`. Everything else stays `completed`.
 *
 * Dependency-free + pure so it is unit-testable in isolation.
 */

/**
 * @param {any} result  the value returned by an action handler
 * @returns {{ status: 'completed'|'failed', error_message: (string|null) }}
 */
export function classifyHandlerResult(result) {
  const generationFailed =
    result?.action === 'send_message_ai_generation_failed' ||
    result?._fallback_send === true;

  if (!generationFailed) {
    return { status: 'completed', error_message: null };
  }
  return {
    status: 'failed',
    error_message:
      result?._generation_error ||
      result?.error ||
      'AI generation failed — fallback sent',
  };
}

export default { classifyHandlerResult };
