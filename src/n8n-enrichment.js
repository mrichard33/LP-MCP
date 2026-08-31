/**
 * n8n Lead Enrichment API — replaces all Code nodes in LP Lead Enrichment workflow
 * 
 * POST /n8n/enrich-lead
 * 
 * This endpoint does everything the 8 Code nodes did:
 * 1. Parse input params from GHL webhook body
 * 2. Get LP token (uses LP MCP's built-in token manager)
 * 3. Resolve prospect ID (from prospect_id, lead_id, OR VERIFIED phone/email fallback)
 * 4. Fetch full lead data + lead info from LP API
 * 5. Build enriched record (aggregate leads, appointments, jobs, calls)
 * 6. Calculate highest stage, market, sale amounts, etc.
 * 7. Apply lp-linked + lp-enriched tags via additive POST (NEVER via PUT)
 * 8. Return customFields-only payload ready for GHL contact update
 *
 * v4.0 — 2026-07-26 — Verified prospect matching (cross-linked contact fix).
 *   PROBLEM: parseGetCustomers3() returned `data[0]` — the first record LP
 *   handed back — with NO comparison against the phone/email/lastname that
 *   was actually searched. Any non-empty GetCustomers3 response became a
 *   "match" and its cst_id was written onto the GHL contact. enrichFromLP()
 *   then stamped that prospect's MOST RECENT lds_id, so every bad link
 *   pointed at a recent, high-numbered lead.
 *
 *   The widest hole was the last-name-only branch, which fired when a
 *   contact had neither phone nor email — i.e. anonymous webchat sessions
 *   ("guest visitor 036"). It searched LP on a display-name fragment and
 *   accepted whatever came back.
 *
 *   Verified live 2026-07-26 (HL Supabase, contacts grouped by custom field
 *   GmAVmW6V9sekD7pVONKr):
 *     lead 555698 → 5 unrelated contacts (dittus, igo, moore, perino, lewis)
 *     lead 560432 → 4 (carmen + 3 "guest visitor" webchat sessions)
 *     lead 558727 → 4 (3 "guest visitor" + ray na)
 *     lead 560362 → 4 (2 "guest visitor" + wilson + miles)
 *     lead 560043 → 3 — Sandrra Crawford inherited Paulette Hendry's
 *                       7/27 10:00 AM appointment. Phones did not match
 *                       (+14074920504 vs 9045348352), so this was never a
 *                       phone collision — it was an unverified accept.
 *
 *   FIX:
 *     1. parseGetCustomers3() (single record, unverified) is REPLACED by
 *        extractArray() from sync-utils.js + pickVerifiedProspect(), which
 *        scans ALL returned rows and accepts only one whose phone (last 10
 *        digits) or email actually equals what we searched for.
 *     2. The last-name-only search is REMOVED. It is unverifiable by
 *        construction.
 *     3. A contact with neither phone nor email is no longer resolved at
 *        all — the endpoint returns its existing 404 instead of guessing.
 *     4. resolved_via now reports match provenance: prospect_id | lead_id |
 *        phone_verified | email_verified | ghl_contact_phone_verified |
 *        ghl_contact_email_verified | unresolved | unresolved_no_identifiers
 *
 *   PRIOR ART: pickPhoneMatch() in src/services/lp-contact-backstop.js
 *   already implements exactly this last-10-digit verification and rejects
 *   a mismatching top hit. This module never received the same hardening.
 *
 *   GOVERNING PRINCIPLE: an unlinked contact is strictly better than a
 *   wrongly-linked one. A 404 is recoverable — the lead is retried when LP
 *   finishes processing it. A wrong link silently shows one homeowner
 *   another homeowner's appointment.
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
import { normalizePhone, getField, extractArray } from './sync-utils.js';
import { latestJobValue } from './lp-job-value.js';

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

// ─── v4.0: VERIFIED prospect resolution ──────────────────────────
//
// Everything below replaces v2.0's parseGetCustomers3() → data[0] accept.
// The contract is now: we only return a prospect we can PROVE matches the
// identifier we searched on. Anything else returns null and the caller
// falls through to the endpoint's 404.

/**
 * Last-10-digit comparison key for a phone, or null when there aren't
 * enough digits to compare. LP and GHL disagree on country code and
 * formatting; the last 10 digits are the stable key. Same convention as
 * pickPhoneMatch() in src/services/lp-contact-backstop.js.
 */
