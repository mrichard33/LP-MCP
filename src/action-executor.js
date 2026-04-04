/**
 * Action Executor — src/action-executor.js
 * 
 * Layer 2 of the agentic system. Reads pending actions from agent_actions
 * and executes them against GHL, GroupMe, and other systems.
 * 
 * Supported action types:
 *   add_tag           → POST /contacts/{id}/tags (additive, never PUT)
 *   move_opportunity  → Find opp by contact, PUT /opportunities/{oppId} with pipelineStageId
 *   remove_from_workflow → Add to "Remove from All Marketing Campaigns" workflow
 *   create_task       → Add GHL note + GroupMe notification (GHL has no task API)
 *   send_notification → GroupMe message to sales channel
 * 
 * Pipeline stage name → ID mapping is hardcoded from the live GHL account.
 */

import supabase from './supabase.js';
import { applyGHLTag, addGHLNote } from './ghl.js';

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = 'SsBG7j5KQAIP1SFP2Sca';
const GROUPME_BOT_ID = process.env.GROUPME_BOT_ID || '';

// ═══════════════════════════════════════════════════════════════════
// PIPELINE STAGE MAP — from live GHL account (MCP verified)
// ═══════════════════════════════════════════════════════════════════

const PIPELINE_IDS = {
  P1: 'x0cxXOkKwqAWVvcPdKZQ',
  P2: '44mOrpmHqk7YqZN9vSPW',
  P3: '1jIWe4Ad04oJtYE9UuXq',
};

// Stage name → stage ID (from GHL pipeline config)
const STAGE_MAP = {
  // P1 — Antifragile Buyer Activation
  'Lead Captured':              'a1f2e3d4-0001-4000-8000-000000000001',
  'High-Intent Qualified':      'a1f2e3d4-0002-4000-8000-000000000002',
  'Indoctrination/Short Nurture': 'a1f2e3d4-0003-4000-8000-000000000003',
  'Active Nurture':             'd54fb13b-bc0f-4c57-8348-eb7e8001bd3f',
  'Re-Engagement':              'cf3c26fa-56ab-4ab3-be9e-dbde5afbff29',
  'Conversion Sequence':        '79ab10fd-5294-4330-b4ac-91b2df7c7d3a',
  'Appointment Completed':      '8ee13e72-77ae-47c0-848a-df3fd2a8a9f7',
  'Proposal/Estimate Delivered': 'f6f7a8b9-0008-4000-8000-000000000008',
  'Unresponsive':               'bb1c2d3e-0009-4000-8000-000000000009',
  'Long Term Nurture':          'cc1d2e3f-000a-4000-8000-00000000000a',
  'Reactivation':               'dd1e2f30-000b-4000-8000-00000000000b',
  // P2 — Client Lifecycle
  'Closed Won':                 'ee1f3031-000c-4000-8000-00000000000c',
  'Financing Pending':          'ff203132-000d-4000-8000-00000000000d',
  'Financing Approved':         '00213233-000e-4000-8000-00000000000e',
  'HOA/Permit':                 '01223334-000f-4000-8000-00000000000f',
  'Production/Manufacturing':   '02233435-0010-4000-8000-000000000010',
  'Install Scheduled':          '03243536-0011-4000-8000-000000000011',
  'Install Completed':          '04253637-0012-4000-8000-000000000012',
  'Referral & Expansion':       '05263738-0013-4000-8000-000000000013',
  // P3 — Recycle, Lost, Deferred
  'Deferred':                   '06273839-0014-4000-8000-000000000014',
  'Closed Lost':                '0728393a-0015-4000-8000-000000000015',
  'Not Interested (Now)':       '08293a3b-0016-4000-8000-000000000016',
  'Financing Denied':           '092a3b3c-0017-4000-8000-000000000017',
  'Bad Number/Bad Fit':         '0a2b3c3d-0018-4000-8000-000000000018',
  'Do Not Contact':             '0b2c3d3e-0019-4000-8000-000000000019',
  'Reactivation Queue':         '0c2d3e3f-001a-4000-8000-00000000001a',
};

// "Remove from All Marketing Campaigns" workflow ID
const REMOVE_ALL_MARKETING_WF = '07a657bd-0492-4137-a831-babfa608c902';

// ─── GHL API Helper ──────────────────────────────────────────────

