/**
 * LP Lead Handler — src/actions/handlers/lp-lead.js
 *
 * Phase 2 write: agentic creation of leads in LeadPerfection. Catchall
 * for any contact path that didn't push to LP via a GHL workflow — most
 * commonly chatbot in-session bookings, where Bot 4 books the appointment
 * but no upstream workflow fires LP-Send Lead to Lead Perfection.
 *
 * Idempotency: always check lp_inbound_lead_id and lp_lead_id custom
 * fields BEFORE pushing. If either is set, the lead is already (or will
 * shortly be) in LP — skip with reason 'already_in_lp'. The reaper also
 * marks create_lp_lead non-idempotent so retries won't double-fire even
 * if the in-handler check were bypassed.
 *
 * Required fields: firstname, phone, address1, zip. Missing any of these
 * is a clean SKIP (not a throw) with GroupMe + GHL note explaining what
 * needs to be completed.
 *
 * On success:
 *   - Write returned in1_id to lp_inbound_lead_id custom field
 *   - Add tag 'lp-pushed-by-agentic' for diagnostics + dedup
 *   - Add GHL note documenting the push
 *   - Send rich GroupMe notification (always includes Prospect line,
 *     even when 'PENDING' — per Mark's directive that absence is signal)
 *
 * The LP-Inbound Webhook on the GHL side will then fire the callback
 * that writes back lp_lead_id and lp_prospect_id and clears any
 * lp-sync-failed tag. This handler does not wait for that callback.
 *
 * Built 2026-05-01 in response to Jane (mbAtXiTF1bCOBj7KpTfc) — chatbot
 * lead booked Window Estimate that never made it to LP because none of
 * the four existing LP push paths triggered for her.
 */

import supabase from '../../supabase.js';
import { addLead as lpAddLead } from '../../lp-client.js';
import { sendGroupMeMessage } from '../../groupme.js';
import { addGHLNote, updateGHLContactFields, applyGHLTag } from '../../ghl.js';
import { isLPLeadId, ghlFetch } from '../helpers.js';
import { resolveContactInfo } from '../resolvers.js';

// GHL custom field IDs — pinned in Mark's project memory
const FIELD_LP_INBOUND_LEAD_ID = '3YMxheIlPyhACB8zyc3W';
const FIELD_LP_LEAD_ID         = 'GmAVmW6V9sekD7pVONKr';
const FIELD_LP_SOURCE_ID       = 'BbUJ6RrdTjjEqqRA8JVx'; // srs_id (sub-source)
const FIELD_CONTACT_SUMMARY    = 'dDFaBRpRn2aHVZTboUeB';
const FIELD_LAST_APPT_DATE     = 'x8KO5o89WPLfC7ivia3A'; // last_appointment_start_date
const FIELD_LAST_APPT_TIME     = 'U67epWMNqjbf0SHAllEZ'; // last_appointment_start_time

// Fallback srs_id for chatbot leads when contact-level field is empty.
// Confirmed by Mark 2026-05-01 — this matches the Reece ChatBot
// sub-source code in LP's source/sub-source table.
const DEFAULT_CHATBOT_SRS_ID = '5574';

/**
 * Format US 10-digit phone for LP. Returns digits-only or empty string.
 */
function normalizePhone(phone) {
  if (!phone) return '';
  return String(phone).replace(/\D/g, '').slice(-10);
}

/**
 * Read a custom field value from a GHL contact's customFields array.
 * GHL surfaces custom fields as { id, value } objects.
 */
function readCustomField(ghlContact, fieldId) {
  const arr = ghlContact?.customFields || [];
  const found = arr.find(f => f && f.id === fieldId);
  return found?.value;
}

/**
 * Resolve the appointment date+time. Priority order:
 *   1. action_payload.appt_date / appt_time (rule explicitly passed)
 *   2. event_payload.appointment_date / appointment_time (the most
 *      common path — ghl.workflow_handoff appt:booked event from
 *      LP-Set Appointment workflow step 1)
 *   3. ghlContact custom fields (FIELD_LAST_APPT_DATE/TIME)
 *   4. ghlContact.last_appointment_* (in case GHL surfaces them top-level)
 *
 * Returns { adate: 'MM/DD/YYYY', atime: '10:00 AM' } or null when both
 * fields cannot be resolved.
 */
