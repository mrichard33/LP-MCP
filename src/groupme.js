/**
 * GroupMe Integration — src/groupme.js
 *
 * Two-way GroupMe integration for the agentic system:
 *   1. OUTBOUND: Send notifications and approval requests to GroupMe
 *   2. INBOUND:  Receive replies via callback webhook, match to pending actions
 *
 * Approval flow (v1.6):
 *   - Action created with requires_approval=true
 *   - Bot posts approval request with action ID
 *   - User replies with one of:
 *       "Yes 1234"          → approve & queue execution
 *       "No 1234"           → reject
 *       "Edit 1234 <desc>"  → AI rewrites with the description as guidance
 *
 * v1.6 — EDIT X COMMAND + IN-CONTEXT LEARNING LOOP (2026-04-29).
 *   New third option on every approval card: `Edit <ref> <description>`.
 *   When fired:
 *     1. Look up the pending approval and its send_message action
 *     2. Pull the original triggerMessage from the system_events row
 *     3. Call generateResponse() with opts.editInstruction + opts.previousMessage
 *        — response-generator v2.7.4 injects a HUMAN CORRECTION block into
 *        the user prompt so the model rewrites with the correction applied
 *     4. UPDATE the agent_actions row's payload.message with the new text
 *     5. INSERT into agent_response_edits — this row becomes a future
 *        in-context learning example for ALL responses with the same
 *        intent_class. Continuous self-improvement, no fine-tuning.
 *     6. Archive the old groupme_approval_requests row (suffix the
 *        short_ref to free it) and send a fresh approval card with the
 *        original short_ref. Mark can keep editing (recursive) or approve.
 *
 *   The footer line on every approval card now reads:
 *     Reply: Yes 1234  •  No 1234  •  Edit 1234 <describe change>
 *
 * v1.5 — INSERT-FIRST DEDUP (2026-04-29).
 *   Closes the parallel-card race surfaced on action #28144. The
 *   tracking record is now claimed BEFORE the GroupMe send, using the
 *   unique constraint on short_ref to serialize concurrent workers.
 *
 * v1.4 — Zombie-proof tracking (superseded by v1.5).
 * v1.3 — Auto-execute after approval.
 * v1.2 — Enriched approval requests with full decision context.
 * v1.1 — Fix: rejection uses status='rejected' (was 'cancelled').
 *
 * Routes:
 *   POST /webhook/groupme — Callback URL for GroupMe bot
 *   POST /groupme/send    — Manual send (for testing)
 *   GET  /groupme/pending — View pending approval requests
 */

import supabase from './supabase.js';
import { generateResponse } from './response-generator.js';

const GROUPME_BOT_ID = process.env.GROUPME_BOT_ID || '';
const GROUPME_GROUP_ID = process.env.GROUPME_GROUP_ID || '';
const SELF_BASE_URL = `http://localhost:${process.env.PORT || 8080}`;

// ═══════════════════════════════════════════════════════════════════
// OUTBOUND: Send messages to GroupMe
// ═══════════════════════════════════════════════════════════════════

export async function sendGroupMeMessage(text) {
  if (!GROUPME_BOT_ID) {
    console.log('[GroupMe] No BOT_ID — message logged only:', text.slice(0, 100));
    return { sent: false, reason: 'no_bot_id' };
  }
  try {
    const res = await fetch('https://api.groupme.com/v3/bots/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot_id: GROUPME_BOT_ID, text: text.slice(0, 1000) }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[GroupMe] POST failed: ${res.status} ${body.slice(0, 200)}`);
      return { sent: false, reason: `http_${res.status}` };
    }
    return { sent: true };
  } catch (err) {
    console.error('[GroupMe] Send failed:', err.message);
    return { sent: false, reason: err.message };
  }
}

// ═══════════════════════════════════════════════════════════════════
// v1.3: AUTO-EXECUTE AFTER APPROVAL
// ═══════════════════════════════════════════════════════════════════

