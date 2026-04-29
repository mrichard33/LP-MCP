/**
 * LP Appointment Sync — src/lp-appointment-sync.js
 *
 * v5.0: Expanded fallback resolution chain + actionable failure notification.
 *
 * Why v5.0 exists:
 *   v4.3 had four resolution paths but only ONE narrowing strategy when the
 *   GHL prospect ID failed (a single GetCustomers3 call passing phone AND
 *   email together — LP intersects them, so a stale email or shared phone
 *   would skip valid prospects). When LP only has the lead at a household
 *   level (multiple people on one phone) or the email on file is wrong,
 *   the chain failed to find a real lead even though one existed.
 *
 *   Marie Widjaja (GHL 2WHqbq7n46JncW3oJ2IJ, 2026-04-29) hit this: prospect
 *   426508 had no bookable lead yet (still in LP inbound queue), her phone
 *   wasn't reachable in LP, and the chain skipped without trying the
 *   address narrowing that would have caught it.
 *
 * v5.0 chain (each candidate validated via LP API getLeadByLdsId before
 *  acceptance — never trust an unvalidated ID):
 *
 *   0. PROSPECT FAST-PATH — GHL `lp_prospect_id` field → getLeads(cst_id).
 *      Cleanest signal when present. Unchanged from v4.3.
 *
 *   1. HLCID (Supabase) — lp_leads where ghl_contact_id = contact.id, most
 *      recent bookable, validated via LP API. Unchanged from v4.3.
 *
 *   2. PHONE + ADDRESS — GetCustomers3({phone}), narrow result list to
 *      prospects whose street number AND zip match the GHL contact. NEW.
 *      Most precise LP API match — handles shared phones (households,
 *      property managers) where address is the disambiguator.
 *
 *   3. PHONE + EMAIL — same prospect list, narrow by email. NEW (v4.3 sent
 *      both fields to LP at once, which intersects; we want union with
 *      address-first preference).
 *
 *   4. PHONE ONLY — same prospect list, accept first prospect with a
 *      bookable lead. NEW. Last-resort match when address is missing on
 *      one side or email is stale.
 *
 *   5. GHL FIELD — `GmAVmW6V9sekD7pVONKr`, validated, must NOT equal the
 *      stored `in1_id` (`3YMxheIlPyhACB8zyc3W`). Unchanged from v4.3.
 *
 *   6. FAILURE — actionable GroupMe notification with full appointment
 *      details + LP IDs tried + direct manual-action steps. v4.3 only
 *      sent a one-liner. v5.0 sends a structured card the team can act on.
 *
 * The expensive LP API call (`GetCustomers3` with phone) is made AT MOST
 * ONCE — its result is cached locally in resolveLPLeadId and reused
 * across steps 2/3/4. Steps 2 → 3 → 4 are pure client-side filtering of
 * the same prospect list.
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
 * v5.0 also returns address1 and postalCode for phone+address narrowing.
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
      address1: contact.address1 || null,
      postalCode: contact.postalCode || null,
      city: contact.city || null,
      state: contact.state || null,
      prospectId: getCustomField(fields, LP_PROSPECT_ID_FIELD),
      inboundId: getCustomField(fields, LP_INBOUND_ID_FIELD),
      ghlLeadIdField: getCustomField(fields, LP_LEAD_ID_FIELD),
      appointmentDate: getCustomField(fields, LAST_APPT_DATE_FIELD),
      appointmentTime: getCustomField(fields, LAST_APPT_TIME_FIELD),
    };
  } catch (err) {
    console.warn(`[LP-APPT] GHL enrichment failed for ${contactId}: ${err.message}`);
    return {
      phone: null, email: null, name: null,
      address1: null, postalCode: null, city: null, state: null,
      prospectId: null, inboundId: null, ghlLeadIdField: null,
      appointmentDate: null, appointmentTime: null,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════
// LP LEAD ID RESOLUTION CHAIN (v5.0)
// ═══════════════════════════════════════════════════════════════════

// Dispositions where LP will accept a SetAppointment call
const BOOKABLE_DISPOSITIONS = new Set([
  'Data', 'Issue', 'Set', 'NIS', 'NIS2', 'NI', 'BO', '1Leg', 'NoHome',
]);

/**
 * Find the best bookable lead from an array of LP lead records.
 * Prefers leads with a BOOKABLE_DISPOSITIONS disposition; falls back to
 * the first record with any lds_id if no bookable lead exists.
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
 * Extract the leading street number from a street address.
 * "13454 1st Street East" → "13454"
 * "Apt 5, 1234 Main St"   → "1234"  (uses last leading-number group; usually safer)
 * Empty / unmatched returns "".
 */
