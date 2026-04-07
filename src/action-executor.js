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
 * v3.3 — Enrich send_notification with contact name + LP Prospect ID.
 *   Template variables: {{contact_name}}, {{contact_id}}, {{lp_lead_id}}, {{contact_phone}}
 *   Resolved from GHL API and Supabase lp_leads before interpolation.
 *
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

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = 'SsBG7j5KQAIP1SFP2Sca';

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
// CONTACT + LP LEAD RESOLVER
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

/**
 * v3.3: Resolve LP Lead ID from Supabase for a GHL contact.
 * Returns the most recent LP lead's lp_lead_id, or null.
 */
async function resolveLPLeadId(contactId) {
  if (!contactId) return null;
  try {
    const { data: lpLead } = await supabase.from('lp_leads')
      .select('lp_lead_id')
      .eq('ghl_contact_id', contactId)
      .order('synced_at', { ascending: false })
      .limit(1).maybeSingle();
    return lpLead?.lp_lead_id ? String(lpLead.lp_lead_id) : null;
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
  const { pipeline