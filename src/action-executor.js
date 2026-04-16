/**
 * Action Executor — src/action-executor.js
 * 
 * Layer 2 of the agentic system. Reads pending actions from agent_actions
 * and executes them against GHL, LP, GroupMe, and other systems.
 * 
 * Supported action types (15):
 *   add_tag              → POST /contacts/{id}/tags (additive, never PUT)
 *   remove_tag           → DELETE /contacts/{id}/tags (single tag or batch array)
 *   move_opportunity     → Find opp by contact, PUT /opportunities/{oppId} with pipelineStageId
 *   update_opportunity   → PUT /opportunities/{oppId} with monetaryValue, source, lostReasonId (v4.1)
 *   remove_from_workflow → Remove contact from GHL workflow or add to "Remove All" workflow
 *   add_to_workflow      → POST /contacts/{id}/workflow/{wfId} — enroll contact in GHL workflow
 *   book_appointment     → POST /calendars/events/appointments — book GHL calendar appointment
 *   cancel_appointment   → PUT /calendars/events/appointments/{id} — cancel/update GHL appointment
 *   create_task          → Add GHL note + GroupMe notification (GHL has no task API)
 *   send_notification    → GroupMe message to sales channel
 *   set_lp_appointment   → Push appointment to LP via SetAppointment API (Phase 2 write)
 *   update_custom_fields → PUT /contacts/{id} with customFields array
 *   update_contact_email → PUT /contacts/{id} with {email} — LP email enrichment (v9.0)
 *   calculate_time_lapse_tier → Read LP Last Contact, compute tier, apply time-lapse tag
 *   send_message         → POST to GHL incoming webhook → GHL workflow sends SMS/email
 *
 * v4.1 — update_opportunity: PUT /opportunities/{oppId} for monetaryValue, source,
 *   lostReasonId. Also supports updating contact source via PUT /contacts/{id}.
 *   Used for P2 value/source enrichment backfill and ongoing loss intelligence.
 *
 * v3.9 — Enriched GroupMe notifications and approval requests.
 *   resolveContactInfo now returns { name, phone, ghlContactId, lpLead } where
 *   lpLead is the full Supabase row — reused by buildNotificationEnrichment so
 *   enrichment building adds zero new lp_leads queries.
 *   New buildNotificationEnrichment pulls decision context from the event
 *   payload, lp_leads, and lead_intelligence (single query) and feeds it into
 *   both the approval-request path (sendApprovalRequest v1.2) and the executed
 *   send_notification path (buildRichNotification). Reviewers can now approve
 *   from GroupMe alone without switching to GHL/LP.
 *   Known limitation: for multi-event approval batches, enrichment reflects
 *   only the first action's triggering event.
 *
 * v3.8 — LP Lead ID detection in resolvers.
 * v3.7 — Event payload fallback for contact name resolution.
 * v3.6 — Direct LP API lookup for Prospect ID.
 * v3.5 — Guaranteed contact name fallback (GHL → Supabase → contact ID).
 * v3.4 — GHL Rate Limiter integration.
 * v3.3 — Enrich send_notification with contact name + LP Prospect ID.
 * v3.2 — Batch tag removal to avoid GHL 429 rate limits.
 * v3.1 — Fix set_lp_appointment date/time resolution for webhook payloads.
 * v3.0 — TIER 1 AGENTIC: add_to_workflow, book_appointment, cancel_appointment.
 */

import supabase from './supabase.js';
import { applyGHLTag, addGHLNote, updateGHLContactFields, updateGHLContactEmail, getGHLContact } from './ghl.js';
import { setAppointment as lpSetAppointment, getLeadByLdsId } from './lp-client.js';
import { resolveLPLeadId } from './lp-appointment-sync.js';
import { sendGroupMeMessage, sendApprovalRequest } from './groupme.js';
import { acquireToken, report429, registerRateLimiterRoutes } from './ghl-rate-limiter.js';
import { formatPhone, formatDateTime } from './format-helpers.js';
import { executeSendMessage } from './send-message-handler.js';
import { checkForwardOnly } from './pipeline-guard.js';

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = 'SsBG7j5KQAIP1SFP2Sca';

// ═══════════════════════════════════════════════════════════════════
// ID TYPE DETECTION
// ═══════════════════════════════════════════════════════════════════

function isLPLeadId(id) {
  return id && /^\d+$/.test(String(id));
}

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

const CALENDAR_MAP = {
  'Review Session':            'DQYMaJ22N6zL4SXjHukw',
  'Measurement Verification':  'zEdPmkNccR2ovo3rQAd3',
  'Window Estimate':           'aJj14ONxh1oFyDcQ706O',
  'Home Protection Assessment':'zS1wg0JqQ1zsszJyJqKX',
  'Confirmation Call':         'gFWoSQrlKIdfRbAPV842',
};

const REMOVE_ALL_MARKETING_WF = '07a657bd-0492-4137-a831-babfa608c902';