function streetNumberFrom(addr) {
  if (!addr) return '';
  const s = String(addr).trim();
  // Prefer the FIRST numeric token (most addresses lead with house number)
  const m = s.match(/\b(\d{1,7})\b/);
  return m ? m[1] : '';
}

/** Normalize a US zip to 5 digits. "33708-1234" → "33708". */
function zip5(zip) {
  if (!zip) return '';
  const m = String(zip).match(/\d{5}/);
  return m ? m[0] : '';
}

/** Normalize email for case-insensitive comparison. */
function normalizeEmail(e) {
  return String(e || '').toLowerCase().trim();
}

/**
 * Last-10-digit phone normalization.
 * "+1 (908) 887-8795" → "9088878795"
 */
function normalizePhone(p) {
  return String(p || '').replace(/\D/g, '').slice(-10);
}

/**
 * Pick the address fields off a prospect returned by LP GetCustomers3.
 * LP's response keys vary across endpoints; we check several common
 * casings rather than assuming one shape.
 */
function prospectAddressFields(p) {
  return {
    address: p.Address || p.address || p.Address1 || p.address1 || p.AddressLine1 || '',
    zip:     p.Zip || p.zip || p.PostalCode || p.postalCode || p.ZipCode || p.zipcode || '',
    email:   p.Email || p.email || '',
  };
}

/**
 * Resolve a prospect to a bookable LP lead. Used as the inner step of
 * phone-based fallbacks. Returns null if the prospect has no bookable lead.
 */
async function resolveProspectToBookableLead(prospect) {
  const prospectId = prospect.ProspectID || prospect.prospectid || prospect.CstID || prospect.cst_id;
  if (!prospectId) return null;
  try {
    const leadsResult = await getLeads({ cst_id: prospectId, PageSize: 20 });
    const leadRecords = Array.isArray(leadsResult) ? leadsResult : [leadsResult];
    return findBookableLead(leadRecords, prospectId);
  } catch (err) {
    console.warn(`[LP-RESOLVE] GetLead for prospect ${prospectId} failed: ${err.message}`);
    return null;
  }
}

/**
 * Safely resolve a REAL LP Lead ID (lds_id) for a GHL contact.
 *
 * v5.0 chain — see file header for full description. Each candidate is
 * validated via LP API getLeadByLdsId (or is the direct output of an
 * LP getLeads/getCustomers3 call that already returns lds_id) before
 * acceptance.
 */
