/**
 * LP Appointment Sync — src/lp-appointment-sync.js
 *
 * v5.1.6: CALENDAR NAME RESOLUTION (fixes GroupMe N/A calendar field).
 *
 *   Three layers of calendar name resolution, in priority order:
 *
 *   1. Webhook body — `calendar_name` (existing) OR `calendar_id` (NEW).
 *      `calendar_id` is mapped to a display name via CALENDAR_NAME_MAP.
 *      APPT Handlers should send `calendar_id` in the webhook body
 *      (the workflow knows which calendar fired it).
 *
 *   2. GHL appointments API — `enrichFromGHLContact` now fetches the
 *      latest appointment in parallel with the contact GET. Pulls
 *      calendarId + calendar metadata from the appointment record.
 *
 *   3. Fallback — appointment.title field, or 'N/A' as last resort.
 *
 *   CALENDAR_NAME_MAP covers the five live calendars per architecture spec:
 *      Review Session, MV, Window Estimate, HPA, Confirmation Call.
 *
 * v5.1.5: EMAIL MATCHING (Step 4) + AUTO-CLEAR `lp-sync-failed` ON SUCCESS.
 *
 *   Email matching joins phone in the last-resort tier — both run only
 *   after ID-based paths (Supabase, GHL Lead ID field, prospect ID)
 *   have produced no match. Email path uses LP's getCustomers3({email})
 *   then validates each prospect's leads against lognumber.
 *
 *   Tag cleanup: when a successful resolution returns (whether actually
 *   running SetAppointment or short-circuiting via already-set duplicate
 *   check), we now strip `lp-sync-failed` from the GHL contact. That
 *   tag was applied by an earlier failed attempt and shouldn't persist
 *   after the issue is resolved. Best-effort, non-blocking.
 *
 * v5.1.4: Phone matching demoted to last resort.
 * v5.1.3: Read GHL contact ID from LP's `lognumber` field.
 * v5.1.2: Probe surfaces lognumber, userfields, and notes content.
 * v5.1.1: Adds /webhook/ghl/lp-probe diagnostic endpoint.
 * v5.1: HLCID-first chain + manual-action fallback tag.
 *
 * v5.1.6 resolution chain (each candidate validated against the live LP
 *   record AND must have lognumber === inbound GHL contact ID before accept):
 *
 *   0. SUPABASE FAST-PATH — lp_leads.ghl_contact_id (cache hint,
 *      lognumber-validated). One DB query + one LP getLeadByLdsId.
 *
 *   1. GHL LEAD ID FIELD — `GmAVmW6V9sekD7pVONKr` on the GHL contact.
 *      Most authoritative when populated: identifies the exact lead.
 *
 *   2. PROSPECT ID + LOGNUMBER — GHL custom field LP_PROSPECT_ID_FIELD.
 *      One LP getLeads(cst_id) call → scan returned leads, accept the
 *      one whose lognumber matches the GHL contact ID.
 *
 *   3. PHONE + LOGNUMBER (LAST RESORT) — getCustomers3({phone}) →
 *      for each prospect returned, getLeads(cst_id) + lognumber filter.
 *
 *   4. EMAIL + LOGNUMBER (LAST RESORT) — getCustomers3({email}) →
 *      same shape as Step 3 but using email. Runs after phone because
 *      phone usually narrows the prospect set more tightly. Only runs
 *      when steps 0–3 produced nothing.
 *
 *   5. FAILURE — apply `lp-sync-failed` tag, GroupMe + GHL note.
 *
 * Endpoints:
 *   POST /webhook/ghl/set-lp-appointment — main sync entry (v5.1.6)
 *   POST /webhook/ghl/lp-probe          — diagnostic (v5.1.2)
 */

import supabase from './supabase.js';
import {
  setAppointment as lpSetAppointment,
  getLeadByLdsId,
  getCustomers3,
  getLeads,
} from './lp-client.js';
import {
  getGHLContact,
  updateGHLContactFields,
  addGHLNote,
  applyGHLTag,
  removeGHLTags,
} from './ghl.js';
import { sendGroupMeMessage } from './groupme.js';
import { acquireToken } from './ghl-rate-limiter.js';

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

// GHL custom field IDs
const LAST_APPT_DATE_FIELD  = 'x8KO5o89WPLfC7ivia3A';
const LAST_APPT_TIME_FIELD  = 'U67epWMNqjbf0SHAllEZ';
const LP_LEAD_ID_FIELD      = 'GmAVmW6V9sekD7pVONKr';
const LP_INBOUND_ID_FIELD   = '3YMxheIlPyhACB8zyc3W';
const LP_PROSPECT_ID_FIELD  = 'ZRQAVrzhtzApzLlHmT87';

const LP_SYNC_FAILED_TAG = 'lp-sync-failed';

// ─── Calendar ID → display name map (v5.1.6) ───────────────────
// Source: system architecture spec (5 live calendars).
// Used to translate calendar_id from webhook body or appointments API
// into the human-readable name shown in GroupMe + GHL notes.
const CALENDAR_NAME_MAP = {
  'DQYMaJ22N6zL4SXjHukw': 'Review Session',
  'zEdPmkNccR2ovo3rQAd3': 'MV',
  'aJj14ONxh1oFyDcQ706O': 'Window Estimate',
  'zS1wg0JqQ1zsszJyJqKX': 'HPA',
  'gFWoSQrlKIdfRbAPV842': 'Confirmation Call',
};

