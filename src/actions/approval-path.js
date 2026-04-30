/**
 * Approval Path — src/actions/approval-path.js
 *
 * The GroupMe approval pipeline — isolated so future tuning of pre-gen,
 * trigger-message resolution, or head-of-line behavior stays a small,
 * focused edit. Extracted from action-executor.js v4.2 refactor.
 *
 * v4.7 (2026-04-30) — AUTO-EXECUTE book_appointment companion actions.
 *   Mark's ask: when the AI emits companion_action: book_appointment, the
 *   booking should fire IMMEDIATELY without waiting for GroupMe approval.
 *   The verbal-confirmation send_message in the same batch still goes
 *   through approval (still want a human eye on outbound copy until the
 *   responder is widely trusted), but the actual GHL Calendar write
 *   doesn't waste an approval cycle.
 *
 *   Why this is safe to auto-execute:
 *   1. response-generator.js v2.7.6 only emits a companion_action when
 *      the lead has hard-confirmed a SPECIFIC time previously offered by
 *      the bot — not on a vague "yes" or "ok"
 *   2. validateResponse already drops companions with past dates, missing
 *      fields, malformed start_time, or unknown calendar_name (v1.8 fix)
 *   3. The booking action's idempotency is handled by GHL — duplicate
 *      bookings on the same calendar/contact/start_time are rejected
 *   4. If the booking does fail (rate limit, slot conflict), the failure
 *      surfaces on the action row and Mark sees it in the action audit.
 *      The verbal-confirm SMS is still gated on his approval, so he can
 *      reject the SMS if he sees a failed book_appointment in the card.
 *
 *   Implementation: a single COMPANION_AUTO_EXECUTE allowlist controls
 *   which companion types skip approval. Today: just 'book_appointment'.
 *   Future companion types default to the v4.6 approval-gated path until
 *   explicitly added to the allowlist.
 *
 *   Card behavior: the auto-executing companion is NOT pushed into the
 *   batch's `actions` array (the card aggregator only displays
 *   approval-gated rows), but the companion details are still surfaced
 *   via enrichment.companionAction so the card can render an "AUTO-BOOK
 *   QUEUED" line. groupme.js can read that field and display it however
 *   it wants. (If groupme.js ignores it, no harm — the booking still
 *   fires; the card just doesn't mention it.)
 *
 *   Phase 2 of the executor picks the auto-execute companion up on the
 *   very next cycle — the same heartbeat that processed Phase 1
 *   (approval queue) above. Typical lag: <500ms.
 *
 * v4.6 (2026-04-29) — COMPANION_ACTION INSERTION (auto-book on hard confirm).
 *   Pairs with response-generator.js v2.7.6 which can now emit a top-level
 *   companion_action field (currently only book_appointment). When the
 *   pre-generation result includes companion_action, this approval-path
 *   inserts a sibling agent_action into the same batch_id BEFORE sending
 *   the GroupMe approval card. The card therefore shows BOTH the verbal
 *   confirmation send_message AND the auto-book — Mark approves once,
 *   both fire together.  (NOTE: superseded by v4.7 for book_appointment;
 *   the companion now auto-executes instead of joining the approval card.)
 *
 *   Insertion shape (v4.6):
 *     - event_id: same as the parent send_message action
 *     - target_system: 'ghl' (book_appointment hits GHL Calendar API)
 *     - target_entity: 'contact'
 *     - target_id: same contact
 *     - action_type: companion_action.action_type ('book_appointment')
 *     - action_payload: companion_action.action_payload (validated by
 *       response-generator.validateResponse — past dates, missing fields,
 *       and bad calendar names are dropped before this code sees them)
 *     - reasoning: companion_action.reasoning (extraction trace)
 *     - confidence: 1.0
 *     - rule_applied: same as parent (e.g. AGENTIC_RESPOND_POST_CHATBOT)
 *     - status: 'pending_approval' (same gate as parent) [v4.7: 'pending'
 *       for auto-execute types]
 *     - requires_approval: true [v4.7: false for auto-execute types]
 *     - batch_id: same batch_id (so approval-card aggregation works)
 *     - sequence_order: parent.sequence_order - 1 (so executor processes
 *       the booking BEFORE the verbal confirmation message; that way if
 *       the booking fails, we don't send a "locked in" message that
 *       wasn't actually locked in)
 *
 *   The approval card aggregator already iterates the full batch's
 *   actions, so adding this row before sendApprovalRequest is enough —
 *   no card-format changes needed in groupme.js.
 *
 *   If the companion_action insert fails (DB error), we log a warning
 *   and continue with the original verbal-confirm-only flow. Better to
 *   have a verbal confirmation without an auto-book than to block the
 *   whole batch.
 *
 * v4.5 (2026-04-28) — APPLY HANDOFF INLINE ON SHORT-CIRCUIT.
 *   PROBLEM: Under v4.4 the pre-gen short-circuit branch left the action
 *   queued and shipped an approval card that had NO message preview line
 *   (because makeShortCircuitResult sets message:null). Mark would see:
 *
 *     🔔 APPROVAL [#27239]
 *     🤖 AGENTIC RESPONSE
 *     👤 Mark Test (+19545081512)
 *     💬 "Can someone call me now?"
 *     🤖 Lead is persistently requesting immediate human contact...
 *     🎯 send_message: SMS reply | Tag: pause-workflow
 *     Reply: Yes 27239 or No 27239
 *
 *   No 📱 line. Nothing to actually approve. If Mark approved anyway,
 *   the runtime would call generateResponse() AGAIN, hit the gate AGAIN,
 *   and only THEN apply the handoff tag via handleShortCircuit. Two
 *   gate evaluations, one wasted approval cycle, and a misleading card
 *   that asked for review of a non-decision.
 *
 *   FIX: When pre-gen returns short_circuit:true, apply the handoff
 *   IMMEDIATELY at queue time:
 *     1. POST the handoff tag (and suppress-automation if disqualifier)
 *        to the GHL contact
 *     2. Mark every action in the batch as completed with a structured
 *        execution_result describing the handoff
 *     3. Send a 🛑 AGENTIC SHORT-CIRCUIT notice to GroupMe (informational,
 *        not an approval card)
 *     4. Skip sendApprovalRequest entirely for this batch
 *
 *   The runtime path in send-message-handler.handleShortCircuit becomes
 *   a no-op for these actions (they're already 'completed' before
 *   send-message-handler ever sees them) but stays in place as the
 *   canonical path for actions that bypass pre-generation (direct LP
 *   webhook send, n8n manual triggers, etc.).
 *
 *   Surfaced 2026-04-28 by Mark with contact 15Z6TaUK4WHBK1R4H64S asking
 *   "Can someone call me now?" — gate fired CALLBACK, blank approval
 *   card landed in GroupMe, Mark approved, runtime applied
 *   hdl:callback-request, no GHL workflow listened, conversation died.
 *
 * v4.4 (2026-04-28) — Two safety fixes for AGENTIC_* approvals:
 *   1. NULL-SAFE PREVIEW LOG (the `generated.message.slice(0,80)` log
 *      crashed when message:null due to a short-circuit).
 *   2. SHORT-CIRCUIT PASS-THROUGH (don't overwrite payload with null;
 *      let runtime regenerate). Superseded by v4.5 inline handoff above.
 *
 * v4.3 (2026-04-24) — Pre-generation searches the whole batch for the
 * send_message action instead of checking only actions[0].
 *
 * v4.2 — Pre-filter active tracking records to prevent head-of-line block.
 *
 * Paired with sql/008_approval_queue_ttl.sql (48h auto-expiry).
 */

