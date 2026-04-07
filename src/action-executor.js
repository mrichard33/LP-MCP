/**
 * Action Executor — src/action-executor.js
 * 
 * Layer 2 of the agentic system. Reads pending actions from agent_actions
 * and executes them against GHL, LP, GroupMe, and other systems.
 * 
 * Supported action types (8):
 *   add_tag              → POST /contacts/{id}/tags (additive, never PUT)
 *   remove_tag           → DELETE /contacts/{id}/tags (removes specific tag)
 *   move_opportunity     → Find opp by contact, PUT /opportunities/{oppId} with pipelineStageId
 *   remove_from_workflow → Add to "Remove from All Marketing Campaigns" workflow
 *   create_task          → Add GHL note + GroupMe notification (GHL has no task API)
 *   send_notification    → GroupMe message to sales channel
 *   set_lp_appointment   → Push appointment to LP via SetAppointment API (Phase 2 write)
 *   update_custom_fields → PUT /contacts/{id} with customFields array
 *
 * v2.5 — LP appointment pre-check: before calling SetAppointment, checks lp_leads
 *   table for existing appointment on same date. If LP already has it (appointment
 *   originated from LP call center), skips the API call. If date differs (reschedule
 *   from GHL), proceeds. Prevents redundant/error-prone duplicate SetAppointment calls.
 *
 * v2.4 — Fix appointment date/time resolution from GHL webhook payloads.
 * v2.3 — Template interpolation for action payloads.
 */

import supabase from './supabase.js';
import { applyGHLTag, addGHLNote, updateGHLContactFields } from './ghl.js';
import { setAppointment as lpSetAppointment } from './lp-client.js';
import { sendGroupMeMessage, sendApprovalRequest } from './groupme.js';

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = 'SsBG7j5KQAIP1SFP2Sca';

// ═══════════════════════════════════════════════════════════════════
// PIPELINE STAGE MAP
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

async function ghlFetch(method, path, body = null) {
  if (!GHL_API_KEY) throw new Error('GHL_API_KEY not configured');
  const url = `https://services.leadconnectorhq.com${path}`;
  const opts = { method, headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Content-Type': 'application/json', 'Accept': 'application/json' }, signal: AbortSignal.timeout(15000) };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) { const text = await res.text().catch(() => ''); throw new Error(`GHL ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`); }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : { status: res.status, ok: true };
}

// ═══════════════════════════════════════════════════════════════════
// TEMPLATE INTERPOLATION
// ═══════════════════════════════════════════════════════════════════

async function getEventContext(action) {
  if (!action.event_id) return {};
  try {
    const { data: evt } = await supabase
      .from('system_events')
      .select('payload, event_type, event_subtype')
      .eq('id', action.event_id)
      .maybeSingle();
    if (!evt?.payload) return {};
    const payload = typeof evt.payload === 'string' ? JSON.parse(evt.payload) : evt.payload;
    return { ...payload };
  } catch (err) {
    console.error(`[ActionExecutor] Failed to fetch event context for action ${action.id}:`, err.message);
    return {};
  }
}

function interpolate(template, context) {
  if (!template || typeof template !== 'string') return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const val = context[key];
    if (val === undefined || val === null) return '';
    return String(val);
  });
}

