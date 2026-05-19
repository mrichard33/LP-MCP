/**
 * Antifragile Validation Gate — Notification Helper
 * src/services/validation/notify.js
 *
 * Sends GroupMe "intelligence"-class notifications when an action is blocked
 * (or, optionally, when it's warned). Routes through the standard
 * send_notification action_type so the existing classifier + GroupMe
 * formatting do the work — we don't duplicate transport here.
 *
 * Notification class taxonomy (from notification standard v1.0, 2026-05-14):
 *   system / priority / intelligence / debug
 * AVG events are 'intelligence' — they're insights about routing logic
 * the rep doesn't need to act on immediately but the operator (Mark)
 * needs to see in real time.
 */

import supabase from '../../supabase.js';

/**
 * Log a validation outcome to validation_log. Returns the inserted row id
 * or null on error. Never throws — logging is best-effort.
 *
 * @param {object} args
 * @param {object} args.action            The action being validated
 * @param {object} args.invariant         The invariant definition from doctrine
 * @param {object} args.checkResult       { passed, reason, context_snapshot, ... }
 * @param {boolean} args.blocked          Whether action was actually blocked
 * @param {boolean} args.notified         Whether a notification was sent
 */
export async function logValidationOutcome({
  action,
  invariant,
  checkResult,
  blocked,
  notified,
}) {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('validation_log')
      .insert({
        action_id: action.id,
        contact_id: action.target_id || null,
        rule_applied: action.rule_applied || null,
        action_type: action.action_type || null,
        invariant_key: invariant.key,
        invariant_name: invariant.name,
        severity: invariant.severity,
        framework_citation: invariant.framework_citation,
        reason: checkResult.reason || 'no_reason_supplied',
        context_snapshot: checkResult.context_snapshot || null,
        action_payload: action.action_payload || null,
        blocked: !!blocked,
        notified: !!notified,
      })
      .select('id')
      .single();
    if (error) {
      console.error(`[avg:notify] validation_log insert failed: ${error.message}`);
      return null;
    }
    return data?.id || null;
  } catch (e) {
    console.error(`[avg:notify] validation_log insert exception: ${e.message}`);
    return null;
  }
}

/**
 * Queue a GroupMe notification for a validation block. Inserts a
 * send_notification action into agent_actions so the standard
 * notification pipeline (classifier + GroupMe formatter) handles delivery.
 *
 * We deliberately queue rather than send synchronously so:
 *   - The blocking decision returns fast (notification doesn't slow the
 *     executor).
 *   - The notification respects the same priority-lane ordering as other
 *     intelligence-class alerts.
 *   - Retries and observability come for free.
 *
 * @returns {Promise<number|null>} the queued action id, or null on error
 */
export async function queueValidationNotification({
  action,
  invariant,
  checkResult,
}) {
  if (!supabase) return null;

  const contactId = action.target_id || 'unknown';
  const ruleApplied = action.rule_applied || 'unknown_rule';
  const actionType = action.action_type || 'unknown_action';
  const canonicalCode = action.action_payload?.canonical_code || '';
  const canonicalName = action.action_payload?.canonical_name || '';

  const summary =
    canonicalCode || canonicalName
      ? `${actionType} → ${canonicalCode || canonicalName}`
      : actionType;

  const message =
    `🛡️ AVG ${invariant.severity} — ${invariant.key}: ${invariant.name}\n` +
    `Action: ${summary}\n` +
    `Rule: ${ruleApplied}\n` +
    `Reason: ${checkResult.reason || '(no reason)'}\n` +
    `Framework: ${invariant.framework_citation}`;

  const narrative =
    `The Antifragile Validation Gate ${invariant.severity === 'BLOCK' ? 'blocked' : 'warned on'} ` +
    `an action queued by rule "${ruleApplied}" against contact ${contactId}. ` +
    `Invariant ${invariant.key} (${invariant.name}) flagged: ${checkResult.reason || 'no reason supplied'}. ` +
    `Framework citation: ${invariant.framework_citation}. ` +
    `Review action #${action.id} — either fix the rule that queued this or override manually.`;

  try {
    const { data, error } = await supabase
      .from('agent_actions')
      .insert({
        event_id: action.event_id || null,
        action_type: 'send_notification',
        target_system: 'groupme',
        target_entity: 'contact',
        target_id: String(contactId),
        action_payload: {
          tier: 'AVG',
          status: invariant.severity,
          message: message,
          narrative: narrative,
          next_step: `Review action #${action.id} in agent_actions. Patch the originating rule or whitelist this case.`,
          action_verb: invariant.severity === 'BLOCK' ? 'REVIEW BLOCKED ACTION' : 'REVIEW WARNED ACTION',
          notification_class: 'intelligence',
          avg_meta: {
            invariant_key: invariant.key,
            invariant_name: invariant.name,
            severity: invariant.severity,
            framework_citation: invariant.framework_citation,
            blocked_action_id: action.id,
            rule_applied: ruleApplied,
          },
        },
        reasoning: `AVG ${invariant.severity}: ${invariant.key} — ${checkResult.reason || 'no reason'}`,
        confidence: 1.0,
        rule_applied: `AVG_${invariant.key}`,
        status: 'pending',
        requires_approval: false,
        priority: 20, // intelligence-class — between customer-facing (10) and routing (50)
      })
      .select('id')
      .single();

    if (error) {
      console.error(`[avg:notify] notification queue failed: ${error.message}`);
      return null;
    }
    return data?.id || null;
  } catch (e) {
    console.error(`[avg:notify] notification queue exception: ${e.message}`);
    return null;
  }
}
