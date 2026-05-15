/**
 * n8n Lead Enrichment API — replaces all Code nodes in LP Lead Enrichment workflow
 * 
 * POST /n8n/enrich-lead
 * 
 * This endpoint does everything the 8 Code nodes did:
 * 1. Parse input params from GHL webhook body
 * 2. Get LP token (uses LP MCP's built-in token manager)
 * 3. Resolve prospect ID (from prospect_id, lead_id, OR phone/email fallback)
 * 4. Fetch full lead data + lead info from LP API
 * 5. Build enriched record (aggregate leads, appointments, jobs, calls)
 * 6. Calculate highest stage, market, sale amounts, etc.
 * 7. Apply lp-linked + lp-enriched tags via additive POST (NEVER via PUT)
 * 8. Return customFields-only payload ready for GHL contact update
 *
 * v3.0 — 2026-05-15 — Tag wipe fix.
 *   PUT /contacts/{id} with a `tags` array WHOLESALE-REPLACES the contact's
 *   entire tag set. The previous v2.0 "merge" approach (GET tags → merge with
 *   ['lp-linked', 'lp-enriched'] → PUT) was racy: any tag added between the
 *   GET sample and the PUT execution by GHL workflows (I.WE step 2, E.0
 *   step 106) or agent rules (ENTRY_HYGIENE_AT_CREATION_*) was silently
 *   wiped. Symptom: every calculator-completed contact ended with empty
 *   entry:* / active-entry:* / stage:* tags (Mark Test contact
 *   F5wIFrNefJmXcfFZXuI1, 2026-05-15).
 *
 *   Fix: the endpoint no longer fetches/merges/returns `tags`. Instead it
 *   POSTs `lp-linked` + `lp-enriched` directly to /contacts/{id}/tags
 *   (additive, never wipes). `ghl_update_body` now contains only
 *   `customFields` — the n8n workflow PUT still works, but never wipes
 *   tags because the `tags` field is absent.
 *
 *   Companion change: n8n workflow B3QbDlXlVuqcCH78 published draft that
 *   delegates entirely to this endpoint. The draft's PUT will send the
 *   tagless ghl_update_body, eliminating the wipe.
 *
 * v2.0 — Phone/email fallback via GetCustomers3 + lp_lead_id writeback
 *   When lp_prospect_id and lp_lead_id are both empty, accepts phone/email
 *   as fallback search params and uses LP GetCustomers3 to resolve the prospect.
 *   Also writes lp_lead_id (real lds_id) back to GHL customFields so
 *   contact.lp_lead_id gets populated after enrichment.
 *   Fixes: SetAppointment wrong-ID bug (in1_id vs lds_id).
 */

import { getToken } from './token-manager.js';

const LP_API_BASE = process.env.LP_API_BASE_URL || 'https://api.leadperfection.com';
const GHL_API_KEY = process.env.GHL_API_KEY;

// ─── LP API helpers ──────────────────────────────────────────────

async function lpPost(path, params, token) {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(`${LP_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Bearer ${token}`,
    },
    body,
    signal: AbortSignal.timeout(60000),
  });
  return res.json();
}

async function ghlGet(contactId) {
  const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Version': '2021-07-28',
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(30000),
  });
  return res.json();
}

/**
 * v3.0 — Additive tag application via POST /contacts/{id}/tags.
 *
 * NEVER use PUT /contacts/{id} with a `tags` array — it wholesale-replaces
 * the contact's entire tag set and wipes anything added by concurrent
 * workflows or agent rules between the GET sample and the PUT execution.
 *
 * POST /contacts/{id}/tags is additive: GHL merges the provided tags into
 * the existing set. Idempotent on the server side (duplicate POSTs do not
 * duplicate tags).
 */
async function ghlPostTags(contactId, tags) {
  const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Version': '2021-07-28',
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ tags }),
    signal: AbortSignal.timeout(15000),
  });
  return { ok: res.ok, status: res.status };
}

// ─── Parse LP response (handles various LP API response formats) ─

