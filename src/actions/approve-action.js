/**
 * approve_action, as a function — src/actions/approve-action.js
 *
 * 2026-09-28 — lifted out of the approve_action MCP tool (src/tools/agent-tools.js)
 * so POST /slack/dnc-lift/decision can approve its Five9 row through the SAME
 * write the tool performs, not a lookalike. The tool now calls this; behaviour
 * is unchanged, including the 2026-04-28 fix: approval writes status 'pending'
 * (never 'approved', which the executor never reads).
 *
 * approved_by is stored EXACTLY as given. The GroupMe path lowercases its
 * approver; this one must not, because five9_remove_numbers_from_dnc_approved
 * refuses any approved_by that is not a Slack user id (U…/W…, uppercase) —
 * that refusal is how an auto-escalation or GroupMe approval is kept out of a
 * human-only DNC removal.
 */

import supabase from '../supabase.js';

/**
 * @param {object} p
 * @param {number} p.actionId
 * @param {'approve'|'reject'} p.decision
 * @param {string} [p.approvedBy='ryan']   the tool's historical default
 * @param {string} [p.rejectionReason]
 * @returns {Promise<{ok:boolean, data?:object, error?:string, notFound?:boolean}>}
 */
export async function approveAgentAction({ actionId, decision, approvedBy, rejectionReason } = {}, deps = {}) {
  const db = deps.supabase || supabase;
  const now = (deps.now ? deps.now() : new Date()).toISOString();
  const isApprove = decision === 'approve';
  const who = approvedBy || 'ryan';
  const updates = isApprove
    ? {
        // 'pending' (NOT 'approved') so the executor's .eq('status','pending')
        // pickup matches. Mirrors groupme.js:handleGroupMeCallback.
        status: 'pending',
        approved_by: who,
        approved_at: now,
        updated_at: now,
      }
    : {
        status: 'rejected',
        approved_by: who,
        approved_at: now,
        rejection_reason: rejectionReason || null,
        updated_at: now,
      };

  const { data, error } = await db
    .from('agent_actions')
    .update(updates)
    .eq('id', actionId)
    .eq('status', 'pending_approval')
    .select('id, action_type, status, target_id')
    .single();

  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, notFound: true };
  return { ok: true, data };
}