function interpolatePayload(payload, context) {
  if (!payload || typeof payload !== 'object') return payload;
  if (!context || Object.keys(context).length === 0) return payload;
  const result = {};
  for (const [key, val] of Object.entries(payload)) {
    if (typeof val === 'string') {
      result[key] = interpolate(val, context);
    } else if (Array.isArray(val)) {
      result[key] = val.map(item => typeof item === 'string' ? interpolate(item, context) : item);
    } else {
      result[key] = val;
    }
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════
// CONTACT NAME RESOLVER
// ═══════════════════════════════════════════════════════════════════

async function resolveContactInfo(contactId) {
  if (!contactId || /^\d+$/.test(contactId)) return { name: null, phone: null };
  try {
    const ghlRes = await ghlFetch('GET', `/contacts/${contactId}`);
    const c = ghlRes?.contact || {};
    const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.name || null;
    const phone = c.phone || null;
    return { name, phone };
  } catch { return { name: null, phone: null }; }
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
  if (!stageId) throw new Error(`Unknown stage: "${stage}" — fix the agent_rule`);

  const searchRes = await ghlFetch('GET', `/opportunities/search?location_id=${GHL_LOCATION_ID}&contact_id=${contactId}&pipeline_id=${pipelineId}`);
  const opps = searchRes?.opportunities || [];
  if (opps.length > 0) {
    await ghlFetch('PUT', `/opportunities/${opps[0].id}`, { pipelineStageId: stageId, status: status || 'open' });
    return { action: 'updated', opportunity_id: opps[0].id, pipeline, stage, status };
  } else {
    const contactRes = await ghlFetch('GET', `/contacts/${contactId}`);
    const name = contactRes?.contact?.name || contactRes?.contact?.firstName || 'Unknown';
    const newOpp = await ghlFetch('POST', '/opportunities/', { pipelineId, pipelineStageId: stageId, locationId: GHL_LOCATION_ID, contactId, name, status: status || 'open' });
    return { action: 'created', opportunity_id: newOpp?.opportunity?.id, pipeline, stage, status };
  }
}

async function executeRemoveFromWorkflow(action) {
  const contactId = action.target_id;
  if (action.action_payload?.remove_all) {
    await ghlFetch('POST', `/contacts/${contactId}/workflow/${REMOVE_ALL_MARKETING_WF}`, {});
    return { action: 'added_to_remove_all_workflow', contact_id: contactId };
  }
  const wfId = action.action_payload?.workflow_id;
  if (!wfId) throw new Error('Missing workflow_id');
  await ghlFetch('DELETE', `/contacts/${contactId}/workflow/${wfId}`);
  return { action: 'removed', contact_id: contactId, workflow_id: wfId };
}

async function executeCreateTask(action, context) {
  const contactId = action.target_id;
  const payload = interpolatePayload(action.action_payload, context);
  const title = payload?.title || 'Agent task';
  const description = payload?.description || '';
  const noteText = description ? `[AGENT TASK] ${title}\n${description}` : `[AGENT TASK] ${title}`;
  await addGHLNote(contactId, noteText);
  const { name, phone } = await resolveContactInfo(contactId);
  const contactLabel = name ? `${name}${phone ? ` (${phone})` : ''}` : contactId;
  await sendGroupMeMessage(`🤖 AGENT TASK: ${title}\nContact: ${contactLabel}`);
  return { action: 'note_added', contact_id: contactId, title };
}

async function executeSendNotification(action, context) {
  const payload = interpolatePayload(action.action_payload, context);
  const message = payload?.message || 'Agent notification';
  const contactId = action.target_id;
  const { name, phone } = await resolveContactInfo(contactId);
  const contactLabel = name ? `${name}${phone ? ` (${phone})` : ''}` : contactId;
  const full = `🤖 ${message}\nContact: ${contactLabel}`;
  await sendGroupMeMessage(full);
  return { action: 'groupme_sent', message: full.slice(0, 100) };
}

// ═══════════════════════════════════════════════════════════════════
// LP APPOINTMENT WRITEBACK
// ═══════════════════════════════════════════════════════════════════

/**
 * Normalize a date to YYYY-MM-DD for comparison purposes.
 * Handles: "2026-04-10", "2026-04-10T14:00:00+00:00", "04/10/2026"
 */
function normalizeDateForComparison(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  // ISO format: 2026-04-10 or 2026-04-10T...
  if (s.match(/^\d{4}-\d{2}-\d{2}/)) return s.slice(0, 10);
  // US format: MM/DD/YYYY
  const usMatch = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (usMatch) return `${usMatch[3]}-${usMatch[1]}-${usMatch[2]}`;
  return null;
}

async function executeSetLPAppointment(action) {
  const contactId = action.target_id;
  const payload = action.action_payload || {};

  // ─── Fetch event payload (contains the GHL webhook data) ───────
  let eventPayload = {};
  if (action.event_id) {
    const { data: evt } = await supabase.from('system_events').select('payload').eq('id', action.event_id).maybeSingle();
    if (evt?.payload) eventPayload = typeof evt.payload === 'string' ? JSON.parse(evt.payload) : evt.payload;
  }

  // ─── Resolve LP Lead ID ────────────────────────────────────────
  let lpLeadId = payload.lp_lead_id || eventPayload.lp_lead_id || eventPayload.lpLeadId || null;
  if (!lpLeadId && contactId) {
    const { data: lpLead } = await supabase.from('lp_leads').select('lp_lead_id').eq('ghl_contact_id', contactId).order('synced_at', { ascending: false }).limit(1).maybeSingle();
    if (lpLead?.lp_lead_id) { lpLeadId = lpLead.lp_lead_id; }
    else {
      const ghlRes = await ghlFetch('GET', `/contacts/${contactId}`);
      const lpField = (ghlRes?.contact?.customFields || []).find(f => f.id === 'GmAVmW6V9sekD7pVONKr');
      if (lpField?.value) lpLeadId = String(lpField.value);
    }
  }
  if (!lpLeadId) throw new Error(`No LP Lead ID for contact ${contactId}`);

  // ─── Resolve appointment date ──────────────────────────────────
  let rawDate = payload.appt_date || payload.appointment_date
    || eventPayload.appt_date || eventPayload.appointment_date
    || eventPayload.start_time || null;
  if (!rawDate && contactId) {
    const ghlRes = await ghlFetch('GET', `/contacts/${contactId}`);
    rawDate = ghlRes?.contact?.last_appointment_start_date || ghlRes?.contact?.lastAppointmentStartDate || null;
  }
  if (!rawDate) throw new Error('Cannot resolve appointment date');

  let apptDate;
  if (rawDate.includes('-')) { const [y, m, d] = rawDate.split('T')[0].split('-'); apptDate = `${m}/${d}/${y}`; }
  else apptDate = rawDate;

  // ─── Resolve appointment time ──────────────────────────────────
  let rawTime = payload.appt_time || payload.appointment_time
    || eventPayload.appt_time || eventPayload.appointment_time || null;
  if (!rawTime && eventPayload.start_time?.includes('T')) rawTime = eventPayload.start_time.split('T')[1]?.slice(0, 5);
  if (!rawTime && contactId) {
    const ghlRes = await ghlFetch('GET', `/contacts/${contactId}`);
    rawTime = ghlRes?.contact?.last_appointment_start_time || ghlRes?.contact?.lastAppointmentStartTime || null;
  }
  if (!rawTime) throw new Error('Cannot resolve appointment time');

  // ─── Convert 12h to 24h format if needed ───────────────────────
  let apptTime = rawTime;
  const match12 = apptTime.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (match12) {
    let h = parseInt(match12[1], 10);
    const min = match12[2], p = match12[3].toUpperCase();
    if (p === 'AM' && h === 12) h = 0;
    if (p === 'PM' && h !== 12) h += 12;
    apptTime = `${String(h).padStart(2, '0')}:${min}`;
  }
  if (apptTime.length > 5) apptTime = apptTime.slice(0, 5);

  const setBy = payload.set_by || '5686';
  const calendarName = payload.calendar_name || eventPayload.calendar_name || eventPayload.title || 'N/A';

  // ═══════════════════════════════════════════════════════════════
  // v2.5: LP APPOINTMENT PRE-CHECK
  // If LP already has an appointment on the same date, skip the API call.
  // This handles the case where the appointment originated from LP
  // (call center / canvassing) and GHL is redundantly trying to set it.
  // If the dates differ, it's a reschedule from GHL — proceed.
  // ═══════════════════════════════════════════════════════════════
  const ghlDateNormalized = normalizeDateForComparison(rawDate);

  try {
    const { data: existingLead } = await supabase
      .from('lp_leads')
      .select('appointment_set, appointment_date')
      .eq('lp_lead_id', lpLeadId)
      .maybeSingle();

    if (existingLead?.appointment_set && existingLead.appointment_date) {
      const lpDateNormalized = normalizeDateForComparison(existingLead.appointment_date);
      if (ghlDateNormalized && lpDateNormalized && ghlDateNormalized === lpDateNormalized) {
        console.log(`[ActionExecutor] ⏭️ LP already has appointment on ${lpDateNormalized} for lds_id=${lpLeadId} — skipping SetAppointment (originated from LP)`);

        await addGHLNote(contactId, `[LP SYNC] Appointment already exists in LP — skipped duplicate SetAppointment\nLP Lead ID: ${lpLeadId}\nLP Date: ${lpDateNormalized}\nGHL Date: ${ghlDateNormalized}\nCalendar: ${calendarName}`).catch(() => {});

        return {
          action: 'already_set_in_lp',
          lp_lead_id: lpLeadId,
          lp_appointment_date: lpDateNormalized,
          ghl_appointment_date: ghlDateNormalized,
          reason: 'LP already has appointment on same date — appointment likely originated from LP call center',
          calendar_name: calendarName,
          contact_id: contactId,
        };
      } else {
        console.log(`[ActionExecutor] LP has appointment on ${lpDateNormalized} but GHL wants ${ghlDateNormalized} — proceeding (reschedule)`);
      }
    }
  } catch (err) {
    // Pre-check failed — proceed anyway (don't block on pre-check errors)
    console.warn(`[ActionExecutor] LP pre-check failed for ${lpLeadId}: ${err.message} — proceeding with SetAppointment`);
  }

  // ─── Call LP SetAppointment API ────────────────────────────────
  console.log(`[ActionExecutor] LP Appointment: lds_id=${lpLeadId}, date=${apptDate}, time=${apptTime}, calendar=${calendarName}`);

  const result = await lpSetAppointment({ ldsId: lpLeadId, setBy, apptDate, apptTime });

  await addGHLNote(contactId, `[LP SYNC] Appointment set in Lead Perfection\nLP Lead ID: ${lpLeadId}\nDate: ${apptDate}\nTime: ${apptTime}\nCalendar: ${calendarName}`).catch(() => {});
  const { name } = await resolveContactInfo(contactId);
  await sendGroupMeMessage(`📅 LP Appointment Set\nContact: ${name || contactId}\nLP Lead: ${lpLeadId}\nDate: ${apptDate} ${apptTime}\nCalendar: ${calendarName}`).catch(() => {});

  console.log(`[ActionExecutor] ✅ LP appointment set: lds_id=${lpLeadId}, ${apptDate} ${apptTime}`);
  return { action: 'lp_appointment_set', lp_lead_id: lpLeadId, appt_date: apptDate, appt_time: apptTime, set_by: setBy, calendar_name: calendarName, lp_response: result, contact_id: contactId };
}

// ═══════════════════════════════════════════════════════════════════
// GHL CUSTOM FIELD UPDATE
// ═══════════════════════════════════════════════════════════════════

async function executeUpdateCustomFields(action) {
  const contactId = action.target_id;
  const fields = action.action_payload?.fields;
  if (!contactId) throw new Error('Missing contactId');
  if (!fields || !Array.isArray(fields) || fields.length === 0) throw new Error('Missing or empty fields array');

  const result = await updateGHLContactFields(contactId, fields);
  if (result === 'not_found') throw new Error(`GHL contact ${contactId} not found (deleted?)`);
  if (!result) throw new Error('GHL custom field update failed');

  console.log(`[ActionExecutor] ✅ Custom fields updated for ${contactId}: ${fields.length} fields`);
  return { action: 'custom_fields_updated', contact_id: contactId, field_count: fields.length, fields: fields.map(f => f.id) };
}

// ═══════════════════════════════════════════════════════════════════
// EXECUTOR ENGINE
// ═══════════════════════════════════════════════════════════════════

const CONTEXT_AWARE_HANDLERS = new Set(['send_notification', 'create_task']);

const ACTION_HANDLERS = {
  add_tag: executeAddTag,
  remove_tag: executeRemoveTag,
  move_opportunity: executeMoveOpportunity,
  remove_from_workflow: executeRemoveFromWorkflow,
  create_task: executeCreateTask,
  send_notification: executeSendNotification,
  set_lp_appointment: executeSetLPAppointment,
  update_custom_fields: executeUpdateCustomFields,
};

async function executeSingleAction(action) {
  const handler = ACTION_HANDLERS[action.action_type];
  if (!handler) {
    await supabase.from('agent_actions').update({ status: 'failed', error_message: `Unknown action type: ${action.action_type}`, executed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', action.id);
    return { action_id: action.id, status: 'failed', error: `Unknown: ${action.action_type}` };
  }
  await supabase.from('agent_actions').update({ status: 'executing', updated_at: new Date().toISOString() }).eq('id', action.id);
  try {
    let context = {};
    if (CONTEXT_AWARE_HANDLERS.has(action.action_type)) {
      context = await getEventContext(action);
    }
    const result = await handler(action, context);
    await supabase.from('agent_actions').update({ status: 'completed', execution_result: result, executed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', action.id);
    console.log(`[ActionExecutor] ✅ ${action.action_type} completed (action ${action.id}, rule: ${action.rule_applied})`);
    return { action_id: action.id, status: 'completed', result };
  } catch (err) {
    const retries = (action.retry_count || 0) + 1;
    const max = action.max_retries || 3;
    const st = retries >= max ? 'failed' : 'pending';
    await supabase.from('agent_actions').update({ status: st, error_message: err.message, retry_count: retries, executed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', action.id);
    console.error(`[ActionExecutor] ❌ ${action.action_type} failed (action ${action.id}): ${err.message} [retry ${retries}/${max}]`);
    return { action_id: action.id, status: st, error: err.message, retry: `${retries}/${max}` };
  }
}

export async function executeActions({ limit = 50 } = {}) {
  const startTime = Date.now();

  const { data: approvalActions } = await supabase.from('agent_actions')
    .select('*').eq('status', 'pending_approval')
    .order('created_at', { ascending: true }).limit(20);
  if (approvalActions?.length) {
    const approvalBatches = new Map();
    for (const a of approvalActions) {
      const k = a.batch_id || `s_${a.id}`;
      if (!approvalBatches.has(k)) approvalBatches.set(k, []);
      approvalBatches.get(k).push(a);
    }
    for (const [batchId, actions] of approvalBatches) {
      const { data: existing } = await supabase
        .from('groupme_approval_requests')
        .select('id')
        .eq('batch_id', batchId)
        .maybeSingle();
      if (!existing) {
        const { name, phone } = await resolveContactInfo(actions[0].target_id);
        await sendApprovalRequest(actions, name, phone).catch(err => {
          console.error(`[ActionExecutor] Approval request failed for batch ${batchId}:`, err.message);
        });
      }
    }
  }

  const { data: actions, error } = await supabase.from('agent_actions').select('*').eq('status', 'pending')
    .order('created_at', { ascending: true }).order('sequence_order', { ascending: true }).limit(limit);
  if (error) return { success: false, error: error.message };
  if (!actions?.length) return { success: true, actions_executed: 0, approval_requests_sent: approvalActions?.length || 0, elapsed_ms: Date.now() - startTime };

  const batches = new Map();
  for (const a of actions) { const k = a.batch_id || `s_${a.id}`; if (!batches.has(k)) batches.set(k, []); batches.get(k).push(a); }
  for (const b of batches.values()) b.sort((a, b) => (a.sequence_order || 0) - (b.sequence_order || 0));

  console.log(`[ActionExecutor] Executing ${actions.length} actions in ${batches.size} batches...`);
  const results = []; let completed = 0, failed = 0;
  for (const [bid, ba] of batches) {
    for (const a of ba) {
      const r = await executeSingleAction(a); results.push(r);
      if (r.status === 'completed') completed++; else if (r.status === 'failed') { failed++; break; }
    }
  }
  const elapsed = Date.now() - startTime;
  console.log(`[ActionExecutor] Done: ${completed} completed, ${failed} failed (${elapsed}ms)`);
  return { success: true, actions_executed: results.length, completed, failed, retrying: results.filter(r => r.status === 'pending').length, approval_requests_sent: approvalActions?.length || 0, results, elapsed_ms: elapsed };
}

// ═══════════════════════════════════════════════════════════════════
// EXPRESS ROUTES
// ═══════════════════════════════════════════════════════════════════

export function registerActionExecutorRoutes(app) {
  app.post('/n8n/decision-engine/execute', async (req, res) => {
    try { res.json(await executeActions({ limit: req.body?.limit || 50 })); }
    catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
  app.get('/n8n/decision-engine/execution-stats', async (req, res) => {
    try {
      const [p, a, c, f] = await Promise.all([
        supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'pending_approval'),
        supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'completed'),
        supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'failed'),
      ]);
      res.json({ pending: p.count || 0, pending_approval: a.count || 0, completed: c.count || 0, failed: f.count || 0 });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}
