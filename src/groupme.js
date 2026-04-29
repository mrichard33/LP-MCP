/**
 * GroupMe Integration — src/groupme.js
 *
 * Two-way GroupMe integration for the agentic system:
 *   1. OUTBOUND: Send notifications and approval requests to GroupMe
 *   2. INBOUND:  Receive replies via callback webhook, match to pending actions
 *
 * Approval flow:
 *   - Action created with requires_approval=true
 *   - Bot posts approval request with action ID
 *   - User replies "Yes 1234" or "No 1234" (where 1234 = batch ID prefix)
 *   - Webhook handler matches reply → approves/rejects batch → executes
 *
 * v1.5 — INSERT-FIRST DEDUP (2026-04-29).
 *   PROBLEM: Two parallel GroupMe approval cards firing for the same batch.
 *   Surfaced 2026-04-28 by Mark on action #28144 (Mark Test). Railway logs
 *   showed two `processApprovalQueue` workers entering the loop within 5s
 *   of each other, both passing the in-loop existence check (because the
 *   tracking record had not been inserted yet — the v1.4 code sent the
 *   GroupMe message BEFORE persisting the tracking row). Both workers
 *   sent the message; both then upserted the same `short_ref` row (the
 *   second was a no-op due to onConflict, leaving exactly one tracking
 *   record in the DB but two messages in GroupMe).
 *
 *   ROOT CAUSE: The v1.4 ordering — send first, persist second — leaves
 *   a TOCTOU window between the existence check in approval-path.js and
 *   the upsert here. Concurrent runs (n8n heartbeat + auto-execute trigger
 *   after a prior approval) can both pass the check and both send.
 *
 *   FIX: Claim the batch via strict INSERT before calling sendGroupMeMessage.
 *   `short_ref` already has a unique constraint (used by the v1.4 onConflict),
 *   so a strict insert will fail with code 23505 if another worker has
 *   claimed it. On unique violation we silently skip the send (the other
 *   worker is handling it). On any other insert error we throw so the
 *   batch retries. After a successful claim, if GroupMe delivery fails
 *   we DELETE the claim row so the next heartbeat can retry.
 *
 *   This closes the race fully — there is no longer a window where two
 *   workers can both send a GroupMe card for the same batch.
 *
 * v1.4 — Zombie-proof tracking (2026-04-24).
 *   sendApprovalRequest now checks the sendGroupMeMessage return value and
 *   only inserts the groupme_approval_requests tracking record when GroupMe
 *   actually accepted the message. (Superseded by v1.5 above — claim now
 *   happens BEFORE the send, not after.)
 *
 * v1.3 — Auto-execute after approval.
 * v1.2 — Enriched approval requests with full decision context.
 * v1.1 — Fix: rejection uses status='rejected' (was 'cancelled').
 *
 * Routes:
 *   POST /webhook/groupme — Callback URL for GroupMe bot
 *   POST /groupme/send    — Manual send (for testing)
 *   GET  /groupme/pending  — View pending approval requests
 */

import supabase from './supabase.js';

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

/**
 * Fire-and-forget: trigger the action executor immediately after an approval.
 * Eliminates the wait for the next heartbeat cycle.
 */
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

/**
 * Human-readable rule name mapping for GroupMe display.
 */
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

/**
 * Build a concise action summary for GroupMe display.
 */
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

/**
 * v1.5 — Insert-first dedup. Claim the batch by inserting the tracking
 * record BEFORE sending the GroupMe message. If another worker has already
 * claimed it (concurrent run), the unique constraint on short_ref fires a
 * 23505 error and we silently skip. If GroupMe delivery fails after a
 * successful claim, we delete the claim so the next heartbeat retries.
 *
 * v1.2 — Enriched approval request with full decision context.
 */
