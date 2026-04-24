/**
 * Approval Path — src/actions/approval-path.js
 *
 * The GroupMe approval pipeline — isolated so future tuning of pre-gen,
 * trigger-message resolution, or head-of-line behavior stays a small,
 * focused edit. Extracted from action-executor.js v4.2 refactor.
 *
 * v4.2 changes preserved exactly:
 *   1. Pre-filter the pending_approval query against active tracking records
 *      so stale unanswered approvals cannot starve the limit(20) window.
 *   2. In-loop defense-in-depth re-check for concurrent executor runs.
 *   3. triggerMessage resolution accepts message_preview (the field on
 *      ai.analysis_completed events that AGENTIC_* rules fire on).
 *
 * Paired with sql/008_approval_queue_ttl.sql which auto-expires unanswered
 * approvals after 48h so the tracked-batch set stays bounded.
 */

import supabase from '../supabase.js';
import { sendApprovalRequest } from '../groupme.js';
import { resolveContactInfo, resolveLPProspectId, getEventContext } from './resolvers.js';
import { buildNotificationEnrichment } from './enrichment.js';

/**
 * Process the pending_approval queue. Returns the number of approval
 * requests sent this cycle for stats reporting.
 */
export async function processApprovalQueue() {
  // v4.2 — Pre-filter batches that already have an active ('pending') tracking
  // record so stale unanswered approvals do not starve the limit(20) window.
  // Only status='pending' blocks; resolved/expired/approved/rejected entries
  // are ignored, permitting legitimate re-sends after an expiry/failure.
  const { data: trackedRows } = await supabase
    .from('groupme_approval_requests')
    .select('batch_id')
    .eq('status', 'pending');
  const trackedBatchIds = new Set((trackedRows || []).map(r => r.batch_id).filter(Boolean));

  const { data: rawApprovalActions } = await supabase.from('agent_actions')
    .select('*')
    .eq('status', 'pending_approval')
    .order('created_at', { ascending: true })
    .limit(100);

  const approvalActions = (rawApprovalActions || [])
    .filter(a => !trackedBatchIds.has(a.batch_id || `s_${a.id}`))
    .slice(0, 20);

  if (!approvalActions?.length) return 0;

  const approvalBatches = new Map();
  for (const a of approvalActions) {
    const k = a.batch_id || `s_${a.id}`;
    if (!approvalBatches.has(k)) approvalBatches.set(k, []);
    approvalBatches.get(k).push(a);
  }

  for (const [batchId, actions] of approvalBatches) {
    // Defense-in-depth: re-check for an active tracking record inside the
    // loop. Guards against concurrent executor runs (heartbeat + approval-
    // triggered execute) from double-sending the same card.
    const { data: existing } = await supabase
      .from('groupme_approval_requests')
      .select('id')
      .eq('batch_id', batchId)
      .eq('status', 'pending')
      .maybeSingle();
    if (existing) continue;

    const firstAction = actions[0];
    const { name, phone, lpLead, ghlContactId } = await resolveContactInfo(firstAction.target_id);
    const prospectId = await resolveLPProspectId(firstAction.target_id);
    const ctx = await getEventContext(firstAction);
    const enrichment = await buildNotificationEnrichment(firstAction.target_id, ctx, { lpLead, prospectId, ghlContactId });

    if (firstAction.action_type === 'send_message' && firstAction.action_payload?.requires_ai_generation) {
      try {
        const { generateResponse } = await import('../response-generator.js');
        // v4.2 — message_preview is the canonical inbound field on
        // ai.analysis_completed events (what AGENTIC_* rules fire on).
        // Still accept message_text/messageText/body from ghl.reply_received
        // and other event shapes.
        const triggerMessage = ctx.message_text || ctx.messageText || ctx.body || ctx.message_preview || 'No trigger message';
        const channel = firstAction.action_payload?.channel || 'sms';

        console.log(`[ActionExecutor] Pre-generating AI response for approval ${batchId}`);
        const generated = await generateResponse(firstAction.target_id, channel, triggerMessage);

        const updatedPayload = {
          ...firstAction.action_payload,
          message: generated.message,
          subject: generated.subject,
          story_arc: generated.story_arc,
          ai_reasoning: generated.reasoning,
          requires_ai_generation: false,
          pre_generated: true,
          generated_at: new Date().toISOString(),
        };

        await supabase.from('agent_actions')
          .update({ action_payload: updatedPayload, updated_at: new Date().toISOString() })
          .eq('id', firstAction.id);

        enrichment.generatedMessage = generated.message;
        enrichment.storyArc = generated.story_arc;
        enrichment.aiReasoning = generated.reasoning;

        console.log(`[ActionExecutor] Pre-generated: "${generated.message.slice(0, 80)}..." (arc: ${generated.story_arc})`);
      } catch (err) {
        console.error(`[ActionExecutor] Pre-approval generation failed for ${batchId}: ${err.message}`);
        enrichment.generatedMessage = null;
        enrichment.aiGenerationError = err.message;
      }
    }

    await sendApprovalRequest(actions, name, phone, enrichment).catch(err => {
      console.error(`[ActionExecutor] Approval request failed for batch ${batchId}:`, err.message);
    });
  }

  return approvalActions.length;
}
