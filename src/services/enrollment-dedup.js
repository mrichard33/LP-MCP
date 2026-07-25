/**
 * Enrollment-dedup — src/services/enrollment-dedup.js
 *
 * Cross-rule guard: the same contact must not be added to the same workflow
 * twice within a short window. This is NOT an S5.2 special case.
 *
 * Why (2026-07-25): a single cancellation is seen twice — once by the LP
 * disposition path (LP_DISP_CANCEL_COLD_TO_S5_2, recorded rule_applied
 * 'STATE_ENROLLMENT') and once by the GHL cancel webhook
 * (GHL_APPT_CANCELLED_REBOOK_COLD). Both enqueue an add_to_workflow into the
 * S5.2 v2 Appointment Rescue workflow, and nothing dedupes across rules. Result:
 * 290 contacts enrolled into S5.2 more than once in 30 days (365 excess
 * enrollments), each a duplicate rescue message. Keying on the DESTINATION
 * workflow (not the rule name) also covers a contact who genuinely cancels twice
 * in a few hours — they don't need two rescue enrollments either.
 *
 * The executor short-circuits on a duplicate BEFORE calling GHL, marking the
 * action completed with execution_result.skipped (mirrors the send-dedup gate).
 *
 * FAIL-OPEN everywhere: no supabase, no resolvable workflow identity, or any
 * lookup error → duplicate:false (enroll). Losing a legitimate enrollment is
 * worse than an occasional duplicate. The `client` option injects a supabase
 * client for unit tests; production passes none.
 */

import defaultSupabase from '../supabase.js';

const DEFAULT_WINDOW_HOURS = Math.max(
  1,
  parseInt(process.env.WORKFLOW_REENROLL_WINDOW_HOURS || '6', 10),
);

// How many recent completed enrollments to scan for a destination match. Small:
// a contact enrolled into many distinct workflows inside the window is rare, and
// we only need to find one matching the incoming destination.
const SCAN_LIMIT = 50;

/**
 * Resolved destination identity for an add_to_workflow payload — the value, not
 * the raw JSON string. Every live rule carries a top-level `workflow_id` (GHL
 * UUID); the `canonical_code` fallback covers rows that resolve the UUID at
 * dispatch time.
 * @returns {string|null}
 */
export function workflowIdentity(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.workflow_id) return String(payload.workflow_id);
  if (payload.canonical_code) return `code:${payload.canonical_code}`;
  return null;
}

/**
 * Find a prior completed enrollment of the same contact into the same workflow
 * within the window.
 *
 * @param {object} action  the add_to_workflow agent_action row (target_id,
 *   action_payload, id)
 * @returns {Promise<{ duplicate: boolean, prior_action_id: (number|null),
 *   age_ms: (number|null), reason: string }>}  duplicate:true only on a real
 *   match; all guard/error paths fail OPEN (duplicate:false).
 */
export async function findPriorEnrollment(action, { client, windowHours = DEFAULT_WINDOW_HOURS } = {}) {
  const supabase = client ?? defaultSupabase;
  const open = (reason) => ({ duplicate: false, prior_action_id: null, age_ms: null, reason });

  if (!supabase) return open('no_supabase_open');
  const contactId = action?.target_id;
  if (!contactId) return open('no_contact_open');

  const identity = workflowIdentity(action?.action_payload);
  if (!identity) return open('no_workflow_identity_open');

  try {
    const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
    let query = supabase
      .from('agent_actions')
      .select('id, action_payload, created_at')
      .eq('target_id', contactId)
      .eq('action_type', 'add_to_workflow')
      .eq('status', 'completed')
      .gte('created_at', windowStart)
      .order('created_at', { ascending: false })
      .limit(SCAN_LIMIT);
    // Exclude the current row if it already exists (it is normally still
    // 'executing' at this point, but be defensive against re-entry).
    if (action?.id != null) query = query.neq('id', action.id);

    const { data, error } = await query;
    if (error) throw error;

    const rows = Array.isArray(data) ? data : [];
    for (const row of rows) {
      if (workflowIdentity(row.action_payload) === identity) {
        const age_ms = row.created_at ? Date.now() - new Date(row.created_at).getTime() : null;
        return { duplicate: true, prior_action_id: row.id, age_ms, reason: 'duplicate_enrollment_window' };
      }
    }
    return open('no_prior_enrollment');
  } catch (err) {
    console.warn(`[enrollmentDedup] lookup failed for ${contactId} wf=${identity} (fail-open, enrolling): ${err.message}`);
    return open('error_open');
  }
}

export default { workflowIdentity, findPriorEnrollment };