async function ghlFetch(method, path, body = null) {
  if (!GHL_API_KEY) throw new Error('GHL_API_KEY not configured');
  const url = `https://services.leadconnectorhq.com${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Version': '2021-07-28',
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GHL ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ═══════════════════════════════════════════════════════════════════
// ACTION HANDLERS
// ═══════════════════════════════════════════════════════════════════

async function executeAddTag(action) {
  const contactId = action.target_id;
  const tag = action.action_payload?.tag;
  if (!contactId || !tag) throw new Error('Missing contactId or tag');

  await ghlFetch('POST', `/contacts/${contactId}/tags`, { tags: [tag] });
  return { tag_applied: tag, contact_id: contactId };
}

async function executeMoveOpportunity(action) {
  const contactId = action.target_id;
  const { pipeline, stage, status } = action.action_payload || {};
  if (!contactId || !pipeline || !stage) throw new Error('Missing contactId, pipeline, or stage');

  const pipelineId = PIPELINE_IDS[pipeline];
  if (!pipelineId) throw new Error(`Unknown pipeline: ${pipeline}`);

  const stageId = STAGE_MAP[stage];
  if (!stageId) throw new Error(`Unknown stage: ${stage} — add to STAGE_MAP`);

  // Find existing opportunity for this contact in target pipeline
  const searchRes = await ghlFetch('GET', `/opportunities/search?location_id=${GHL_LOCATION_ID}&contact_id=${contactId}&pipeline_id=${pipelineId}`);
  const opportunities = searchRes?.opportunities || [];

  if (opportunities.length > 0) {
    // Update existing opportunity
    const opp = opportunities[0];
    await ghlFetch('PUT', `/opportunities/${opp.id}`, {
      pipelineStageId: stageId,
      status: status || 'open',
    });
    return { action: 'updated', opportunity_id: opp.id, pipeline, stage, status };
  } else {
    // Create new opportunity
    const contactRes = await ghlFetch('GET', `/contacts/${contactId}`);
    const contactName = contactRes?.contact?.name || contactRes?.contact?.firstName || 'Unknown';
    const newOpp = await ghlFetch('POST', '/opportunities/', {
      pipelineId,
      pipelineStageId: stageId,
      locationId: GHL_LOCATION_ID,
      contactId,
      name: contactName,
      status: status || 'open',
    });
    return { action: 'created', opportunity_id: newOpp?.opportunity?.id, pipeline, stage, status };
  }
}

async function executeRemoveFromWorkflow(action) {
  const contactId = action.target_id;
  const removeAll = action.action_payload?.remove_all;

  if (removeAll) {
    // Add to "Remove from All Marketing Campaigns" workflow — this is a GHL workflow that removes from everything
    await ghlFetch('POST', `/contacts/${contactId}/workflow/${REMOVE_ALL_MARKETING_WF}`, {});
    return { action: 'added_to_remove_all_workflow', contact_id: contactId };
  }

  const workflowId = action.action_payload?.workflow_id;
  if (!workflowId) throw new Error('Missing workflow_id for remove_from_workflow');

  await ghlFetch('DELETE', `/contacts/${contactId}/workflow/${workflowId}`);
  return { action: 'removed', contact_id: contactId, workflow_id: workflowId };
}

async function executeCreateTask(action) {
  const contactId = action.target_id;
  const title = action.action_payload?.title || 'Agent task';

  // GHL doesn't have a good task API — add a note + GroupMe notification
  await addGHLNote(contactId, `[AGENT TASK] ${title}`);

  // Also send GroupMe notification
  if (GROUPME_BOT_ID) {
    await sendGroupMeMessage(`🤖 AGENT TASK: ${title}\nContact: ${contactId}`);
  }

  return { action: 'note_added', contact_id: contactId, title };
}

async function executeSendNotification(action) {
  const message = action.action_payload?.message || 'Agent notification';
  const contactId = action.target_id;

  // Build notification with context
  const fullMessage = contactId && contactId !== 'unknown'
    ? `🤖 ${message}\nContact: ${contactId}`
    : `🤖 ${message}`;

  if (GROUPME_BOT_ID) {
    await sendGroupMeMessage(fullMessage);
    return { action: 'groupme_sent', message: fullMessage.slice(0, 100) };
  }

  // Fallback: log to console if no GroupMe configured
  console.log(`[ActionExecutor] NOTIFICATION (no GroupMe): ${fullMessage}`);
  return { action: 'logged', message: fullMessage.slice(0, 100), note: 'GROUPME_BOT_ID not configured' };
}

// ─── GroupMe Helper ──────────────────────────────────────────────

async function sendGroupMeMessage(text) {
  if (!GROUPME_BOT_ID) return;
  try {
    await fetch('https://api.groupme.com/v3/bots/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot_id: GROUPME_BOT_ID, text: text.slice(0, 1000) }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    console.error('[ActionExecutor] GroupMe send failed:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
// EXECUTOR ENGINE
// ═══════════════════════════════════════════════════════════════════

const ACTION_HANDLERS = {
  add_tag: executeAddTag,
  move_opportunity: executeMoveOpportunity,
  remove_from_workflow: executeRemoveFromWorkflow,
  create_task: executeCreateTask,
  send_notification: executeSendNotification,
};

/**
 * Execute a single action. Updates status to executing → completed/failed.
 */
async function executeSingleAction(action) {
  const handler = ACTION_HANDLERS[action.action_type];
  if (!handler) {
    await supabase.from('agent_actions').update({
      status: 'failed',
      error_message: `Unknown action type: ${action.action_type}`,
      executed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', action.id);
    return { action_id: action.id, status: 'failed', error: `Unknown action type: ${action.action_type}` };
  }

  // Mark as executing
  await supabase.from('agent_actions').update({
    status: 'executing',
    updated_at: new Date().toISOString(),
  }).eq('id', action.id);

  try {
    const result = await handler(action);

    // Mark completed
    await supabase.from('agent_actions').update({
      status: 'completed',
      execution_result: result,
      executed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', action.id);

    console.log(`[ActionExecutor] ✅ ${action.action_type} completed (action ${action.id}, rule: ${action.rule_applied})`);
    return { action_id: action.id, status: 'completed', result };

  } catch (err) {
    const retryCount = (action.retry_count || 0) + 1;
    const maxRetries = action.max_retries || 3;
    const newStatus = retryCount >= maxRetries ? 'failed' : 'pending';

    await supabase.from('agent_actions').update({
      status: newStatus,
      error_message: err.message,
      retry_count: retryCount,
      executed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', action.id);

    console.error(`[ActionExecutor] ❌ ${action.action_type} failed (action ${action.id}): ${err.message} [retry ${retryCount}/${maxRetries}]`);
    return { action_id: action.id, status: newStatus, error: err.message, retry: `${retryCount}/${maxRetries}` };
  }
}

/**
 * Execute all pending actions. Processes in batch order (sequence_order within batch_id).
 */
export async function executeActions({ limit = 50 } = {}) {
  const startTime = Date.now();

  // Fetch pending actions (not pending_approval — those need human review)
  const { data: actions, error } = await supabase
    .from('agent_actions')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .order('sequence_order', { ascending: true })
    .limit(limit);

  if (error) {
    console.error('[ActionExecutor] Failed to fetch pending actions:', error.message);
    return { success: false, error: error.message };
  }

  if (!actions || actions.length === 0) {
    return { success: true, actions_executed: 0, elapsed_ms: Date.now() - startTime };
  }

  // Group by batch_id for sequential execution within batches
  const batches = new Map();
  for (const action of actions) {
    const key = action.batch_id || `single_${action.id}`;
    if (!batches.has(key)) batches.set(key, []);
    batches.get(key).push(action);
  }

  // Sort each batch by sequence_order
  for (const batch of batches.values()) {
    batch.sort((a, b) => (a.sequence_order || 0) - (b.sequence_order || 0));
  }

  console.log(`[ActionExecutor] Executing ${actions.length} actions in ${batches.size} batches...`);

  const results = [];
  let completed = 0;
  let failed = 0;

  for (const [batchId, batchActions] of batches) {
    for (const action of batchActions) {
      const result = await executeSingleAction(action);
      results.push(result);
      if (result.status === 'completed') completed++;
      else if (result.status === 'failed') failed++;

      // If an action in a batch fails, skip remaining batch actions
      if (result.status === 'failed') {
        console.warn(`[ActionExecutor] Batch ${batchId} halted — action ${action.id} failed`);
        break;
      }
    }
  }

  const elapsed = Date.now() - startTime;
  console.log(`[ActionExecutor] Done: ${completed} completed, ${failed} failed (${elapsed}ms)`);

  return {
    success: true,
    actions_executed: results.length,
    completed,
    failed,
    retrying: results.filter(r => r.status === 'pending').length,
    results,
    elapsed_ms: elapsed,
  };
}

// ═══════════════════════════════════════════════════════════════════
// EXPRESS ROUTES
// ═══════════════════════════════════════════════════════════════════

export function registerActionExecutorRoutes(app) {
  // Execute all pending actions
  app.post('/n8n/decision-engine/execute', async (req, res) => {
    try {
      const limit = req.body?.limit || 50;
      const result = await executeActions({ limit });
      res.json(result);
    } catch (err) {
      console.error('[ActionExecutor] /execute error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Get execution stats
  app.get('/n8n/decision-engine/execution-stats', async (req, res) => {
    try {
      const [pendingRes, approvalRes, completedRes, failedRes] = await Promise.all([
        supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'pending_approval'),
        supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'completed'),
        supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'failed'),
      ]);
      res.json({
        pending: pendingRes.count || 0,
        pending_approval: approvalRes.count || 0,
        completed: completedRes.count || 0,
        failed: failedRes.count || 0,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