async function ghlFetch(method, path, body = null) {
  if (!GHL_API_KEY) throw new Error('GHL_API_KEY not configured');
  await acquireToken();
  const url = `https://services.leadconnectorhq.com${path}`;
  const opts = { method, headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Content-Type': 'application/json', 'Accept': 'application/json' }, signal: AbortSignal.timeout(15000) };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (res.status === 429) {
    report429();
    const text = await res.text().catch(() => '');
    throw new Error(`GHL ${method} ${path} → 429: ${text.slice(0, 200)}`);
  }
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
// CONTACT + LP PROSPECT RESOLVER — with guaranteed fallback chain
// ═══════════════════════════════════════════════════════════════════

async function resolveContactInfo(contactId, eventContext = {}) {
  if (!contactId) return { name: 'Unknown', phone: null, ghlContactId: null, lpLead: null };

  const LP_LEAD_COLUMNS = 'lp_lead_id, lp_prospect_id, ghl_contact_id, first_name, last_name, phone, ' +
    'lead_source, lead_source_detail, disposition_code, disposition_label, rep_name, ' +
    'appointment_set, appointment_date, demo_completed';

  if (isLPLeadId(contactId)) {
    let lpLeadRow = null;
    try {
      const { data: lpLead } = await supabase.from('lp_leads')
        .select(LP_LEAD_COLUMNS)
        .eq('lp_lead_id', contactId)
        .maybeSingle();
      if (lpLead) {
        lpLeadRow = lpLead;
        const name = [lpLead.first_name, lpLead.last_name].filter(Boolean).join(' ') || null;
        if (name) return { name, phone: lpLead.phone || null, ghlContactId: lpLead.ghl_contact_id || null, lpLead: lpLeadRow };
      }
    } catch {}
    try {
      const result = await getLeadByLdsId(contactId);
      const prospects = Array.isArray(result) ? result : [result];
      for (const p of prospects) {
        if (!p) continue;
        const name = [p.FirstName || p.firstname, p.LastName || p.lastname].filter(Boolean).join(' ') || null;
        if (name) return { name, phone: p.Phone || p.phone || null, ghlContactId: lpLeadRow?.ghl_contact_id || null, lpLead: lpLeadRow };
      }
    } catch {}
    const payloadName = eventContext.contactName || eventContext.contact_name || eventContext.lead_name || eventContext.leadName || null;
    if (payloadName) return { name: payloadName, phone: null, ghlContactId: lpLeadRow?.ghl_contact_id || null, lpLead: lpLeadRow };
    return { name: `LP Lead ${contactId}`, phone: null, ghlContactId: lpLeadRow?.ghl_contact_id || null, lpLead: lpLeadRow };
  }

  let lpLeadRow = null;
  try {
    const { data: lpLead } = await supabase.from('lp_leads')
      .select(LP_LEAD_COLUMNS)
      .eq('ghl_contact_id', contactId)
      .order('synced_at', { ascending: false })
      .limit(1).maybeSingle();
    if (lpLead) lpLeadRow = lpLead;
  } catch {}

  try {
    const ghlRes = await ghlFetch('GET', `/contacts/${contactId}`);
    const c = ghlRes?.contact || {};
    const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.name || null;
    const phone = c.phone || null;
    if (name) return { name, phone, ghlContactId: contactId, lpLead: lpLeadRow };
  } catch {}

  if (lpLeadRow) {
    const name = [lpLeadRow.first_name, lpLeadRow.last_name].filter(Boolean).join(' ') || null;
    if (name) return { name, phone: lpLeadRow.phone || null, ghlContactId: contactId, lpLead: lpLeadRow };
  }

  const payloadName = eventContext.contactName || eventContext.contact_name || eventContext.lead_name || eventContext.leadName || null;
  if (payloadName && payloadName !== contactId) {
    return { name: payloadName, phone: null, ghlContactId: contactId, lpLead: lpLeadRow };
  }

  return { name: contactId, phone: null, ghlContactId: contactId, lpLead: lpLeadRow };
}

async function resolveLPProspectId(contactId) {
  if (!contactId) return 'Not in LP';

  let lpLeadId = null;
  let cachedProspectId = null;

  if (isLPLeadId(contactId)) {
    lpLeadId = contactId;
    try {
      const { data: lpLead } = await supabase.from('lp_leads')
        .select('lp_prospect_id')
        .eq('lp_lead_id', contactId)
        .maybeSingle();
      cachedProspectId = lpLead?.lp_prospect_id ? String(lpLead.lp_prospect_id) : null;
    } catch {}
  } else {
    try {
      const { data: lpLead } = await supabase.from('lp_leads')
        .select('lp_lead_id, lp_prospect_id')
        .eq('ghl_contact_id', contactId)
        .order('synced_at', { ascending: false })
        .limit(1).maybeSingle();
      lpLeadId = lpLead?.lp_lead_id || null;
      cachedProspectId = lpLead?.lp_prospect_id ? String(lpLead.lp_prospect_id) : null;
    } catch {}
  }

  if (!lpLeadId) return 'Not in LP';

  try {
    const result = await getLeadByLdsId(lpLeadId);
    const prospects = Array.isArray(result) ? result : [result];
    for (const prospect of prospects) {
      if (!prospect) continue;
      const pid = prospect.ProspectID || prospect.prospectid || prospect.CstID
        || prospect.cst_id || prospect.prospectId || null;
      if (pid) {
        console.log(`[ActionExecutor] LP API resolved prospect ID: ${pid} for lead ${lpLeadId}`);
        return String(pid);
      }
    }
  } catch (err) {
    console.warn(`[ActionExecutor] LP API prospect lookup failed for lead ${lpLeadId}: ${err.message}`);
  }

  if (cachedProspectId) {
    console.log(`[ActionExecutor] Using cached prospect ID: ${cachedProspectId} for lead ${lpLeadId}`);
    return cachedProspectId;
  }

  return 'Not in LP';
}

// ═══════════════════════════════════════════════════════════════════
// v3.9: NOTIFICATION ENRICHMENT BUILDER
// ═══════════════════════════════════════════════════════════════════

async function buildNotificationEnrichment(contactId, context = {}, { lpLead = null, prospectId = null, ghlContactId = null } = {}) {
  const enrichment = {
    messageText: context.message_text || context.messageText || context.body || null,
    messageType: context.message_type || context.messageType || null,
    lpSource: null,
    repName: null,
    disposition: null,
    prospectId: prospectId && prospectId !== 'Not in LP' ? prospectId : null,
    score: context.score || context.intent_score || null,
    tier: context.tier || context.intent_tier || null,
    barrier: context.barrier || context.psychological_barrier || null,
    briefing: context.briefing || context.rep_briefing || null,
    aiSummary: context.ai_summary || context.ai_reasoning || null,
    objection: context.objection_type || null,
    appointmentDate: context.start_time || context.appointment_date || null,
    calendarName: context.calendar_name || null,
  };

  if (lpLead) {
    if (!enrichment.lpSource) enrichment.lpSource = lpLead.lead_source_detail || lpLead.lead_source || null;
    if (!enrichment.repName) enrichment.repName = lpLead.rep_name || null;
    if (!enrichment.disposition) enrichment.disposition = lpLead.disposition_label || lpLead.disposition_code || null;
    if (!enrichment.appointmentDate) enrichment.appointmentDate = lpLead.appointment_date || null;
  }

  const intelKey = ghlContactId || (lpLead?.ghl_contact_id) || (isLPLeadId(contactId) ? null : contactId);
  if (intelKey) {
    try {
      const { data: intel } = await supabase.from('lead_intelligence')
        .select('intent_score, intent_tier, objection_type, psychological_barrier, rep_briefing, ai_reasoning')
        .eq('ghl_contact_id', intelKey)
        .maybeSingle();
      if (intel) {
        if (!enrichment.score) enrichment.score = intel.intent_score || null;
        if (!enrichment.tier) enrichment.tier = intel.intent_tier || null;
        if (!enrichment.barrier) enrichment.barrier = intel.psychological_barrier || null;
        if (!enrichment.briefing) enrichment.briefing = intel.rep_briefing || null;
        if (!enrichment.aiSummary) enrichment.aiSummary = intel.ai_reasoning || null;
        if (!enrichment.objection) enrichment.objection = intel.objection_type || null;
      }
    } catch {}
  }

  return enrichment;
}

function buildRichNotification({ baseMessage, name, phone, contactId, prospectId, enrichment = {} }) {
  const lines = [];
  lines.push(`🤖 ${baseMessage}`);
  const displayPhone = formatPhone(phone);
  const nameLine = `👤 ${name || 'Unknown'}${displayPhone ? ` ${displayPhone}` : ''}`;
  lines.push(nameLine);
  const idLabel = isLPLeadId(contactId) ? 'LP Lead ID' : 'Contact ID';
  const idParts = [`${idLabel}: ${contactId}`];
  if (prospectId && prospectId !== 'Not in LP') idParts.push(`Prospect: ${prospectId}`);
  lines.push(`   ${idParts.join(' | ')}`);
  if (enrichment.messageText) {
    const msg = String(enrichment.messageText).slice(0, 120);
    const suffix = enrichment.messageType ? ` [${enrichment.messageType}]` : '';
    lines.push(`💬 "${msg}"${suffix}`);
  }
  const lpParts = [];
  if (enrichment.lpSource) lpParts.push(`Src: ${enrichment.lpSource}`);
  if (enrichment.repName) lpParts.push(`Rep: ${enrichment.repName}`);
  if (enrichment.disposition) lpParts.push(`Disp: ${enrichment.disposition}`);
  if (lpParts.length) lines.push(`📋 ${lpParts.join(' | ')}`);
  if (enrichment.score || enrichment.tier || enrichment.barrier) {
    const intentParts = [];
    if (enrichment.score) intentParts.push(`Score: ${enrichment.score}`);
    if (enrichment.tier) intentParts.push(`Tier: ${enrichment.tier}`);
    if (enrichment.barrier) intentParts.push(`Barrier: ${enrichment.barrier}`);
    lines.push(`📊 ${intentParts.join(' | ')}`);
  }
  if (enrichment.appointmentDate) {
    const prefix = enrichment.calendarName ? `${enrichment.calendarName}: ` : '';
    const displayDate = formatDateTime(enrichment.appointmentDate) || enrichment.appointmentDate;
    lines.push(`📅 ${prefix}${displayDate}`);
  }
  return lines.join('\n');
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
  const payload = action.action_payload || {};
  const tags = payload.tags || (payload.tag ? [payload.tag] : []);
  if (!contactId || tags.length === 0) throw new Error('Missing contactId or tag/tags');
  await ghlFetch('DELETE', `/contacts/${contactId}/tags`, { tags });
  if (tags.length === 1) {
    return { tag_removed: tags[0], contact_id: contactId };
  }
  console.log(`[ActionExecutor] ✅ Batch removed ${tags.length} tags from ${contactId}`);
  return { tags_removed: tags.length, tags, contact_id: contactId };
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
    // v4.0: Forward-only guard — prevent backward pipeline movement
    const guard = checkForwardOnly(opps[0].pipelineStageId, stageId);
    if (!guard.allowed) {
      console.log(`[ActionExecutor] ⏭️ Forward-only: ${pipeline} opp at pos ${guard.currentPos}, target pos ${guard.targetPos} — ${guard.reason}`);
      return { action: 'skipped_forward_only', opportunity_id: opps[0].id, pipeline, current_position: guard.currentPos, target_position: guard.targetPos, target_stage: stage, reason: guard.reason };
    }
    await ghlFetch('PUT', `/opportunities/${opps[0].id}`, { pipelineStageId: stageId, status: status || 'open' });
    return { action: 'updated', opportunity_id: opps[0].id, pipeline, stage, status };
  } else {
    const contactRes = await ghlFetch('GET', `/contacts/${contactId}`);
    const name = contactRes?.contact?.name || contactRes?.contact?.firstName || 'Unknown';
    const newOpp = await ghlFetch('POST', '/opportunities/', { pipelineId, pipelineStageId: stageId, locationId: GHL_LOCATION_ID, contactId, name, status: status || 'open' });
    return { action: 'created', opportunity_id: newOpp?.opportunity?.id, pipeline, stage, status };
  }
}

