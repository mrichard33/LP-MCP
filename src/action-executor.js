/**
 * Action Executor — src/action-executor.js
 * 
 * Layer 2 of the agentic system. Reads pending actions from agent_actions
 * and executes them against GHL, LP, GroupMe, and other systems.
 * 
 * Supported action types:
 *   add_tag              → POST /contacts/{id}/tags (additive, never PUT)
 *   remove_tag           → DELETE /contacts/{id}/tags (removes specific tag)
 *   move_opportunity     → Find opp by contact, PUT /opportunities/{oppId} with pipelineStageId
 *   remove_from_workflow → Add to "Remove from All Marketing Campaigns" workflow
 *   create_task          → Add GHL note + GroupMe notification (GHL has no task API)
 *   send_notification    → GroupMe message to sales channel
 *   set_lp_appointment   → Push appointment to LP via SetAppointment API (Phase 2 write)
 */

import supabase from './supabase.js';
import { applyGHLTag, addGHLNote } from './ghl.js';
import { setAppointment as lpSetAppointment } from './lp-client.js';

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = 'SsBG7j5KQAIP1SFP2Sca';
const GROUPME_BOT_ID = process.env.GROUPME_BOT_ID || '';

// ═══════════════════════════════════════════════════════════════════
// PIPELINE STAGE MAP — exact GHL names (verified 2026-04-05)
// ═══════════════════════════════════════════════════════════════════

const PIPELINE_IDS = {
  P1: 'x0cxXOkKwqAWVvcPdKZQ',
  P2: '44mOrpmHqk7YqZN9vSPW',
  P3: '1jIWe4Ad04oJtYE9UuXq',
};

const STAGE_MAP = {
  'Lead Captured':                       '793f72f8-08b3-4d0a-9227-a646f1fdc7f6',
  'High-Intent Qualified':               '0afdc1bc-2859-4696-ab13-07f8c59e457e',
  'Indoctrination / Short Nurture':      '67f50407-f004-47b3-ad70-83e0eccbe2d1',
  'Active Nurture':                      '538d9a8e-4b38-4331-9711-87f40a6dd4ef',
  'Re-Engagement':                       'a75f34d2-b38d-4edd-ac98-4a89304be71c',
  'Conversion Sequence':                 '79ab10fd-5294-4330-b4ac-91b2df7c7d3a',
  'Appointment Completed':               '656c8446-da9b-4c97-add8-ba50d8319b84',
  'Proposal / Estimate Delivered':       '10776799-ee76-409f-a630-9c496e5d708e',
  'Unresponsive':                        '9a3fec61-4057-4b30-bb23-5b5f57702d4d',
  'Reactivation':                        '8a17a6ab-56ff-47b2-9c61-77b8ded7e479',
  'Long Term Nurture':                   '36ccbca0-c57f-466a-bd66-c7aa2a91e79d',
  'Closed Won':                          '2f7396e6-c51f-41f8-85f2-c2896733889f',
  'Closed Won (Contract Signed)':        'fec39f2e-ba39-4536-95b2-bbac7ca6c454',
  'Financing Pending / Document Collection': 'b7fc445c-a969-42b1-9a7a-eda5c89f25a5',
  'Financing Approved':                  '375089e1-aaa5-429f-8c4c-5e01058fa8f8',
  'HOA / Permit In Progress':            '561f35fe-3632-40e9-bf0d-b9061bdf2589',
  'Production / Manufacturing':          '6b89bc8d-067a-41fb-a76c-fc0c9feaaf92',
  'Install Scheduled':                   'd852ba71-c6f5-422b-9c74-33b6036c69a5',
  'Install Completed':                   '5fc94c74-d136-481e-b8ca-2200817111af',
  'Referral & Expansion Opportunity':    '053a0020-0f96-4a22-8717-8814c3ca1ff8',
  'Deferred / Timing':                   '3b786609-dec8-411f-9318-8b63778aa4cb',
  'Not Interested (Now)':                'e0bde70a-f32f-4b6d-88b2-be0c89c46852',
  'Bad Fit / Wrong Home':                'f9cd1a23-a6f9-452c-b129-c47d5a14a6bd',
  'Do Not Contact':                      '5f332652-b8c1-4a67-ba30-dc3450a3e039',
  'Hard Disqualified':                   '6194a841-8f59-4164-adee-dc0bd99510dc',
  'Reactivation Queue':                  'fda5f000-19a7-420f-935a-f1f2de0c7675',
};

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
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return res.json();
  return { status: res.status, ok: true };
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