function calendarNameFromId(calendarId) {
  if (!calendarId) return null;
  const id = String(calendarId).trim();
  return CALENDAR_NAME_MAP[id] || null;
}

function cleanGHLValue(val) {
  if (val === 'null' || val === 'undefined' || val === '' || val == null) return null;
  return String(val).trim();
}

function getCustomField(customFields, fieldId) {
  const field = customFields?.find(f => f.id === fieldId);
  return field?.value != null ? String(field.value).trim() : null;
}

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

/**
 * v5.1.6: Fetch the most recent appointment for a contact.
 * Used as fallback when calendar_id/calendar_name not in webhook body.
 *
 * Tries multiple endpoint shapes because GHL v2 has shifted the
 * response structure between versions. Returns the most recent
 * appointment by startTime descending, or null on failure.
 */
async function fetchLatestAppointment(contactId) {
  if (!contactId) return null;
  try {
    const qs = new URLSearchParams({ contactId });
    if (GHL_LOCATION_ID) qs.set('locationId', GHL_LOCATION_ID);
    const res = await ghlFetch('GET', `/calendars/events/appointments?${qs.toString()}`);

    // Response can be { events: [...] } | { appointments: [...] } | [...]
    const list = res?.events || res?.appointments || (Array.isArray(res) ? res : null) || [];
    if (!Array.isArray(list) || list.length === 0) return null;

    const sorted = list
      .filter(a => a && (a.startTime || a.start_time || a.startsAt))
      .sort((a, b) => {
        const ta = new Date(a.startTime || a.start_time || a.startsAt).getTime();
        const tb = new Date(b.startTime || b.start_time || b.startsAt).getTime();
        return tb - ta;
      });
    return sorted[0] || list[0] || null;
  } catch (err) {
    console.warn(`[LP-APPT] fetchLatestAppointment failed for ${contactId}: ${err.message}`);
    return null;
  }
}

