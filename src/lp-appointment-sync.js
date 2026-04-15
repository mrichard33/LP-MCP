/**
 * LP Appointment Sync — src/lp-appointment-sync.js
 * 
 * v4.3: Direct webhook endpoint for GHL → LP appointment synchronization.
 * Called by GHL APPT Handler workflows via standard webhook (form-encoded).
 * 
 * v4.3: Self-enriching endpoint. GHL standard webhooks only reliably resolve
 *   {{contact.id}} — all other merge fields may arrive empty. The endpoint now
 *   makes ONE GHL API call when any field is missing, and extracts phone, email,
 *   prospect ID, and appointment date/time from the contact's custom fields.
 *   This makes the endpoint resilient regardless of webhook type.
 * 
 * Resolution chain:
 *   0. Prospect ID fast-path → GetLead by cst_id → find bookable lead
 *   1. Supabase lp_leads by ghl_contact_id → most recent bookable lead → validate via LP API
 *   2. LP API GetCustomers3 by phone/email → prospect → GetLead → find bookable lead
 *   3. GHL field GmAVmW6V9sekD7pVONKr ONLY if != field 3YMxheIlPyhACB8zyc3W (in1_id) AND validates
 *   4. Graceful skip with GroupMe notification if no valid lds_id found
 * 
 * Endpoint: POST /webhook/ghl/set-lp-appointment
 */

import supabase from './supabase.js';
import {
  setAppointment as lpSetAppointment,
  getLeadByLdsId,
  getCustomers3,
  getLeads,
} from './lp-client.js';
import { getGHLContact, updateGHLContactFields, addGHLNote } from './ghl.js';
import { sendGroupMeMessage } from './groupme.js';
import { acquireToken } from './ghl-rate-limiter.js';

const GHL_API_KEY = process.env.GHL_API_KEY;

// GHL custom field IDs
const LAST_APPT_DATE_FIELD  = 'x8KO5o89WPLfC7ivia3A';
const LAST_APPT_TIME_FIELD  = 'U67epWMNqjbf0SHAllEZ';
const LP_LEAD_ID_FIELD      = 'GmAVmW6V9sekD7pVONKr';
const LP_INBOUND_ID_FIELD   = '3YMxheIlPyhACB8zyc3W';
const LP_PROSPECT_ID_FIELD  = 'ZRQAVrzhtzApzLlHmT87';

/**
 * Clean a value from GHL webhook body.
 * GHL sends literal string "null" when a template variable doesn't resolve.
 */
function cleanGHLValue(val) {
  if (val === 'null' || val === 'undefined' || val === '' || val == null) return null;
  return String(val).trim();
}

/**
 * Extract a custom field value from GHL contact customFields array.
 */
function getCustomField(customFields, fieldId) {
  const field = customFields?.find(f => f.id === fieldId);
  return field?.value != null ? String(field.value).trim() : null;
}

// ─── GHL API helper ──────────────────────────────────────────────
async function ghlFetch(method, path, body = null) {
  if (!GHL_API_KEY) throw new Error('GHL_API_KEY not configured');
  await acquireToken();
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
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : { status: res.status, ok: true };
}

// ═══════════════════════════════════════════════════════════════════
// v4.3: SELF-ENRICHMENT FROM GHL CONTACT
// ═══════════════════════════════════════════════════════════════════

/**
 * Fetch the GHL contact and extract all fields needed for LP sync.
 * Called when the webhook body is missing critical fields (which is always
 * the case with GHL standard webhooks that don't resolve merge fields).
 * 
 * Returns an object with all extracted fields. Null values = not available.
 */