async function executeRemoveTag(action) {
  const contactId = action.target_id;
  const tag = action.action_payload?.tag;
  if (!contactId || !tag) throw new Error('Missing contactId or tag');
  await ghlFetch('DELETE', `/contacts/${contactId}/tags`, { tags: [tag] });
  return { tag_removed: tag, contact_id: contactId };
}

async function executeMoveOpportunity(action) {
  const contactId = action.target_id;
  const { pipeline, stage, status } = action.action_payload || {};
  if (!contactId || !pipeline || !stage) throw new Error('Missing contactId, pipeline, or stage');

  const pipelineId = PIPELINE_IDS[pipeline];
  if (!pipelineId) throw new Error(`Unknown pipeline: ${pipeline}`);
  const stageId = STAGE_MAP[stage];
  if (!stageId) throw new Error(`Unknown stage: "${stage}" — fix the agent_rule, no aliases allowed`);

  const searchRes = await ghlFetch('GET',
    `/opportunities/search?location_id=${GHL_LOCATION_ID}&contact_id=${contactId}&pipeline_id=${pipelineId}`);
  const opportunities = searchRes?.opportunities || [];

  if (opportunities.length > 0) {
    const opp = opportunities[0];
    await ghlFetch('PUT', `/opportunities/${opp.id}`, { pipelineStageId: stageId, status: status || 'open' });
    return { action: 'updated', opportunity_id: opp.id, pipeline, stage, status };
  } else {
    const contactRes = await ghlFetch('GET', `/contacts/${contactId}`);
    const contact = contactRes?.contact || {};
    const contactName = contact.name || contact.firstName || 'Unknown';
    const newOpp = await ghlFetch('POST', '/opportunities/', {
      pipelineId, pipelineStageId: stageId, locationId: GHL_LOCATION_ID, contactId, name: contactName, status: status || 'open',
    });
    return { action: 'created', opportunity_id: newOpp?.opportunity?.id, pipeline, stage, status };
  }
}

