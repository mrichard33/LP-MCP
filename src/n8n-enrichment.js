/**
 * n8n Lead Enrichment API — replaces all Code nodes in LP Lead Enrichment workflow
 * 
 * POST /n8n/enrich-lead
 * 
 * This endpoint does everything the 8 Code nodes did:
 * 1. Parse input params from GHL webhook body
 * 2. Get LP token (uses LP MCP's built-in token manager)
 * 3. Resolve prospect ID (from prospect_id or lead_id)
 * 4. Fetch full lead data + lead info from LP API
 * 5. Build enriched record (aggregate leads, appointments, jobs, calls)
 * 6. Calculate highest stage, market, sale amounts, etc.
 * 7. Fetch current GHL tags and merge
 * 8. Return complete payload ready for GHL contact update
 */

import { getToken } from '../token-manager.js';

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

  // Latest lead
  const leadsArr = Array.isArray(leads) ? leads : [];
  if (leadsArr.length > 0) {
    const l = leadsArr[leadsArr.length - 1];
    enriched.latestLeadId = String(l.lds_id || l.LeadID || '');
    enriched.latestLeadDate = l.EntryDate || l.entrydate || '';
    enriched.latestLeadSource = l.Source || l.source || '';
    enriched.latestLeadStatus = l.Disposition || l.disposition || l.Status || '';
  }

  // Latest appointment
  const apptsArr = Array.isArray(appointments) ? appointments : [];
  if (apptsArr.length > 0) {
    const a = apptsArr[apptsArr.length - 1];
    enriched.latestApptDate = a.ApptDate || a.apptdate || a.Date || '';
    enriched.latestApptResult = a.Result || a.result || a.Disposition || '';
    enriched.latestApptSalesRep = a.SalesRep || a.salesrep || a.RepName || '';
  }

  // Latest job
  const jobsArr = Array.isArray(jobs) ? jobs : [];
  if (jobsArr.length > 0) {
    const j = jobsArr[jobsArr.length - 1];
    enriched.latestJobId = String(j.job_id || j.JobID || '');
    enriched.latestJobStatus = j.StatusDescription || j.jbs_description || j.Status || '';
    enriched.latestJobDate = j.SoldDate || j.solddate || '';
    enriched.latestJobAmount = String(j.ContractAmount || j.contractamount || j.Amount || '');
  }

  // Latest call
  const callsArr = Array.isArray(callHistory) ? callHistory : [];
  if (callsArr.length > 0) {
    const c = callsArr[callsArr.length - 1];
    enriched.lastCallDate = c.CallDate || c.calldate || '';
    enriched.lastCallResult = c.ResultCode || c.resultcode || c.Result || '';
    enriched.lastCallType = c.CallType || c.calltype || '';
  }

  // Recent notes
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