async function resolveLPLeadId(ghlContactId, contactInfo = {}) {
  const webhookProspectId = cleanGHLValue(contactInfo.prospectId);
  const phoneRaw = contactInfo.phone || '';
  const emailRaw = contactInfo.email || '';
  const phone = normalizePhone(phoneRaw);
  const email = normalizeEmail(emailRaw);
  const contactStreetNo = streetNumberFrom(contactInfo.address1);
  const contactZip      = zip5(contactInfo.postalCode);

  // ── Step 0: Prospect ID fast-path ─────────────────────────────
  if (webhookProspectId && /^\d+$/.test(webhookProspectId)) {
    try {
      const leadsResult = await getLeads({ cst_id: webhookProspectId, PageSize: 20 });
      const leadRecords = Array.isArray(leadsResult) ? leadsResult : [leadsResult];
      const best = findBookableLead(leadRecords, webhookProspectId);
      if (best) {
        console.log(`[LP-RESOLVE] ✅ Step 0 prospect fast-path: lds_id=${best.ldsId}, prospect=${webhookProspectId}, disp=${best.disp}`);
        return { ldsId: best.ldsId, prospectId: webhookProspectId, source: 'prospect_id_fastpath', step: 0 };
      }
      console.warn(`[LP-RESOLVE] Step 0: prospect ${webhookProspectId} has no bookable leads — falling through`);
    } catch (err) {
      console.warn(`[LP-RESOLVE] Step 0 fast-path failed for ${webhookProspectId}: ${err.message}`);
    }
  }

  // ── Step 1: HLCID match (Supabase lp_leads.ghl_contact_id) ────
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
            console.log(`[LP-RESOLVE] ✅ Step 1 HLCID: lds_id=${candidate.lp_lead_id}, prospect=${pid}, disp=${candidate.disposition_code}`);
            return { ldsId: String(candidate.lp_lead_id), prospectId: pid, source: 'hlcid_supabase_validated', step: 1 };
          }
        } catch (err) {
          console.warn(`[LP-RESOLVE] Step 1 HLCID candidate ${candidate.lp_lead_id} failed validation: ${err.message}`);
        }
      }
    }
  } catch (err) {
    console.warn(`[LP-RESOLVE] Step 1 HLCID lookup failed: ${err.message}`);
  }

  // ── Steps 2/3/4 share ONE GetCustomers3 phone-only call ───────
  // We deliberately query LP by phone alone (not phone+email together —
  // LP intersects them, which is too restrictive). Then we narrow the
  // result list client-side, address-first.
  let prospectList = [];
  if (phone) {
    try {
      const prospects = await getCustomers3({ phone });
      prospectList = Array.isArray(prospects) ? prospects : (prospects ? [prospects] : []);
      prospectList = prospectList.filter(Boolean);
      console.log(`[LP-RESOLVE] GetCustomers3 by phone returned ${prospectList.length} prospect(s)`);
    } catch (err) {
      console.warn(`[LP-RESOLVE] GetCustomers3 by phone failed: ${err.message}`);
    }
  } else {
    console.warn(`[LP-RESOLVE] No phone available — skipping steps 2/3/4`);
  }

  // ── Step 2: Phone + address narrowing ─────────────────────────
  // Match leading street number AND 5-digit zip. If both match, this
  // is a confident hit even when multiple prospects share the phone.
  if (prospectList.length && contactStreetNo && contactZip) {
    for (const p of prospectList) {
      const { address: pAddr, zip: pZip } = prospectAddressFields(p);
      const pStreetNo = streetNumberFrom(pAddr);
      const pZip5 = zip5(pZip);
      if (pStreetNo && pZip5 && pStreetNo === contactStreetNo && pZip5 === contactZip) {
        const best = await resolveProspectToBookableLead(p);
        if (best) {
          console.log(`[LP-RESOLVE] ✅ Step 2 phone+address: lds_id=${best.ldsId}, prospect=${best.prospectId}, disp=${best.disp}`);
          return { ldsId: best.ldsId, prospectId: best.prospectId, source: 'phone_plus_address', step: 2 };
        }
      }
    }
    console.warn(`[LP-RESOLVE] Step 2: no phone+address match (street=${contactStreetNo}, zip=${contactZip})`);
  }

  // ── Step 3: Phone + email narrowing ───────────────────────────
  if (prospectList.length && email) {
    for (const p of prospectList) {
      const { email: pEmail } = prospectAddressFields(p);
      if (pEmail && normalizeEmail(pEmail) === email) {
        const best = await resolveProspectToBookableLead(p);
        if (best) {
          console.log(`[LP-RESOLVE] ✅ Step 3 phone+email: lds_id=${best.ldsId}, prospect=${best.prospectId}, disp=${best.disp}`);
          return { ldsId: best.ldsId, prospectId: best.prospectId, source: 'phone_plus_email', step: 3 };
        }
      }
    }
    console.warn(`[LP-RESOLVE] Step 3: no phone+email match`);
  }

  // ── Step 4: Phone only (last-resort) ──────────────────────────
  // Accept the first prospect on the phone with a bookable lead.
  // Households with multiple prospects on one phone will get the first
  // bookable one — acceptable when address/email both failed to narrow.
  if (prospectList.length) {
    for (const p of prospectList) {
      const best = await resolveProspectToBookableLead(p);
      if (best) {
        console.log(`[LP-RESOLVE] ✅ Step 4 phone-only: lds_id=${best.ldsId}, prospect=${best.prospectId}, disp=${best.disp}`);
        return { ldsId: best.ldsId, prospectId: best.prospectId, source: 'phone_only_lastresort', step: 4 };
      }
    }
    console.warn(`[LP-RESOLVE] Step 4: phone-only — no prospect on this phone has a bookable lead`);
  }

  // ── Step 5: GHL field — must validate AND not equal in1_id ────
  try {
    const ghlRes = await ghlFetch('GET', `/contacts/${ghlContactId}`);
    const customFields = ghlRes?.contact?.customFields || [];
    const leadIdField = customFields.find(f => f.id === LP_LEAD_ID_FIELD);
    const inboundIdField = customFields.find(f => f.id === LP_INBOUND_ID_FIELD);
    const ghlLeadId = leadIdField?.value ? String(leadIdField.value) : null;
    const ghlInboundId = inboundIdField?.value ? String(inboundIdField.value) : null;

    if (ghlLeadId) {
      if (ghlInboundId && ghlLeadId === ghlInboundId) {
        console.warn(`[LP-RESOLVE] Step 5: GHL field matches inbound ID (${ghlLeadId}) — skipping`);
      } else {
        const result = await getLeadByLdsId(ghlLeadId);
        const records = Array.isArray(result) ? result : [result];
        const valid = records.find(r => r && (r.LeadID || r.leadid || r.lds_id));
        if (valid) {
          const pid = String(valid.ProspectID || valid.prospectid || valid.CstID || valid.cst_id || '');
          console.log(`[LP-RESOLVE] ✅ Step 5 GHL field validated: lds_id=${ghlLeadId}, prospect=${pid}`);
          return { ldsId: ghlLeadId, prospectId: pid, source: 'ghl_field_validated', step: 5 };
        }
        console.warn(`[LP-RESOLVE] Step 5: GHL field ${ghlLeadId} failed validation — likely in1_id`);
      }
    }
  } catch (err) {
    console.warn(`[LP-RESOLVE] Step 5 GHL field check failed: ${err.message}`);
  }

  console.warn(`[LP-RESOLVE] ❌ No valid lds_id for ${ghlContactId} after 6-step chain`);
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
// FAILURE NOTIFICATION (v5.0 — actionable card)
// ═══════════════════════════════════════════════════════════════════

