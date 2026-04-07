/**
 * Action Executor — src/action-executor.js
 * 
 * Layer 2 of the agentic system. Reads pending actions from agent_actions
 * and executes them against GHL, LP, GroupMe, and other systems.
 * 
 * Supported action types (11):
 *   add_tag              → POST /contacts/{id}/tags (additive, never PUT)
 *   remove_tag           → DELETE /contacts/{id}/tags (single tag or batch array)
 *   move_opportunity     → Find opp by contact, PUT /opportunities/{oppId} with pipelineStageId
 *   remove_from_workflow → Remove contact from GHL workflow or add to "Remove All" workflow
 *   add_to_workflow      → POST /contacts/{id}/workflow/{wfId} — enroll contact in GHL workflow
 *   book_appointment     → POST /calendars/events/appointments — book GHL calendar appointment
 *   cancel_appointment   → PUT /calendars/events/appointments/{id} — cancel/update GHL appointment
 *   create_task          → Add GHL note + GroupMe notification (GHL has no task API)
 *   send_notification    → GroupMe message to sales channel
 *   set_lp_appointment   → Push appointment to LP via SetAppointment API (Phase 2 write)
 *   update_custom_fields → PUT /contacts/{id} with customFields array
 *
 * v3.4 — GHL Rate Limiter integration.
 *   ghlFetch now acquires a token before each call and reports 429s to the
 *   shared rate limiter. Prevents the 429 feedback loop that burned through
 *   GHL's rate limit. Stats endpoint at GET /n8n/rate-limiter/stats.
 *
 * v3.3 — Enrich send_notification with contact name + LP Prospect ID.
 * v3.2 — Batch tag removal to avoid GHL 429 rate limits.
 * v3.1 — Fix set_lp_appointment date/time resolution for webhook payloads.
 * v3.0 — TIER 1 AGENTIC: add_to_workflow, book_appointment, cancel_appointment.
 * v2.5 — LP appointment pre-check.
 * v2.4 — Fix appointment date/time resolution.
 * v2.3 — Template interpolation for action payloads.
 */

import supabase from './supabase.js';
import { applyGHLTag, addGHLNote, updateGHLContactFields } from './ghl.js';
import { setAppointment as lpSetAppointment } from './lp-client.js';
import { sendGroupMeMessage, sendApprovalRequest } from './groupme.js';
import { acquireToken, report429, registerRateLimiterRoutes } from './ghl-rate-limiter.js';

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

// ═══════════════════════════════════════════════════════════════════
// CALENDAR MAP — Maps friendly names to GHL calendar IDs
// ═══════════════════════════════════════════════════════════════════

const CALENDAR_MAP = {
  'Review Session':            'DQYMaJ22N6zL4SXjHukw',
  'Measurement Verification':  'zEdPmkNccR2ovo3rQAd3',
  'Window Estimate':           'aJj14ONxh1oFyDcQ706O',
  'Home Protection Assessment':'zS1wg0JqQ1zsszJyJqKX',
  'Confirmation Call':         'gFWoSQrlKIdfRbAPV842',
};

const REMOVE_ALL_MARKETING_WF = '07a657bd-0492-4137-a831-babfa608c902';

/**
 * v3.4: Rate-limited GHL fetch.
 * Acquires a token from the shared rate limiter before each call.
 * On 429: reports to the rate limiter (drains bucket + pauses 30s).
 */
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
// CONTACT + LP PROSPECT RESOLVER
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

