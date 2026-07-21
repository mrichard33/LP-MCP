/**
 * Action Idempotency Guard — src/actions/idempotency.js
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * agent_actions had no deduplication at creation time. Any rule that
 * re-evaluates on repeated `ai.analysis_completed` events emitted a fresh
 * create_task + send_notification on every pass.
 *
 * Measured 2026-07-20 (24h window):
 *   mcZ8OFDfZndBUgEdcnO2 (Mike Hak)       14x create_task,  8x send_notification
 *   TUGI07Od1vfQNugznyaf (Kristie Afonso)  8x create_task,  5x send_notification
 *
 * Contributing rules — note there are FIVE, which is the whole point:
 *   LAYER3_DISPATCH, OBJ_FAMILY_REPEAT_TRUST, ESC_EXISTING_CUSTOMER,
 *   BEHAVIORAL_SPOUSE_OBJECTION_PRE_DEMO, BEHAVIORAL_DISENGAGEMENT
 *
 * This is a creation-layer defect, not a rule defect. Guarding a single rule
 * would have prevented none of the observed duplicates.
 *
 * The cost is not storage. Mike Hak was a genuine service failure — a no-show
 * who waited 30+ minutes. At the exact moment the system most needed to emit
 * one clean, actionable signal, it emitted thirty. Deduplication is an
 * incident-response fix.
 *
 * ---------------------------------------------------------------------------
 * SCOPE
 * ---------------------------------------------------------------------------
 * Only `create_task` and `send_notification` are guarded. These are
 * non-idempotent, human-facing, and have no natural dedup key.
 *
 * Deliberately NOT guarded:
 *   add_tag / remove_tag        — idempotent at the handler; replay is harmless
 *   send_message                — already protected by the outbound lock and
 *                                 superseded_by_newer_* guards
 *   sync_lp_appointment_to_ghl  — already guarded (`already_in_sync`)
 *
 * ---------------------------------------------------------------------------
 * KEY DESIGN
 * ---------------------------------------------------------------------------
 *   <target_id>:<rule_applied>:<action_type>:<YYYY-MM-DD America/New_York>
 *
 * Day-bucketed in Eastern time, matching how the ops team reads the queue.
 * The window is deliberately a calendar day rather than a rolling interval:
 * a genuinely new escalation tomorrow SHOULD produce a new task, and a repeat
 * of the same escalation today should not.
 *
 * rule_applied is part of the key so two different rules escalating the same
 * contact for different reasons still both surface. Only same-rule repeats
 * collapse.
 */

import { supabase } from '../supabase.js';

/** Action types that are non-idempotent and human-facing. */
export const DEDUP_ACTION_TYPES = new Set(['create_task', 'send_notification']);

/** IANA zone the ops team reads the queue in. */
const DEDUP_TZ = 'America/New_York';

/**
 * Calendar date (YYYY-MM-DD) for `when` in the ops timezone.
 * Uses en-CA because it formats as ISO-8601, avoiding manual padding.
 */
function opsDate(when = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DEDUP_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(when);
}

/**
 * Build the idempotency key for an action, or null if out of scope.
 *
 * Returning null (rather than throwing) is intentional: callers can pass
 * every action through unconditionally and let scope be decided here.
 *
 * @param {object} action
 * @param {string} action.action_type
 * @param {string} action.target_id
 * @param {string} [action.rule_applied]
 * @param {Date}   [when] - defaults to now; injectable for tests
 * @returns {string|null}
 */
export function buildIdempotencyKey(action, when = new Date()) {
  if (!action || !DEDUP_ACTION_TYPES.has(action.action_type)) return null;
  if (!action.target_id) return null;

  const rule = action.rule_applied || 'norule';
  return `${action.target_id}:${rule}:${action.action_type}:${opsDate(when)}`;
}

/**
 * Has this action already been created today?
 *
 * FAIL-OPEN: on any lookup error we return false so the action is still
 * created. A duplicate task is a nuisance; a silently dropped escalation is a
 * customer-facing failure. Never trade the second for the first.
 *
 * @param {object} action
 * @param {Date}   [when]
 * @returns {Promise<{duplicate: boolean, key: string|null, existingId?: number}>}
 */
export async function isDuplicateAction(action, when = new Date()) {
  const key = buildIdempotencyKey(action, when);
  if (!key) return { duplicate: false, key: null };

  try {
    const { data, error } = await supabase
      .from('agent_actions')
      .select('id')
      .eq('idempotency_key', key)
      .limit(1);

    if (error) {
      console.warn(`[idempotency] lookup failed for ${key} — failing open:`, error.message);
      return { duplicate: false, key };
    }

    if (data && data.length > 0) {
      return { duplicate: true, key, existingId: data[0].id };
    }
    return { duplicate: false, key };
  } catch (err) {
    console.warn(`[idempotency] lookup threw for ${key} — failing open:`, err.message);
    return { duplicate: false, key };
  }
}

/**
 * Convenience wrapper: decide whether to insert, and return the row to insert.
 *
 * Returns { skip: true, reason, existingId } when the action is a same-day
 * repeat, or { skip: false, row } with idempotency_key stamped on.
 *
 * The DB unique index (agent_actions_idem_uniq) is the real enforcement — this
 * check just avoids a guaranteed-failing insert and gives a clean audit reason.
 * Callers should still handle a 23505 unique violation as a benign skip, since
 * two concurrent evaluations can both pass this check.
 */
export async function guardAction(action, when = new Date()) {
  const { duplicate, key, existingId } = await isDuplicateAction(action, when);

  if (duplicate) {
    return {
      skip: true,
      reason: 'duplicate_same_day_action',
      key,
      existingId,
    };
  }

  return {
    skip: false,
    row: key ? { ...action, idempotency_key: key } : action,
  };
}
