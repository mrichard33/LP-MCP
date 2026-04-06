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
 * Routes:
 *   POST /webhook/groupme — Callback URL for GroupMe bot
 *   POST /groupme/send    — Manual send (for testing)
 *   GET  /groupme/pending  — View pending approval requests
 */

import supabase from './supabase.js';

const GROUPME_BOT_ID = process.env.GROUPME_BOT_ID || '';
const GROUPME_GROUP_ID = process.env.GROUPME_GROUP_ID || '';

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
// APPROVAL REQUEST FORMAT
// ═══════════════════════════════════════════════════════════════════

export async function sendApprovalRequest(batchActions, contactName, contactPhone) {
  if (!batchActions?.length) return;

  const first = batchActions[0];
  const batchId = first.batch_id || `s_${first.id}`;
  // Use first 8 chars of batch_id as short reference
  const shortRef = String(first.id);

  const actionSummary = batchActions.map(a => {
    if (a.action_type === 'add_tag') return `Tag: ${a.action_payload?.tag}`;
    if (a.action_type === 'move_opportunity') return `Move → ${a.action_payload?.pipeline} ${a.action_payload?.stage}`;
    if (a.action_type === 'remove_from_workflow') return `Remove from workflow`;
    if (a.action_type === 'create_task') return `Task: ${a.action_payload?.title}`;
    if (a.action_type === 'send_notification') return `Notify`;
    return a.action_type;
  }).join('\n  ');

  const msg = [
    `🔔 APPROVAL NEEDED [#${shortRef}]`,
    `Rule: ${first.rule_applied}`,
    `Contact: ${contactName || 'Unknown'}${contactPhone ? ` (${contactPhone})` : ''}`,
    `Reason: ${first.reasoning || 'N/A'}`,
    `Actions:`,
    `  ${actionSummary}`,
    ``,
    `Reply: Yes ${shortRef} or No ${shortRef}`,
  ].join('\n');

  await sendGroupMeMessage(msg);

  // Store the mapping so we can match replies
  await supabase.from('groupme_approval_requests').upsert({
    short_ref: shortRef,
    batch_id: batchId,
    action_ids: batchActions.map(a => a.id),
    rule_applied: first.rule_applied,
    target_id: first.target_id,
    contact_name: contactName || null,
    status: 'pending',
    requested_at: new Date().toISOString(),
  }, { onConflict: 'short_ref' });

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
    return { handled: true, action: 'approved', shortRef, actionCount: actionIds.length };

  } else {
    // Reject all actions in the batch
    const { error } = await supabase
      .from('agent_actions')
      .update({
        status: 'cancelled',
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