export async function sendApprovalRequest(batchActions, contactName, contactPhone, enrichment = {}) {
  if (!batchActions?.length) return;

  const first = batchActions[0];
  const batchId = first.batch_id || `s_${first.id}`;
  const shortRef = String(first.id);

  const ruleName = RULE_DISPLAY_NAMES[first.rule_applied] || first.rule_applied;
  const actionSummary = formatActionSummary(batchActions);

  // Build the message lines
  const lines = [];
  lines.push(`🔔 APPROVAL [#${shortRef}]`);
  lines.push(`${ruleName}`);
  lines.push(`👤 ${contactName || 'Unknown'}${contactPhone ? ` (${contactPhone})` : ''}`);

  // Context: what triggered this (inbound message from lead)
  if (enrichment.messageText) {
    const msg = enrichment.messageText.slice(0, 200);
    lines.push(`💬 "${msg}"${enrichment.messageType ? ` [${enrichment.messageType}]` : ''}`);
  }

  // LP data if available
  const lpParts = [];
  if (enrichment.lpSource) lpParts.push(`Src: ${enrichment.lpSource}`);
  if (enrichment.repName) lpParts.push(`Rep: ${enrichment.repName}`);
  if (enrichment.disposition) lpParts.push(`Disp: ${enrichment.disposition}`);
  if (enrichment.prospectId && enrichment.prospectId !== 'Not in LP') lpParts.push(`Prospect: ${enrichment.prospectId}`);
  if (lpParts.length > 0) lines.push(`📋 ${lpParts.join(' | ')}`);

  // Intent data if available
  if (enrichment.score || enrichment.tier) {
    const intentParts = [];
    if (enrichment.score) intentParts.push(`Score: ${enrichment.score}`);
    if (enrichment.tier) intentParts.push(`Tier: ${enrichment.tier}`);
    if (enrichment.barrier) intentParts.push(`Barrier: ${enrichment.barrier}`);
    lines.push(`📊 ${intentParts.join(' | ')}`);
  }

  // AI summary if available
  if (enrichment.aiSummary) {
    lines.push(`🤖 ${enrichment.aiSummary.slice(0, 150)}`);
  }

  // What the actions will do
  lines.push(`🎯 ${actionSummary}`);

  // Generated AI response preview — NEVER truncate. This is what Mark reads to approve.
  if (enrichment.generatedMessage) {
    lines.push(`📱 "${enrichment.generatedMessage}"`);
  } else if (enrichment.aiGenerationError) {
    lines.push(`⚠️ AI generation failed: ${enrichment.aiGenerationError.slice(0, 100)}`);
  }

  lines.push('');
  lines.push(`Reply: Yes ${shortRef} or No ${shortRef}`);

  const msg = lines.join('\n');

  // ──────────────────────────────────────────────────────────────────
  // v1.5 — INSERT-FIRST DEDUP. Claim the batch BEFORE sending. If another
  // worker has already claimed it, the unique constraint on short_ref
  // fires a 23505 error and we silently skip. Closes the TOCTOU window
  // that allowed concurrent processApprovalQueue runs (heartbeat +
  // auto-execute trigger) to both fire a GroupMe card.
  // ──────────────────────────────────────────────────────────────────

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
      // Unique violation on short_ref — another worker has this batch.
      // Silently skip; the other worker's GroupMe send is in flight or
      // already complete.
      console.log(`[GroupMe] Batch ${batchId} (#${shortRef}) already claimed by another worker — skipping duplicate send`);
      return;
    }
    throw new Error(`Failed to claim approval batch ${batchId}: ${claimErr.message}`);
  }

  // Claimed — now send the GroupMe message.
  const sendResult = await sendGroupMeMessage(msg);
  if (!sendResult?.sent) {
    // Send failed — release our claim so the next heartbeat can retry.
    // Best-effort delete (don't throw on delete failure — the throw below
    // is the signal the caller cares about).
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
// INBOUND: Handle GroupMe callback webhook
// ═══════════════════════════════════════════════════════════════════

async function handleGroupMeCallback(payload) {
  // Ignore bot messages (prevent loops)
  if (payload.sender_type === 'bot') return { handled: false, reason: 'bot_message' };

  // Verify group (optional safety check)
  if (GROUPME_GROUP_ID && String(payload.group_id) !== GROUPME_GROUP_ID) {
    return { handled: false, reason: 'wrong_group' };
  }

  const text = (payload.text || '').trim();
  const senderName = payload.name || 'Unknown';

  // Match "Yes 1234" or "No 1234" pattern
  const approvalMatch = text.match(/^(yes|no|approve|reject|deny)\s+(\d+)\s*$/i);
  if (!approvalMatch) {
    // Not an approval command — could be general chat
    console.log(`[GroupMe] Non-approval message from ${senderName}: "${text.slice(0, 50)}"`);
    return { handled: false, reason: 'not_approval_command' };
  }

  const decision = approvalMatch[1].toLowerCase();
  const shortRef = approvalMatch[2];
  const isApproved = ['yes', 'approve'].includes(decision);

  console.log(`[GroupMe] Approval ${isApproved ? 'YES' : 'NO'} for #${shortRef} by ${senderName}`);

  // Look up the approval request
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
    // Approve all actions in the batch
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

    // Mark the request as approved
    await supabase
      .from('groupme_approval_requests')
      .update({ status: 'approved', resolved_by: senderName, resolved_at: new Date().toISOString() })
      .eq('short_ref', shortRef);

    await sendGroupMeMessage(`✅ Approved #${shortRef} (${request.rule_applied}). ${actionIds.length} actions queued for execution.`);

    console.log(`[GroupMe] ✅ Batch approved: #${shortRef} — ${actionIds.length} actions by ${senderName}`);

    // v1.3: Immediately trigger execution — don't wait for heartbeat
    triggerExecution().catch(err => {
      console.warn(`[GroupMe] Auto-execute failed after approval: ${err.message}`);
    });

    return { handled: true, action: 'approved', shortRef, actionCount: actionIds.length };

  } else {
    // v1.1: Reject all actions in the batch — use 'rejected' (not 'cancelled')
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

    // Mark the request as rejected
    await supabase
      .from('groupme_approval_requests')
      .update({ status: 'rejected', resolved_by: senderName, resolved_at: new Date().toISOString() })
      .eq('short_ref', shortRef);

    await sendGroupMeMessage(`🚫 Rejected #${shortRef} (${request.rule_applied}). ${actionIds.length} actions cancelled.`);

    console.log(`[GroupMe] 🚫 Batch rejected: #${shortRef} — ${actionIds.length} actions by ${senderName}`);
    return { handled: true, action: 'rejected', shortRef, actionCount: actionIds.length };
  }
}

// ═══════════════════════════════════════════════════════════════════
// EXPRESS ROUTES
// ═══════════════════════════════════════════════════════════════════

export function registerGroupMeRoutes(app) {

  // GroupMe callback webhook (no auth — GroupMe doesn't send auth headers)
  app.post('/webhook/groupme', async (req, res) => {
    res.status(200).json({ ok: true }); // Respond immediately — GroupMe requires fast response
    try {
      await handleGroupMeCallback(req.body);
    } catch (err) {
      console.error('[GroupMe] Webhook error:', err.message);
    }
  });

  // Manual send (for testing)
  app.post('/groupme/send', async (req, res) => {
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });
    const result = await sendGroupMeMessage(message);
    res.json(result);
  });

  // View pending approval requests
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