import supabase from '../supabase.js';
import { sendApprovalRequest, sendGroupMeMessage } from '../groupme.js';
import { resolveContactInfo, resolveLPProspectId, getEventContext } from './resolvers.js';
import { buildNotificationEnrichment } from './enrichment.js';
import { acquireToken, report429 } from '../ghl-rate-limiter.js';
import { bumpContactCache } from '../context-builder.js';

const GHL_API_KEY = process.env.GHL_API_KEY || '';

// ═══════════════════════════════════════════════════════════════════
// v4.7: COMPANION AUTO-EXECUTE ALLOWLIST
// ═══════════════════════════════════════════════════════════════════
//
// Companion action types that SKIP approval and auto-execute via Phase 2
// of the executor. Today: book_appointment only. The AI emits companion
// book_appointment only when the lead hard-confirmed a previously-offered
// time and validateResponse cleared past-date / missing-field / unknown-
// calendar guards — that's a tighter trust window than the verbal-confirm
// SMS itself, so the booking fires immediately while the SMS still waits
// for human review.
//
// Add a type here only when the same trust argument applies: the AI must
// only emit it under a verifiable, narrow condition AND validateResponse
// must already screen for shape errors.
const COMPANION_AUTO_EXECUTE = new Set(['book_appointment']);

// ═══════════════════════════════════════════════════════════════════
// v4.5: INLINE HANDOFF HELPERS
// ═══════════════════════════════════════════════════════════════════