async function enrichFromGHLContact(contactId) {
  // v5.1.6: parallel fetch — contact GET + latest appointment.
  // Both are best-effort; either failing leaves the field null and
  // the caller falls through to whatever was already in the webhook body.
  const [contactRes, latestAppt] = await Promise.all([
    ghlFetch('GET', `/contacts/${contactId}`).catch(err => {
      console.warn(`[LP-APPT] GHL contact fetch failed for ${contactId}: ${err.message}`);
      return null;
    }),
    fetchLatestAppointment(contactId),
  ]);

  const contact = contactRes?.contact || {};
  const fields = contact.customFields || [];

  // Calendar resolution: appointment.calendarId → name map → appointment.title fallback
  let calendarId = null;
  let calendarName = null;
  if (latestAppt) {
    calendarId = latestAppt.calendarId || latestAppt.calendar_id || null;
    if (calendarId) {
      calendarName = calendarNameFromId(calendarId);
    }
    if (!calendarName) {
      calendarName = latestAppt.calendarName || latestAppt.calendar_name || latestAppt.title || null;
    }
  }

  return {
    phone: contact.phone || null,
    email: contact.email || null,
    name: [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.name || null,
    address1: contact.address1 || null,
    postalCode: contact.postalCode || null,
    city: contact.city || null,
    state: contact.state || null,
    prospectId: getCustomField(fields, LP_PROSPECT_ID_FIELD),
    inboundId: getCustomField(fields, LP_INBOUND_ID_FIELD),
    ghlLeadIdField: getCustomField(fields, LP_LEAD_ID_FIELD),
    appointmentDate: getCustomField(fields, LAST_APPT_DATE_FIELD),
    appointmentTime: getCustomField(fields, LAST_APPT_TIME_FIELD),
    calendarId,
    calendarName,
  };
}

const BOOKABLE_DISPOSITIONS = new Set([
  'Data', 'Issue', 'Set', 'NIS', 'NIS2', 'NI', 'BO', '1Leg', 'NoHome',
]);

function extractHLCID(leadRecord) {
  if (!leadRecord) return null;
  const v = leadRecord.lognumber
        ?? leadRecord.LogNumber
        ?? leadRecord.logNumber
        ?? leadRecord.HLCID
        ?? leadRecord.hlcid
        ?? leadRecord.HlcId
        ?? leadRecord.Hlcid
        ?? leadRecord.hlcID
        ?? leadRecord.HLcId;
  return v != null && String(v).trim() !== '' ? String(v).trim() : null;
}

function findLeadByHLCID(leadRecords, ghlContactId, prospectIdFallback = null) {
  if (!ghlContactId || !Array.isArray(leadRecords) || leadRecords.length === 0) return null;
  const targetId = String(ghlContactId).trim();

  const matches = [];
  for (const lead of leadRecords) {
    if (!lead) continue;
    const hlcid = extractHLCID(lead);
    if (!hlcid) continue;
    if (hlcid !== targetId) continue;
    const ldsId = lead.LeadID || lead.leadid || lead.lds_id || lead.id;
    if (!ldsId) continue;
    const disp = lead.Disposition || lead.disposition || lead.disp_code || '';
    const pid = lead.ProspectID || lead.prospectid || lead.CstID || lead.cst_id || prospectIdFallback;
    matches.push({ ldsId: String(ldsId), prospectId: pid ? String(pid) : null, disp });
  }

  if (matches.length === 0) return null;
  if (matches.length === 1) return { ...matches[0], hlcidMatched: true };

  console.warn(`[LP-RESOLVE] ⚠️ ${matches.length} leads matched HLCID=${targetId} — tiebreaking by bookable disposition`);
  const bookable = matches.find(m => BOOKABLE_DISPOSITIONS.has(m.disp));
  return { ...(bookable || matches[0]), hlcidMatched: true };
}

function zip5(zip) {
  if (!zip) return '';
  const m = String(zip).match(/\d{5}/);
  return m ? m[0] : '';
}

function normalizePhone(p) {
  return String(p || '').replace(/\D/g, '').slice(-10);
}

function cleanEmail(e) {
  return String(e || '').trim().toLowerCase();
}

async function resolveProspectToHLCIDLead(prospect, ghlContactId) {
  const prospectId = prospect.ProspectID || prospect.prospectid || prospect.CstID || prospect.cst_id;
  if (!prospectId) return null;
  try {
    const leadsResult = await getLeads({ cst_id: prospectId, PageSize: 50 });
    const records = Array.isArray(leadsResult) ? leadsResult : [leadsResult];
    const allLeads = [];
    for (const p of records) {
      if (!p) continue;
      const ls = p.leads || p.Leads || [];
      if (ls.length === 0) allLeads.push(p);
      else allLeads.push(...ls);
    }
    return findLeadByHLCID(allLeads, ghlContactId, prospectId);
  } catch (err) {
    console.warn(`[LP-RESOLVE] GetLeads for prospect ${prospectId} failed: ${err.message}`);
    return null;
  }
}

/**
 * v5.1.5 chain — see file header for full priority rationale.
 *
 *   Step 0 (Supabase cache, lognumber-validated)
 *   Step 1 (GHL Lead ID field, lognumber-validated)
 *   Step 2 (Prospect ID + lognumber)
 *   Step 3 (Phone + lognumber — LAST RESORT)
 *   Step 4 (Email + lognumber — LAST RESORT)
 *   FAILURE
 */
async function resolveLPLeadId(ghlContactId, contactInfo = {}) {
  const webhookProspectId = cleanGHLValue(contactInfo.prospectId);
  const phone = normalizePhone(contactInfo.phone || '');
  const email = cleanEmail(contactInfo.email || '');

  // ── Step 0: Supabase fast-path (cache hint, lognumber-validated) ──
  try {
    const { data: leads } = await supabase.from('lp_leads')
      .select('lp_lead_id, lp_prospect_id, disposition_code, synced_at')
      .eq('ghl_contact_id', ghlContactId)
      .order('synced_at', { ascending: false })
      .limit(5);

    if (leads?.length) {
      for (const candidate of leads) {
        if (!candidate.lp_lead_id) continue;
        try {
          const result = await getLeadByLdsId(candidate.lp_lead_id);
          const records = Array.isArray(result) ? result : [result];
          for (const prospect of records) {
            if (!prospect) continue;
            const innerLeads = prospect.leads || prospect.Leads || [];
            const target = innerLeads.find(l =>
              String(l.LeadID || l.leadid || l.lds_id || l.id) === String(candidate.lp_lead_id)
            );
            if (!target) continue;
            const hlcid = extractHLCID(target);
            if (hlcid && hlcid === String(ghlContactId)) {
              const pid = String(prospect.ProspectID || prospect.prospectid || prospect.CstID || prospect.cst_id || candidate.lp_prospect_id || '');
              console.log(`[LP-RESOLVE] ✅ Step 0 Supabase+lognumber: lds_id=${candidate.lp_lead_id}, prospect=${pid}, disp=${candidate.disposition_code}`);
              return { ldsId: String(candidate.lp_lead_id), prospectId: pid, source: 'supabase_hlcid_validated', step: 0 };
            }
            console.warn(`[LP-RESOLVE] Step 0: lds_id=${candidate.lp_lead_id} lognumber mismatch (got ${hlcid || 'null'}, want ${ghlContactId})`);
          }
        } catch (err) {
          console.warn(`[LP-RESOLVE] Step 0 validation failed for lds_id=${candidate.lp_lead_id}: ${err.message}`);
        }
      }
    }
  } catch (err) {
    console.warn(`[LP-RESOLVE] Step 0 Supabase lookup failed: ${err.message}`);
  }

  // ── Step 1: GHL Lead ID field + lognumber ─────────────────────
  try {
    const ghlRes = await ghlFetch('GET', `/contacts/${ghlContactId}`);
    const customFields = ghlRes?.contact?.customFields || [];
    const leadIdField = customFields.find(f => f.id === LP_LEAD_ID_FIELD);
    const inboundIdField = customFields.find(f => f.id === LP_INBOUND_ID_FIELD);
    const ghlLeadId = leadIdField?.value ? String(leadIdField.value) : null;
    const ghlInboundId = inboundIdField?.value ? String(inboundIdField.value) : null;

    if (ghlLeadId) {
      if (ghlInboundId && ghlLeadId === ghlInboundId) {
        console.warn(`[LP-RESOLVE] Step 1: GHL field matches inbound ID (${ghlLeadId}) — skipping (in1_id is not a real lds_id)`);
      } else {
        const result = await getLeadByLdsId(ghlLeadId);
        const records = Array.isArray(result) ? result : [result];
        for (const prospect of records) {
          if (!prospect) continue;
          const innerLeads = prospect.leads || prospect.Leads || [];
          const target = innerLeads.find(l =>
            String(l.LeadID || l.leadid || l.lds_id || l.id) === ghlLeadId
          );
          if (!target) continue;
          const hlcid = extractHLCID(target);
          if (hlcid && hlcid === String(ghlContactId)) {
            const pid = String(prospect.ProspectID || prospect.prospectid || prospect.CstID || prospect.cst_id || '');
            console.log(`[LP-RESOLVE] ✅ Step 1 GHL field+lognumber: lds_id=${ghlLeadId}, prospect=${pid}`);
            return { ldsId: ghlLeadId, prospectId: pid, source: 'ghl_field_plus_hlcid', step: 1 };
          }
          console.warn(`[LP-RESOLVE] Step 1: GHL field lds_id=${ghlLeadId} lognumber mismatch (got ${hlcid || 'null'}, want ${ghlContactId})`);
        }
      }
    } else {
      console.log(`[LP-RESOLVE] Step 1: GHL Lead ID field empty — skipping`);
    }
  } catch (err) {
    console.warn(`[LP-RESOLVE] Step 1 GHL field check failed: ${err.message}`);
  }

  // ── Step 2: Prospect ID + lognumber ───────────────────────────
  if (webhookProspectId && /^\d+$/.test(webhookProspectId)) {
    try {
      const leadsResult = await getLeads({ cst_id: webhookProspectId, PageSize: 50 });
      const records = Array.isArray(leadsResult) ? leadsResult : [leadsResult];
      const allLeads = [];
      for (const prospect of records) {
        if (!prospect) continue;
        const innerLeads = prospect.leads || prospect.Leads || [];
        if (innerLeads.length === 0) {
          allLeads.push(prospect);
        } else {
          allLeads.push(...innerLeads);
        }
      }
      const best = findLeadByHLCID(allLeads, ghlContactId, webhookProspectId);
      if (best) {
        console.log(`[LP-RESOLVE] ✅ Step 2 prospect+lognumber: lds_id=${best.ldsId}, prospect=${best.prospectId || webhookProspectId}, disp=${best.disp}`);
        return { ldsId: best.ldsId, prospectId: best.prospectId || webhookProspectId, source: 'prospect_plus_hlcid', step: 2 };
      }
      console.warn(`[LP-RESOLVE] Step 2: prospect ${webhookProspectId} has no lead with matching lognumber — falling through`);
    } catch (err) {
      console.warn(`[LP-RESOLVE] Step 2 prospect+lognumber failed for ${webhookProspectId}: ${err.message}`);
    }
  } else {
    console.log(`[LP-RESOLVE] Step 2: GHL has no LP Prospect ID — skipping`);
  }

  // ── Step 3: Phone + lognumber (LAST RESORT) ───────────────────
  if (phone) {
    let prospectList = [];
    try {
      const prospects = await getCustomers3({ phone });
      prospectList = Array.isArray(prospects) ? prospects : (prospects ? [prospects] : []);
      prospectList = prospectList.filter(Boolean);
      console.log(`[LP-RESOLVE] Step 3 (last resort): GetCustomers3 by phone returned ${prospectList.length} prospect(s)`);
    } catch (err) {
      console.warn(`[LP-RESOLVE] Step 3 GetCustomers3 by phone failed: ${err.message}`);
    }

    for (const p of prospectList) {
      const best = await resolveProspectToHLCIDLead(p, ghlContactId);
      if (best) {
        console.log(`[LP-RESOLVE] ✅ Step 3 phone+lognumber (last resort): lds_id=${best.ldsId}, prospect=${best.prospectId}, disp=${best.disp}`);
        return { ldsId: best.ldsId, prospectId: best.prospectId, source: 'phone_plus_hlcid_lastresort', step: 3 };
      }
    }
    if (prospectList.length) {
      console.warn(`[LP-RESOLVE] Step 3: no phone-matched prospect has a lead with matching lognumber`);
    }
  } else {
    console.warn(`[LP-RESOLVE] Step 3: no phone available — skipping last-resort phone path`);
  }

  // ── Step 4: Email + lognumber (LAST RESORT) ───────────────────
  // Final fallback. getCustomers3({email}) returns prospects sharing
  // the email; for each, we fetch their leads and require lognumber
  // match before accepting. Multiple LP prospects can share an email
  // (especially shared household / family / staff inboxes).
  if (email) {
    let prospectList = [];
    try {
      const prospects = await getCustomers3({ email });
      prospectList = Array.isArray(prospects) ? prospects : (prospects ? [prospects] : []);
      prospectList = prospectList.filter(Boolean);
      console.log(`[LP-RESOLVE] Step 4 (last resort): GetCustomers3 by email returned ${prospectList.length} prospect(s)`);
    } catch (err) {
      console.warn(`[LP-RESOLVE] Step 4 GetCustomers3 by email failed: ${err.message}`);
    }

    for (const p of prospectList) {
      const best = await resolveProspectToHLCIDLead(p, ghlContactId);
      if (best) {
        console.log(`[LP-RESOLVE] ✅ Step 4 email+lognumber (last resort): lds_id=${best.ldsId}, prospect=${best.prospectId}, disp=${best.disp}`);
        return { ldsId: best.ldsId, prospectId: best.prospectId, source: 'email_plus_hlcid_lastresort', step: 4 };
      }
    }
    if (prospectList.length) {
      console.warn(`[LP-RESOLVE] Step 4: no email-matched prospect has a lead with matching lognumber`);
    }
  } else {
    console.warn(`[LP-RESOLVE] Step 4: no email available — skipping last-resort email path`);
  }

  console.warn(`[LP-RESOLVE] ❌ No lognumber-validated lds_id for ${ghlContactId} after 5-step chain`);
  return null;
}

// ─── Date/time parsing ──────────────────────────────────────────

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

// ─── Failure notification ──────────────────────────────────────

function formatPhoneDisplay(p) {
  const d = normalizePhone(p);
  if (d.length !== 10) return p || '';
  return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
}

async function sendSyncFailureNotification({
  contactId, contactName, contactPhone, contactEmail,
  address1, city, state, postalCode,
  prospectId, inboundId, ghlLeadIdField,
  appointmentDate, appointmentTime, calendarName,
}) {
  const phoneDisplay = formatPhoneDisplay(contactPhone);
  const addrLine = [
    address1,
    [city, state].filter(Boolean).join(', '),
    zip5(postalCode) || postalCode,
  ].filter(Boolean).join(' • ') || 'no address on file';

  const idsLine = [
    prospectId    ? `prospect=${prospectId}`              : null,
    inboundId     ? `in1_id=${inboundId}`                 : null,
    ghlLeadIdField? `ghl_lp_lead_field=${ghlLeadIdField}` : null,
  ].filter(Boolean).join(' • ') || 'none populated';

  const apptLine = [
    appointmentDate || '?',
    appointmentTime || '?',
    calendarName || 'no calendar name',
  ].join(' @ ');

  const ghlLink = `https://app.gohighlevel.com/v2/location/SsBG7j5KQAIP1SFP2Sca/contacts/detail/${contactId}`;

  const tagApplied = await applyGHLTag(contactId, LP_SYNC_FAILED_TAG).catch((err) => {
    console.warn(`[LP-APPT] Failed to apply ${LP_SYNC_FAILED_TAG} tag: ${err.message}`);
    return false;
  });
  if (tagApplied) {
    console.log(`[LP-APPT] Applied ${LP_SYNC_FAILED_TAG} tag to ${contactId} — manual-action workflow will fire`);
  }

  const card =
`🚨 LP APPT SYNC FAILED — manual action required

👤 ${contactName || '(no name)'}
📞 ${phoneDisplay || 'no phone'}
✉️ ${contactEmail || 'no email'}
🏠 ${addrLine}

📅 Appt: ${apptLine}

🆔 LP IDs tried: ${idsLine}
🔗 GHL: ${ghlLink}

CHAIN RESULT — all 5 lognumber-validated steps failed:
  0 supabase+lognumber       • 1 GHL field+lognumber
  2 prospect+lognumber       • 3 phone+lognumber (last resort)
  4 email+lognumber (last resort)

Tag '${LP_SYNC_FAILED_TAG}' applied${tagApplied ? '' : ' (FAILED — see logs)'} →
manual-action workflow will fire team notifications.

ACTION:
  1. Open lead in LP (search by phone ${phoneDisplay || '???'} or address)
  2. If lead does not exist in LP yet → create it from GHL data above
  3. Confirm lognumber on the LP lead matches GHL contact ${contactId}
  4. Once lds_id exists with correct lognumber → SetAppointment to ${apptLine}
  5. Optional: paste lds_id into GHL field LP Lead ID for future syncs
  6. Remove tag '${LP_SYNC_FAILED_TAG}' from contact when resolved
     (or just re-fire this webhook — successful resolution auto-clears it)`;

  await sendGroupMeMessage(card).catch((err) => {
    console.warn(`[LP-APPT] GroupMe notification failed: ${err.message}`);
  });

  await addGHLNote(contactId,
    `[LP SYNC v5.1.6] Appointment NOT synced — full lognumber-validated chain failed.\n` +
    `Tried (in priority order): supabase+lognumber, GHL field+lognumber, prospect+lognumber, phone+lognumber (last resort), email+lognumber (last resort).\n` +
    `LP IDs: ${idsLine}\n` +
    `Appt: ${apptLine}\n` +
    `Tag '${LP_SYNC_FAILED_TAG}' ${tagApplied ? 'applied' : 'FAILED to apply'} — ` +
    `manual-action workflow handles team notification.\n` +
    `MANUAL ACTION: create/find lead in LP with lognumber=${contactId}, run SetAppointment, remove tag (or re-fire webhook).`
  ).catch(() => {});
}

/**
 * Best-effort cleanup: remove `lp-sync-failed` tag from a GHL contact
 * after a successful resolution. The tag was applied by an earlier
 * failed attempt; with the issue now resolved, it should not persist.
 * Non-blocking — failures are logged but never thrown.
 */
async function clearSyncFailedTag(contactId) {
  if (!contactId) return;
  try {
    await removeGHLTags(contactId, [LP_SYNC_FAILED_TAG]);
    console.log(`[LP-APPT] Cleared ${LP_SYNC_FAILED_TAG} tag from ${contactId} (success path)`);
  } catch (err) {
    console.warn(`[LP-APPT] ${LP_SYNC_FAILED_TAG} cleanup failed for ${contactId}: ${err.message}`);
  }
}

// ─── Main sync ──────────────────────────────────────────────────

async function syncAppointmentToLP({
  contactId, contactPhone, contactEmail, contactName,
  address1, city, state, postalCode,
  prospectId: webhookProspectId, inboundId, ghlLeadIdField,
  appointmentDate, appointmentTime, calendarName,
}) {
  if (!contactId) throw new Error('contact_id is required');

  const resolution = await resolveLPLeadId(contactId, {
    phone: contactPhone,
    email: contactEmail,
    address1,
    postalCode,
    prospectId: webhookProspectId,
  });

  if (!resolution) {
    await sendSyncFailureNotification({
      contactId, contactName, contactPhone, contactEmail,
      address1, city, state, postalCode,
      prospectId: webhookProspectId, inboundId, ghlLeadIdField,
      appointmentDate, appointmentTime, calendarName,
    });
    return {
      success: false,
      action: 'skipped_no_valid_lead_id',
      contact_id: contactId,
      contact_name: contactName,
      attempted_steps: ['supabase+lognumber', 'ghl_field+lognumber', 'prospect+lognumber', 'phone+lognumber_lastresort', 'email+lognumber_lastresort'],
      manual_action_tag_applied: LP_SYNC_FAILED_TAG,
    };
  }

  const { ldsId, prospectId, source, step } = resolution;

  try {
    const fields = [{ id: LP_LEAD_ID_FIELD, field_value: ldsId }];
    if (prospectId) fields.push({ id: LP_PROSPECT_ID_FIELD, field_value: prospectId });
    await updateGHLContactFields(contactId, fields);
    console.log(`[LP-APPT] Wrote back lds_id=${ldsId}, prospect=${prospectId} to GHL`);
  } catch (err) {
    console.warn(`[LP-APPT] GHL writeback failed (non-blocking): ${err.message}`);
  }

  // Resolution succeeded — clear any stale failure tag from prior attempts
  await clearSyncFailedTag(contactId);

  const apptDate = parseApptDate(appointmentDate);
  const apptTime = parseApptTime(appointmentTime);
  if (!apptDate) throw new Error(`Cannot parse appointment date: ${appointmentDate}`);
  if (!apptTime) throw new Error(`Cannot parse appointment time: ${appointmentTime}`);

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
        return { success: true, action: 'already_set_in_lp', lp_lead_id: ldsId, lp_prospect_id: prospectId, date: lpNorm, resolution_source: source, resolution_step: step };
      }
    }
  } catch (err) {
    console.warn(`[LP-APPT] Duplicate check failed (non-blocking): ${err.message}`);
  }

  console.log(`[LP-APPT] Setting: lds_id=${ldsId}, date=${apptDate}, time=${apptTime}, via=${source} (step ${step})`);
  const result = await lpSetAppointment({ ldsId, setBy: '5686', apptDate, apptTime });

  await addGHLNote(contactId,
    `[LP SYNC v5.1.6] Appointment set\nLP Lead: ${ldsId} (via ${source}, step ${step})\nProspect: ${prospectId || 'N/A'}\nDate: ${apptDate} ${apptTime}\nCalendar: ${calendarName || 'N/A'}`
  ).catch(() => {});

  await sendGroupMeMessage(
    `📅 LP Appointment Set (v5.1.6 ID-first)\n` +
    `👤 ${contactName || contactId}\n` +
    `📋 LP Lead: ${ldsId} (${source}, step ${step}) | Prospect: ${prospectId || 'N/A'}\n` +
    `📅 ${apptDate} ${apptTime} | ${calendarName || 'N/A'}`
  ).catch(() => {});

  console.log(`[LP-APPT] ✅ Done: lds_id=${ldsId}, ${apptDate} ${apptTime}`);
  return {
    success: true, action: 'lp_appointment_set',
    lp_lead_id: ldsId, lp_prospect_id: prospectId,
    appt_date: apptDate, appt_time: apptTime,
    calendar_name: calendarName,
    resolution_source: source, resolution_step: step,
    lp_response: result,
  };
}