function parseResponse(data) {
  if (!data) return null;
  if (Array.isArray(data) && data.length > 0) return data[0];
  if (data.Records) {
    const r = Array.isArray(data.Records) ? data.Records : [data.Records];
    return r.length > 0 ? r[0] : null;
  }
  if (data.Data) {
    const d = Array.isArray(data.Data) ? data.Data : [data.Data];
    return d.length > 0 ? d[0] : null;
  }
  if (data.Result) {
    const res = Array.isArray(data.Result) ? data.Result : [data.Result];
    return res.length > 0 ? res[0] : null;
  }
  if (data.cst_id || data.ProspectID || data.firstname) return data;
  return data;
}

// ─── v2.0: Phone/email fallback via GetCustomers3 ────────────────

/**
 * Search LP by phone or email using GetCustomers3.
 * Returns the prospect ID (cst_id) if found, or null.
 * Tries phone first (most reliable match), then email.
 */
async function resolveProspectByPhoneEmail({ phone, email, last_name }, token) {
  // Normalize phone: strip non-digits
  const cleanPhone = phone ? String(phone).replace(/\D/g, '') : '';

  // Try phone first
  if (cleanPhone) {
    console.log(`[n8n/enrich] GetCustomers3 fallback: searching by phone ${cleanPhone}`);
    const result = await lpPost('/api/Customers/GetCustomers3', {
      phone: cleanPhone,
      email: '',
      lastname: '',
      prospectid: '',
    }, token);

    const prospect = parseGetCustomers3(result);
    if (prospect) {
      console.log(`[n8n/enrich] GetCustomers3 phone match: cst_id=${prospect.cst_id}`);
      return String(prospect.cst_id);
    }
  }

  // Try email
  if (email) {
    console.log(`[n8n/enrich] GetCustomers3 fallback: searching by email ${email}`);
    const result = await lpPost('/api/Customers/GetCustomers3', {
      phone: '',
      email: email,
      lastname: '',
      prospectid: '',
    }, token);

    const prospect = parseGetCustomers3(result);
    if (prospect) {
      console.log(`[n8n/enrich] GetCustomers3 email match: cst_id=${prospect.cst_id}`);
      return String(prospect.cst_id);
    }
  }

  // Try last name (least specific, may return multiple)
  if (last_name && !cleanPhone && !email) {
    console.log(`[n8n/enrich] GetCustomers3 fallback: searching by lastname ${last_name}`);
    const result = await lpPost('/api/Customers/GetCustomers3', {
      phone: '',
      email: '',
      lastname: last_name,
      prospectid: '',
    }, token);

    const prospect = parseGetCustomers3(result);
    if (prospect) {
      console.log(`[n8n/enrich] GetCustomers3 lastname match: cst_id=${prospect.cst_id}`);
      return String(prospect.cst_id);
    }
  }

  return null;
}

/**
 * Parse GetCustomers3 response — returns the first prospect record or null.
 * GetCustomers3 returns an array of prospect records.
 */
function parseGetCustomers3(data) {
  if (!data) return null;
  if (Array.isArray(data)) {
    return data.length > 0 ? data[0] : null;
  }
  if (data.Records && Array.isArray(data.Records)) {
    return data.Records.length > 0 ? data.Records[0] : null;
  }
  if (data.cst_id || data.ProspectID) return data;
  return null;
}

// ─── Build enriched record from LP data ──────────────────────────