function enrichFromLP(enrichedRecord, rawLead, rawInfo) {
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

  // Aggregate across all leads
  let totalAppointments = 0;
  let totalJobs = 0;
  const allAppointments = [];
  const allJobsFlat = [];

  for (const lead of allLeads) {
    if (lead.appointments) {
      totalAppointments += lead.appointments.length;
      allAppointments.push(...lead.appointments);
    }
    if (lead.jobs) {
      totalJobs += lead.jobs.length;
      allJobsFlat.push(...lead.jobs);
    }
  }

  // Find the most advanced lead (best disposition)
  const dispoRank = { 'Data': 1, 'Set': 2, 'Verified': 3, 'Confirmed': 4, 'Issued': 5, 'Sat': 6, 'Sold': 7 };
  const sortedLeads = [...allLeads].sort((a, b) => {
    return (dispoRank[b.disposition] || 0) - (dispoRank[a.disposition] || 0);
  });
  const bestLead = sortedLeads.length > 0 ? sortedLeads[0] : null;

  // Pipeline flags from best lead
  const pf = bestLead ? {
    set: bestLead.apptset === 'true' || bestLead.everset === 'true',
    verified: bestLead.verified === 'true' || bestLead.eververified === 'true',
    confirmed: bestLead.confirmed === 'true' || bestLead.everconfirmed === 'true',
    issued: bestLead.issued === 'true' || bestLead.everissued === 'true',
    sat: bestLead.sat === 'true' || bestLead.eversat === 'true',
    sold: bestLead.sold === 'true'
  } : {};

  // Highest pipeline stage
  let highestStage = 'Data';
  if (pf.sold) highestStage = 'Sold';
  else if (pf.sat) highestStage = 'Sat';
  else if (pf.issued) highestStage = 'Issued';
  else if (pf.confirmed) highestStage = 'Confirmed';
  else if (pf.verified) highestStage = 'Verified';
  else if (pf.set) highestStage = 'Set';

  // Market
  const markets = [...new Set(allLeads.map(l => l.brn_id).filter(Boolean))].join(', ');

  // Sale amounts
  const totalGrossSale = allLeads
    .reduce((sum, l) => sum + parseFloat(l.GrossSaleAmount || '0'), 0)
    .toFixed(2);

  // Sales rep from best lead
  const salesRep = bestLead ? (bestLead.salesrepname || '') : '';

  // Latest appointment — sort by date descending
  const latestAppt = allAppointments.length > 0
    ? allAppointments.sort((a, b) => new Date(b.apptdate || 0) - new Date(a.apptdate || 0))[0]
    : null;

  // Split appointment datetime into GHL native date + time fields
  let apptDate = '';
  let apptTime = '';
  let apptStatus = '';
  if (latestAppt && latestAppt.apptdate) {
    const dt = new Date(latestAppt.apptdate);
    apptDate = dt.getFullYear() + '-' +
      String(dt.getMonth() + 1).padStart(2, '0') + '-' +
      String(dt.getDate()).padStart(2, '0');
    const hours = dt.getHours();
    const mins = String(dt.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    apptTime = ((hours % 12) || 12) + ':' + mins + ' ' + ampm;
    apptStatus = latestAppt.disposition || '';
  }

  // Friendly timestamp in Eastern time
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
      // ── Step 1: Parse input params ──
      const body = req.body || {};
      const lp_prospect_id = body['LP Prospect ID'] || body.lp_prospect_id || body.prospect_id || body.ProspectID || body.prospectid || '';
      const lp_lead_id = body['LP Lead ID'] || body.lp_lead_id || body.lead_id || body.LeadID || body.leadid || body.lds_id || '';
      const contact_id = body.contact_id || body.contactId || body.ghl_contact_id || '';

      if (!contact_id) {
        return res.status(400).json({ success: false, error: 'contact_id is required' });
      }
      if (!lp_prospect_id && !lp_lead_id) {
        return res.status(400).json({ success: false, error: 'Must provide lp_prospect_id or lp_lead_id', contact_id });
      }

      // ── Step 2: Get LP token ──
      const token = await getToken();
      if (!token) {
        return res.status(500).json({ success: false, error: 'Failed to get LP token' });
      }

      // ── Step 3: Resolve prospect ID ──
      let resolvedProspectId = lp_prospect_id ? String(lp_prospect_id).trim() : '';

      if (!resolvedProspectId && lp_lead_id) {
        // Look up prospect by lead ID
        const leadLookup = await lpPost('/api/Customers/GetLead', {
          lds_id: lp_lead_id,
          PageSize: '1',
          StartIndex: '1',
          options: '0',
        }, token);

        let cst_id = '';
        if (Array.isArray(leadLookup) && leadLookup.length > 0) {
          cst_id = String(leadLookup[0].cst_id || leadLookup[0].ProspectID || '');
        } else if (leadLookup.cst_id || leadLookup.ProspectID) {
          cst_id = String(leadLookup.cst_id || leadLookup.ProspectID || '');
        } else if (leadLookup.Records && leadLookup.Records.length > 0) {
          cst_id = String(leadLookup.Records[0].cst_id || '');
        }

        if (!cst_id) {
          return res.status(404).json({ success: false, error: `Could not resolve prospect ID from lead ID ${lp_lead_id}`, contact_id });
        }
        resolvedProspectId = cst_id;
      }

      // ── Step 4: Fetch full lead data + lead info in parallel ──
      const [fullData, leadInfo] = await Promise.all([
        lpPost('/api/Customers/GetLead', {
          cst_id: resolvedProspectId,
          PageSize: '1',
          StartIndex: '1',
          options: '0',
        }, token),
        lpPost('/api/Customers/GetLeadInfo', {
          prospectid: resolvedProspectId,
        }, token),
      ]);

      // ── Step 5: Build enriched record ──
      const { enriched, rawLead, rawInfo } = buildEnrichedRecord(fullData, leadInfo, resolvedProspectId, contact_id);

      // ── Step 6: Enrich from LP (aggregate) ──
      const lpFields = enrichFromLP(enriched, rawLead, rawInfo);

      // ── Step 7: Fetch current GHL tags and merge ──
      let mergedTags = ['lp-linked', 'lp-enriched'];
      try {
        const ghlContact = await ghlGet(contact_id);
        const existingTags = ghlContact.contact?.tags || ghlContact.tags || [];
        mergedTags = [...new Set([...existingTags, 'lp-linked', 'lp-enriched'])];
      } catch (e) {
        console.error('[n8n/enrich] Failed to fetch GHL tags:', e.message);
      }

      // ── Step 8: Build final GHL update payload ──
      const ghlUpdateBody = {
        tags: mergedTags,
        customFields: [
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
        ],
      };

      // ── Return complete result ──
      const elapsed = Date.now() - startTime;
      res.json({
        success: true,
        contact_id,
        lp_prospect_id: lpFields.lp_prospect_id,
        ghl_update_body: ghlUpdateBody,
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