/**
 * POST tags to a contact using the additive endpoint. Mirrors the helper
 * in send-message-handler.js so we don't need a circular import. Returns
 * true on success, false on failure (logged).
 */
async function applyContactTagsInline(contactId, tagList) {
  if (!contactId || !Array.isArray(tagList) || tagList.length === 0) return false;
  if (!GHL_API_KEY) return false;
  const filtered = tagList.filter(t => typeof t === 'string' && t.length > 0);
  if (filtered.length === 0) return false;

  try {
    await acquireToken();
    const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-07-28',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ tags: filtered }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 429) {
      report429();
      console.warn(`[ApprovalPath] applyContactTagsInline 429 for ${contactId}`);
      return false;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[ApprovalPath] applyContactTagsInline ${res.status}: ${text.slice(0, 150)}`);
      return false;
    }
    bumpContactCache(contactId);
    return true;
  } catch (err) {
    console.warn(`[ApprovalPath] applyContactTagsInline threw: ${err.message}`);
    return false;
  }
}

/**
 * v4.5 — Inline handoff. Replaces the approval-card-then-runtime path
 * for short-circuited send_message actions. Applies the handoff tag(s)
 * directly, marks every action in the batch as 'completed' with an
 * execution_result that mirrors send-message-handler.handleShortCircuit's
 * shape, and sends an informational notice to GroupMe.
 *
 * Returns the count of actions completed for stats.
 */
async function applyHandoffInline({
  contactId,
  batchActions,
  generated,
  contactName,
  contactPhone,
  triggerMessage,
}) {
  const handoffTag = generated.handoff_tag || null;
  const isDQ = !!generated.is_disqualifier;
  const tagsToApply = [];
  if (handoffTag) tagsToApply.push(handoffTag);
  if (isDQ) tagsToApply.push('suppress-automation');

  let tagApplied = false;
  if (tagsToApply.length > 0) {
    tagApplied = await applyContactTagsInline(contactId, tagsToApply);
  }

  // Mark every action in the batch completed. add_tag actions in the batch
  // (e.g. pause-workflow) are intentionally also marked complete because
  // the agentic system has decided this lead is being handed off — the
  // pause-workflow tag is no longer the right side effect (the GHL workflow
  // listening on handoffTag will own state from here). If a future rule
  // wants pause-workflow to apply alongside a handoff, add it to the
  // tagsToApply list above explicitly.
  const completedAt = new Date().toISOString();
  const sharedResult = {
    action: 'send_message_handed_off_inline',
    reason: 'compliance_gate_handoff',
    contact_id: contactId,
    handoff_tag: handoffTag,
    handler_code: generated.handler_code || null,
    intent_class: generated.intent_class || null,
    bucket_type: generated.bucket_type || null,
    is_disqualifier: isDQ,
    tags_applied: tagApplied ? tagsToApply : [],
    classification_method: generated.classification_method || null,
    classifier_confidence: generated.classifier_confidence ?? null,
    applied_at: 'queue_time_v4_5',
  };

  const actionIds = batchActions.map(a => a.id);
  await supabase
    .from('agent_actions')
    .update({
      status: 'completed',
      executed_at: completedAt,
      approved_by: 'auto_handoff_pregeneration',
      execution_result: sharedResult,
      updated_at: completedAt,
    })
    .in('id', actionIds);

  // GroupMe informational notice — same format as
  // send-message-handler.handleShortCircuit so the human signal is
  // identical regardless of which path applied the tag.
  const dqLabel = isDQ ? ' [DISQUALIFIER]' : '';
  const tagSummary = tagsToApply.join(', ') || 'none';
  const preview = (triggerMessage || '').slice(0, 120);
  const displayName = contactName ? `${contactName}${contactPhone ? ` (${contactPhone})` : ''}` : contactId;

  await sendGroupMeMessage(
    `🛑 AGENTIC SHORT-CIRCUIT${dqLabel} (queue-time)\n` +
    `👤 ${displayName}\n` +
    `Intent: ${generated.intent_class || 'unknown'}` +
    (generated.handler_code ? ` (${generated.handler_code})` : '') + `\n` +
    `Tags applied: ${tagSummary}${tagApplied ? '' : ' [TAG WRITE FAILED]'}\n` +
    `Method: ${generated.classification_method || 'unknown'} (${(generated.classifier_confidence ?? 0).toFixed(2)})\n` +
    `Inbound: "${preview}"\n` +
    `→ GHL workflow on tag now owns the response. No approval card sent (nothing for human to review — handoff is mechanical).`
  ).catch(err => {
    console.warn(`[ApprovalPath] GroupMe (inline short-circuit) failed: ${err.message}`);
  });

  console.log(`[ApprovalPath] 🛑 INLINE HANDOFF: ${contactId} → ${tagSummary} ` +
    `(intent: ${generated.intent_class}, ${batchActions.length} actions completed, no approval card)`);

  return actionIds.length;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN — APPROVAL QUEUE PROCESSOR
// ═══════════════════════════════════════════════════════════════════

/**
 * Process the pending_approval queue. Returns the number of approval
 * requests sent this cycle for stats reporting (does not include
 * inline-handoff batches that bypassed the approval card).
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

  let cardsSent = 0;
  let inlineHandoffs = 0;

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
    // only actions[0] misses the generation trigger.
    const sendAction = actions.find(
      a => a.action_type === 'send_message' && a.action_payload?.requires_ai_generation
    );

    let inlineHandoffApplied = false;

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

        if (generated.short_circuit) {
          // ── v4.5: APPLY HANDOFF INLINE — no approval card, no runtime gate.
          console.log(`[ActionExecutor] Pre-gen short-circuit (intent: ${generated.intent_class}, ` +
                      `handler: ${generated.handler_code || 'n/a'}, ` +
                      `tag: ${generated.handoff_tag || 'none'}). ` +
                      `Applying handoff INLINE — skipping approval card.`);

          const completedCount = await applyHandoffInline({
            contactId: sendAction.target_id,
            batchActions: actions,
            generated,
            contactName: name,
            contactPhone: phone,
            triggerMessage,
          });
          inlineHandoffs += completedCount > 0 ? 1 : 0;
          inlineHandoffApplied = true;
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

          // ── v4.6: COMPANION_ACTION INSERTION ──────────────────────
          // If response-generator emitted a companion_action (e.g.
          // book_appointment for hard-confirmed held times), insert it
          // as a sibling row in the same batch.
          //
          // v4.7: book_appointment companions auto-execute (status:
          // 'pending', requires_approval: false) — Phase 2 of the
          // executor will pick them up on the same heartbeat that
          // processed this approval queue. Future companion types
          // default to the v4.6 approval-gated path unless added to
          // COMPANION_AUTO_EXECUTE.
          //
          // The companion was already shape-validated by validateResponse
          // (past-date guard, ISO format, calendar_name presence) — if
          // it's truthy here, it's safe to persist.
          if (generated.companion_action && generated.companion_action.action_type) {
            const companion = generated.companion_action;
            const parentSeq = typeof sendAction.sequence_order === 'number' ? sendAction.sequence_order : 0;
            const isAutoExecuting = COMPANION_AUTO_EXECUTE.has(companion.action_type);
            try {
              const { data: companionRow, error: companionErr } = await supabase
                .from('agent_actions')
                .insert({
                  event_id: sendAction.event_id,
                  action_type: companion.action_type,
                  target_system: 'ghl',
                  target_entity: 'contact',
                  target_id: sendAction.target_id,
                  action_payload: companion.action_payload,
                  reasoning: companion.reasoning
                    ? `Companion to send_message ${sendAction.id}: ${companion.reasoning}`
                    : `Companion to send_message ${sendAction.id} (${sendAction.rule_applied || 'manual'})`,
                  confidence: 1.0,
                  rule_applied: sendAction.rule_applied,
                  // v4.7: auto-execute types skip approval; everything
                  // else stays approval-gated as in v4.6.
                  status: isAutoExecuting ? 'pending' : 'pending_approval',
                  requires_approval: !isAutoExecuting,
                  batch_id: sendAction.batch_id,
                  // sequence_order = parentSeq - 1 keeps the booking
                  // ahead of the verbal-confirm SMS in the batch order.
                  // Under v4.7 auto-execute the SMS is in a different
                  // status anyway (pending_approval vs pending), but
                  // keeping the order correct preserves intent for
                  // future approval-gated companions.
                  sequence_order: parentSeq - 1,
                })
                .select()
                .single();

              if (companionErr) {
                console.warn(`[ActionExecutor] Companion insert failed for batch ${batchId}: ${companionErr.message} — proceeding without companion`);
              } else if (companionRow) {
                // v4.7: Only push approval-gated companions into the
                // batch's actions[] array. Auto-executing companions
                // are picked up by Phase 2 directly and shouldn't
                // appear as approval-card line items.
                if (!isAutoExecuting) {
                  actions.push(companionRow);
                  // Sort by sequence_order so the card displays in execution order.
                  actions.sort((a, b) => (a.sequence_order ?? 0) - (b.sequence_order ?? 0));
                }

                console.log(`[ActionExecutor] ✅ Companion ${companion.action_type} inserted: id=${companionRow.id}, batch=${batchId}, seq=${companionRow.sequence_order}, ` +
                  `mode=${isAutoExecuting ? 'AUTO-EXECUTE' : 'approval-gated'}, ` +
                  `payload.calendar_name="${companion.action_payload?.calendar_name || 'n/a'}", ` +
                  `payload.start_time="${companion.action_payload?.start_time || 'n/a'}"`);

                // Surface companion details in enrichment for the approval card.
                // Even auto-executing companions get surfaced — the card can
                // render an "AUTO-BOOK QUEUED" line for human visibility.
                enrichment.companionAction = {
                  type: companion.action_type,
                  calendar_name: companion.action_payload?.calendar_name || null,
                  start_time: companion.action_payload?.start_time || null,
                  duration_minutes: companion.action_payload?.duration_minutes || null,
                  reasoning: companion.reasoning || null,
                  auto_executing: isAutoExecuting,
                };
              }
            } catch (insertErr) {
              console.warn(`[ActionExecutor] Companion insert threw for batch ${batchId}: ${insertErr.message} — proceeding without companion`);
            }
          }
        }
      } catch (err) {
        console.error(`[ActionExecutor] Pre-approval generation failed for ${batchId}: ${err.message}`);
        enrichment.generatedMessage = null;
        enrichment.aiGenerationError = err.message;
        // Fall through to send the approval card with the error surfaced.
      }
    }

    // Skip the approval card entirely if v4.5 inline handoff already
    // resolved this batch.
    if (inlineHandoffApplied) continue;

    await sendApprovalRequest(actions, name, phone, enrichment).catch(err => {
      console.error(`[ActionExecutor] Approval request failed for batch ${batchId}:`, err.message);
    });
    cardsSent++;
  }

  if (inlineHandoffs > 0) {
    console.log(`[ApprovalPath] Cycle: ${cardsSent} cards sent, ${inlineHandoffs} inline handoffs (no card)`);
  }

  return cardsSent;
}