function phoneKey(raw) {
  const digits = normalizePhone(raw);
  return digits && digits.length >= 10 ? digits.slice(-10) : null;
}

/**
 * Every phone LP might have stamped on a prospect record, as last-10 keys.
 * LP's field casing is inconsistent across endpoints (phone1/Phone1/PHONE1),
 * hence getField's case-insensitive fallback.
 */
function prospectPhoneKeys(p) {
  const raw = [
    getField(p, 'phone', 'Phone', 'phone1', 'Phone1', 'homephone', 'HomePhone'),
    getField(p, 'phone2', 'Phone2', 'altphone', 'AltPhone', 'workphone', 'WorkPhone'),
    getField(p, 'phone3', 'Phone3', 'mobile', 'Mobile', 'cellphone', 'CellPhone'),
  ];
  return raw.map(phoneKey).filter(Boolean);
}

/** Normalized email on a prospect record, or null. */
function prospectEmail(p) {
  const e = getField(p, 'email', 'Email', 'emailaddress', 'EmailAddress');
  const t = e ? String(e).trim().toLowerCase() : '';
  return t && t.includes('@') ? t : null;
}

/** cst_id / ProspectID as a string, or null. */
function prospectId(p) {
  const id = getField(p, 'cst_id', 'ProspectID', 'prospectid');
  const s = id !== null && id !== undefined ? String(id).trim() : '';
  return s || null;
}

/**
 * Pick the prospect that ACTUALLY matches what we searched for.
 *
 * Scans EVERY returned row rather than trusting row 0, and requires a
 * concrete equality on the identifier we searched with. Returns
 * { prospect, basis } or null.
 *
 * Returning null is a valid, expected outcome — it means LP gave us rows
 * but none of them are this person. Pre-v4.0 that case silently produced a
 * wrong link.
 */
function pickVerifiedProspect(list, { phone = null, email = null } = {}) {
  const rows = Array.isArray(list) ? list : [];
  if (rows.length === 0) return null;

  const wantPhone = phone ? phoneKey(phone) : null;
  if (wantPhone) {
    const hit = rows.find((p) => prospectPhoneKeys(p).includes(wantPhone));
    if (hit && prospectId(hit)) return { prospect: hit, basis: 'phone_verified' };
  }

  const wantEmail = email ? String(email).trim().toLowerCase() : null;
  if (wantEmail && wantEmail.includes('@')) {
    const hit = rows.find((p) => prospectEmail(p) === wantEmail);
    if (hit && prospectId(hit)) return { prospect: hit, basis: 'email_verified' };
  }

  return null;
}

/**
 * Resolve an LP prospect from phone and/or email, verifying every hit.
 *
 * Returns { prospectId, basis } or null.
 *
 * v4.0 — the last-name-only search was REMOVED. It was unverifiable by
 * construction (LP can return many people named "Crawford" and we have no
 * second factor to choose between them) and it was the direct cause of
 * anonymous webchat contacts inheriting an unrelated prospect: with no
 * phone and no email, the old code searched on the display-name fragment
 * and took row 0. Callers now get null and the endpoint returns its
 * existing 404, which is the correct outcome for a contact we cannot
 * identify.
 */