// ─── Diagnostic probe (v5.1.2 — surfaces lognumber + userfields) ──

function leadSnapshot(lead) {
  if (!lead || typeof lead !== 'object') return null;
  const keys = Object.keys(lead);

  const hlcidLikeKeys = keys.filter(k => /hlc|ghl|contact|external/i.test(k));
  const userFieldKeys = keys.filter(k => /^user\d+$/i.test(k));

  const sample = {};
  for (const k of hlcidLikeKeys) sample[k] = lead[k];
  for (const k of userFieldKeys) sample[k] = lead[k];
  for (const k of ['LeadID', 'leadid', 'lds_id', 'id', 'ProspectID', 'prospectid', 'CstID', 'cst_id', 'Disposition', 'disposition', 'lognumber', 'in1_id', 'sender']) {
    if (k in lead) sample[k] = lead[k];
  }

  let userfieldsNormalized = null;
  const ufRaw = lead.userfields ?? lead.UserFields ?? lead.user_fields;
  if (Array.isArray(ufRaw)) {
    userfieldsNormalized = {};
    for (const uf of ufRaw) {
      if (!uf) continue;
      const name = uf.name || uf.Name || uf.field || uf.Field || uf.key || uf.Key;
      const val  = uf.value ?? uf.Value ?? uf.val ?? uf.Val;
      if (name) userfieldsNormalized[String(name)] = val;
    }
  } else if (ufRaw && typeof ufRaw === 'object') {
    userfieldsNormalized = ufRaw;
  }

  let notesPreview = null;
  const nRaw = lead.notes ?? lead.Notes;
  if (Array.isArray(nRaw) && nRaw.length) {
    notesPreview = {
      count: nRaw.length,
      sample: nRaw.slice(0, 2).map(n => ({
        keys: Object.keys(n || {}).slice(0, 10),
        preview: String(n?.note || n?.Note || n?.body || n?.Body || n?.text || n?.Text || '').slice(0, 200),
      })),
    };
  }

  return {
    field_count: keys.length,
    all_field_names: keys,
    hlcid_like_field_names: hlcidLikeKeys,
    user_field_names: userFieldKeys,
    extracted_hlcid: extractHLCID(lead),
    sample_values: sample,
    userfields_normalized: userfieldsNormalized,
    notes_preview: notesPreview,
  };
}

