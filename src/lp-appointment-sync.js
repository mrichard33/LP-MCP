/**
 * LP Appointment Sync — src/lp-appointment-sync.js
 * 
 * v4.0: Direct webhook endpoint for GHL → LP appointment synchronization.
 * Called by GHL APPT Handler workflows via HTTP action step.
 * 
 * Contains the safe lds_id resolution chain that validates every candidate
 * through the LP API before use. NEVER blindly trusts GHL custom field
 * GmAVmW6V9sekD7pVONKr (may contain in1_id from addlead).
 * 
 * Resolution chain:
 *   1. Supabase lp_leads by ghl_contact_id → most recent bookable lead → validate via LP API
 *   2. LP API GetCustomers3 by phone/email → prospect → GetLead → find bookable lead
 *   3. GHL field GmAVmW6V9sekD7pVONKr ONLY if != field 3YMxheIlPyhACB8zyc3W (in1_id) AND validates
 *   4. Graceful skip with GroupMe notification if no valid lds_id found
 * 
 * Endpoint: POST /webhook/ghl/set-lp-appointment
 * 
 * GHL Workflow HTTP Action config:
 *   URL:    https://lp-mcp-production.up.railway.app/webhook/ghl/set-lp-appointment
 *   Method: POST
 *   Body:   {
 *     "contact_id":       "{{contact.id}}",
 *     "contact_phone":    "{{contact.phone}}",
 *     "contact_email":    "{{contact.email}}",
 *     "contact_name":     "{{contact.name}}",
 *     "appointment_date": "{{appointment.start_date}}",
 *     "appointment_time": "{{appointment.start_time}}",
 *     "calendar_name":    "{{appointment.calendar_name}}"
 *   }
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

// ─── GHL API helper (mirrors action-executor.js pattern) ─────────
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
// LP LEAD ID RESOLUTION CHAIN (v4.0)
// ═══════════════════════════════════════════════════════════════════

const LP_LEAD_ID_FIELD    = 'GmAVmW6V9sekD7pVONKr';
const LP_INBOUND_ID_FIELD = '3YMxheIlPyhACB8zyc3W';
const LP_PROSPECT_ID_FIELD = 'ZRQAVrzhtzApzLlHmT87';

// Dispositions where LP will accept a SetAppointment call
const BOOKABLE_DISPOSITIONS = new Set([
  'Data', 'Issue', 'Set', 'NIS', 'NIS2', 'NI', 'BO', '1Leg', 'NoHome',
]);

/**
 * Safely resolve a REAL LP Lead ID (lds_id) for a GHL contact.
 * Every candidate is validated via LP API getLeadByLdsId before acceptance.
 * 
 * @param {string} ghlContactId — GHL Contact ID
 * @param {Object} contactInfo  — { phone, email } from GHL (avoids extra API call)
 * @returns {{ ldsId: string, prospectId: string, source: string } | null}
 */
async function resolveLPLeadId(ghlContactId, contactInfo = {}) {

  // ── Step 1: Supabase lp_leads (sync engine stores REAL lds_id values) ──
  try {
    const { data: leads } = await supabase.from('lp_leads')
      .select('lp_lead_id, lp_prospect_id, disposition_code, appointment_set, appointment_date')
      .eq('ghl_contact_id', ghlContactId)
      .order('synced_at', { ascending: false });

    if (leads?.length) {
      // Prefer the most recent lead in a bookable disposition
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

  // ── Step 2: LP API GetCustomers3 by phone/email ──
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

          if (bestLead) {
            console.log(`[LP-RESOLVE] ✅ GetCustomers3: lds_id=${bestLead.ldsId}, prospect=${bestLead.prospectId}, disp=${bestLead.disp}`);
            return { ldsId: bestLead.ldsId, prospectId: bestLead.prospectId, source: 'lp_api_customers3' };
          }
        } catch (err) {
          console.warn(`[LP-RESOLVE] GetLead for prospect ${prospectId} failed: ${err.message}`);
        }
      }
    } catch (err) {
      console.warn(`[LP-RESOLVE] GetCustomers3 failed: ${err.message}`);
    }
  }

  // ── Step 3: GHL custom field — ONLY if different from inbound ID ──
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
// DATE/TIME PARSING (shared with action-executor.js)
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