async function resolveProspectByPhoneEmail({ phone, email }, token) {
  const cleanPhone = normalizePhone(phone) || '';

  if (cleanPhone.length >= 10) {
    console.log(`[n8n/enrich] GetCustomers3: searching by phone ${cleanPhone}`);
    const result = await lpPost('/api/Customers/GetCustomers3', {
      phone: cleanPhone,
      email: '',
      lastname: '',
      prospectid: '',
    }, token);

    const rows = extractArray(result);
    const match = pickVerifiedProspect(rows, { phone: cleanPhone });
    if (match) {
      const id = prospectId(match.prospect);
      console.log(`[n8n/enrich] GetCustomers3 phone match VERIFIED: cst_id=${id}`);
      return { prospectId: id, basis: match.basis };
    }
    if (rows.length > 0) {
      console.warn(
        `[n8n/enrich] GetCustomers3 phone search returned ${rows.length} row(s) but NONE carried ` +
        `${cleanPhone} — rejecting. (Pre-v4.0 this accepted row 0 and produced a cross-linked contact.)`
      );
    }
  }

  if (email && String(email).includes('@')) {
    console.log(`[n8n/enrich] GetCustomers3: searching by email ${email}`);
    const result = await lpPost('/api/Customers/GetCustomers3', {
      phone: '',
      email: email,
      lastname: '',
      prospectid: '',
    }, token);

    const rows = extractArray(result);
    const match = pickVerifiedProspect(rows, { email });
    if (match) {
      const id = prospectId(match.prospect);
      console.log(`[n8n/enrich] GetCustomers3 email match VERIFIED: cst_id=${id}`);
      return { prospectId: id, basis: match.basis };
    }
    if (rows.length > 0) {
      console.warn(
        `[n8n/enrich] GetCustomers3 email search returned ${rows.length} row(s) but NONE carried ` +
        `${email} — rejecting.`
      );
    }
  }

  return null;
}

// ─── Build enriched record from LP data ──────────────────────────

