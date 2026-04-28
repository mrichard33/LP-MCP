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
 * v4.3 (2026-04-24) — Pre-generation now searches the batch for the
 * send_message action instead of checking only actions[0]. Rules that
 * emit multiple actions (e.g. AGENTIC_RESPOND_POST_CHATBOT emits
 * [add_tag pause-bot, send_message]) put send_message at index 1, so the
 * firstAction check never matched and cards shipped to GroupMe without the
 * 📱 AI response preview line. Now we find the send_message action by
 * action_type and pre-generate for it specifically.
 *
 * v4.4 (2026-04-28) — Two safety fixes for AGENTIC_* approvals:
 *
 *   1. NULL-SAFE PREVIEW LOG. The hot-path log
 *        console.log(`...${generated.message.slice(0, 80)}...`)
 *      crashed with "Cannot read properties of null (reading 'slice')"
 *      whenever generateResponse returned short_circuit:true (because
 *      makeShortCircuitResult sets message:null deliberately). The
 *      crash was caught by the outer try/catch and surfaced to GroupMe
 *      as "AI generation failed: Cannot read properties of null", which
 *      misleadingly suggested an upstream model error.
 *
 *   2. SHORT-CIRCUIT PASS-THROUGH. When generateResponse returns
 *      short_circuit:true (a compliance/intent gate fired — STOP,
 *      WHO_IS_THIS, ANGRY, RENTER, etc.), we MUST NOT overwrite
 *      action_payload.message with null and flip pre_generated:true.
 *      Doing so produces an action that runtime can't actually send
 *      ("No message text after AI generation") and leaves the contact
 *      stuck. Instead we leave the action untouched
 *      (requires_ai_generation:true), so when send-message-handler
 *      executes it, generateResponse short-circuits again at runtime
 *      and handleShortCircuit applies the correct handoff tag, sets
 *      suppress-automation if disqualifier, and notifies GroupMe with
 *      a 🛑 short-circuit card.
 *
 *      The card we send NOW (at approval time) shows the gate context
 *      so the human reviewer sees what's about to happen — but we
 *      don't try to "approve a null message".
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

    // v4.3 — Search the whole batch for a send_message action that needs
    // pre-generation. Rules like AGENTIC_RESPOND_POST_CHATBOT emit
    // [add_tag pause-bot (index 0), send_message (index 1)], so checking
    // only actions[0] misses the generation trigger. The card then ships
    // without the 📱 "..." preview line even though the payload asks for
    // AI generation.
    const sendAction = actions.find(
      a => a.action_type === 'send_message' && a.action_payload?.requires_ai_generation
    );

    if (sendAction) {
      try {
        const { generateResponse } = await import('../response-generator.js');
        // v4.2 — message_preview is the canonical inbound field on
        // ai.analysis_completed events (what AGENTIC_* rules fire on).
        // Still accept message_text/messageText/body from ghl.reply_received
        // and other event shapes.
        const triggerMessage = ctx.message_text || ctx.messageText || ctx.body || ctx.message_preview || 'No trigger message';
        const channel = sendAction.action_payload?.channel || 'sms';

        console.log(`[ActionExecutor] Pre-generating AI response for approval ${batchId} (send_message action ${sendAction.id})`);
        const generated = await generateResponse(sendAction.target_id, channel, triggerMessage);

        // ── v4.4: SHORT-CIRCUIT PASS-THROUGH ─────────────────────
        // If a compliance/intent gate fired, message is null by design.
        // Do NOT overwrite action_payload — leave requires_ai_generation:true
        // so the runtime handler regenerates and applies the proper handoff
        // tag via send-message-handler.handleShortCircuit().
        if (generated.short_circuit) {
          console.log(`[ActionExecutor] Pre-gen short-circuit (intent: ${generated.intent_class}, ` +
                      `handler: ${generated.handler_code || 'n/a'}, ` +
                      `tag: ${generated.handoff_tag || 'none'}). ` +
                      `Action ${sendAction.id} left as-is — runtime will apply handoff.`);

          enrichment.generatedMessage = null;
          enrichment.shortCircuit = true;
          enrichment.intentClass = generated.intent_class || null;
          enrichment.handlerCode = generated.handler_code || null;
          enrichment.handoffTag = generated.handoff_tag || null;
          enrichment.isDisqualifier = !!generated.is_disqualifier;
          enrichment.classifierMethod = generated.classification_method || null;
          enrichment.classifierConfidence = generated.classifier_confidence ?? null;
          enrichment.aiReasoning = `Compliance gate: ${generated.intent_class}` +
            (generated.handoff_tag ? ` → tag ${generated.handoff_tag}` : '');
        } else {
          // Normal generation — pre-fill the action payload so the human
          // can preview-and-approve before runtime sends.
          const updatedPayload = {
            ...sendAction.action_payload,
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
            .eq('id', sendAction.id);

          enrichment.generatedMessage = generated.message;
          enrichment.storyArc = generated.story_arc;
          enrichment.aiReasoning = generated.reasoning;

          // v4.4: null-safe preview log (was: generated.message.slice(0,80))
          const preview = typeof generated.message === 'string'
            ? generated.message.slice(0, 80)
            : '(no message)';
          console.log(`[ActionExecutor] Pre-generated: "${preview}..." (arc: ${generated.story_arc || 'n/a'})`);
        }
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
