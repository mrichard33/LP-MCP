/**
 * LP Lead Handler — src/actions/handlers/lp-lead.js
 *
 * Phase 2 write: agentic creation of a brand-new lead in LP's inbound
 * queue. The catchall path for any contact that booked an appointment
 * but isn't yet in LP — typically chatbot in-session bookings, where
 * Bot 4 books the appointment but no upstream GHL workflow fires
 * LP-Send Lead to Lead Perfection.
 *
 * Why this exists: workflow LP-Send Lead to Lead Perfection (8e30ff37)
 * only fires from three triggers (trigger-hot-call tag, window-estimator
 * tag, manual). Bot 4 booking flow drops chatbot-completed-booked /
 * chatbot-booked-estimate / booked-estimate tags — none of which match
 * any of those triggers, so the lead never gets pushed. Workflow W-E1
 * (75829de7) DOES add a "This lead was sent to Lead Perfection" note
 * with a clickable URL on appointment booking, but that note is just
 * an HTML hyperlink — no actual webhook fires. Result: contact has
 * appointment in GHL only, never in LP. This handler closes the gap.
 *
 * Idempotency: handler short-circuits if either lp_inbound_lead_id or
 * lp_lead_id is already populated on the contact. The reaper marks
 * create_lp_lead non-idempotent (2026-05-01) so retries on stuck rows
 * are failed rather than retried — the in-handler check is the safety
 * net for normal duplicate fires.
 *
 * Field validation: requires firstname, phone, address1, city, state,
 * postalCode, email. Missing-field case is a clean SKIP (not a throw)
 * so the action doesn't churn through retries — operator must update
 * the contact in GHL and the next event-driven fire will retry.
 *
 * On success:
 *   - Write returned in1_id to lp_inbound_lead_id custom field
 *   - Add tag 'lp-pushed-by-agentic' for diagnostics + dedup
 *   - Add GHL note documenting the push (with sender / srs_id / appt)
 *   - Send rich GroupMe notification (always includes "Prospect: PENDING"
 *     line — per Mark's directive that absence is signal)
 *
 * The LP-Inbound Webhook on the GHL side then fires the callback that
 * writes back lp_lead_id and lp_prospect_id and clears any lp-sync-failed
 * tag. Typical end-to-end latency: ~60s.
 *
 * Built 2026-05-01 in response to Jane (mbAtXiTF1bCOBj7KpTfc) — chatbot
 * lead booked Window Estimate that never made it to LP.
 */

import supabase from '../../supabase.js';
import { addLead as lpAddLead, extractInboundLeadId } from '../../lp-client.js';
import { sendGroupMeMessage } from '../../groupme.js';
import { addGHLNote, updateGHLContactFields, applyGHLTag } from '../../ghl.js';
import { isLPLeadId, ghlFetch } from '../helpers.js';
import { parseLongDate } from '../date-parsers.js';
import { resolveContactInfo } from '../resolvers.js';
import { buildRichNotification } from '../enrichment.js';

// ─── GHL custom field IDs (canonical Reece location field map) ─────
const FIELD_LP_INBOUND_LEAD_ID  = '3YMxheIlPyhACB8zyc3W'; // in1_id (LP inbound queue)
const FIELD_LP_LEAD_ID          = 'GmAVmW6V9sekD7pVONKr'; // real lds_id
const FIELD_LP_SOURCE_ID        = 'BbUJ6RrdTjjEqqRA8JVx'; // srs_id (LP SubSource)
const FIELD_LP_PROMOTER_ID      = 'k6j4IBh5IejPooSCsj49'; // pro_id (LP Promoter / employee)
const FIELD_CONTACT_SUMMARY     = 'dDFaBRpRn2aHVZTboUeB'; // pre-built contact summary

// Default LP SubSource ID for chatbot leads. Confirmed by Mark 2026-05-01:
// 5574 is the Reece ChatBot sub-source code. Override via env if Reece's
// SubSource map changes. NOTE: the legacy GHL workflow Chatbot Contact
// Created - Timeout Send Lead has srs_id=830 hardcoded in its URL — that's
// actually pro_id. The workflow has them swapped. Don't copy that bug.
const DEFAULT_CHATBOT_SRS_ID = process.env.LP_DEFAULT_CHATBOT_SRS_ID || '5574';

/**
 * Read a custom field value off a GHL contact's customFields array.
 * Returns the value as a string, or empty string if not present.
 */