/**
 * Parse appointment date into MM/DD/YYYY format for LP API.
 */
function parseApptDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // ISO format: 2026-04-15 or 2026-04-15T10:00:00
  if (s.match(/^\d{4}-\d{2}-\d{2}/)) {
    const [y, m, d] = s.split('T')[0].split('-');
    return `${m}/${d}/${y}`;
  }
  // Already MM/DD/YYYY
  if (s.match(/^\d{2}\/\d{2}\/\d{4}$/)) return s;
  // Long format: April 15, 2026
  const longParsed = parseLongDate(s);
  if (longParsed) return longParsed;
  return s; // Return as-is, LP will reject if invalid
}

/**
 * Parse appointment time into HH:MM 24-hour format for LP API.
 */
function parseApptTime(raw) {
  if (!raw) return null;
  let t = String(raw).trim();
  // Extract time from ISO datetime
  if (t.includes('T')) t = t.split('T')[1]?.slice(0, 5) || t;
  // Convert 12-hour to 24-hour
  const match12 = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (match12) {
    let h = parseInt(match12[1], 10);
    const min = match12[2];
    const p = match12[3].toUpperCase();
    if (p === 'AM' && h === 12) h = 0;
    if (p === 'PM' && h !== 12) h += 12;
    return `${String(h).padStart(2, '0')}:${min}`;
  }
  // Already 24-hour — truncate to HH:MM
  if (t.length > 5) t = t.slice(0, 5);
  return t;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN SYNC FUNCTION
// ═══════════════════════════════════════════════════════════════════

/**
 * Sync a GHL appointment to LP.
 * 
 * @param {Object} params
 * @param {string} params.contactId      — GHL Contact ID
 * @param {string} params.contactPhone   — Contact phone
 * @param {string} params.contactEmail   — Contact email
 * @param {string} params.contactName    — Contact name
 * @param {string} params.appointmentDate — Date (any parseable format)
 * @param {string} params.appointmentTime — Time (any parseable format)
 * @param {string} params.calendarName   — Calendar name for logging
 * @returns {Object} result with action, lp_lead_id, etc.
 */
async function syncAppointmentToLP({
  contactId, contactPhone, contactEmail, contactName,
  appointmentDate, appointmentTime, calendarName,
}) {
  if (!contactId) throw new Error('contact_id is required');

  // ── Resolve LP Lead ID (v4.0 safe chain) ──
  const resolution = await resolveLPLeadId(contactId, {
    phone: contactPhone,
    email: contactEmail,
  });

  if (!resolution) {
    // Graceful skip
    const skipMsg = `⚠️ LP APPT SKIP: No valid LP Lead ID for ${contactName || contactId}. ` +
      `Lead may be in LP inbound queue or has no LP record. ` +
      `GHL: ${contactId}. Set appointment in LP manually.`;
    await sendGroupMeMessage(skipMsg).catch(() => {});
    await addGHLNote(contactId,
      `[LP SYNC] Appointment NOT synced — no valid Lead ID found.\n` +
      `Tried: Supabase cache, LP API (phone/email), GHL field.\n` +
      `Manual action: set appointment in LP directly.`
    ).catch(() => {});

    return {
      success: false,
      action: 'skipped_no_valid_lead_id',
      contact_id: contactId,
      contact_name: contactName,
    };
  }

  const { ldsId, prospectId, source } = resolution;

  // ── Write confirmed IDs back to GHL ──
  try {
    const fields = [{ id: LP_LEAD_ID_FIELD, field_value: ldsId }];
    if (prospectId) fields.push({ id: LP_PROSPECT_ID_FIELD, field_value: prospectId });
    await updateGHLContactFields(contactId, fields);
    console.log(`[LP-APPT] Wrote back lds_id=${ldsId}, prospect=${prospectId} to GHL`);
  } catch (err) {
    console.warn(`[LP-APPT] GHL writeback failed (non-blocking): ${err.message}`);
  }

  // ── Parse date/time ──
  const apptDate = parseApptDate(appointmentDate);
  const apptTime = parseApptTime(appointmentTime);
  if (!apptDate) throw new Error(`Cannot parse appointment date: ${appointmentDate}`);
  if (!apptTime) throw new Error(`Cannot parse appointment time: ${appointmentTime}`);

  // ── Duplicate check ──
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
        return {
          success: true,
          action: 'already_set_in_lp',
          lp_lead_id: ldsId,
          lp_prospect_id: prospectId,
          date: lpNorm,
          resolution_source: source,
        };
      }
    }
  } catch (err) {
    console.warn(`[LP-APPT] Duplicate check failed (non-blocking): ${err.message}`);
  }

  // ── Call LP SetAppointment ──
  console.log(`[LP-APPT] Setting: lds_id=${ldsId}, date=${apptDate}, time=${apptTime}, via=${source}`);
  const result = await lpSetAppointment({ ldsId, setBy: '5686', apptDate, apptTime });

  // ── Post-success logging ──
  await addGHLNote(contactId,
    `[LP SYNC] Appointment set (v4.0)\nLP Lead: ${ldsId} (via ${source})\nProspect: ${prospectId || 'N/A'}\nDate: ${apptDate} ${apptTime}\nCalendar: ${calendarName || 'N/A'}`
  ).catch(() => {});

  await sendGroupMeMessage(
    `📅 LP Appointment Set (v4.0)\n` +
    `👤 ${contactName || contactId}\n` +
    `📋 LP Lead: ${ldsId} (${source}) | Prospect: ${prospectId || 'N/A'}\n` +
    `📅 ${apptDate} ${apptTime} | ${calendarName || 'N/A'}`
  ).catch(() => {});

  console.log(`[LP-APPT] ✅ Done: lds_id=${ldsId}, ${apptDate} ${apptTime}`);
  return {
    success: true,
    action: 'lp_appointment_set',
    lp_lead_id: ldsId,
    lp_prospect_id: prospectId,
    appt_date: apptDate,
    appt_time: apptTime,
    calendar_name: calendarName,
    resolution_source: source,
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
   * Direct webhook for GHL APPT Handler workflows.
   * Fires immediately on appointment booking — no agentic delay.
   * 
   * Body: {
   *   contact_id:       "GHL Contact ID" (REQUIRED)
   *   contact_phone:    "Phone number"
   *   contact_email:    "Email"
   *   contact_name:     "Full name"
   *   appointment_date: "Date in any format"  (REQUIRED)
   *   appointment_time: "Time in any format"  (REQUIRED)
   *   calendar_name:    "Calendar name"
   * }
   * 
   * Returns: { success, action, lp_lead_id, ... }
   */
  app.post('/webhook/ghl/set-lp-appointment', async (req, res) => {
    const startTime = Date.now();
    try {
      const body = req.body || {};
      const contactId = body.contact_id || body.contactId;
      const appointmentDate = body.appointment_date || body.appointmentDate || body.start_date || body.startDate;
      const appointmentTime = body.appointment_time || body.appointmentTime || body.start_time || body.startTime;

      if (!contactId) {
        return res.status(400).json({ success: false, error: 'contact_id is required' });
      }
      if (!appointmentDate || !appointmentTime) {
        return res.status(400).json({ success: false, error: 'appointment_date and appointment_time are required' });
      }

      console.log(`[LP-APPT] Webhook received: contact=${contactId}, date=${appointmentDate}, time=${appointmentTime}`);

      const result = await syncAppointmentToLP({
        contactId,
        contactPhone: body.contact_phone || body.contactPhone || body.phone || '',
        contactEmail: body.contact_email || body.contactEmail || body.email || '',
        contactName: body.contact_name || body.contactName || body.name || '',
        appointmentDate,
        appointmentTime,
        calendarName: body.calendar_name || body.calendarName || body.title || '',
      });

      result.elapsed_ms = Date.now() - startTime;
      res.json(result);

    } catch (err) {
      console.error(`[LP-APPT] Webhook error: ${err.message}`);
      // Notify on failure so it doesn't go unnoticed
      await sendGroupMeMessage(`❌ LP APPT SYNC FAILED: ${err.message}\nContact: ${req.body?.contact_id || 'unknown'}`).catch(() => {});
      res.status(500).json({
        success: false,
        error: err.message,
        elapsed_ms: Date.now() - startTime,
      });
    }
  });

  console.log('[LP-APPT] Registered: POST /webhook/ghl/set-lp-appointment');
}

// Export for potential reuse by action-executor
export { resolveLPLeadId, syncAppointmentToLP };