async function resolveLPProspectId(contactId) {
  if (!contactId) return null;
  try {
    const { data: lpLead } = await supabase.from('lp_leads')
      .select('lp_prospect_id')
      .eq('ghl_contact_id', contactId)
      .order('synced_at', { ascending: false })
      .limit(1).maybeSingle();
    return lpLead?.lp_prospect_id ? String(lpLead.lp_prospect_id) : null;
  } catch { return null; }
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
  const contactId = action.target_id;
  const { name, phone } = await resolveContactInfo(contactId);
  const prospectId = await resolveLPProspectId(contactId);

  const enrichedContext = {
    ...context,
    contact_name: name || 'Unknown',
    contact_id: contactId,
    contact_phone: phone || '',
    lp_prospect_id: prospectId || 'N/A',
  };

  const payload = interpolatePayload(action.action_payload, enrichedContext);
  const message = payload?.message || 'Agent notification';

  const hasContactBlock = message.includes('Name:') || message.includes('Contact ID:');
  const full = hasContactBlock
    ? `🤖 ${message}`
    : `🤖 ${message}\nName: ${name || 'Unknown'}\nContact ID: ${contactId}${prospectId ? `\nProspect ID: ${prospectId}` : ''}`;

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
// LP APPOINTMENT WRITEBACK
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
  if (longParsed) {
    const [m, d, y] = longParsed.split('/');
    return `${y}-${m}-${d}`;
  }
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

  let rawDate = payload.appt_date || payload.appointment_date
    || eventPayload.appt_date || eventPayload.appointment_date
    || eventPayload.startDate || eventPayload.start_date
    || null;
  if (!rawDate && eventPayload.start_time && String(eventPayload.start_time).includes('T')) {
    rawDate = eventPayload.start_time;
  }
  if (!rawDate && contactId) {
    const ghlRes = await ghlFetch('GET', `/contacts/${contactId}`);
    rawDate = ghlRes?.contact?.last_appointment_start_date || ghlRes?.contact?.lastAppointmentStartDate || null;
  }
  if (!rawDate) throw new Error('Cannot resolve appointment date');

  let apptDate;
  if (rawDate.includes('-')) {
    const [y, m, d] = rawDate.split('T')[0].split('-');
    apptDate = `${m}/${d}/${y}`;
  } else {
    const longParsed = parseLongDate(rawDate);
    apptDate = longParsed || rawDate;
  }

  let rawTime = payload.appt_time || payload.appointment_time
    || eventPayload.appt_time || eventPayload.appointment_time
    || null;
  if (!rawTime && eventPayload.start_time) {
    const st = String(eventPayload.start_time);
    if (st.includes('T')) {
      rawTime = st.split('T')[1]?.slice(0, 5);
    } else {
      rawTime = st;
    }
  }
  if (!rawTime && contactId) {
    const ghlRes = await ghlFetch('GET', `/contacts/${contactId}`);
    rawTime = ghlRes?.contact?.last_appointment_start_time || ghlRes?.contact?.lastAppointmentStartTime || null;
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
    const { data: existingLead } = await supabase
      .from('lp_leads')
      .select('appointment_set, appointment_date')
      .eq('lp_lead_id', lpLeadId)
      .maybeSingle();

    if (existingLead?.appointment_set && existingLead.appointment_date) {
      const lpDateNormalized = normalizeDateForComparison(existingLead.appointment_date);
      if (ghlDateNormalized && lpDateNormalized && ghlDateNormalized === lpDateNormalized) {
        console.log(`[ActionExecutor] ⏭️ LP already has appointment on ${lpDateNormalized} for lds_id=${lpLeadId}`);
        await addGHLNote(contactId, `[LP SYNC] Appointment already exists in LP — skipped\nLP Lead ID: ${lpLeadId}\nDate: ${lpDateNormalized}`).catch(() => {});
        return { action: 'already_set_in_lp', lp_lead_id: lpLeadId, lp_appointment_date: lpDateNormalized, ghl_appointment_date: ghlDateNormalized, calendar_name: calendarName, contact_id: contactId };
      }
    }
  } catch (err) {
    console.warn(`[ActionExecutor] LP pre-check failed for ${lpLeadId}: ${err.message}`);
  }

  console.log(`[ActionExecutor] LP Appointment: lds_id=${lpLeadId}, date=${apptDate}, time=${apptTime}`);
  const result = await lpSetAppointment({ ldsId: lpLeadId, setBy, apptDate, apptTime });

  await addGHLNote(contactId, `[LP SYNC] Appointment set in LP\nLP Lead ID: ${lpLeadId}\nDate: ${apptDate}\nTime: ${apptTime}\nCalendar: ${calendarName}`).catch(() => {});
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

const CONTEXT_AWARE_HANDLERS = new Set(['send_notification', 'create_task', 'book_appointment']);

const ACTION_HANDLERS = {
  add_tag: executeAddTag,
  remove_tag: executeRemoveTag,
  move_opportunity: executeMoveOpportunity,
  remove_from_workflow: executeRemoveFromWorkflow,
  add_to_workflow: executeAddToWorkflow,
  book_appointment: executeBookAppointment,
  cancel_appointment: executeCancelAppointment,
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

  // v3.4: Rate limiter stats endpoint
  registerRateLimiterRoutes(app);
}