function readCF(contact, fieldId) {
  const arr = contact?.customFields || [];
  const f = arr.find(x => x.id === fieldId);
  return (f?.value !== undefined && f?.value !== null) ? String(f.value) : '';
}

/**
 * Format US 10-digit phone for LP. Returns digits-only or empty string.
 */
function normalizePhone(phone) {
  if (!phone) return '';
  return String(phone).replace(/\D/g, '').slice(-10);
}

/**
 * Resolve the appointment date+time. Priority order:
 *   1. action_payload.adate / atime / apptdate / appttime (rule explicitly passed)
 *   2. event_payload.appointment_date / appointment_time (the most
 *      common path — ghl.workflow_handoff appt:booked event from
 *      LP-Set Appointment workflow step 1)
 *   3. ghlContact.last_appointment_start_date / start_time (top-level fields)
 *
 * Returns { adate: 'MM/DD/YYYY', atime: '10:00 AM' } or null when both
 * fields cannot be resolved (or include_appt was set false).
 */
function resolveAppointment(payload, eventPayload, ghlContact, includeAppt) {
  if (!includeAppt) return null;

  let rawDate = payload.adate || payload.apptdate || payload.appt_date || payload.appointment_date
    || eventPayload.appt_date || eventPayload.appointment_date
    || eventPayload.startDate || eventPayload.start_date
    || ghlContact?.last_appointment_start_date
    || ghlContact?.lastAppointmentStartDate
    || null;

  let rawTime = payload.atime || payload.appttime || payload.appt_time || payload.appointment_time
    || eventPayload.appt_time || eventPayload.appointment_time
    || ghlContact?.last_appointment_start_time
    || ghlContact?.lastAppointmentStartTime
    || null;

  // ISO datetime string fallback for date
  if (!rawDate && eventPayload.start_time && String(eventPayload.start_time).includes('T')) {
    rawDate = eventPayload.start_time;
  }
  if (!rawTime && eventPayload.start_time) {
    const st = String(eventPayload.start_time);
    if (st.includes('T')) rawTime = st.split('T')[1]?.slice(0, 5) || null;
  }

  // Reject "null" string sentinel that some GHL workflow fires emit
  if (rawDate === 'null') rawDate = null;
  if (rawTime === 'null') rawTime = null;

  if (!rawDate || !rawTime) return null;

  // Normalize date to MM/DD/YYYY
  let adate;
  if (String(rawDate).includes('-')) {
    const [y, m, d] = String(rawDate).split('T')[0].split('-');
    adate = `${m}/${d}/${y}`;
  } else {
    const long = parseLongDate(String(rawDate));
    adate = long || String(rawDate);
  }

  // Time stays in human format ("10:00 AM"). LP's LeadAdd accepts this.
  const atime = String(rawTime).trim();

  return { adate, atime };
}