// ═══════════════════════════════════════════════════════════════════
// v4.1: UPDATE OPPORTUNITY — monetaryValue, source, lostReasonId
// ═══════════════════════════════════════════════════════════════════

/**
 * v4.1: Update opportunity details that move_opportunity doesn't handle.
 * Supports: monetaryValue, source, lostReasonId, status, name.
 * 
 * Payload options:
 *   opportunity_id  — direct opp ID (fastest, skips search)
 *   pipeline        — "P1"/"P2"/"P3" (used with contactId to find opp)
 *   monetaryValue   — numeric sale amount
 *   source          — opportunity source string
 *   lostReasonId    — GHL native lost reason ID
 *   status          — open/won/lost/abandoned
 *   contact_source  — if provided, also updates the GHL contact's source field
 *   contact_custom_fields — [{id, field_value}] to update on the contact
 */
async function executeUpdateOpportunity(action) {
  const contactId = action.target_id;
  const payload = action.action_payload || {};
  
  let oppId = payload.opportunity_id;
  
  // If no direct opp ID, search by contact + pipeline
  if (!oppId) {
    const pipeline = payload.pipeline;
    if (!contactId || !pipeline) throw new Error('Missing opportunity_id or contactId+pipeline');
    const pipelineId = PIPELINE_IDS[pipeline];
    if (!pipelineId) throw new Error(`Unknown pipeline: ${pipeline}`);
    
    const searchRes = await ghlFetch('GET', `/opportunities/search?location_id=${GHL_LOCATION_ID}&contact_id=${contactId}&pipeline_id=${pipelineId}`);
    const opps = searchRes?.opportunities || [];
    if (opps.length === 0) throw new Error(`No ${pipeline} opportunity found for contact ${contactId}`);
    oppId = opps[0].id;
  }
  
  // Build the update body — only include fields that are provided
  const updateBody = {};
  if (payload.monetaryValue !== undefined && payload.monetaryValue !== null) {
    updateBody.monetaryValue = Number(payload.monetaryValue);
  }
  if (payload.source) {
    updateBody.source = payload.source;
  }
  if (payload.lostReasonId) {
    updateBody.lostReasonId = payload.lostReasonId;
  }
  if (payload.status) {
    updateBody.status = payload.status;
  }
  if (payload.name) {
    updateBody.name = payload.name;
  }
  
  if (Object.keys(updateBody).length === 0 && !payload.contact_source && !payload.contact_custom_fields) {
    return { action: 'skipped_no_fields', opportunity_id: oppId, contact_id: contactId };
  }
  
  // Update the opportunity
  let oppResult = null;
  if (Object.keys(updateBody).length > 0) {
    oppResult = await ghlFetch('PUT', `/opportunities/${oppId}`, updateBody);
    console.log(`[ActionExecutor] ✅ update_opportunity: opp ${oppId} updated — ${Object.keys(updateBody).join(', ')}`);
  }
  
  // Optionally update contact source (core field, not custom field)
  if (payload.contact_source && contactId && !isLPLeadId(contactId)) {
    await ghlFetch('PUT', `/contacts/${contactId}`, { source: payload.contact_source });
    console.log(`[ActionExecutor] ✅ update_opportunity: contact ${contactId} source → "${payload.contact_source}"`);
  }
  
  // Optionally update contact custom fields (e.g., LP Gross Sale Amount)
  if (payload.contact_custom_fields && Array.isArray(payload.contact_custom_fields) && contactId && !isLPLeadId(contactId)) {
    await updateGHLContactFields(contactId, payload.contact_custom_fields);
    console.log(`[ActionExecutor] ✅ update_opportunity: contact ${contactId} custom fields updated — ${payload.contact_custom_fields.length} fields`);
  }
  
  return {
    action: 'opportunity_updated',
    opportunity_id: oppId,
    contact_id: contactId,
    fields_updated: Object.keys(updateBody),
    contact_source_updated: !!payload.contact_source,
    contact_custom_fields_updated: payload.contact_custom_fields?.length || 0,
  };
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
  if (!isLPLeadId(contactId)) {
    await addGHLNote(contactId, noteText);
  }
  const { name, phone } = await resolveContactInfo(contactId, context);
  const contactLabel = name ? `${name}${phone ? ` (${phone})` : ''}` : contactId;
  await sendGroupMeMessage(`🤖 AGENT TASK: ${title}\nContact: ${contactLabel}`);
  return { action: 'note_added', contact_id: contactId, title };
}