function resolveAppointment(payload, eventPayload, ghlContact) {
  let rawDate = payload.appt_date || payload.appointment_date
    || eventPayload.appt_date || eventPayload.appointment_date
    || eventPayload.startDate || eventPayload.start_date
    || readCustomField(ghlContact, FIELD_LAST_APPT_DATE)
    || ghlContact?.last_appointment_start_date
    || ghlContact?.lastAppointmentStartDate
    || null;

  let rawTime = payload.appt_time || payload.appointment_time
    || eventPayload.appt_time || eventPayload.appointment_time
    || readCustomField(ghlContact, FIELD_LAST_APPT_TIME)
    || ghlContact?.last_appointment_start_time
    || ghlContact?.lastAppointmentStartTime
    || null;

  // ISO datetime string fallback for date
  if (!rawDate && eventPayload.start_time && String(eventPayload.start_time).includes('T')) {
    rawDate = eventPayload.start_time;
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
    adate = String(rawDate);
  }

  // Time stays in human format ("10:00 AM"). LP's LeadAdd accepts this.
  const atime = String(rawTime);

  return { adate, atime };
}

export async function executeCreateLPLead(action, context = {}) {
  const contactId = action.target_id;
  const payload = action.action_payload || {};

  if (isLPLeadId(contactId)) {
    return { action: 'skipped_target_is_lp_id', contact_id: contactId };
  }

  // ─── Pull event payload ────────────────────────────────────────────
  // Provides appointment_date/time when this rule fires from
  // ghl.workflow_handoff appt:booked.
  let eventPayload = {};
  if (action.event_id) {
    const { data: evt } = await supabase
      .from('system_events')
      .select('payload')
      .eq('id', action.event_id)
      .maybeSingle();
    if (evt?.payload) {
      eventPayload = typeof evt.payload === 'string' ? JSON.parse(evt.payload) : evt.payload;
    }
  }

  // ─── Pull GHL contact ──────────────────────────────────────────────
  let ghlContact = null;
  try {
    const ghlRes = await ghlFetch('GET', `/contacts/${contactId}`);
    ghlContact = ghlRes?.contact || null;
  } catch (err) {
    throw new Error(`GHL contact fetch failed: ${err.message}`);
  }
  if (!ghlContact) throw new Error(`GHL contact ${contactId} not found`);

  // ─── IDEMPOTENCY GUARD ─────────────────────────────────────────────
  // If either LP ID is already populated, lead is already in LP.
  // Cleanly skip — never re-post.
  const existingInbound = readCustomField(ghlContact, FIELD_LP_INBOUND_LEAD_ID);
  const existingLead    = readCustomField(ghlContact, FIELD_LP_LEAD_ID);

  if (existingInbound || existingLead) {
    console.log(`[LP-LEAD] ⏭️ Skip: contact ${contactId} already in LP (in1=${existingInbound}, lds=${existingLead})`);
    return {
      action: 'already_in_lp',
      contact_id: contactId,
      lp_inbound_lead_id: existingInbound || null,
      lp_lead_id: existingLead || null,
    };
  }

  // ─── REQUIRED FIELDS CHECK ─────────────────────────────────────────
  const phone     = normalizePhone(ghlContact.phone);
  const firstname = ghlContact.firstName || '';
  const address1  = ghlContact.address1 || '';
  const zip       = ghlContact.postalCode || '';

  const missing = [];
  if (!firstname) missing.push('firstname');
  if (!phone)     missing.push('phone');
  if (!address1)  missing.push('address1');
  if (!zip)       missing.push('zip');

  if (missing.length) {
    const { name } = await resolveContactInfo(contactId, eventPayload);
    const skipMsg =
      `⚠️ AGENTIC LP-LEAD SKIP: Cannot push to LP — missing required fields\n` +
      `👤 ${name || 'Unknown'} ${phone ? `(${phone})` : ''}\n` +
      `   Contact ID: ${contactId} | Prospect: NONE\n` +
      `Missing: ${missing.join(', ')}\n` +
      `Action required: complete the contact in GHL or push to LP manually.`;
    await sendGroupMeMessage(skipMsg).catch(() => {});
    await addGHLNote(contactId,
      `[AGENTIC LP-LEAD] Skipped — missing required fields: ${missing.join(', ')}`
    ).catch(() => {});
    return {
      action: 'skipped_missing_fields',
      contact_id: contactId,
      missing,
    };
  }

  // ─── BUILD LeadAdd PAYLOAD ─────────────────────────────────────────
  const srs_id = readCustomField(ghlContact, FIELD_LP_SOURCE_ID)
    || payload.srs_id
    || DEFAULT_CHATBOT_SRS_ID;
  const contactSummary = readCustomField(ghlContact, FIELD_CONTACT_SUMMARY)
    || ghlContact.memory_summary
    || '';
  const appt = resolveAppointment(payload, eventPayload, ghlContact);

  const leadFields = {
    firstname,
    lastname: ghlContact.lastName || '',
    address1,
    address2: ghlContact.address2 || '',
    city:     ghlContact.city  || '',
    state:    ghlContact.state || '',
    zip,
    phone,
    phonetype: '1',
    email: ghlContact.email || '',
    productID: 'Windows',
    srs_id: String(srs_id),
    sender: payload.sender || `agentic-${action.rule_applied || 'create_lp_lead'}`,
    notes: contactSummary || `Agentic LP push for GHL contact ${contactId}`,
    lognumber: contactId,
  };
  if (appt) {
    leadFields.apptdate = appt.adate;
    leadFields.appttime = appt.atime;
  }

  // ─── POST TO LP ────────────────────────────────────────────────────
  console.log(`[LP-LEAD] Adding lead: ${firstname} ${ghlContact.lastName || ''} (${phone})${appt ? ` w/ appt ${appt.adate} ${appt.atime}` : ''}`);
  let lpResponse;
  try {
    lpResponse = await lpAddLead(leadFields);
  } catch (err) {
    // LP push failed — escalate to GroupMe + tag for visibility
    const { name } = await resolveContactInfo(contactId, eventPayload);
    await applyGHLTag(contactId, 'lp-sync-failed').catch(() => {});
    await sendGroupMeMessage(
      `🚨 AGENTIC LP-LEAD FAILED: Could not push to LP\n` +
      `👤 ${name || 'Unknown'} (${phone})\n` +
      `   Contact ID: ${contactId} | Prospect: NONE\n` +
      `Error: ${String(err.message).slice(0, 200)}\n` +
      `Action required: manual LP push.`
    ).catch(() => {});
    throw err; // executor will mark failed; reaper will not retry (non-idempotent)
  }

  // Parse the inbound id from the LP response. Both REST and legacy
  // shapes are handled — REST may return { id, in1_id, ... } while
  // legacy lppost returns { status: "OK", message: "lead added: 384191" }.
  let inboundId = null;
  if (lpResponse?.in1_id)        inboundId = String(lpResponse.in1_id);
  else if (lpResponse?.id)       inboundId = String(lpResponse.id);
  else if (lpResponse?.message && typeof lpResponse.message === 'string') {
    const m = lpResponse.message.match(/(\d+)\s*$/);
    if (m) inboundId = m[1];
  }

  if (!inboundId) {
    throw new Error(`LP LeadAdd returned no inbound id: ${JSON.stringify(lpResponse).slice(0, 200)}`);
  }

  // ─── WRITE BACK ────────────────────────────────────────────────────
  try {
    await updateGHLContactFields(contactId, [
      { id: FIELD_LP_INBOUND_LEAD_ID, field_value: inboundId },
    ]);
    await applyGHLTag(contactId, 'lp-pushed-by-agentic');
  } catch (err) {
    console.warn(`[LP-LEAD] Writeback failed (non-blocking): ${err.message}`);
  }

  // ─── NOTES + GROUPME (always include Prospect line) ────────────────
  const { name } = await resolveContactInfo(contactId, eventPayload);
  const apptLine = appt ? `\nAppointment: ${appt.adate} ${appt.atime}` : '';
  const noteText =
    `[AGENTIC LP-LEAD v1.0] Lead pushed to LP\n` +
    `LP Inbound ID: ${inboundId}\n` +
    `srs_id: ${srs_id}` +
    apptLine +
    `\nLP Prospect ID and lp_lead_id will populate via LP-Inbound Webhook callback.`;
  await addGHLNote(contactId, noteText).catch(() => {});

  await sendGroupMeMessage(
    `📝 AGENTIC LP-LEAD: ${name || contactId} pushed to LP\n` +
    `👤 ${name || 'Unknown'} (${phone})\n` +
    `   Contact ID: ${contactId} | Prospect: PENDING (LP callback) | Inbound: ${inboundId}` +
    apptLine
  ).catch(() => {});

  console.log(`[LP-LEAD] ✅ Lead created: contact=${contactId}, in1_id=${inboundId}${appt ? `, appt=${appt.adate} ${appt.atime}` : ''}`);

  return {
    action: 'lp_lead_created',
    contact_id: contactId,
    lp_inbound_lead_id: inboundId,
    appointment: appt,
    srs_id,
    lp_response: lpResponse,
  };
}