function prospectSnapshot(prospect) {
  if (!prospect || typeof prospect !== 'object') return null;
  const keys = Object.keys(prospect);

  const sample = {};
  for (const k of ['cst_id', 'CstID', 'firstname', 'lastname', 'phone1', 'address1', 'city', 'state', 'zip', 'email']) {
    if (k in prospect) sample[k] = prospect[k];
  }

  let userfieldsNormalized = null;
  const ufRaw = prospect.userfields ?? prospect.UserFields ?? prospect.user_fields;
  if (Array.isArray(ufRaw)) {
    userfieldsNormalized = {};
    for (const uf of ufRaw) {
      if (!uf) continue;
      const name = uf.name || uf.Name || uf.field || uf.Field || uf.key || uf.Key;
      const val  = uf.value ?? uf.Value ?? uf.val ?? uf.Val;
      if (name) userfieldsNormalized[String(name)] = val;
    }
  } else if (ufRaw && typeof ufRaw === 'object') {
    userfieldsNormalized = ufRaw;
  }

  return {
    field_count: keys.length,
    all_field_names: keys,
    sample_values: sample,
    userfields_normalized: userfieldsNormalized,
  };
}

async function probeLPForContact({ contactId, prospectId, phone }) {
  const probe = {
    inputs: { contactId, prospectId, phone },
    step1_prospect_lookup: null,
    step2_phone_lookup: null,
  };

  if (prospectId && /^\d+$/.test(String(prospectId))) {
    const start = Date.now();
    try {
      const result = await getLeads({ cst_id: prospectId, PageSize: 50 });
      const records = Array.isArray(result) ? result : [result];

      const inner = [];
      for (const p of records) {
        if (!p) continue;
        const ls = p.leads || p.Leads || [];
        if (ls.length === 0) inner.push({ _is_flat_record: true, ...p });
        else inner.push(...ls);
      }

      probe.step1_prospect_lookup = {
        elapsed_ms: Date.now() - start,
        prospect_record_count: records.length,
        prospect_record_keys: records[0] ? Object.keys(records[0]).slice(0, 40) : [],
        prospect_snapshots: records.map(prospectSnapshot),
        inner_lead_count: inner.length,
        inner_leads: inner.map(leadSnapshot),
        hlcid_match_attempted_against: contactId,
        any_hlcid_matched: inner.some(l => extractHLCID(l) === contactId),
      };
    } catch (err) {
      probe.step1_prospect_lookup = {
        elapsed_ms: Date.now() - start,
        error: err.message,
      };
    }
  }

  if (phone) {
    const start = Date.now();
    try {
      const prospects = await getCustomers3({ phone: normalizePhone(phone) });
      const list = Array.isArray(prospects) ? prospects : (prospects ? [prospects] : []);

      const perProspect = [];
      for (const p of list) {
        if (!p) continue;
        const pid = p.ProspectID || p.prospectid || p.CstID || p.cst_id;
        if (!pid) {
          perProspect.push({ prospect_keys: Object.keys(p).slice(0, 30), no_prospect_id: true });
          continue;
        }
        try {
          const leadsResult = await getLeads({ cst_id: pid, PageSize: 50 });
          const records = Array.isArray(leadsResult) ? leadsResult : [leadsResult];
          const inner = [];
          for (const pr of records) {
            if (!pr) continue;
            const ls = pr.leads || pr.Leads || [];
            if (ls.length === 0) inner.push({ _is_flat_record: true, ...pr });
            else inner.push(...ls);
          }
          perProspect.push({
            prospect_id: pid,
            prospect_snapshot: records[0] ? prospectSnapshot(records[0]) : null,
            inner_lead_count: inner.length,
            inner_leads: inner.map(leadSnapshot),
            any_hlcid_matched: inner.some(l => extractHLCID(l) === contactId),
          });
        } catch (err) {
          perProspect.push({ prospect_id: pid, error: err.message });
        }
      }

      probe.step2_phone_lookup = {
        elapsed_ms: Date.now() - start,
        prospect_count_returned_by_phone: list.length,
        per_prospect: perProspect,
      };
    } catch (err) {
      probe.step2_phone_lookup = {
        elapsed_ms: Date.now() - start,
        error: err.message,
      };
    }
  }

  return probe;
}