/**
 * Format a phone for display: "+19088878795" → "(908) 887-8795".
 */
function formatPhoneDisplay(p) {
  const d = normalizePhone(p);
  if (d.length !== 10) return p || '';
  return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
}

/**
 * Send a structured GroupMe notification when LP sync skips for lack of
 * a valid lds_id. v4.3 sent a one-liner; v5.0 includes the data the team
 * needs to manually create or set the appointment in LP without going
 * back to GHL to look anything up.
 */
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
    postalCode,
  ].filter(Boolean).join(' • ') || 'no address on file';

  const idsLine = [
    prospectId    ? `prospect=${prospectId}`            : null,
    inboundId     ? `in1_id=${inboundId}`               : null,
    ghlLeadIdField? `ghl_lp_lead_field=${ghlLeadIdField}` : null,
  ].filter(Boolean).join(' • ') || 'none populated';

  const apptLine = [
    appointmentDate || '?',
    appointmentTime || '?',
    calendarName || 'no calendar name',
  ].join(' @ ');

  const ghlLink = `https://app.gohighlevel.com/v2/location/SsBG7j5KQAIP1SFP2Sca/contacts/detail/${contactId}`;

  const card =
`🚨 LP APPT SYNC FAILED — manual action required

👤 ${contactName || '(no name)'}
📞 ${phoneDisplay || 'no phone'}
✉️ ${contactEmail || 'no email'}
🏠 ${addrLine}

📅 Appt: ${apptLine}

🆔 LP IDs tried: ${idsLine}
🔗 GHL: ${ghlLink}

CHAIN RESULT — all 6 steps failed:
  0 prospect fast-path • 1 HLCID • 2 phone+address
  3 phone+email • 4 phone-only • 5 GHL lead-id field

ACTION:
  1. Open lead in LP (search by phone ${phoneDisplay || '???'} or address)
  2. If lead does not exist in LP yet → create it from GHL data above
  3. Once lds_id exists → SetAppointment to ${apptLine}
  4. Optional: paste lds_id into GHL field LP Lead ID for future syncs`;

  await sendGroupMeMessage(card).catch((err) => {
    console.warn(`[LP-APPT] GroupMe notification failed: ${err.message}`);
  });

  // Also leave a note on the GHL contact so the next person to open it sees the gap
  await addGHLNote(contactId,
    `[LP SYNC v5.0] Appointment NOT synced — full chain failed.\n` +
    `Tried: prospect fast-path, HLCID/Supabase, phone+address, phone+email, phone-only, GHL field.\n` +
    `LP IDs: ${idsLine}\n` +
    `Appt: ${apptLine}\n` +
    `MANUAL ACTION: create/find lead in LP, run SetAppointment.`
  ).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════