async function triggerExecution() {
  try {
    const res = await fetch(`${SELF_BASE_URL}/n8n/decision-engine/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 10 }),
      signal: AbortSignal.timeout(60000),
    });
    if (res.ok) {
      const data = await res.json();
      console.log(`[GroupMe] Auto-execute after approval: ${data.actions_executed || 0} executed, ${data.completed || 0} completed (${data.elapsed_ms || 0}ms)`);
    } else {
      console.warn(`[GroupMe] Auto-execute failed: HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn(`[GroupMe] Auto-execute error: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// ENRICHED APPROVAL REQUEST FORMAT (v1.2)
// ═══════════════════════════════════════════════════════════════════

const RULE_DISPLAY_NAMES = {
  'BEHAVIORAL_FAST_TRACK':        '🔥 AI FAST-TRACK',
  'BEHAVIORAL_SPOUSE_OBJECTION':  '💑 SPOUSE OBJECTION',
  'BEHAVIORAL_PRICE_OBJECTION':   '💰 PRICE OBJECTION',
  'BEHAVIORAL_TIMING_OBJECTION':  '⏰ TIMING OBJECTION',
  'BEHAVIORAL_TRUST_OBJECTION':   '🛡️ TRUST OBJECTION',
  'BEHAVIORAL_COMPETITOR_OBJECTION': '⚔️ COMPETITOR OBJECTION',
  'BEHAVIORAL_DIY_OBJECTION':     '🔧 DIY OBJECTION',
  'BEHAVIORAL_DISENGAGEMENT':     '📉 DISENGAGEMENT',
  'BEHAVIORAL_ESCALATE_REP':      '🚨 REP ESCALATION',
  'BEHAVIORAL_DNC_REPLY':         '🚫 DNC REPLY',
  'AGENTIC_RESPOND_POST_CHATBOT': '🤖 AGENTIC RESPONSE',
};

function formatActionSummary(actions) {
  const parts = [];
  for (const a of actions) {
    if (a.action_type === 'add_tag') parts.push(`Tag: ${a.action_payload?.tag}`);
    else if (a.action_type === 'remove_tag') {
      const tags = a.action_payload?.tags || [a.action_payload?.tag];
      parts.push(`Remove: ${tags.join(', ')}`);
    }
    else if (a.action_type === 'move_opportunity') parts.push(`Pipeline → ${a.action_payload?.pipeline} ${a.action_payload?.stage}`);
    else if (a.action_type === 'remove_from_workflow') parts.push('Remove from workflow');
    else if (a.action_type === 'create_task') parts.push(`Task: ${(a.action_payload?.title || '').slice(0, 60)}`);
    else if (a.action_type === 'send_notification') parts.push('Notify');
    else if (a.action_type === 'send_message') parts.push(`send_message: ${(a.action_payload?.channel || 'SMS').toUpperCase()} reply`);
    else parts.push(a.action_type);
  }
  return parts.join(' | ');
}

// v1.6: standardized footer line so all approval cards advertise the
// Yes / No / Edit options consistently.
function approvalFooter(shortRef) {
  return `Reply: Yes ${shortRef}  •  No ${shortRef}  •  Edit ${shortRef} <describe change>`;
}

/**
 * v1.5 — Insert-first dedup. Claim the batch by inserting the tracking
 * record BEFORE sending the GroupMe message.
 * v1.6 — Footer line now advertises Edit X option.
 */
export async function sendApprovalRequest(batchActions, contactName, contactPhone, enrichment = {}) {
  if (!batchActions?.length) return;

  const first = batchActions[0];
  const batchId = first.batch_id || `s_${first.id}`;
  const shortRef = String(first.id);

  const ruleName = RULE_DISPLAY_NAMES[first.rule_applied] || first.rule_applied;
  const actionSummary = formatActionSummary(batchActions);

  const lines = [];
  lines.push(`🔔 APPROVAL [#${shortRef}]`);
  lines.push(`${ruleName}`);
  lines.push(`👤 ${contactName || 'Unknown'}${contactPhone ? ` (${contactPhone})` : ''}`);

  if (enrichment.messageText) {
    const msg = enrichment.messageText.slice(0, 200);
    lines.push(`💬 "${msg}"${enrichment.messageType ? ` [${enrichment.messageType}]` : ''}`);
  }

  const lpParts = [];
  if (enrichment.lpSource) lpParts.push(`Src: ${enrichment.lpSource}`);
  if (enrichment.repName) lpParts.push(`Rep: ${enrichment.repName}`);
  if (enrichment.disposition) lpParts.push(`Disp: ${enrichment.disposition}`);
  if (enrichment.prospectId && enrichment.prospectId !== 'Not in LP') lpParts.push(`Prospect: ${enrichment.prospectId}`);
  if (lpParts.length > 0) lines.push(`📋 ${lpParts.join(' | ')}`);

  if (enrichment.score || enrichment.tier) {
    const intentParts = [];
    if (enrichment.score) intentParts.push(`Score: ${enrichment.score}`);
    if (enrichment.tier) intentParts.push(`Tier: ${enrichment.tier}`);
    if (enrichment.barrier) intentParts.push(`Barrier: ${enrichment.barrier}`);
    lines.push(`📊 ${intentParts.join(' | ')}`);
  }

  if (enrichment.aiSummary) {
    lines.push(`🤖 ${enrichment.aiSummary.slice(0, 150)}`);
  }

  lines.push(`🎯 ${actionSummary}`);

  if (enrichment.generatedMessage) {
    lines.push(`📱 "${enrichment.generatedMessage}"`);
  } else if (enrichment.aiGenerationError) {
    lines.push(`⚠️ AI generation failed: ${enrichment.aiGenerationError.slice(0, 100)}`);
  }

  lines.push('');
  lines.push(approvalFooter(shortRef));

  const msg = lines.join('\n');

  // v1.5: INSERT-FIRST DEDUP
  const { error: claimErr } = await supabase
    .from('groupme_approval_requests')
    .insert({
      short_ref: shortRef,
      batch_id: batchId,
      action_ids: batchActions.map(a => a.id),
      rule_applied: first.rule_applied,
      target_id: first.target_id,
      contact_name: contactName || null,
      status: 'pending',
      requested_at: new Date().toISOString(),
    });

  if (claimErr) {
    if (claimErr.code === '23505') {
      console.log(`[GroupMe] Batch ${batchId} (#${shortRef}) already claimed by another worker — skipping duplicate send`);
      return;
    }
    throw new Error(`Failed to claim approval batch ${batchId}: ${claimErr.message}`);
  }

  const sendResult = await sendGroupMeMessage(msg);
  if (!sendResult?.sent) {
    await supabase
      .from('groupme_approval_requests')
      .delete()
      .eq('short_ref', shortRef)
      .catch(err => {
        console.warn(`[GroupMe] Failed to release claim for ${shortRef} after send failure: ${err.message}`);
      });
    throw new Error(`GroupMe delivery failed: ${sendResult?.reason || 'unknown'} — claim released, batch ${batchId} can retry next heartbeat`);
  }

  console.log(`[GroupMe] Approval request sent: #${shortRef} (${first.rule_applied}, ${batchActions.length} actions)`);
}

// ═══════════════════════════════════════════════════════════════════
// v1.6 — EDIT HANDLER + REGENERATED CARD SENDER
// ═══════════════════════════════════════════════════════════════════

/**
 * Resolve the original inbound message that triggered this approval batch.
 * Looks at system_events.event_data first; falls back to null.
 */
async function resolveTriggerMessage(eventId) {
  if (!eventId) return null;
  try {
    const { data, error } = await supabase
      .from('system_events')
      .select('event_data')
      .eq('id', eventId)
      .maybeSingle();
    if (error) {
      console.warn(`[GroupMe] resolveTriggerMessage: system_events lookup error: ${error.message}`);
      return null;
    }
    const ed = data?.event_data || {};
    return ed.message_text || ed.messageText || ed.text || ed.body || null;
  } catch (err) {
    console.warn(`[GroupMe] resolveTriggerMessage threw: ${err.message}`);
    return null;
  }
}

/**
 * Send a fresh approval card AFTER an Edit X regeneration. Uses the same
 * short_ref as the original card (caller must have already archived the
 * old groupme_approval_requests row, freeing the short_ref). Inserts a
 * new tracking row using the v1.5 INSERT-FIRST pattern.
 */
async function sendRegeneratedApprovalCard({
  request, batchActions, newMessage, editInstruction, senderName, shortRef,
}) {
  const ruleName = RULE_DISPLAY_NAMES[request.rule_applied] || request.rule_applied;
  const actionSummary = formatActionSummary(batchActions);

  const lines = [];
  lines.push(`🔄 EDITED [#${shortRef}] (by ${senderName})`);
  lines.push(`${ruleName}`);
  lines.push(`👤 ${request.contact_name || 'Unknown'}`);
  lines.push(`✏️ Edit: "${editInstruction.slice(0, 200)}"`);
  lines.push(`🎯 ${actionSummary}`);
  lines.push(`📱 "${newMessage}"`);
  lines.push('');
  lines.push(approvalFooter(shortRef));

  const msg = lines.join('\n');

  // v1.5 INSERT-FIRST claim (caller already freed the original short_ref)
  const { error: claimErr } = await supabase
    .from('groupme_approval_requests')
    .insert({
      short_ref: shortRef,
      batch_id: request.batch_id,
      action_ids: request.action_ids,
      rule_applied: request.rule_applied,
      target_id: request.target_id,
      contact_name: request.contact_name,
      status: 'pending',
      requested_at: new Date().toISOString(),
    });

  if (claimErr) {
    if (claimErr.code === '23505') {
      console.warn(`[GroupMe] Edit re-card: short_ref ${shortRef} unexpectedly already claimed — archive may have failed. Skipping.`);
      return false;
    }
    throw new Error(`Failed to claim regenerated approval ${shortRef}: ${claimErr.message}`);
  }

  const sendResult = await sendGroupMeMessage(msg);
  if (!sendResult?.sent) {
    await supabase.from('groupme_approval_requests').delete().eq('short_ref', shortRef).catch(() => {});
    throw new Error(`Edit GroupMe send failed: ${sendResult?.reason || 'unknown'}`);
  }

  return true;
}

/**
 * Handle "Edit <shortRef> <description>" command.
 *
 * Flow:
 *   1. Look up pending approval by short_ref
 *   2. Find the send_message action and its current payload
 *   3. Resolve the original triggerMessage from system_events
 *   4. Call generateResponse with opts.editInstruction + opts.previousMessage
 *   5. Update agent_actions.action_payload with the new message
 *   6. Insert into agent_response_edits (continuous self-improvement loop)
 *   7. Archive the old approval row (suffix short_ref) so the original
 *      short_ref is free
 *   8. Send a fresh "🔄 EDITED" card with the original short_ref
 *
 * Mark can edit again (recursive) or Yes/No the new card.
 */
async function editApprovalRequest(shortRef, editInstruction, senderName) {
  // 1. Look up the pending approval
  const { data: request, error: reqErr } = await supabase
    .from('groupme_approval_requests')
    .select('*')
    .eq('short_ref', shortRef)
    .eq('status', 'pending')
    .maybeSingle();

  if (reqErr) {
    console.error(`[GroupMe] Edit lookup failed for #${shortRef}: ${reqErr.message}`);
    await sendGroupMeMessage(`❌ Edit error for #${shortRef}: ${reqErr.message.slice(0, 120)}`);
    return { handled: true, action: 'lookup_error', error: reqErr.message };
  }

  if (!request) {
    await sendGroupMeMessage(`❓ No pending approval for #${shortRef}. It may already be approved/rejected.`);
    return { handled: true, action: 'not_found', shortRef };
  }

  const actionIds = request.action_ids || [];

  // 2. Find the send_message action
  const { data: actions, error: actErr } = await supabase
    .from('agent_actions')
    .select('id, action_type, action_payload, target_id, event_id, rule_applied, batch_id')
    .in('id', actionIds);

  if (actErr) {
    console.error(`[GroupMe] Edit action fetch failed for #${shortRef}: ${actErr.message}`);
    await sendGroupMeMessage(`❌ Edit error for #${shortRef}: ${actErr.message.slice(0, 120)}`);
    return { handled: true, action: 'action_fetch_error', error: actErr.message };
  }

  const sendMsgAction = (actions || []).find(a => a.action_type === 'send_message');
  if (!sendMsgAction) {
    await sendGroupMeMessage(`❌ #${shortRef} has no send_message action to edit.`);
    return { handled: true, action: 'no_send_message' };
  }

  const previousMessage = sendMsgAction.action_payload?.message;
  const channel = String(sendMsgAction.action_payload?.channel || 'sms').toLowerCase();
  const contactId = sendMsgAction.target_id;

  if (!previousMessage) {
    await sendGroupMeMessage(`❌ #${shortRef} has no message to edit (action_payload.message is empty).`);
    return { handled: true, action: 'no_message' };
  }

  // 3. Resolve the original trigger message
  const triggerMessage = await resolveTriggerMessage(sendMsgAction.event_id);
  if (!triggerMessage) {
    await sendGroupMeMessage(`❌ Couldn't find the original inbound message for #${shortRef} (event_id ${sendMsgAction.event_id}). Reject and ask the lead to message again, or send manually.`);
    return { handled: true, action: 'no_trigger_message' };
  }

  // 4. Regenerate via response-generator v2.7.4 with edit context
  let regenerated;
  try {
    regenerated = await generateResponse(contactId, channel, triggerMessage, {
      editInstruction,
      previousMessage,
    });
  } catch (err) {
    console.error(`[GroupMe] Edit regenerate failed for #${shortRef}: ${err.message}`);
    await sendGroupMeMessage(`❌ Edit failed for #${shortRef}: ${err.message.slice(0, 200)}`);
    return { handled: true, action: 'regenerate_failed', error: err.message };
  }

  if (!regenerated || !regenerated.message) {
    await sendGroupMeMessage(`❌ Edit failed for #${shortRef}: regenerator returned no message.`);
    return { handled: true, action: 'no_regenerated_message' };
  }

  // 5. Update the agent_actions row's payload with the new message
  const newPayload = { ...sendMsgAction.action_payload, message: regenerated.message };
  const { error: updErr } = await supabase
    .from('agent_actions')
    .update({ action_payload: newPayload, updated_at: new Date().toISOString() })
    .eq('id', sendMsgAction.id);

  if (updErr) {
    console.error(`[GroupMe] Edit save failed for action ${sendMsgAction.id}: ${updErr.message}`);
    await sendGroupMeMessage(`❌ Edit generated but save failed for #${shortRef}: ${updErr.message.slice(0, 120)}`);
    return { handled: true, action: 'save_failed', error: updErr.message };
  }

  // 6. INSERT into agent_response_edits (continuous self-improvement)
  // Fire-and-forget — failure here doesn't break the flow
  supabase
    .from('agent_response_edits')
    .insert({
      action_id: sendMsgAction.id,
      ghl_contact_id: contactId,
      intent_class: regenerated.intent_class || null,
      classification_method: regenerated.classification_method || null,
      channel,
      buyer_stage: regenerated.buyer_stage || null,
      trigger_message: String(triggerMessage).slice(0, 2000),
      original_message: String(previousMessage).slice(0, 2000),
      edit_instruction: String(editInstruction).slice(0, 2000),
      final_message: String(regenerated.message).slice(0, 2000),
      booking_policy: regenerated.booking_policy || null,
      active_entry_tag: regenerated.active_entry_tag || null,
      edited_by: senderName,
    })
    .then(({ error }) => {
      if (error) {
        console.warn(`[GroupMe] Failed to log edit to agent_response_edits: ${error.message}`);
      } else {
        console.log(`[GroupMe] Logged edit for action ${sendMsgAction.id} to agent_response_edits (intent=${regenerated.intent_class})`);
      }
    });

  // 7. Archive old approval row — suffix short_ref to free the original
  const archivedShortRef = `${shortRef}_v${request.id}`;
  const { error: archErr } = await supabase
    .from('groupme_approval_requests')
    .update({
      short_ref: archivedShortRef,
      status: 'edited',
      resolved_by: senderName,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', request.id);

  if (archErr) {
    console.error(`[GroupMe] Edit archive failed for #${shortRef}: ${archErr.message}`);
    await sendGroupMeMessage(`⚠️ Edit applied to action but couldn't archive old card for #${shortRef}: ${archErr.message.slice(0, 100)}. Action payload was updated; please reject manually if the card is stale.`);
    return { handled: true, action: 'archive_failed', error: archErr.message };
  }

  // 8. Send the new card with the original short_ref (now free)
  try {
    await sendRegeneratedApprovalCard({
      request,
      batchActions: actions || [],
      newMessage: regenerated.message,
      editInstruction,
      senderName,
      shortRef,
    });
  } catch (err) {
    console.error(`[GroupMe] Edit re-card send failed for #${shortRef}: ${err.message}`);
    await sendGroupMeMessage(`⚠️ Edit applied but re-card send failed for #${shortRef}: ${err.message.slice(0, 120)}. The action payload was updated; check /groupme/pending.`);
    return { handled: true, action: 'recard_failed', error: err.message };
  }

  console.log(`[GroupMe] ✏️ Edit applied for #${shortRef} by ${senderName}: action=${sendMsgAction.id}, intent=${regenerated.intent_class}, ${regenerated.message.length} chars, edits_in_prompt=${regenerated.edits_used_in_prompt || 0}`);
  return {
    handled: true,
    action: 'edited',
    shortRef,
    actionCount: actionIds.length,
    intent: regenerated.intent_class,
    editsInPrompt: regenerated.edits_used_in_prompt || 0,
  };
}

// ═══════════════════════════════════════════════════════════════════
// INBOUND: Handle GroupMe callback webhook
// ═══════════════════════════════════════════════════════════════════

async function handleGroupMeCallback(payload) {
  if (payload.sender_type === 'bot') return { handled: false, reason: 'bot_message' };

  if (GROUPME_GROUP_ID && String(payload.group_id) !== GROUPME_GROUP_ID) {
    return { handled: false, reason: 'wrong_group' };
  }

  const text = (payload.text || '').trim();
  const senderName = payload.name || 'Unknown';

  // v1.6: Edit pattern checked FIRST (before approval pattern). Format:
  //   "Edit 1234 propose specific times not just days"
  // The description after the ID is captured greedily.
  const editMatch = text.match(/^edit\s+(\d+)\s+(.+)$/is);
  if (editMatch) {
    const shortRef = editMatch[1];
    const editInstruction = editMatch[2].trim();
    if (!editInstruction) {
      await sendGroupMeMessage(`❓ Edit ${shortRef} requires a description. Format: Edit ${shortRef} <describe what to change>`);
      return { handled: true, action: 'edit_no_description' };
    }
    console.log(`[GroupMe] Edit command for #${shortRef} by ${senderName}: "${editInstruction.slice(0, 100)}"`);
    return await editApprovalRequest(shortRef, editInstruction, senderName);
  }

  // Standard Yes/No approval pattern
  const approvalMatch = text.match(/^(yes|no|approve|reject|deny)\s+(\d+)\s*$/i);
  if (!approvalMatch) {
    console.log(`[GroupMe] Non-approval message from ${senderName}: "${text.slice(0, 50)}"`);
    return { handled: false, reason: 'not_approval_command' };
  }

  const decision = approvalMatch[1].toLowerCase();
  const shortRef = approvalMatch[2];
  const isApproved = ['yes', 'approve'].includes(decision);

  console.log(`[GroupMe] Approval ${isApproved ? 'YES' : 'NO'} for #${shortRef} by ${senderName}`);

  const { data: request } = await supabase
    .from('groupme_approval_requests')
    .select('*')
    .eq('short_ref', shortRef)
    .eq('status', 'pending')
    .maybeSingle();

  if (!request) {
    await sendGroupMeMessage(`❓ No pending approval found for #${shortRef}. It may have already been processed.`);
    return { handled: true, action: 'not_found', shortRef };
  }

  const actionIds = request.action_ids || [];

  if (isApproved) {
    const { error } = await supabase
      .from('agent_actions')
      .update({
        status: 'pending',
        approved_by: senderName.toLowerCase(),
        updated_at: new Date().toISOString(),
      })
      .in('id', actionIds)
      .eq('status', 'pending_approval');

    if (error) {
      console.error('[GroupMe] Approval update failed:', error.message);
      await sendGroupMeMessage(`❌ Error approving #${shortRef}: ${error.message}`);
      return { handled: true, action: 'error', error: error.message };
    }

    await supabase
      .from('groupme_approval_requests')
      .update({ status: 'approved', resolved_by: senderName, resolved_at: new Date().toISOString() })
      .eq('short_ref', shortRef);

    // v1.6: also retroactively mark any agent_response_edits rows for these
    // actions as approval_outcome='approved' so the in-context-learning
    // retrieval can prefer confirmed-good corrections.
    supabase
      .from('agent_response_edits')
      .update({
        approval_outcome: 'approved',
        approved_at: new Date().toISOString(),
      })
      .in('action_id', actionIds)
      .is('approval_outcome', null)
      .then(({ error: updErr }) => {
        if (updErr) console.warn(`[GroupMe] Failed to mark edits approved: ${updErr.message}`);
      });

    await sendGroupMeMessage(`✅ Approved #${shortRef} (${request.rule_applied}). ${actionIds.length} actions queued for execution.`);

    console.log(`[GroupMe] ✅ Batch approved: #${shortRef} — ${actionIds.length} actions by ${senderName}`);

    triggerExecution().catch(err => {
      console.warn(`[GroupMe] Auto-execute failed after approval: ${err.message}`);
    });

    return { handled: true, action: 'approved', shortRef, actionCount: actionIds.length };

  } else {
    const { error } = await supabase
      .from('agent_actions')
      .update({
        status: 'rejected',
        approved_by: senderName.toLowerCase(),
        error_message: `Rejected via GroupMe by ${senderName}`,
        updated_at: new Date().toISOString(),
      })
      .in('id', actionIds)
      .eq('status', 'pending_approval');

    if (error) {
      console.error('[GroupMe] Rejection update failed:', error.message);
      await sendGroupMeMessage(`❌ Error rejecting #${shortRef}: ${error.message}`);
      return { handled: true, action: 'error', error: error.message };
    }

    await supabase
      .from('groupme_approval_requests')
      .update({ status: 'rejected', resolved_by: senderName, resolved_at: new Date().toISOString() })
      .eq('short_ref', shortRef);

    // v1.6: mark related edits as rejected so they don't pollute the
    // in-context-learning corpus with corrections that were ultimately
    // judged wrong.
    supabase
      .from('agent_response_edits')
      .update({
        approval_outcome: 'rejected',
        approved_at: new Date().toISOString(),
      })
      .in('action_id', actionIds)
      .is('approval_outcome', null)
      .then(({ error: updErr }) => {
        if (updErr) console.warn(`[GroupMe] Failed to mark edits rejected: ${updErr.message}`);
      });

    await sendGroupMeMessage(`🚫 Rejected #${shortRef} (${request.rule_applied}). ${actionIds.length} actions cancelled.`);

    console.log(`[GroupMe] 🚫 Batch rejected: #${shortRef} — ${actionIds.length} actions by ${senderName}`);
    return { handled: true, action: 'rejected', shortRef, actionCount: actionIds.length };
  }
}

// ═══════════════════════════════════════════════════════════════════
// EXPRESS ROUTES
// ═══════════════════════════════════════════════════════════════════

export function registerGroupMeRoutes(app) {

  app.post('/webhook/groupme', async (req, res) => {
    res.status(200).json({ ok: true });
    try {
      await handleGroupMeCallback(req.body);
    } catch (err) {
      console.error('[GroupMe] Webhook error:', err.message);
    }
  });

  app.post('/groupme/send', async (req, res) => {
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });
    const result = await sendGroupMeMessage(message);
    res.json(result);
  });

  app.get('/groupme/pending', async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('groupme_approval_requests')
        .select('*')
        .eq('status', 'pending')
        .order('requested_at', { ascending: false })
        .limit(20);
      if (error) return res.status(500).json({ error: error.message });
      res.json({ count: data?.length || 0, requests: data || [] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  console.log('[GroupMe] Registered: POST /webhook/groupme | POST /groupme/send | GET /groupme/pending');
}