async function enrichFromGHLContact(contactId) {
  try {
    const ghlRes = await ghlFetch('GET', `/contacts/${contactId}`);
    const contact = ghlRes?.contact || {};
    const fields = contact.customFields || [];

    return {
      phone: contact.phone || null,
      email: contact.email || null,
      name: [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.name || null,
      prospectId: getCustomField(fields, LP_PROSPECT_ID_FIELD),
      appointmentDate: getCustomField(fields, LAST_APPT_DATE_FIELD),
      appointmentTime: getCustomField(fields, LAST_APPT_TIME_FIELD),
    };
  } catch (err) {
    console.warn(`[LP-APPT] GHL enrichment failed for ${contactId}: ${err.message}`);
    return { phone: null, email: null, name: null, prospectId: null, appointmentDate: null, appointmentTime: null };
  }
}

// ═══════════════════════════════════════════════════════════════════
// LP LEAD ID RESOLUTION CHAIN (v4.1)
// ═══════════════════════════════════════════════════════════════════

// Dispositions where LP will accept a SetAppointment call
const BOOKABLE_DISPOSITIONS = new Set([
  'Data', 'Issue', 'Set', 'NIS', 'NIS2', 'NI', 'BO', '1Leg', 'NoHome',
]);

/**
 * Find the best bookable lead from an array of LP lead records.
 */
function findBookableLead(leadRecords, prospectId) {
  let bestLead = null;
  for (const lead of leadRecords) {
    if (!lead) continue;
    const ldsId = lead.LeadID || lead.leadid || lead.lds_id;
    const disp = lead.Disposition || lead.disposition || lead.disp_code || '';
    if (!ldsId) continue;
    if (!bestLead) bestLead = { ldsId: String(ldsId), prospectId: String(prospectId), disp };
    if (BOOKABLE_DISPOSITIONS.has(disp)) {
      bestLead = { ldsId: String(ldsId), prospectId: String(prospectId), disp };
      break;
    }
  }
  return bestLead;
}

/**
 * Safely resolve a REAL LP Lead ID (lds_id) for a GHL contact.
 * Every candidate is validated via LP API getLeadByLdsId before acceptance.
 */
async function resolveLPLeadId(ghlContactId, contactInfo = {}) {
  const webhookProspectId = cleanGHLValue(contactInfo.prospectId);

  // ── Step 0: Prospect ID fast-path ─────────────────────────────
  if (webhookProspectId && /^\d+$/.test(webhookProspectId)) {
    try {
      const leadsResult = await getLeads({ cst_id: webhookProspectId, PageSize: 20 });
      const leadRecords = Array.isArray(leadsResult) ? leadsResult : [leadsResult];
      const best = findBookableLead(leadRecords, webhookProspectId);
      if (best) {
        console.log(`[LP-RESOLVE] ✅ Prospect ID fast-path: lds_id=${best.ldsId}, prospect=${webhookProspectId}, disp=${best.disp}`);
        return { ldsId: best.ldsId, prospectId: webhookProspectId, source: 'prospect_id_fastpath' };
      }
      console.warn(`[LP-RESOLVE] Prospect ${webhookProspectId} has no bookable leads — falling through`);
    } catch (err) {
      console.warn(`[LP-RESOLVE] Prospect ID fast-path failed for ${webhookProspectId}: ${err.message}`);
    }
  }

  // ── Step 1: Supabase lp_leads ─────────────────────────────────
  try {
    const { data: leads } = await supabase.from('lp_leads')
      .select('lp_lead_id, lp_prospect_id, disposition_code, appointment_set, appointment_date')
      .eq('ghl_contact_id', ghlContactId)
      .order('synced_at', { ascending: false });

    if (leads?.length) {
      const bookable = leads.find(l => BOOKABLE_DISPOSITIONS.has(l.disposition_code));
      const candidate = bookable || leads[0];

      if (candidate.lp_lead_id) {
        try {
          const result = await getLeadByLdsId(candidate.lp_lead_id);
          const records = Array.isArray(result) ? result : [result];
          const valid = records.find(r => r && (r.LeadID || r.leadid || r.lds_id));
          if (valid) {
            const pid = String(valid.ProspectID || valid.prospectid || valid.CstID || valid.cst_id || candidate.lp_prospect_id || '');
            console.log(`[LP-RESOLVE] ✅ Supabase: lds_id=${candidate.lp_lead_id}, prospect=${pid}, disp=${candidate.disposition_code}`);
            return { ldsId: String(candidate.lp_lead_id), prospectId: pid, source: 'supabase_validated' };
          }
        } catch (err) {
          console.warn(`[LP-RESOLVE] Supabase candidate ${candidate.lp_lead_id} failed validation: ${err.message}`);
        }
      }
    }
  } catch (err) {
    console.warn(`[LP-RESOLVE] Supabase lookup failed: ${err.message}`);
  }

  // ── Step 2: LP API GetCustomers3 by phone/email ───────────────
  const phone = (contactInfo.phone || '').replace(/\D/g, '').slice(-10);
  const email = contactInfo.email || '';

  if (phone || email) {
    try {
      const searchParams = {};
      if (phone) searchParams.phone = phone;
      if (email) searchParams.email = email;
      const prospects = await getCustomers3(searchParams);
      const prospectList = Array.isArray(prospects) ? prospects : [prospects];

      for (const prospect of prospectList) {
        if (!prospect) continue;
        const prospectId = prospect.ProspectID || prospect.prospectid || prospect.CstID || prospect.cst_id;
        if (!prospectId) continue;

        try {
          const leadsResult = await getLeads({ cst_id: prospectId, PageSize: 20 });
          const leadRecords = Array.isArray(leadsResult) ? leadsResult : [leadsResult];
          const best = findBookableLead(leadRecords, prospectId);
          if (best) {
            console.log(`[LP-RESOLVE] ✅ GetCustomers3: lds_id=${best.ldsId}, prospect=${best.prospectId}, disp=${best.disp}`);
            return { ldsId: best.ldsId, prospectId: best.prospectId, source: 'lp_api_customers3' };
          }
        } catch (err) {
          console.warn(`[LP-RESOLVE] GetLead for prospect ${prospectId} failed: ${err.message}`);
        }
      }
    } catch (err) {
      console.warn(`[LP-RESOLVE] GetCustomers3 failed: ${err.message}`);
    }
  }

  // ── Step 3: GHL custom field — ONLY if validates via LP API ───
  try {
    const ghlRes = await ghlFetch('GET', `/contacts/${ghlContactId}`);
    const customFields = ghlRes?.contact?.customFields || [];
    const leadIdField = customFields.find(f => f.id === LP_LEAD_ID_FIELD);
    const inboundIdField = customFields.find(f => f.id === LP_INBOUND_ID_FIELD);
    const ghlLeadId = leadIdField?.value ? String(leadIdField.value) : null;
    const ghlInboundId = inboundIdField?.value ? String(inboundIdField.value) : null;

    if (ghlLeadId) {
      if (ghlInboundId && ghlLeadId === ghlInboundId) {
        console.warn(`[LP-RESOLVE] ⚠️ GHL field matches inbound ID (${ghlLeadId}) — skipping`);
      } else {
        const result = await getLeadByLdsId(ghlLeadId);
        const records = Array.isArray(result) ? result : [result];
        const valid = records.find(r => r && (r.LeadID || r.leadid || r.lds_id));
        if (valid) {
          const pid = String(valid.ProspectID || valid.prospectid || valid.CstID || valid.cst_id || '');
          console.log(`[LP-RESOLVE] ✅ GHL field (validated): lds_id=${ghlLeadId}, prospect=${pid}`);
          return { ldsId: ghlLeadId, prospectId: pid, source: 'ghl_field_validated' };
        } else {
          console.warn(`[LP-RESOLVE] ⚠️ GHL field ${ghlLeadId} failed validation — likely in1_id`);
        }
      }
    }
  } catch (err) {
    console.warn(`[LP-RESOLVE] GHL field check failed: ${err.message}`);
  }

  console.warn(`[LP-RESOLVE] ❌ No valid lds_id for ${ghlContactId}`);
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// DATE/TIME PARSING
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

function parseApptDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (s.match(/^\d{4}-\d{2}-\d{2}/)) {
    const [y, m, d] = s.split('T')[0].split('-');
    return `${m}/${d}/${y}`;
  }
  if (s.match(/^\d{2}\/\d{2}\/\d{4}$/)) return s;
  const longParsed = parseLongDate(s);
  if (longParsed) return longParsed;
  return s;
}

function parseApptTime(raw) {
  if (!raw) return null;
  let t = String(raw).trim();
  if (t.includes('T')) t = t.split('T')[1]?.slice(0, 5) || t;
  const match12 = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (match12) {
    let h = parseInt(match12[1], 10);
    const min = match12[2];
    const p = match12[3].toUpperCase();
    if (p === 'AM' && h === 12) h = 0;
    if (p === 'PM' && h !== 12) h += 12;
    return `${String(h).padStart(2, '0')}:${min}`;
  }
  if (t.length > 5) t = t.slice(0, 5);
  return t;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN SYNC FUNCTION
// ═══════════════════════════════════════════════════════════════════

async function syncAppointmentToLP({
  contactId, contactPhone, contactEmail, contactName,
  prospectId: webhookProspectId,
  appointmentDate, appointmentTime, calendarName,
}) {
  if (!contactId) throw new Error('contact_id is required');

  const resolution = await resolveLPLeadId(contactId, {
    phone: contactPhone,
    email: contactEmail,
    prospectId: webhookProspectId,
  });

  if (!resolution) {
    const skipMsg = `⚠️ LP APPT SKIP: No valid LP Lead ID for ${contactName || contactId}. ` +
      `Lead may be in LP inbound queue or has no LP record. ` +
      `GHL: ${contactId}. Set appointment in LP manually.`;
    await sendGroupMeMessage(skipMsg).catch(() => {});
    await addGHLNote(contactId,
      `[LP SYNC] Appointment NOT synced — no valid Lead ID found.\n` +
      `Tried: prospect fast-path, Supabase cache, LP API (phone/email), GHL field.\n` +
      `Manual action: set appointment in LP directly.`
    ).catch(() => {});
    return { success: false, action: 'skipped_no_valid_lead_id', contact_id: contactId, contact_name: contactName };
  }

  const { ldsId, prospectId, source } = resolution;

  // Write confirmed IDs back to GHL
  try {
    const fields = [{ id: LP_LEAD_ID_FIELD, field_value: ldsId }];
    if (prospectId) fields.push({ id: LP_PROSPECT_ID_FIELD, field_value: prospectId });
    await updateGHLContactFields(contactId, fields);
    console.log(`[LP-APPT] Wrote back lds_id=${ldsId}, prospect=${prospectId} to GHL`);
  } catch (err) {
    console.warn(`[LP-APPT] GHL writeback failed (non-blocking): ${err.message}`);
  }

  const apptDate = parseApptDate(appointmentDate);
  const apptTime = parseApptTime(appointmentTime);
  if (!apptDate) throw new Error(`Cannot parse appointment date: ${appointmentDate}`);
  if (!apptTime) throw new Error(`Cannot parse appointment time: ${appointmentTime}`);

  // Duplicate check
  try {
    const { data: existing } = await supabase.from('lp_leads')
      .select('appointment_set, appointment_date')
      .eq('lp_lead_id', ldsId)
      .maybeSingle();
    if (existing?.appointment_set && existing.appointment_date) {
      const lpNorm = normalizeDateForComparison(existing.appointment_date);
      const ghlNorm = normalizeDateForComparison(appointmentDate);
      if (lpNorm && ghlNorm && lpNorm === ghlNorm) {
        console.log(`[LP-APPT] ⏭️ Already set on ${lpNorm} for lds_id=${ldsId}`);
        await addGHLNote(contactId,
          `[LP SYNC] Appointment already exists in LP — skipped\nLP Lead: ${ldsId} | Date: ${lpNorm}`
        ).catch(() => {});
        return { success: true, action: 'already_set_in_lp', lp_lead_id: ldsId, lp_prospect_id: prospectId, date: lpNorm, resolution_source: source };
      }
    }
  } catch (err) {
    console.warn(`[LP-APPT] Duplicate check failed (non-blocking): ${err.message}`);
  }

  console.log(`[LP-APPT] Setting: lds_id=${ldsId}, date=${apptDate}, time=${apptTime}, via=${source}`);
  const result = await lpSetAppointment({ ldsId, setBy: '5686', apptDate, apptTime });

  await addGHLNote(contactId,
    `[LP SYNC] Appointment set (v4.3)\nLP Lead: ${ldsId} (via ${source})\nProspect: ${prospectId || 'N/A'}\nDate: ${apptDate} ${apptTime}\nCalendar: ${calendarName || 'N/A'}`
  ).catch(() => {});

  await sendGroupMeMessage(
    `📅 LP Appointment Set (v4.3)\n` +
    `👤 ${contactName || contactId}\n` +
    `📋 LP Lead: ${ldsId} (${source}) | Prospect: ${prospectId || 'N/A'}\n` +
    `📅 ${apptDate} ${apptTime} | ${calendarName || 'N/A'}`
  ).catch(() => {});

  console.log(`[LP-APPT] ✅ Done: lds_id=${ldsId}, ${apptDate} ${apptTime}`);
  return {
    success: true, action: 'lp_appointment_set',
    lp_lead_id: ldsId, lp_prospect_id: prospectId,
    appt_date: apptDate, appt_time: apptTime,
    calendar_name: calendarName, resolution_source: source,
    lp_response: result,
  };
}

// ═══════════════════════════════════════════════════════════════════
// WEBHOOK ENDPOINT
// ═══════════════════════════════════════════════════════════════════

export function registerLPAppointmentSyncRoutes(app) {

  /**
   * POST /webhook/ghl/set-lp-appointment
   * 
   * v4.3: Self-enriching endpoint. Only contactId is truly required from the
   * webhook body. All other fields (phone, email, prospect ID, appointment
   * date/time) are auto-fetched from GHL API when missing.
   * 
   * GHL standard webhooks don't resolve most merge fields, so the endpoint
   * makes ONE GHL API call to get everything it needs. If fields DO arrive
   * from the webhook body, the API call is skipped.
   */
  app.post('/webhook/ghl/set-lp-appointment', async (req, res) => {
    const startTime = Date.now();
    try {
      const body = req.body || {};
      const contactId = cleanGHLValue(body.contact_id || body.contactId);

      if (!contactId) {
        return res.status(400).json({ success: false, error: 'contact_id is required' });
      }

      // Extract what we can from the webhook body
      let appointmentDate = cleanGHLValue(body.appointment_date || body.appointmentDate || body.start_date || body.startDate);
      let appointmentTime = cleanGHLValue(body.appointment_time || body.appointmentTime || body.start_time || body.startTime);
      let prospectId = cleanGHLValue(body.lp_prospect_id || body.prospect_id || body.prospectId);
      let contactPhone = cleanGHLValue(body.contact_phone || body.contactPhone || body.phone) || '';
      let contactEmail = cleanGHLValue(body.contact_email || body.contactEmail || body.email) || '';
      let contactName = cleanGHLValue(body.contact_name || body.contactName || body.name) || '';
      let calendarName = cleanGHLValue(body.calendar_name || body.calendarName || body.title) || '';

      // v4.3: Self-enrich from GHL API when critical fields are missing.
      // ONE API call fills in everything — phone, email, prospect, date, time.
      if (!appointmentDate || !appointmentTime || !prospectId || !contactPhone) {
        console.log(`[LP-APPT] Self-enriching from GHL API for ${contactId} (missing: ${[
          !appointmentDate && 'date', !appointmentTime && 'time',
          !prospectId && 'prospect', !contactPhone && 'phone',
        ].filter(Boolean).join(', ')})`);

        const enriched = await enrichFromGHLContact(contactId);

        if (!appointmentDate && enriched.appointmentDate) appointmentDate = enriched.appointmentDate;
        if (!appointmentTime && enriched.appointmentTime) appointmentTime = enriched.appointmentTime;
        if (!prospectId && enriched.prospectId) prospectId = enriched.prospectId;
        if (!contactPhone && enriched.phone) contactPhone = enriched.phone;
        if (!contactEmail && enriched.email) contactEmail = enriched.email;
        if (!contactName && enriched.name) contactName = enriched.name;

        console.log(`[LP-APPT] After enrichment: date=${appointmentDate}, time=${appointmentTime}, prospect=${prospectId || 'none'}, phone=${contactPhone ? 'yes' : 'no'}`);
      }

      if (!appointmentDate || !appointmentTime) {
        return res.status(400).json({
          success: false,
          error: 'appointment_date and appointment_time not available (checked webhook body + GHL contact)',
        });
      }

      console.log(`[LP-APPT] Webhook received: contact=${contactId}, date=${appointmentDate}, time=${appointmentTime}, prospect=${prospectId || 'none'}`);

      const result = await syncAppointmentToLP({
        contactId, contactPhone, contactEmail, contactName,
        prospectId, appointmentDate, appointmentTime, calendarName,
      });

      result.elapsed_ms = Date.now() - startTime;
      res.json(result);

    } catch (err) {
      console.error(`[LP-APPT] Webhook error: ${err.message}`);
      await sendGroupMeMessage(`❌ LP APPT SYNC FAILED: ${err.message}\nContact: ${req.body?.contact_id || req.body?.contactId || 'unknown'}`).catch(() => {});
      res.status(500).json({ success: false, error: err.message, elapsed_ms: Date.now() - startTime });
    }
  });

  console.log('[LP-APPT] Registered: POST /webhook/ghl/set-lp-appointment');
}

// Export for potential reuse by action-executor
export { resolveLPLeadId, syncAppointmentToLP };