function buildEnrichedRecord(fullData, leadInfo, prospectId, contactId) {
  const lead = parseResponse(fullData) || {};
  const info = parseResponse(leadInfo) || {};

  const prospect = lead.Prospect || lead.prospect || lead;
  const leads = lead.Leads || lead.leads || lead.LeadHistory || [];
  const appointments = lead.Appointments || lead.appointments || lead.AppointmentHistory || [];
  const jobs = lead.Jobs || lead.jobs || lead.JobHistory || [];
  const notes = lead.Notes || lead.notes || [];
  const callHistory = lead.CallHistory || lead.callHistory || lead.Calls || [];
  const milestones = lead.Milestones || lead.milestones || [];
  const payments = lead.Payments || lead.payments || [];

  const safeCount = (arr) => Array.isArray(arr) ? arr.length : (arr ? 1 : 0);

  const enriched = {
    lp_prospect_id: String(prospect.cst_id || prospect.ProspectID || lead.cst_id || lead.ProspectID || prospectId || ''),
    contact_id: contactId || '',
    firstName: prospect.firstname || prospect.FirstName || lead.firstname || lead.FirstName || '',
    lastName: prospect.lastname || prospect.LastName || lead.lastname || lead.LastName || '',
    email: prospect.email || prospect.Email || lead.email || lead.Email || '',
    phone: prospect.phone || prospect.Phone || lead.phone || lead.Phone || '',
    address1: prospect.address1 || prospect.Address1 || lead.address1 || '',
    city: prospect.city || prospect.City || lead.city || '',
    state: prospect.state || prospect.State || lead.state || '',
    zip: prospect.zip || prospect.Zip || lead.zip || '',
    leadStatus: info.Disposition || info.disposition || lead.Disposition || lead.disposition || prospect.Disposition || '',
    source: info.Source || info.source || lead.Source || lead.source || prospect.Source || '',
    subSource: info.SubSourceDescription || info.subsource || lead.SubSource || '',
    promoter: info.PromoterName || info.promoter || lead.Promoter || '',
    entryDate: info.EntryDate || info.entrydate || lead.EntryDate || lead.entrydate || '',
    totalCalls: safeCount(callHistory),
    totalNotes: safeCount(notes),
    totalAppointments: safeCount(appointments),
    totalJobs: safeCount(jobs),
    totalMilestones: safeCount(milestones),
    totalPayments: safeCount(payments),
    latestLeadId: '', latestLeadDate: '', latestLeadSource: '', latestLeadStatus: '',
    latestApptDate: '', latestApptResult: '', latestApptSalesRep: '',
    latestJobId: '', latestJobStatus: '', latestJobDate: '', latestJobAmount: '',
    lastCallDate: '', lastCallResult: '', lastCallType: '',
    recentNotes: '',
  };

  const leadsArr = Array.isArray(leads) ? leads : [];
  if (leadsArr.length > 0) {
    const l = leadsArr[leadsArr.length - 1];
    enriched.latestLeadId = String(l.lds_id || l.LeadID || '');
    enriched.latestLeadDate = l.EntryDate || l.entrydate || '';
    enriched.latestLeadSource = l.Source || l.source || '';
    enriched.latestLeadStatus = l.Disposition || l.disposition || l.Status || '';
  }

  const apptsArr = Array.isArray(appointments) ? appointments : [];
  if (apptsArr.length > 0) {
    const a = apptsArr[apptsArr.length - 1];
    enriched.latestApptDate = a.ApptDate || a.apptdate || a.Date || '';
    enriched.latestApptResult = a.Result || a.result || a.Disposition || '';
    enriched.latestApptSalesRep = a.SalesRep || a.salesrep || a.RepName || '';
  }

  const jobsArr = Array.isArray(jobs) ? jobs : [];
  if (jobsArr.length > 0) {
    const j = jobsArr[jobsArr.length - 1];
    enriched.latestJobId = String(j.job_id || j.JobID || '');
    enriched.latestJobStatus = j.StatusDescription || j.jbs_description || j.Status || '';
    enriched.latestJobDate = j.SoldDate || j.solddate || '';
    enriched.latestJobAmount = String(j.ContractAmount || j.contractamount || j.Amount || '');
  }

  const callsArr = Array.isArray(callHistory) ? callHistory : [];
  if (callsArr.length > 0) {
    const c = callsArr[callsArr.length - 1];
    enriched.lastCallDate = c.CallDate || c.calldate || '';
    enriched.lastCallResult = c.ResultCode || c.resultcode || c.Result || '';
    enriched.lastCallType = c.CallType || c.calltype || '';
  }

  const notesArr = Array.isArray(notes) ? notes : [];
  if (notesArr.length > 0) {
    enriched.recentNotes = notesArr.slice(-3).map(n => {
      const date = n.NoteDate || n.notedate || n.Date || '';
      const text = n.NoteText || n.notetext || n.Text || n.Note || JSON.stringify(n);
      const author = n.Author || n.author || n.UserName || '';
      return `[${date}] ${author}: ${text}`;
    }).join(' | ');
  }

  return { enriched, rawLead: lead, rawInfo: info };
}

// ─── Enrich from LP (aggregate across all leads) ─────────────────