async function executeSendNotification(action, context) {
  const contactId = action.target_id;
  const { name, phone, lpLead, ghlContactId } = await resolveContactInfo(contactId, context);
  const prospectId = await resolveLPProspectId(contactId);
  const enrichment = await buildNotificationEnrichment(contactId, context, { lpLead, prospectId, ghlContactId });

  const enrichedContext = {
    ...context,
    contact_name: name,
    contact_id: contactId,
    contact_phone: phone || '',
    lp_prospect_id: prospectId,
  };

  const payload = interpolatePayload(action.action_payload, enrichedContext);
  const baseMessage = payload?.message || 'Agent notification';

  const full = buildRichNotification({ baseMessage, name, phone, contactId, prospectId, enrichment });
  await sendGroupMeMessage(full);
  return { action: 'groupme_sent', message: full.slice(0, 200) };
}

// ═══════════════════════════════════════════════════════════════════
// v3.0: ADD TO WORKFLOW
// ═══════════════════════════════════════════════════════════════════

async function executeAddToWorkflow(action) {
  const contactId = action.target_id;
  const payload = action.action_payload || {};
  const wfId = payload.workflow_id;
  if (!contactId) throw new Error('Missing contactId');
  if (!wfId) throw new Error('Missing workflow_id in action payload');
  await ghlFetch('POST', `/contacts/${contactId}/workflow/${wfId}`, {});
  const wfName = payload.workflow_name || wfId;
  console.log(`[ActionExecutor] ✅ Contact ${contactId} added to workflow: ${wfName} (${wfId})`);
  return { action: 'added_to_workflow', contact_id: contactId, workflow_id: wfId, workflow_name: wfName };
}