// MAIN SYNC FUNCTION
// ═══════════════════════════════════════════════════════════════════

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
      attempted_steps: ['prospect_fastpath', 'hlcid', 'phone+address', 'phone+email', 'phone-only', 'ghl_field'],
    };
  }

  const { ldsId, prospectId, source, step } = resolution;

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
        return { success: true, action: 'already_set_in_lp', lp_lead_id: ldsId, lp_prospect_id: prospectId, date: lpNorm, resolution_source: source, resolution_step: step };
      }
    }
  } catch (err) {
    console.warn(`[LP-APPT] Duplicate check failed (non-blocking): ${err.message}`);
  }

  console.log(`[LP-APPT] Setting: lds_id=${ldsId}, date=${apptDate}, time=${apptTime}, via=${source} (step ${step})`);
  const result = await lpSetAppointment({ ldsId, setBy: '5686', apptDate, apptTime });

  await addGHLNote(contactId,
    `[LP SYNC v5.0] Appointment set\nLP Lead: ${ldsId} (via ${source}, step ${step})\nProspect: ${prospectId || 'N/A'}\nDate: ${apptDate} ${apptTime}\nCalendar: ${calendarName || 'N/A'}`
  ).catch(() => {});

  await sendGroupMeMessage(
    `📅 LP Appointment Set (v5.0)\n` +
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

// ═══════════════════════════════════════════════════════════════════
// WEBHOOK ENDPOINT
// ═══════════════════════════════════════════════════════════════════

export function registerLPAppointmentSyncRoutes(app) {

  /**
   * POST /webhook/ghl/set-lp-appointment
   *
   * v5.0: Self-enriching endpoint with expanded resolution chain.
   * Only contactId is truly required from the webhook body. All other
   * fields are auto-fetched from GHL when missing — including the
   * address fields used by the new phone+address narrowing step.
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
      let prospectId  = cleanGHLValue(body.lp_prospect_id || body.prospect_id || body.prospectId);
      let inboundId   = cleanGHLValue(body.lp_inbound_lead_id || body.inbound_id || body.inboundId);
      let ghlLeadIdField = cleanGHLValue(body.lp_lead_id_field || body.ghl_lead_id);
      let contactPhone = cleanGHLValue(body.contact_phone || body.contactPhone || body.phone) || '';
      let contactEmail = cleanGHLValue(body.contact_email || body.contactEmail || body.email) || '';
      let contactName  = cleanGHLValue(body.contact_name || body.contactName || body.name) || '';
      let calendarName = cleanGHLValue(body.calendar_name || body.calendarName || body.title) || '';
      let address1     = cleanGHLValue(body.address1 || body.address) || '';
      let postalCode   = cleanGHLValue(body.postal_code || body.postalCode || body.zip) || '';
      let city         = cleanGHLValue(body.city) || '';
      let state        = cleanGHLValue(body.state) || '';

      // v4.3 enrichment, extended in v5.0 to fetch address fields too
      const needsEnrich = !appointmentDate || !appointmentTime || !prospectId || !contactPhone || !address1;
      if (needsEnrich) {
        console.log(`[LP-APPT] Self-enriching from GHL API for ${contactId} (missing: ${[
          !appointmentDate && 'date', !appointmentTime && 'time',
          !prospectId && 'prospect', !contactPhone && 'phone', !address1 && 'address',
        ].filter(Boolean).join(', ')})`);

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

        console.log(`[LP-APPT] After enrichment: date=${appointmentDate}, time=${appointmentTime}, prospect=${prospectId || 'none'}, phone=${contactPhone ? 'yes' : 'no'}, addr=${address1 ? 'yes' : 'no'}`);
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

  console.log('[LP-APPT] Registered: POST /webhook/ghl/set-lp-appointment (v5.0)');
}

// Export for potential reuse by action-executor
export { resolveLPLeadId, syncAppointmentToLP };