function enrichFromLP(enrichedRecord, rawLead) {
  const fullRaw = rawLead || {};

  let prospect = {};
  if (Array.isArray(fullRaw) && fullRaw.length > 0) {
    prospect = fullRaw[0];
  } else if (fullRaw.cst_id || fullRaw.firstname || fullRaw.leads) {
    prospect = fullRaw;
  } else {
    prospect = fullRaw;
  }

  const allLeads = prospect.leads || [];

  let totalAppointments = 0;
  let totalJobs = 0;
  const allAppointments = [];

  for (const lead of allLeads) {
    if (lead.appointments) {
      totalAppointments += lead.appointments.length;
      allAppointments.push(...lead.appointments);
    }
    if (lead.jobs) {
      totalJobs += lead.jobs.length;
    }
  }

  const dispoRank = { 'Data': 1, 'Set': 2, 'Verified': 3, 'Confirmed': 4, 'Issued': 5, 'Sat': 6, 'Sold': 7 };
  const sortedLeads = [...allLeads].sort((a, b) => (dispoRank[b.disposition] || 0) - (dispoRank[a.disposition] || 0));
  const bestLead = sortedLeads.length > 0 ? sortedLeads[0] : null;

  const pf = bestLead ? {
    set: bestLead.apptset === 'true' || bestLead.everset === 'true',
    verified: bestLead.verified === 'true' || bestLead.eververified === 'true',
    confirmed: bestLead.confirmed === 'true' || bestLead.everconfirmed === 'true',
    issued: bestLead.issued === 'true' || bestLead.everissued === 'true',
    sat: bestLead.sat === 'true' || bestLead.eversat === 'true',
    sold: bestLead.sold === 'true'
  } : {};

  let highestStage = 'Data';
  if (pf.sold) highestStage = 'Sold';
  else if (pf.sat) highestStage = 'Sat';
  else if (pf.issued) highestStage = 'Issued';
  else if (pf.confirmed) highestStage = 'Confirmed';
  else if (pf.verified) highestStage = 'Verified';
  else if (pf.set) highestStage = 'Set';

  const markets = [...new Set(allLeads.map(l => l.brn_id).filter(Boolean))].join(', ');
  const totalGrossSale = allLeads.reduce((sum, l) => sum + parseFloat(l.GrossSaleAmount || '0'), 0).toFixed(2);
  const salesRep = bestLead ? (bestLead.salesrepname || '') : '';

  const latestAppt = allAppointments.length > 0
    ? allAppointments.sort((a, b) => new Date(b.apptdate || 0) - new Date(a.apptdate || 0))[0]
    : null;

  let apptDate = '';
  let apptTime = '';
  let apptStatus = '';
  if (latestAppt && latestAppt.apptdate) {
    const dt = new Date(latestAppt.apptdate);
    apptDate = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
    const hours = dt.getHours();
    const mins = String(dt.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    apptTime = ((hours % 12) || 12) + ':' + mins + ' ' + ampm;
    apptStatus = latestAppt.disposition || '';
  }

  // v2.0: Extract the real lds_id from the latest lead for lp_lead_id writeback
  let latestLdsId = '';
  if (allLeads.length > 0) {
    // Use the most recently entered lead's lds_id
    const sortedByDate = [...allLeads].sort((a, b) => {
      const dateA = new Date(a.dateentered || a.DateEntered || a.entrydate || 0);
      const dateB = new Date(b.dateentered || b.DateEntered || b.entrydate || 0);
      return dateB - dateA;
    });
    const latest = sortedByDate[0];
    latestLdsId = String(latest.lds_id || latest.LeadID || latest.id || '');
  }

  const lastSynced = (() => {
    const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const hours = d.getHours();
    const mins = String(d.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const time = ((hours % 12) || 12) + ':' + mins + ' ' + ampm;
    const date = String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0') + '/' + d.getFullYear();
    return date + ' at ' + time;
  })();

  return {
    lp_prospect_id: String(enrichedRecord.lp_prospect_id || prospect.cst_id || ''),
    lp_lead_id: latestLdsId,
    contact_id: enrichedRecord.contact_id || '',
    lp_highest_stage: highestStage,
    lp_market: markets,
    lp_total_leads: allLeads.length,
    lp_gross_sale_amount: totalGrossSale,
    lp_ever_sold: pf.sold ? 'Yes' : 'No',
    lp_ever_sat: pf.sat ? 'Yes' : 'No',
    lp_best_lead_sales_rep: salesRep,
    lp_total_appointments: totalAppointments,
    lp_latest_appt_status: apptStatus,
    lp_last_synced: lastSynced,
    last_appointment_start_date: apptDate,
    last_appointment_start_time: apptTime,
  };
}

// ─── Main route handler ──────────────────────────────────────────

export function registerN8nEnrichRoute(app) {

  app.post('/n8n/enrich-lead', async (req, res) => {
    const startTime = Date.now();

    try {
      const body = req.body || {};
      const lp_prospect_id = body['LP Prospect ID'] || body.lp_prospect_id || body.prospect_id || body.ProspectID || body.prospectid || '';
      const lp_lead_id = body['LP Lead ID'] || body.lp_lead_id || body.lead_id || body.LeadID || body.leadid || body.lds_id || '';
      const contact_id = body.contact_id || body.contactId || body.ghl_contact_id || '';
      const phone = body.phone || body.Phone || '';
      const email = body.email || body.Email || '';
      const first_name = body.first_name || body.firstName || body.FirstName || body.firstname || '';
      const last_name = body.last_name || body.lastName || body.LastName || body.lastname || '';

      if (!contact_id) {
        return res.status(400).json({ success: false, error: 'contact_id is required' });
      }

      const token = await getToken();
      if (!token) {
        return res.status(500).json({ success: false, error: 'Failed to get LP token' });
      }

      let resolvedProspectId = lp_prospect_id ? String(lp_prospect_id).trim() : '';
      let resolvedVia = 'prospect_id';

      // Resolution chain: prospect_id → lead_id → phone/email fallback
      if (!resolvedProspectId && lp_lead_id) {
        resolvedVia = 'lead_id';
        const leadLookup = await lpPost('/api/Customers/GetLead', {
          lds_id: lp_lead_id, PageSize: '1', StartIndex: '1', options: '0',
        }, token);

        let cst_id = '';
        if (Array.isArray(leadLookup) && leadLookup.length > 0) {
          cst_id = String(leadLookup[0].cst_id || leadLookup[0].ProspectID || '');
        } else if (leadLookup.cst_id || leadLookup.ProspectID) {
          cst_id = String(leadLookup.cst_id || leadLookup.ProspectID || '');
        } else if (leadLookup.Records && leadLookup.Records.length > 0) {
          cst_id = String(leadLookup.Records[0].cst_id || '');
        }

        if (cst_id) resolvedProspectId = cst_id;
      }

      // v2.0: Phone/email fallback via GetCustomers3
      if (!resolvedProspectId && (phone || email || last_name)) {
        resolvedVia = 'phone_email_fallback';
        console.log(`[n8n/enrich] No LP IDs available — trying GetCustomers3 fallback for contact ${contact_id}`);
        const fallbackResult = await resolveProspectByPhoneEmail({ phone, email, last_name }, token);
        if (fallbackResult) {
          resolvedProspectId = fallbackResult;
        }
      }

      // v2.0: If still no prospect ID, fetch GHL contact to get phone/email and retry
      if (!resolvedProspectId && contact_id) {
        resolvedVia = 'ghl_contact_fallback';
        console.log(`[n8n/enrich] No LP IDs or phone/email — fetching GHL contact ${contact_id} for phone/email`);
        try {
          const ghlContact = await ghlGet(contact_id);
          const c = ghlContact?.contact || ghlContact || {};
          const ghlPhone = c.phone || '';
          const ghlEmail = c.email || '';
          const ghlLastName = c.lastName || '';
          if (ghlPhone || ghlEmail) {
            const fallbackResult = await resolveProspectByPhoneEmail({
              phone: ghlPhone, email: ghlEmail, last_name: ghlLastName,
            }, token);
            if (fallbackResult) resolvedProspectId = fallbackResult;
          }
        } catch (e) {
          console.error('[n8n/enrich] GHL contact fetch failed:', e.message);
        }
      }

      if (!resolvedProspectId) {
        return res.status(404).json({
          success: false,
          error: 'Could not resolve LP prospect. Tried: prospect_id, lead_id, phone, email, GHL contact lookup. Lead may still be in LP inbound queue (not yet processed).',
          contact_id,
          resolution_attempted: resolvedVia,
        });
      }

      const [fullData, leadInfo] = await Promise.all([
        lpPost('/api/Customers/GetLead', { cst_id: resolvedProspectId, PageSize: '1', StartIndex: '1', options: '0' }, token),
        lpPost('/api/Customers/GetLeadInfo', { prospectid: resolvedProspectId }, token),
      ]);

      const { enriched, rawLead, rawInfo } = buildEnrichedRecord(fullData, leadInfo, resolvedProspectId, contact_id);
      const lpFields = enrichFromLP(enriched, rawLead);

      // ─── v3.0 — Additive tag application (NEVER via PUT body) ──────
      // Apply lp-linked + lp-enriched via POST /contacts/{id}/tags. This
      // leaves all other tags untouched. The previous v2.0 approach (GET
      // tags, merge with new tags, include in PUT body) wiped any tag
      // added between the GET and the PUT — including entry:* and
      // active-entry:* tags added by GHL workflows or agent rules.
      // See file header for full incident notes.
      let lpTagsApplied = false;
      let lpTagsStatus = null;
      try {
        const tagRes = await ghlPostTags(contact_id, ['lp-linked', 'lp-enriched']);
        lpTagsApplied = tagRes.ok;
        lpTagsStatus = tagRes.status;
        if (tagRes.ok) {
          console.log(`[n8n/enrich] ✅ Additive POST lp-linked + lp-enriched to ${contact_id}`);
        } else {
          console.error(`[n8n/enrich] Tag POST returned ${tagRes.status} for ${contact_id}`);
        }
      } catch (e) {
        console.error(`[n8n/enrich] Failed to POST lp-linked/lp-enriched to ${contact_id}: ${e.message}`);
      }

      // v2.0: Include lp_lead_id in customFields so GHL gets the real lds_id
      const customFields = [
        { key: 'lp_prospect_id', field_value: lpFields.lp_prospect_id },
        { key: 'lp_highest_stage', field_value: lpFields.lp_highest_stage },
        { key: 'lp_market', field_value: lpFields.lp_market },
        { key: 'lp_total_leads', field_value: String(lpFields.lp_total_leads) },
        { key: 'lp_gross_sale_amount', field_value: lpFields.lp_gross_sale_amount },
        { key: 'lp_ever_sold', field_value: lpFields.lp_ever_sold },
        { key: 'lp_ever_sat', field_value: lpFields.lp_ever_sat },
        { key: 'lp_best_lead_sales_rep', field_value: lpFields.lp_best_lead_sales_rep },
        { key: 'lp_total_appointments', field_value: String(lpFields.lp_total_appointments) },
        { key: 'lp_latest_appt_status', field_value: lpFields.lp_latest_appt_status },
        { key: 'lp_last_synced', field_value: lpFields.lp_last_synced },
        { key: 'last_appointment_start_date', field_value: lpFields.last_appointment_start_date },
        { key: 'last_appointment_start_time', field_value: lpFields.last_appointment_start_time },
      ];

      // v2.0: Write lp_lead_id (the real lds_id) if we resolved one
      if (lpFields.lp_lead_id) {
        customFields.push({ key: 'lp_lead_id', field_value: lpFields.lp_lead_id });
      }

      // v3.0 — `ghl_update_body` no longer contains `tags`. The n8n workflow's
      // downstream PUT /contacts/{id} will therefore not wipe the tag array.
      // Tags are applied above via additive POST /contacts/{id}/tags.
      const ghlUpdateBody = { customFields };

      const elapsed = Date.now() - startTime;
      res.json({
        success: true,
        contact_id,
        lp_prospect_id: lpFields.lp_prospect_id,
        lp_lead_id: lpFields.lp_lead_id || null,
        resolved_via: resolvedVia,
        ghl_update_body: ghlUpdateBody,
        lp_tags_applied: lpTagsApplied,
        lp_tags_status: lpTagsStatus,
        enriched_summary: {
          firstName: enriched.firstName,
          lastName: enriched.lastName,
          leadStatus: enriched.leadStatus,
          source: enriched.source,
          highestStage: lpFields.lp_highest_stage,
          totalLeads: lpFields.lp_total_leads,
          totalAppointments: lpFields.lp_total_appointments,
          grossSaleAmount: lpFields.lp_gross_sale_amount,
          latestJobStatus: enriched.latestJobStatus,
          lastCallDate: enriched.lastCallDate,
          recentNotes: enriched.recentNotes,
        },
        elapsed_ms: elapsed,
      });

    } catch (err) {
      console.error('[n8n/enrich] Error:', err.stack || err.message);
      res.status(500).json({
        success: false,
        error: err.message,
        contact_id: req.body?.contact_id || '',
      });
    }
  });
}