async function executeRemoveFromWorkflow(action) {
  const contactId = action.target_id;
  if (action.action_payload?.remove_all) {
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
  await addGHLNote(contactId, `[AGENT TASK] ${title}`);
  if (GROUPME_BOT_ID) await sendGroupMeMessage(`🤖 AGENT TASK: ${title}\nContact: ${contactId}`);
  return { action: 'note_added', contact_id: contactId, title };
}

async function executeSendNotification(action) {
  const message = action.action_payload?.message || 'Agent notification';
  const contactId = action.target_id;
  const fullMessage = contactId && contactId !== 'unknown'
    ? `🤖 ${message}\nContact: ${contactId}` : `🤖 ${message}`;
  if (GROUPME_BOT_ID) {
    await sendGroupMeMessage(fullMessage);
    return { action: 'groupme_sent', message: fullMessage.slice(0, 100) };
  }
  console.log(`[ActionExecutor] NOTIFICATION (no GroupMe): ${fullMessage}`);
  return { action: 'logged', message: fullMessage.slice(0, 100), note: 'GROUPME_BOT_ID not configured' };
}

// ═══════════════════════════════════════════════════════════════════
// LP APPOINTMENT WRITEBACK — Phase 2 Write Action
// ═══════════════════════════════════════════════════════════════════

/**
 * set_lp_appointment action handler.
 * 
 * Pushes a GHL appointment booking to Lead Perfection via the SetAppointment API.
 * Uses lp-client.js which handles token management, form-encoding, retry, and
 * circuit breaker automatically — no GHL Custom Webhook fragility.
 * 
 * Required action_payload fields:
 *   lp_lead_id  — LP lead ID (lds_id). Looked up from lp_leads if not provided.
 *   appt_date   — Appointment date in ISO format (converted to MM/DD/YYYY)
 *   appt_time   — Appointment time (12h or 24h, converted to HH:MM 24h)
 *   set_by      — LP employee ID (default: 5686 = GHL system user)
 * 
 * Optional:
 *   calendar_name — For logging purposes
 */
async function executeSetLPAppointment(action) {
  const contactId = action.target_id;
  const payload = action.action_payload || {};

  // ─── Resolve LP Lead ID ────────────────────────────────────────
  let lpLeadId = payload.lp_lead_id;

  if (!lpLeadId && contactId) {
    // Look up from lp_leads table by GHL contact ID
    const { data: lpLead } = await supabase
      .from('lp_leads')
      .select('lp_lead_id')
      .eq('ghl_contact_id', contactId)
      .order('synced_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lpLead?.lp_lead_id) {
      lpLeadId = lpLead.lp_lead_id;
    } else {
      // Try GHL custom field as fallback
      const ghlRes = await ghlFetch('GET', `/contacts/${contactId}`);
      const customFields = ghlRes?.contact?.customFields || [];
      // GmAVmW6V9sekD7pVONKr = LP Lead ID custom field
      const lpField = customFields.find(f => f.id === 'GmAVmW6V9sekD7pVONKr');
      if (lpField?.value) {
        lpLeadId = String(lpField.value);
      }
    }
  }

  if (!lpLeadId) {
    throw new Error(`Cannot set LP appointment: no LP Lead ID found for contact ${contactId}. Lead may not be in LP yet.`);
  }

  // ─── Format Date (ISO → MM/DD/YYYY) ───────────────────────────
  let apptDate = payload.appt_date;
  if (apptDate && apptDate.includes('-')) {
    // ISO format: 2026-04-10 or 2026-04-10T14:00:00
    const datePart = apptDate.split('T')[0];
    const [year, month, day] = datePart.split('-');
    apptDate = `${month}/${day}/${year}`;
  }
  if (!apptDate) throw new Error('Missing appt_date in action payload');

  // ─── Format Time (12h → 24h HH:MM) ────────────────────────────
  let apptTime = payload.appt_time;
  if (apptTime) {
    // Handle "2:00 PM", "10:00 AM", "14:00", etc.
    const match12 = apptTime.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (match12) {
      let hours = parseInt(match12[1], 10);
      const minutes = match12[2];
      const period = match12[3].toUpperCase();
      if (period === 'AM' && hours === 12) hours = 0;
      if (period === 'PM' && hours !== 12) hours += 12;
      apptTime = `${String(hours).padStart(2, '0')}:${minutes}`;
    }
    // If already in 24h format (e.g. "14:00"), leave as-is
    // Strip seconds if present (e.g. "14:00:00" → "14:00")
    if (apptTime.length > 5) apptTime = apptTime.slice(0, 5);
  }
  if (!apptTime) throw new Error('Missing appt_time in action payload');

  const setBy = payload.set_by || '5686';

  // ─── Call LP API via lp-client.js ──────────────────────────────
  const result = await lpSetAppointment({
    ldsId: lpLeadId,
    setBy,
    apptDate,
    apptTime,
  });

  // ─── Add GHL note confirming the writeback ─────────────────────
  const noteText = `[LP SYNC] Appointment set in Lead Perfection\nLP Lead ID: ${lpLeadId}\nDate: ${apptDate}\nTime: ${apptTime}\nCalendar: ${payload.calendar_name || 'N/A'}`;
  await addGHLNote(contactId, noteText).catch(err => {
    console.warn(`[ActionExecutor] GHL note failed (non-critical): ${err.message}`);
  });

  // ─── GroupMe notification ──────────────────────────────────────
  if (GROUPME_BOT_ID) {
    await sendGroupMeMessage(
      `📅 LP Appointment Set\nLP Lead: ${lpLeadId}\nDate: ${apptDate} ${apptTime}\nCalendar: ${payload.calendar_name || 'N/A'}\nContact: ${contactId}`
    ).catch(() => {});
  }

  console.log(`[ActionExecutor] ✅ LP appointment set: lds_id=${lpLeadId}, ${apptDate} ${apptTime}`);

  return {
    action: 'lp_appointment_set',
    lp_lead_id: lpLeadId,
    appt_date: apptDate,
    appt_time: apptTime,
    set_by: setBy,
    lp_response: result,
    contact_id: contactId,
  };
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
  remove_tag: executeRemoveTag,
  move_opportunity: executeMoveOpportunity,
  remove_from_workflow: executeRemoveFromWorkflow,
  create_task: executeCreateTask,
  send_notification: executeSendNotification,
  set_lp_appointment: executeSetLPAppointment,
};

async function executeSingleAction(action) {
  const handler = ACTION_HANDLERS[action.action_type];
  if (!handler) {
    await supabase.from('agent_actions').update({
      status: 'failed', error_message: `Unknown action type: ${action.action_type}`,
      executed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq('id', action.id);
    return { action_id: action.id, status: 'failed', error: `Unknown action type: ${action.action_type}` };
  }

  await supabase.from('agent_actions').update({
    status: 'executing', updated_at: new Date().toISOString(),
  }).eq('id', action.id);

  try {
    const result = await handler(action);
    await supabase.from('agent_actions').update({
      status: 'completed', execution_result: result,
      executed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq('id', action.id);
    console.log(`[ActionExecutor] ✅ ${action.action_type} completed (action ${action.id}, rule: ${action.rule_applied})`);
    return { action_id: action.id, status: 'completed', result };
  } catch (err) {
    const retryCount = (action.retry_count || 0) + 1;
    const maxRetries = action.max_retries || 3;
    const newStatus = retryCount >= maxRetries ? 'failed' : 'pending';
    await supabase.from('agent_actions').update({
      status: newStatus, error_message: err.message, retry_count: retryCount,
      executed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq('id', action.id);
    console.error(`[ActionExecutor] ❌ ${action.action_type} failed (action ${action.id}): ${err.message} [retry ${retryCount}/${maxRetries}]`);
    return { action_id: action.id, status: newStatus, error: err.message, retry: `${retryCount}/${maxRetries}` };
  }
}

export async function executeActions({ limit = 50 } = {}) {
  const startTime = Date.now();
  const { data: actions, error } = await supabase
    .from('agent_actions').select('*').eq('status', 'pending')
    .order('created_at', { ascending: true }).order('sequence_order', { ascending: true }).limit(limit);

  if (error) { console.error('[ActionExecutor] Failed to fetch pending actions:', error.message); return { success: false, error: error.message }; }
  if (!actions || actions.length === 0) return { success: true, actions_executed: 0, elapsed_ms: Date.now() - startTime };

  const batches = new Map();
  for (const action of actions) {
    const key = action.batch_id || `single_${action.id}`;
    if (!batches.has(key)) batches.set(key, []);
    batches.get(key).push(action);
  }
  for (const batch of batches.values()) batch.sort((a, b) => (a.sequence_order || 0) - (b.sequence_order || 0));

  console.log(`[ActionExecutor] Executing ${actions.length} actions in ${batches.size} batches...`);
  const results = [];
  let completed = 0, failed = 0;

  for (const [batchId, batchActions] of batches) {
    for (const action of batchActions) {
      const result = await executeSingleAction(action);
      results.push(result);
      if (result.status === 'completed') completed++;
      else if (result.status === 'failed') failed++;
      if (result.status === 'failed') { console.warn(`[ActionExecutor] Batch ${batchId} halted — action ${action.id} failed permanently`); break; }
    }
  }

  const elapsed = Date.now() - startTime;
  console.log(`[ActionExecutor] Done: ${completed} completed, ${failed} failed (${elapsed}ms)`);
  return { success: true, actions_executed: results.length, completed, failed, retrying: results.filter(r => r.status === 'pending').length, results, elapsed_ms: elapsed };
}

// ═══════════════════════════════════════════════════════════════════
// EXPRESS ROUTES
// ═══════════════════════════════════════════════════════════════════

export function registerActionExecutorRoutes(app) {
  app.post('/n8n/decision-engine/execute', async (req, res) => {
    try { res.json(await executeActions({ limit: req.body?.limit || 50 })); }
    catch (err) { console.error('[ActionExecutor] /execute error:', err.message); res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/n8n/decision-engine/execution-stats', async (req, res) => {
    try {
      const [pendingRes, approvalRes, completedRes, failedRes] = await Promise.all([
        supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'pending_approval'),
        supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'completed'),
        supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'failed'),
      ]);
      res.json({ pending: pendingRes.count || 0, pending_approval: approvalRes.count || 0, completed: completedRes.count || 0, failed: failedRes.count || 0 });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}