// ═══════════════════════════════════════════════════════════════════
// v3.0: BOOK APPOINTMENT
// ═══════════════════════════════════════════════════════════════════

async function executeBookAppointment(action, context) {
  const contactId = action.target_id;
  const payload = interpolatePayload(action.action_payload, context);
  if (!contactId) throw new Error('Missing contactId');

  let calendarId = payload.calendar_id;
  if (!calendarId && payload.calendar_name) {
    calendarId = CALENDAR_MAP[payload.calendar_name];
    if (!calendarId) throw new Error(`Unknown calendar name: "${payload.calendar_name}". Valid: ${Object.keys(CALENDAR_MAP).join(', ')}`);
  }
  if (!calendarId) throw new Error('Missing calendar_id or calendar_name');

  let startTime = payload.start_time;
  if (!startTime && payload.appointment_date && payload.appointment_time) {
    const date = payload.appointment_date;
    let time = payload.appointment_time;
    let isoDate = date;
    const usMatch = date.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (usMatch) isoDate = `${usMatch[3]}-${usMatch[1]}-${usMatch[2]}`;
    const match12 = time.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (match12) {
      let h = parseInt(match12[1], 10);
      const min = match12[2], p = match12[3].toUpperCase();
      if (p === 'AM' && h === 12) h = 0;
      if (p === 'PM' && h !== 12) h += 12;
      time = `${String(h).padStart(2, '0')}:${min}`;
    }
    startTime = `${isoDate}T${time}:00-04:00`;
  }
  if (!startTime) throw new Error('Missing start_time or appointment_date+appointment_time');

  let endTime = payload.end_time;
  if (!endTime) {
    const durationMin = payload.duration_minutes || 90;
    const start = new Date(startTime);
    const end = new Date(start.getTime() + durationMin * 60000);
    endTime = end.toISOString();
  }

  const title = payload.title || payload.calendar_name || 'Appointment';
  const status = payload.status || 'new';
  const assignedUserId = payload.assigned_user_id || null;

  const body = { calendarId, locationId: GHL_LOCATION_ID, contactId, startTime, endTime, title, appointmentStatus: status, toNotify: true };
  if (assignedUserId) body.assignedUserId = assignedUserId;

  console.log(`[ActionExecutor] Booking appointment: calendar=${calendarId}, contact=${contactId}, start=${startTime}, status=${status}`);
  const result = await ghlFetch('POST', '/calendars/events/appointments', body);
  const appointmentId = result?.id || result?.appointment?.id || null;
  console.log(`[ActionExecutor] ✅ Appointment booked: id=${appointmentId}, calendar=${title}`);
  return { action: 'appointment_booked', appointment_id: appointmentId, calendar_id: calendarId, calendar_name: title, contact_id: contactId, start_time: startTime, end_time: endTime, status };
}

// ═══════════════════════════════════════════════════════════════════
// v3.0: CANCEL APPOINTMENT
// ═══════════════════════════════════════════════════════════════════

async function executeCancelAppointment(action) {
  const payload = action.action_payload || {};
  const appointmentId = payload.appointment_id;
  const newStatus = payload.status || 'cancelled';
  if (!appointmentId) throw new Error('Missing appointment_id');
  await ghlFetch('PUT', `/calendars/events/appointments/${appointmentId}`, { appointmentStatus: newStatus });
  console.log(`[ActionExecutor] ✅ Appointment ${appointmentId} status → ${newStatus}`);
  return { action: 'appointment_updated', appointment_id: appointmentId, new_status: newStatus };
}

// ═══════════════════════════════════════════════════════════════════
// LP APPOINTMENT WRITEBACK — v4.0
// ═══════════════════════════════════════════════════════════════════

const MONTH_MAP = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
};