function buildEnrichedRecord(fullData, leadInfo, prospectIdValue, contactId) {
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
    lp_prospect_id: String(prospect.cst_id || prospect.ProspectID || lead.cst_id || lead.ProspectID || prospectIdValue || ''),
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

  // ── lp_gross_sale_amount is ONE job's value (2026-08-31) ──────────
  // This used to SUM GrossSaleAmount across every lead, while
  // src/ghl-field-sync.js wrote a MAX to the SAME GHL field
  // (lp_gross_sale_amount / YWhoVixgPtvEDzSXcMpJ) — so the number a contact
  // displayed depended on which writer ran last. The GHL workflow "C.0-IN Sale
  // Made Entry" reads this field as the stage-1 Client Lifecycle opportunity's
  // monetary value, so on a repeat customer the sum inflated their pipeline by
  // work that was already closed and paid, and the max reported whichever job
  // happened to be biggest.
  //
  // Both writers now mean the same thing, via the same function: the value of
  // the contact's most recent non-cancelled job. Key aliases match the ones
  // src/sync-children.js reads when it writes lp_jobs, so the number derived
  // from a live LP payload here and the number derived from the mirror there
  // agree. Single-job contacts are unaffected.
  const allJobs = allLeads
    .flatMap(l => (Array.isArray(l.jobs) ? l.jobs : []))
    .map(j => ({
      lp_job_id:  j.id ?? j.job_id ?? j.JobID ?? null,
      job_status: j.jobstatus ?? j.JobStatus ?? j.job_status ?? '',
      job_value:  j.grossamount ?? j.GrossAmount ?? j.gsa ?? j.GSA ?? null,
    }));
  const jobGrossSale = latestJobValue(allJobs);
  // Lead-grain fallback for a prospect whose payload carries no job objects:
  // the most recently entered lead that actually has a sale amount, mirroring
  // the same rule one level up rather than reverting to a sum. '0.00' when
  // there is no sale anywhere — unchanged from before, so a prospect with no
  // sale still clears the field rather than leaving a stale number.
  const newestLeadGross = [...allLeads]
    .sort((a, b) => new Date(b.dateentered || b.DateEntered || b.entrydate || 0)
                  - new Date(a.dateentered || a.DateEntered || a.entrydate || 0))
    .map(l => parseFloat(l.GrossSaleAmount || '0'))
    .find(v => Number.isFinite(v) && v > 0);
  const totalGrossSale = (jobGrossSale !== null ? jobGrossSale : (newestLeadGross ?? 0)).toFixed(2);

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

      if (!contact_id) {
        return res.status(400).json({ success: false, error: 'contact_id is required' });
      }

      const token = await getToken();
      if (!token) {
        return res.status(500).json({ success: false, error: 'Failed to get LP token' });
      }

      let resolvedProspectId = lp_prospect_id ? String(lp_prospect_id).trim() : '';
      // v4.0: resolvedVia is set only on SUCCESS, so a failed attempt can never
      // masquerade as a resolution method in the response or the logs.
      let resolvedVia = resolvedProspectId ? 'prospect_id' : 'unresolved';

      // Resolution chain: prospect_id → lead_id → VERIFIED phone/email fallback
      if (!resolvedProspectId && lp_lead_id) {
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

        // lds_id → cst_id is an exact LP key lookup, not a search — no
        // verification needed or possible.
        if (cst_id) {
          resolvedProspectId = cst_id;
          resolvedVia = 'lead_id';
        }
      }

      // v4.0: VERIFIED phone/email fallback. Every hit is checked against the
      // identifier we searched with; the unverifiable last-name search is gone.
      if (!resolvedProspectId && (phone || email)) {
        console.log(`[n8n/enrich] No LP IDs available — trying verified GetCustomers3 fallback for contact ${contact_id}`);
        const fallback = await resolveProspectByPhoneEmail({ phone, email }, token);
        if (fallback) {
          resolvedProspectId = fallback.prospectId;
          resolvedVia = fallback.basis;
        }
      }

      // v4.0: Still nothing — read the GHL contact for a phone/email and retry.
      // A contact carrying NEITHER is not identifiable. We do NOT fall back to
      // a name search: that is precisely how anonymous webchat contacts
      // ("guest visitor NNN") inherited unrelated prospects. Exit to the 404.
      if (!resolvedProspectId && contact_id) {
        try {
          const ghlContact = await ghlGet(contact_id);
          const c = ghlContact?.contact || ghlContact || {};
          const ghlPhone = c.phone || '';
          const ghlEmail = c.email || '';
          if (ghlPhone || ghlEmail) {
            console.log(`[n8n/enrich] Retrying verified fallback with GHL contact ${contact_id} phone/email`);
            const fallback = await resolveProspectByPhoneEmail({ phone: ghlPhone, email: ghlEmail }, token);
            if (fallback) {
              resolvedProspectId = fallback.prospectId;
              resolvedVia = `ghl_contact_${fallback.basis}`;
            }
          } else {
            resolvedVia = 'unresolved_no_identifiers';
            console.warn(
              `[n8n/enrich] contact ${contact_id} has NO phone and NO email — not identifiable. ` +
              `Refusing to guess (v4.0: an unlinked contact beats a wrongly-linked one).`
            );
          }
        } catch (e) {
          console.error('[n8n/enrich] GHL contact fetch failed:', e.message);
        }
      }

      if (!resolvedProspectId) {
        return res.status(404).json({
          success: false,
          error: 'Could not verifiably resolve LP prospect. Tried: prospect_id, lead_id, verified phone match, verified email match, GHL contact lookup. Lead may still be in LP inbound queue (not yet processed), or the contact carries no identifier we can match on.',
          contact_id,
          resolved_via: resolvedVia,
          resolution_attempted: resolvedVia,
        });
      }

      const [fullData, leadInfo] = await Promise.all([
        lpPost('/api/Customers/GetLead', { cst_id: resolvedProspectId, PageSize: '1', StartIndex: '1', options: '0' }, token),
        lpPost('/api/Customers/GetLeadInfo', { prospectid: resolvedProspectId }, token),
      ]);

      const { enriched, rawLead } = buildEnrichedRecord(fullData, leadInfo, resolvedProspectId, contact_id);
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

// Exported for unit tests + introspection (scripts/test-enrichment-prospect-verification.js)
export const __testing = {
  phoneKey,
  prospectPhoneKeys,
  prospectEmail,
  prospectId,
  pickVerifiedProspect,
};