export async function executeCreateLPLead(action) {
  const contactId = action.target_id;
  const payload = action.action_payload || {};

  if (!contactId || isLPLeadId(contactId)) {
    throw new Error(`create_lp_lead: target_id must be a GHL contact ID (got: ${contactId})`);
  }

  // ─── Pull event payload ────────────────────────────────────────────
  // Provides appointment_date/time when this rule fires from
  // ghl.workflow_handoff appt:booked.
  let eventPayload = {};
  if (action.event_id) {
    try {
      const { data: evt } = await supabase
        .from('system_events')
        .select('payload')
        .eq('id', action.event_id)
        .maybeSingle();
      if (evt?.payload) {
        eventPayload = typeof evt.payload === 'string' ? JSON.parse(evt.payload) : evt.payload;
      }
    } catch {}
  }

  // ─── Fetch GHL contact ─────────────────────────────────────────────
  let ghlContact = null;
  try {
    const ghlRes = await ghlFetch('GET', `/contacts/${contactId}`);
    ghlContact = ghlRes?.contact || null;
  } catch (err) {
    throw new Error(`create_lp_lead: GHL contact fetch failed for ${contactId}: ${err.message}`);
  }
  if (!ghlContact) {
    throw new Error(`create_lp_lead: GHL contact ${contactId} not found`);
  }

  // ─── Idempotency guard ─────────────────────────────────────────────
  // If either LP ID is already populated, lead is already in (or about
  // to be in) LP. Cleanly skip — never re-post.
  const existingInbound = readCF(ghlContact, FIELD_LP_INBOUND_LEAD_ID);
  const existingLeadId  = readCF(ghlContact, FIELD_LP_LEAD_ID);
  if (existingInbound || existingLeadId) {
    console.log(`[LP-CREATE] ⏭️ Skip: contact ${contactId} already in LP (in1=${existingInbound || 'none'}, lds=${existingLeadId || 'none'})`);
    return {
      action: 'already_in_lp',
      contact_id: contactId,
      lp_inbound_lead_id: existingInbound || null,
      lp_lead_id: existingLeadId || null,
    };
  }

  // ─── Validate required GHL fields ─────────────────────────────────
  // We need the basics that LP requires to create a lead. Skip cleanly
  // (don't throw) if any are missing — the action would just retry and
  // we'd churn notifications. The skip is its own success state.
  const phone     = normalizePhone(ghlContact.phone);
  const firstName = ghlContact.firstName || '';
  const address1  = ghlContact.address1 || '';
  const city      = ghlContact.city || '';
  const state     = ghlContact.state || '';
  const zip       = ghlContact.postalCode || '';
  const email     = ghlContact.email || '';

  const missing = [];
  if (!firstName) missing.push('firstName');
  if (!phone)     missing.push('phone');
  if (!address1)  missing.push('address1');
  if (!city)      missing.push('city');
  if (!state)     missing.push('state');
  if (!zip)       missing.push('postalCode');
  if (!email)     missing.push('email');

  if (missing.length) {
    const { name } = await resolveContactInfo(contactId, eventPayload);
    // v4.2 enrichment: always render the Prospect line. NONE here means
    // the contact isn't in LP yet, which is exactly the state we're trying
    // to fix — so the GroupMe alert points the operator to the missing
    // fields blocking the push.
    const skipMsg = buildRichNotification({
      baseMessage: `⚠️ LP CREATE SKIP: missing required field(s) — ${missing.join(', ')}`,
      name,
      phone,
      contactId,
      prospectId: null, // forces "Prospect: NONE"
      enrichment: {},
    });
    await sendGroupMeMessage(skipMsg).catch(() => {});
    await addGHLNote(contactId,
      `[LP CREATE v1.0] Skipped — required field(s) missing: ${missing.join(', ')}\n` +
      `Lead cannot be pushed to Lead Perfection until these are populated.\n` +
      `Add the missing fields in GHL; the next appointment_booked event will retry the push.`
    ).catch(() => {});
    console.warn(`[LP-CREATE] ⚠️ SKIPPED ${contactId}: missing ${missing.join(', ')}`);
    return {
      action: 'skipped_missing_fields',
      contact_id: contactId,
      missing_fields: missing,
    };
  }

  // ─── Resolve LP source / promoter / product / notes ───────────────
  const srsId = String(payload.srs_id || readCF(ghlContact, FIELD_LP_SOURCE_ID) || DEFAULT_CHATBOT_SRS_ID);
  const proId = String(payload.pro_id || readCF(ghlContact, FIELD_LP_PROMOTER_ID) || '');
  const product = String(payload.product || 'Win');
  const sender = String(payload.sender || `GHL-${ghlContact.source || 'Agentic'}`);
  const contactSummary = readCF(ghlContact, FIELD_CONTACT_SUMMARY);
  const notes = String(
    payload.notes ||
    contactSummary ||
    `Lead from GHL Agentic system. Contact ID: ${contactId}. See chat history in GHL for details.`
  );

  // ─── Resolve appointment (optional, default include) ──────────────
  const includeAppt = payload.include_appt !== false;
  const appt = resolveAppointment(payload, eventPayload, ghlContact, includeAppt);
  const adate = appt?.adate || '';
  const atime = appt?.atime || '';

  // ─── Build payload (REST-style names; addLead's legacy fallback path
  //     handles translation if REST endpoint fails) ─────────────────
  const leadFields = {
    firstname: firstName,
    lastname: ghlContact.lastName || '',
    address1,
    city,
    state,
    zip,
    phone,                                   // REST naming
    email,
    sender,
    srs_id: srsId,
    pro_id: proId,
    productID: product,                       // REST naming
    proddescr: product,
    notes,
    lognumber: contactId,
    User1: contactId,                         // cross-attribution: GHL contact ID in LP
    HasConsent: 'true',
    ConsentDate: ghlContact.dateAdded || new Date().toISOString(),
    TextOptIn: 'true',
    EmailOptIn: 'true',
  };
  if (adate && atime) {
    leadFields.apptdate = adate;              // REST naming
    leadFields.appttime = atime;              // REST naming
  }

  // ─── POST TO LP (REST first, legacy fallback) ─────────────────────
  let lpResponse;
  try {
    lpResponse = await lpAddLead(leadFields);
  } catch (err) {
    // Both REST and legacy paths exhausted. Tag for visibility, escalate
    // to GroupMe with full context, throw so the action goes to 'failed'
    // (reaper marks create_lp_lead non-idempotent so it won't retry).
    const { name } = await resolveContactInfo(contactId, eventPayload);
    await applyGHLTag(contactId, 'lp-sync-failed').catch(() => {});
    const failMsg = buildRichNotification({
      baseMessage: `❌ LP CREATE FAILED: both REST and legacy lppost paths exhausted`,
      name,
      phone,
      contactId,
      prospectId: null, // forces "Prospect: NONE"
      enrichment: {},
    });
    await sendGroupMeMessage(`${failMsg}\n📝 Error: ${String(err.message).slice(0, 250)}\n👉 Manual recovery required.`).catch(() => {});
    throw err;
  }

  // ─── Parse the inbound id from the response ───────────────────────
  const inboundId = extractInboundLeadId(lpResponse);
  if (!inboundId) {
    // LP returned OK but with no parseable in1_id — log raw response,
    // throw so the action goes to 'failed' (reaper non-idempotent guard
    // prevents retry-doubling).
    console.error(`[LP-CREATE] LP returned OK but no in1_id parseable: ${JSON.stringify(lpResponse).slice(0, 300)}`);
    throw new Error(`LP addLead returned OK but in1_id could not be parsed: ${lpResponse?.message || '(no message)'}`);
  }

  const pathTaken = lpResponse?._path || 'unknown'; // 'rest' | 'legacy'

  // ─── Write the in1_id back to GHL ─────────────────────────────────
  // Real lp_lead_id and lp_prospect_id will arrive via the LP-Inbound
  // Webhook callback within ~60s; we don't wait for that here.
  try {
    await updateGHLContactFields(contactId, [
      { id: FIELD_LP_INBOUND_LEAD_ID, field_value: inboundId },
    ]);
    await applyGHLTag(contactId, 'lp-pushed-by-agentic');
  } catch (err) {
    console.warn(`[LP-CREATE] GHL writeback failed (non-blocking): ${err.message}`);
  }

  // ─── Annotate the contact ─────────────────────────────────────────
  const apptLine = adate && atime
    ? `Appointment included: ${adate} at ${atime}`
    : `No appointment included.`;
  await addGHLNote(contactId,
    `[LP CREATE v1.0] Lead pushed to Lead Perfection inbound queue\n` +
    `LP Inbound ID (in1_id): ${inboundId}\n` +
    `Path: ${pathTaken === 'rest' ? 'REST /api/Leads/LeadAdd' : pathTaken === 'legacy' ? 'lppost (legacy fallback)' : 'unknown'}\n` +
    `srs_id: ${srsId} | pro_id: ${proId || '(none)'} | product: ${product} | sender: ${sender}\n` +
    `${apptLine}\n` +
    `LP will issue real lds_id within ~60s and the LP-Inbound Webhook callback will write lp_lead_id + lp_prospect_id back to this contact.`
  ).catch(() => {});

  // ─── Notify GroupMe (always include Prospect line) ────────────────
  // Prospect is "PENDING" because LP hasn't issued the lds_id yet. The
  // follow-up callback (within ~60s) writes lp_prospect_id; reviewer can
  // refresh the contact in 60-90s to see it populated.
  const { name } = await resolveContactInfo(contactId, eventPayload);
  const successMsg = buildRichNotification({
    baseMessage: `🆕 LP Lead Created via ${pathTaken === 'rest' ? 'REST' : 'legacy'} (Inbound: ${inboundId})`,
    name,
    phone,
    contactId,
    prospectId: 'PENDING',  // callback within ~60s will populate
    enrichment: {
      appointmentDate: adate && atime ? `${adate} ${atime}` : null,
      lpSource: sender,
    },
  });
  await sendGroupMeMessage(successMsg).catch(() => {});

  console.log(`[LP-CREATE] ✅ Lead pushed to LP (${pathTaken}): in1_id=${inboundId} for contact ${contactId} (appt: ${adate ? `${adate} ${atime}` : 'none'})`);

  return {
    action: 'lp_lead_created',
    contact_id: contactId,
    lp_inbound_lead_id: inboundId,
    path: pathTaken,
    srs_id: srsId,
    pro_id: proId || null,
    product,
    appt_date: adate || null,
    appt_time: atime || null,
    appt_included: !!(adate && atime),
    lp_response: lpResponse,
  };
}