// ─── Webhook endpoints ─────────────────────────────────────────

export function registerLPAppointmentSyncRoutes(app) {

  app.post('/webhook/ghl/set-lp-appointment', async (req, res) => {
    const startTime = Date.now();
    try {
      const body = req.body || {};
      const contactId = cleanGHLValue(body.contact_id || body.contactId);

      if (!contactId) {
        return res.status(400).json({ success: false, error: 'contact_id is required' });
      }

      let appointmentDate = cleanGHLValue(body.appointment_date || body.appointmentDate || body.start_date || body.startDate);
      let appointmentTime = cleanGHLValue(body.appointment_time || body.appointmentTime || body.start_time || body.startTime);
      let prospectId  = cleanGHLValue(body.lp_prospect_id || body.prospect_id || body.prospectId);
      let inboundId   = cleanGHLValue(body.lp_inbound_lead_id || body.inbound_id || body.inboundId);
      let ghlLeadIdField = cleanGHLValue(body.lp_lead_id_field || body.ghl_lead_id);
      let contactPhone = cleanGHLValue(body.contact_phone || body.contactPhone || body.phone) || '';
      let contactEmail = cleanGHLValue(body.contact_email || body.contactEmail || body.email) || '';
      let contactName  = cleanGHLValue(body.contact_name || body.contactName || body.name) || '';
      let calendarName = cleanGHLValue(body.calendar_name || body.calendarName || body.title) || '';
      let calendarId   = cleanGHLValue(body.calendar_id || body.calendarId) || '';
      let address1     = cleanGHLValue(body.address1 || body.address) || '';
      let postalCode   = cleanGHLValue(body.postal_code || body.postalCode || body.zip) || '';
      let city         = cleanGHLValue(body.city) || '';
      let state        = cleanGHLValue(body.state) || '';

      // v5.1.6: if calendar_id provided but no name yet, try the map first
      if (!calendarName && calendarId) {
        calendarName = calendarNameFromId(calendarId) || '';
      }

      const needsEnrich = !appointmentDate || !appointmentTime || !prospectId || !contactPhone || !address1 || !contactEmail || !calendarName;
      if (needsEnrich) {
        console.log(`[LP-APPT] Self-enriching from GHL API for ${contactId}`);
        const enriched = await enrichFromGHLContact(contactId);
        if (!appointmentDate && enriched.appointmentDate) appointmentDate = enriched.appointmentDate;
        if (!appointmentTime && enriched.appointmentTime) appointmentTime = enriched.appointmentTime;
        if (!prospectId && enriched.prospectId) prospectId = enriched.prospectId;
        if (!inboundId && enriched.inboundId) inboundId = enriched.inboundId;
        if (!ghlLeadIdField && enriched.ghlLeadIdField) ghlLeadIdField = enriched.ghlLeadIdField;
        if (!contactPhone && enriched.phone) contactPhone = enriched.phone;
        if (!contactEmail && enriched.email) contactEmail = enriched.email;
        if (!contactName && enriched.name) contactName = enriched.name;
        if (!address1 && enriched.address1) address1 = enriched.address1;
        if (!postalCode && enriched.postalCode) postalCode = enriched.postalCode;
        if (!city && enriched.city) city = enriched.city;
        if (!state && enriched.state) state = enriched.state;
        // v5.1.6: calendar resolution from enrichment (if still missing)
        if (!calendarId && enriched.calendarId) calendarId = enriched.calendarId;
        if (!calendarName && enriched.calendarName) calendarName = enriched.calendarName;
        // Final attempt at the map with the freshly-enriched ID
        if (!calendarName && calendarId) {
          calendarName = calendarNameFromId(calendarId) || '';
        }
      }

      if (!appointmentDate || !appointmentTime) {
        return res.status(400).json({
          success: false,
          error: 'appointment_date and appointment_time not available (checked webhook body + GHL contact)',
        });
      }

      const result = await syncAppointmentToLP({
        contactId, contactPhone, contactEmail, contactName,
        address1, city, state, postalCode,
        prospectId, inboundId, ghlLeadIdField,
        appointmentDate, appointmentTime, calendarName,
      });

      result.elapsed_ms = Date.now() - startTime;
      res.json(result);

    } catch (err) {
      console.error(`[LP-APPT] Webhook error: ${err.message}`);
      await sendGroupMeMessage(`❌ LP APPT SYNC ERROR: ${err.message}\nContact: ${req.body?.contact_id || req.body?.contactId || 'unknown'}`).catch(() => {});
      res.status(500).json({ success: false, error: err.message, elapsed_ms: Date.now() - startTime });
    }
  });

  app.post('/webhook/ghl/lp-probe', async (req, res) => {
    const startTime = Date.now();
    try {
      const body = req.body || {};
      let contactId = cleanGHLValue(body.contactId || body.contact_id);
      let prospectId = cleanGHLValue(body.prospectId || body.prospect_id || body.lp_prospect_id);
      let phone = cleanGHLValue(body.phone || body.contact_phone);

      if (contactId && (!prospectId || !phone)) {
        const enriched = await enrichFromGHLContact(contactId);
        if (!prospectId) prospectId = enriched.prospectId;
        if (!phone) phone = enriched.phone;
      }

      if (!contactId) {
        return res.status(400).json({ error: 'contactId is required (and prospectId or phone for actual lookups)' });
      }

      const probe = await probeLPForContact({ contactId, prospectId, phone });
      probe.elapsed_ms = Date.now() - startTime;
      probe.target_hlcid = contactId;

      res.json(probe);
    } catch (err) {
      console.error(`[LP-PROBE] Error: ${err.message}`);
      res.status(500).json({ error: err.message, elapsed_ms: Date.now() - startTime });
    }
  });

  console.log('[LP-APPT] Registered: POST /webhook/ghl/set-lp-appointment (v5.1.6 calendar-name resolution + ID-first chain)');
  console.log('[LP-PROBE] Registered: POST /webhook/ghl/lp-probe (v5.1.2 diagnostic w/ userfields+lognumber)');
}

export { resolveLPLeadId, syncAppointmentToLP, extractHLCID, findLeadByHLCID, probeLPForContact, fetchLatestAppointment, calendarNameFromId, CALENDAR_NAME_MAP };