function parseLongDate(dateStr) {
  if (!dateStr) return null;
  const match = String(dateStr).trim().match(/^(\w+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (!match) return null;
  const month = MONTH_MAP[match[1].toLowerCase()];
  if (!month) return null;
  const day = String(match[2]).padStart(2, '0');
  return `${month}/${day}/${match[3]}`;
}

function normalizeDateForComparison(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  if (s.match(/^\d{4}-\d{2}-\d{2}/)) return s.slice(0, 10);
  const usMatch = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (usMatch) return `${usMatch[3]}-${usMatch[1]}-${usMatch[2]}`;
  const longParsed = parseLongDate(s);
  if (longParsed) { const [m, d, y] = longParsed.split('/'); return `${y}-${m}-${d}`; }
  return null;
}

async function executeSetLPAppointment(action) {
  const contactId = action.target_id;
  const payload = action.action_payload || {};

  let eventPayload = {};
  if (action.event_id) {
    const { data: evt } = await supabase.from('system_events').select('payload').eq('id', action.event_id).maybeSingle();
    if (evt?.payload) eventPayload = typeof evt.payload === 'string' ? JSON.parse(evt.payload) : evt.payload;
  }

  let lpLeadId = null;
  let resolvedProspectId = null;
  let resolutionSource = 'unknown';

  if (isLPLeadId(contactId)) {
    lpLeadId = contactId;
    resolutionSource = 'target_is_lp_lead_id';
    console.log(`[LP-APPT] Target ${contactId} is LP Lead ID — using directly`);
  } else {
    let ghlContact = null;
    try {
      const ghlRes = await ghlFetch('GET', `/contacts/${contactId}`);
      ghlContact = ghlRes?.contact || null;
    } catch (err) {
      console.warn(`[LP-APPT] GHL contact fetch failed for ${contactId}: ${err.message}`);
    }

    const phone = (ghlContact?.phone || '').replace(/\D/g, '').slice(-10);
    const email = ghlContact?.email || '';
    const resolution = await resolveLPLeadId(contactId, { phone, email });

    if (!resolution) {
      const { name } = await resolveContactInfo(contactId, eventPayload);
      const skipMsg = `⚠️ LP APPT SKIP: No valid LP Lead ID for ${name || contactId}. ` +
        `Lead may still be in LP inbound queue, or has no LP record. ` +
        `GHL Contact: ${contactId}. Manual appointment set required in LP.`;
      await sendGroupMeMessage(skipMsg).catch(() => {});

      if (ghlContact) {
        await addGHLNote(contactId,
          `[LP SYNC] Appointment NOT synced to LP — no valid Lead ID found.\n` +
          `Possible causes: lead still in inbound queue, no LP match, or only in1_id available.\n` +
          `Manual action: set appointment in LP directly.`
        ).catch(() => {});
      }

      console.warn(`[LP-APPT] ⚠️ SKIPPED: No valid lds_id for contact ${contactId}`);
      return {
        action: 'skipped_no_valid_lead_id',
        contact_id: contactId,
        reason: 'No valid LP Lead ID found through any resolution path',
        resolution_attempted: ['supabase', 'lp_api_customers3', 'ghl_field'],
      };
    }

    lpLeadId = resolution.ldsId;
    resolvedProspectId = resolution.prospectId;
    resolutionSource = resolution.source;

    try {
      const writebackFields = [
        { id: 'GmAVmW6V9sekD7pVONKr', field_value: lpLeadId },
      ];
      if (resolvedProspectId) {
        writebackFields.push({ id: 'ZRQAVrzhtzApzLlHmT87', field_value: resolvedProspectId });
      }
      await updateGHLContactFields(contactId, writebackFields);
      console.log(`[LP-APPT] ✅ Wrote back confirmed lds_id=${lpLeadId}, prospect=${resolvedProspectId} to GHL`);
    } catch (err) {
      console.warn(`[LP-APPT] GHL writeback failed (non-blocking): ${err.message}`);
    }
  }

  if (!lpLeadId) throw new Error(`No LP Lead ID for contact ${contactId}`);

  let rawDate = payload.appt_date || payload.appointment_date || eventPayload.appt_date || eventPayload.appointment_date || eventPayload.startDate || eventPayload.start_date || null;
  if (!rawDate && eventPayload.start_time && String(eventPayload.start_time).includes('T')) { rawDate = eventPayload.start_time; }
  if (!rawDate && contactId && !isLPLeadId(contactId)) {
    try {
      const ghlRes = await ghlFetch('GET', `/contacts/${contactId}`);
      rawDate = ghlRes?.contact?.last_appointment_start_date || ghlRes?.contact?.lastAppointmentStartDate || null;
    } catch {}
  }
  if (!rawDate) throw new Error('Cannot resolve appointment date');

  let apptDate;
  if (rawDate.includes('-')) { const [y, m, d] = rawDate.split('T')[0].split('-'); apptDate = `${m}/${d}/${y}`; }
  else { const longParsed = parseLongDate(rawDate); apptDate = longParsed || rawDate; }

  let rawTime = payload.appt_time || payload.appointment_time || eventPayload.appt_time || eventPayload.appointment_time || null;
  if (!rawTime && eventPayload.start_time) {
    const st = String(eventPayload.start_time);
    rawTime = st.includes('T') ? st.split('T')[1]?.slice(0, 5) : st;
  }
  if (!rawTime && contactId && !isLPLeadId(contactId)) {
    try {
      const ghlRes = await ghlFetch('GET', `/contacts/${contactId}`);
      rawTime = ghlRes?.contact?.last_appointment_start_time || ghlRes?.contact?.lastAppointmentStartTime || null;
    } catch {}
  }
  if (!rawTime) throw new Error('Cannot resolve appointment time');

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

  const ghlDateNormalized = normalizeDateForComparison(rawDate);
  try {
    const { data: existingLead } = await supabase.from('lp_leads').select('appointment_set, appointment_date').eq('lp_lead_id', lpLeadId).maybeSingle();
    if (existingLead?.appointment_set && existingLead.appointment_date) {
      const lpDateNormalized = normalizeDateForComparison(existingLead.appointment_date);
      if (ghlDateNormalized && lpDateNormalized && ghlDateNormalized === lpDateNormalized) {
        console.log(`[LP-APPT] ⏭️ LP already has appointment on ${lpDateNormalized} for lds_id=${lpLeadId}`);
        if (!isLPLeadId(contactId)) {
          await addGHLNote(contactId, `[LP SYNC] Appointment already exists in LP — skipped\nLP Lead ID: ${lpLeadId}\nDate: ${lpDateNormalized}`).catch(() => {});
        }
        return { action: 'already_set_in_lp', lp_lead_id: lpLeadId, lp_appointment_date: lpDateNormalized, ghl_appointment_date: ghlDateNormalized, calendar_name: calendarName, contact_id: contactId, resolution_source: resolutionSource };
      }
    }
  } catch (err) { console.warn(`[LP-APPT] LP pre-check failed for ${lpLeadId}: ${err.message}`); }

  console.log(`[LP-APPT] Setting appointment: lds_id=${lpLeadId}, date=${apptDate}, time=${apptTime}, resolved_via=${resolutionSource}`);
  const result = await lpSetAppointment({ ldsId: lpLeadId, setBy, apptDate, apptTime });

  if (!isLPLeadId(contactId)) {
    await addGHLNote(contactId, `[LP SYNC] Appointment set in LP (v4.0)\nLP Lead ID: ${lpLeadId} (confirmed via ${resolutionSource})\nProspect ID: ${resolvedProspectId || 'N/A'}\nDate: ${apptDate}\nTime: ${apptTime}\nCalendar: ${calendarName}`).catch(() => {});
  }
  const { name } = await resolveContactInfo(contactId, eventPayload);
  await sendGroupMeMessage(`📅 LP Appointment Set (v4.0)\nContact: ${name || contactId}\nLP Lead: ${lpLeadId} (${resolutionSource})\nProspect: ${resolvedProspectId || 'N/A'}\nDate: ${apptDate} ${apptTime}\nCalendar: ${calendarName}`).catch(() => {});

  console.log(`[LP-APPT] ✅ LP appointment set: lds_id=${lpLeadId}, ${apptDate} ${apptTime}, resolved_via=${resolutionSource}`);
  return {
    action: 'lp_appointment_set',
    lp_lead_id: lpLeadId,
    lp_prospect_id: resolvedProspectId || null,
    appt_date: apptDate,
    appt_time: apptTime,
    set_by: setBy,
    calendar_name: calendarName,
    resolution_source: resolutionSource,
    lp_response: result,
    contact_id: contactId,
  };
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
// EMAIL ENRICHMENT — update core email field from LP data (v9.0)
// ═══════════════════════════════════════════════════════════════════

async function executeUpdateContactEmail(action, context) {
  const contactId = action.target_id;
  if (!contactId) throw new Error('Missing contactId');

  const payload = interpolatePayload(action.action_payload, context);
  const newEmail = payload.email || context.candidate_email;
  const confidence = Number(payload.confidence_score || context.confidence_score || 0);
  const scoringReasons = context.scoring_reasons || [];
  const sourceLeadId = payload.source_lead_id || context.source_lead_id || null;
  const lpProspectId = payload.lp_prospect_id || context.lp_prospect_id || null;

  if (!newEmail) throw new Error('Missing email in payload');

  let oldEmail = null;
  try {
    const ghlContact = await getGHLContact(contactId);
    if (ghlContact?.email) {
      oldEmail = ghlContact.email;
      const { scoreEmail } = await import('./email-scorer.js');
      const currentScore = scoreEmail(ghlContact.email);
      if (currentScore.score >= 75) {
        console.log(`[ActionExecutor] Email enrichment skipped for ${contactId}: GHL already has good email "${ghlContact.email}" (score: ${currentScore.score})`);
        try {
          await supabase.from('email_enrichment_log').insert({
            ghl_contact_id: contactId, lp_prospect_id: lpProspectId, old_email: oldEmail,
            new_email: newEmail, confidence_score: confidence, scoring_reasons: scoringReasons,
            source_lead_id: sourceLeadId, action_taken: 'skipped_ghl_has_good_email',
          });
        } catch {}
        return { action: 'email_enrichment_skipped', contact_id: contactId, reason: 'ghl_has_good_email', existing_email: ghlContact.email, existing_score: currentScore.score };
      }
    }
  } catch (err) {
    console.warn(`[ActionExecutor] GHL pre-check failed for ${contactId}: ${err.message} — proceeding with update`);
  }

  const result = await updateGHLContactEmail(contactId, newEmail);
  if (result === 'not_found') throw new Error(`GHL contact ${contactId} not found`);
  if (!result) throw new Error('GHL email update failed');

  await addGHLNote(contactId,
    `[EMAIL ENRICHMENT] Email updated from LP data\n` +
    `New: ${newEmail}\n` +
    `Confidence: ${confidence}/100\n` +
    `Source Lead: ${sourceLeadId || 'N/A'}\n` +
    `Reasons: ${scoringReasons.join(', ')}`
  ).catch(() => {});

  try {
    await supabase.from('email_enrichment_log').insert({
      ghl_contact_id: contactId, lp_prospect_id: lpProspectId, old_email: oldEmail,
      new_email: newEmail, confidence_score: confidence, scoring_reasons: scoringReasons,
      source_lead_id: sourceLeadId, action_taken: 'updated',
    });
  } catch (logErr) {
    console.warn(`[ActionExecutor] Email enrichment log failed: ${logErr.message}`);
  }

  console.log(`[ActionExecutor] ✅ Email enriched for ${contactId}: ${newEmail} (confidence: ${confidence})`);
  return { action: 'email_enriched', contact_id: contactId, new_email: newEmail, old_email: oldEmail, confidence_score: confidence };
}

// ═══════════════════════════════════════════════════════════════════
// v4.0: CALCULATE TIME-LAPSE TIER
// ═══════════════════════════════════════════════════════════════════

async function executeCalculateTimeLapseTier(action) {
  const contactId = action.target_id;
  const payload = action.action_payload || {};
  const { source_field_id, tier_thresholds, fallback_tag, fallback_strategy } = payload;

  if (!contactId) throw new Error('Missing contactId');
  if (!source_field_id) throw new Error('Missing source_field_id in payload');

  let fieldValue = null;
  const contact = await getGHLContact(contactId);
  if (contact?.customFields) {
    const field = contact.customFields.find(f => f.id === source_field_id);
    fieldValue = field?.value ?? null;
  }

  let daysSince = null;
  let tierTag = fallback_tag || 'time-lapse:cold';
  let dateMs = null;

  if (fieldValue) {
    if (typeof fieldValue === 'number' && fieldValue > 0) {
      dateMs = fieldValue;
    } else if (typeof fieldValue === 'string') {
      const parsed = new Date(fieldValue);
      if (!isNaN(parsed.getTime())) {
        dateMs = parsed.getTime();
      }
    }
  }

  if (!dateMs && fallback_strategy === 'contact_creation_date' && contact?.dateAdded) {
    const created = new Date(contact.dateAdded);
    if (!isNaN(created.getTime())) {
      dateMs = created.getTime();
      console.log(`[ActionExecutor] [TIER] Using contact creation date for ${contactId}: ${contact.dateAdded}`);
    }
  }

  if (dateMs) {
    daysSince = Math.floor((Date.now() - dateMs) / 86400000);
    if (daysSince < 0) daysSince = 0;

    if (tier_thresholds) {
      if (daysSince <= (tier_thresholds.warm?.max_days ?? 90)) {
        tierTag = tier_thresholds.warm?.tag || 'time-lapse:warm';
      } else if (daysSince <= (tier_thresholds.cool?.max_days ?? 365)) {
        tierTag = tier_thresholds.cool?.tag || 'time-lapse:cool';
      } else {
        tierTag = tier_thresholds.cold?.tag || 'time-lapse:cold';
      }
    }
  } else {
    console.log(`[ActionExecutor] [TIER] No valid date for ${contactId}, using fallback: ${tierTag}`);
  }

  await ghlFetch('POST', `/contacts/${contactId}/tags`, { tags: [tierTag] });
  console.log(`[ActionExecutor] [TIER] ${contactId}: ${daysSince ?? '?'} days → ${tierTag}`);

  return {
    action: 'time_lapse_tier_calculated',
    contact_id: contactId,
    tier: tierTag,
    days_since: daysSince,
    field_value: fieldValue,
    _context: {
      calculated_tier: tierTag.replace('time-lapse:', '').toUpperCase(),
      days_since_last_contact: daysSince !== null ? daysSince : 'unknown',
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// EXECUTOR ENGINE
// ═══════════════════════════════════════════════════════════════════

const CONTEXT_AWARE_HANDLERS = new Set(['send_notification', 'create_task', 'book_appointment', 'update_contact_email', 'send_message']);

const ACTION_HANDLERS = {
  add_tag: executeAddTag,
  remove_tag: executeRemoveTag,
  move_opportunity: executeMoveOpportunity,
  update_opportunity: executeUpdateOpportunity,
  remove_from_workflow: executeRemoveFromWorkflow,
  add_to_workflow: executeAddToWorkflow,
  book_appointment: executeBookAppointment,
  cancel_appointment: executeCancelAppointment,
  create_task: executeCreateTask,
  send_notification: executeSendNotification,
  set_lp_appointment: executeSetLPAppointment,
  update_custom_fields: executeUpdateCustomFields,
  update_contact_email: executeUpdateContactEmail,
  calculate_time_lapse_tier: executeCalculateTimeLapseTier,
  send_message: executeSendMessage,
};

async function executeSingleAction(action, batchContext = {}) {
  const handler = ACTION_HANDLERS[action.action_type];
  if (!handler) {
    await supabase.from('agent_actions').update({ status: 'failed', error_message: `Unknown action type: ${action.action_type}`, executed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', action.id);
    return { action_id: action.id, status: 'failed', error: `Unknown: ${action.action_type}` };
  }
  await supabase.from('agent_actions').update({ status: 'executing', updated_at: new Date().toISOString() }).eq('id', action.id);
  try {
    let context = {};
    if (CONTEXT_AWARE_HANDLERS.has(action.action_type)) { context = { ...(await getEventContext(action)), ...batchContext }; }
    const result = await handler(action, context);
    if (result?._context) Object.assign(batchContext, result._context);
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

  const { data: approvalActions } = await supabase.from('agent_actions').select('*').eq('status', 'pending_approval').order('created_at', { ascending: true }).limit(20);
  if (approvalActions?.length) {
    const approvalBatches = new Map();
    for (const a of approvalActions) { const k = a.batch_id || `s_${a.id}`; if (!approvalBatches.has(k)) approvalBatches.set(k, []); approvalBatches.get(k).push(a); }
    for (const [batchId, actions] of approvalBatches) {
      const { data: existing } = await supabase.from('groupme_approval_requests').select('id').eq('batch_id', batchId).maybeSingle();
      if (!existing) {
        const firstAction = actions[0];
        const { name, phone, lpLead, ghlContactId } = await resolveContactInfo(firstAction.target_id);
        const prospectId = await resolveLPProspectId(firstAction.target_id);
        const ctx = await getEventContext(firstAction);
        const enrichment = await buildNotificationEnrichment(firstAction.target_id, ctx, { lpLead, prospectId, ghlContactId });

        if (firstAction.action_type === 'send_message' && firstAction.action_payload?.requires_ai_generation) {
          try {
            const { generateResponse } = await import('./response-generator.js');
            const triggerMessage = ctx.message_text || ctx.messageText || ctx.body || 'No trigger message';
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

        await sendApprovalRequest(actions, name, phone, enrichment).catch(err => { console.error(`[ActionExecutor] Approval request failed for batch ${batchId}:`, err.message); });
      }
    }
  }

  const { data: actions, error } = await supabase.from('agent_actions').select('*').eq('status', 'pending').order('created_at', { ascending: true }).order('sequence_order', { ascending: true }).limit(limit);
  if (error) return { success: false, error: error.message };
  if (!actions?.length) return { success: true, actions_executed: 0, approval_requests_sent: approvalActions?.length || 0, elapsed_ms: Date.now() - startTime };

  const batches = new Map();
  for (const a of actions) { const k = a.batch_id || `s_${a.id}`; if (!batches.has(k)) batches.set(k, []); batches.get(k).push(a); }
  for (const b of batches.values()) b.sort((a, b) => (a.sequence_order || 0) - (b.sequence_order || 0));

  console.log(`[ActionExecutor] Executing ${actions.length} actions in ${batches.size} batches...`);
  const results = []; let completed = 0, failed = 0;
  for (const [bid, ba] of batches) {
    const batchContext = {};
    for (const a of ba) {
      const r = await executeSingleAction(a, batchContext); results.push(r);
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
  registerRateLimiterRoutes(app);
}
