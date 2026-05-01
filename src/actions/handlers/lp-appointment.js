/**
 * LP Appointment Handler — src/actions/handlers/lp-appointment.js
 *
 * TWO handlers:
 *
 *   executeSetLPAppointment — Phase 2 write: push GHL-booked appointments
 *     into LeadPerfection via the SetAppointment API. Resolves LP Lead ID
 *     through Supabase cache → LP API → GHL field, then calls
 *     /api/Leads/SetAppointment with form-encoded payload.
 *
 *   executeCreateLPLead — NEW (2026-05-01). Push a brand-new lead into
 *     LP's inbound queue via the legacy lppost endpoint. Used when the
 *     contact has booked an appointment in GHL but doesn't yet exist in
 *     LP — the typical chatbot/in-session booking path. The legacy
 *     endpoint accepts `adate` + `atime` and creates the appointment as
 *     part of inbound processing, so the lead AND its appointment land
 *     in LP in a single round-trip. The LP-Inbound Webhook callback then
 *     writes lp_lead_id, lp_prospect_id, and LP Disposition back to GHL
 *     within ~60s, completing the chain.
 *
 *     Why this exists: workflow LP-Send Lead to Lead Perfection
 *     (8e30ff37-...) only fires from three triggers (trigger-hot-call tag,
 *     window-estimator tag, manual). Chatbot bookings via Bot 2 / Bot 4
 *     drop tags like chatbot-completed-booked / booked-estimate that don't
 *     match any of those triggers, so the lead never gets pushed. Workflow
 *     W-E1 (75829de7-...) does add a "This lead was sent to Lead Perfection"
 *     note with a clickable URL, but that note is just an HTML link — no
 *     actual webhook fires. Result: contact has appt in GHL only, never
 *     in LP. This handler closes the gap.
 *
 * Resolution order (executeSetLPAppointment):
 *   1. target_id is already an LP Lead ID (numeric) → use directly
 *   2. Fetch GHL contact → try resolveLPLeadId() (Supabase cache → LP GetCustomers3 → GHL field)
 *   3. If no valid lds_id found → notify via GroupMe, add note, SKIP (not fail)
 *
 * Pre-check (executeSetLPAppointment): if LP already has an appointment
 * on the same normalized date, skip the write (idempotency against retries).
 *
 * Idempotency (executeCreateLPLead): if the contact already has
 * lp_inbound_lead_id OR lp_lead_id populated, the handler returns success
 * without making the API call. This means the same action can be safely
 * re-queued or retried without creating duplicate LP records.
 *
 * Extracted from action-executor.js v4.2 refactor; v4.3 adds executeCreateLPLead.
 */

import supabase from '../../supabase.js';
import { setAppointment as lpSetAppointment, addLead as lpAddLead, extractInboundLeadId } from '../../lp-client.js';
import { resolveLPLeadId } from '../../lp-appointment-sync.js';
import { sendGroupMeMessage } from '../../groupme.js';
import { addGHLNote, updateGHLContactFields } from '../../ghl.js';
import { isLPLeadId, ghlFetch } from '../helpers.js';
import { parseLongDate, normalizeDateForComparison } from '../date-parsers.js';
import { resolveContactInfo, resolveLPProspectId } from '../resolvers.js';

// GHL custom field IDs — the canonical Reece location field map. Keep in
// sync with ghl-field-map.js.
const FIELD_LP_PROSPECT_ID      = 'ZRQAVrzhtzApzLlHmT87'; // lp_prospect_id
const FIELD_LP_LEAD_ID          = 'GmAVmW6V9sekD7pVONKr'; // lp_lead_id (real lds_id)
const FIELD_LP_INBOUND_LEAD_ID  = '3YMxheIlPyhACB8zyc3W'; // lp_inbound_lead_id (in1_id)
const FIELD_LP_SOURCE_ID        = 'BbUJ6RrdTjjEqqRA8JVx'; // srs_id (LP SubSource)
const FIELD_LP_PROMOTER_ID      = 'k6j4IBh5IejPooSCsj49'; // pro_id (LP Promoter / employee)
const FIELD_CONTACT_SUMMARY     = 'dDFaBRpRn2aHVZTboUeB'; // pre-built bot-2 contact summary

// Default LP SubSource ID for chatbot leads — matches the hardcoded
// srs_id=830 in the GHL "Chatbot Contact Created - Timeout Send Lead"
// workflow's webhook URL. Override via env if Reece's SubSource map changes.
const DEFAULT_CHATBOT_SRS_ID = process.env.LP_DEFAULT_CHATBOT_SRS_ID || '830';

/**
 * Read a custom field value off a GHL contact's customFields array.
 * Returns the value as a string, or empty string if not present.
 */
function readCF(contact, fieldId) {
  const arr = contact?.customFields || [];
  const f = arr.find(x => x.id === fieldId);
  return f?.value !== undefined && f?.value !== null ? String(f.value) : '';
}

export async function executeSetLPAppointment(action) {
  const contactId = action.target_id;
  const payload = action.action_payload || {};

  let eventPayload = {};
  if (action.event_id) {
    const { data: evt } = await supabase.from('system_events').select('payload').eq('id', action.event_id).maybeSingle();
    if (evt?.payload) eventPayload = typeof evt.payload === 'string' ? JSON.parse(evt.payload) : evt.payload;
  }

  let lpLeadId = null;
  let resolvedProspectId = null;
  let resolutionSource = 'unknown';

  if (isLPLeadId(contactId)) {
    lpLeadId = contactId;
    resolutionSource = 'target_is_lp_lead_id';
    console.log(`[LP-APPT] Target ${contactId} is LP Lead ID — using directly`);
  } else {
    let ghlContact = null;
    try {
      const ghlRes = await ghlFetch('GET', `/contacts/${contactId}`);
      ghlContact = ghlRes?.contact || null;
    } catch (err) {
      console.warn(`[LP-APPT] GHL contact fetch failed for ${contactId}: ${err.message}`);
    }

    const phone = (ghlContact?.phone || '').replace(/\D/g, '').slice(-10);
    const email = ghlContact?.email || '';
    const resolution = await resolveLPLeadId(contactId, { phone, email });

    if (!resolution) {
      const { name } = await resolveContactInfo(contactId, eventPayload);
      // v4.3: include all available IDs in the skip notification so the
      // reviewer can act without flipping between systems. Prospect ID
      // is shown as "pending" since by definition we have no LP record.
      const skipMsg =
        `⚠️ LP APPT SKIP: No valid LP Lead ID for ${name || contactId}\n` +
        `📋 Contact: ${contactId} | Prospect: pending (not in LP) | LP Lead: not found\n` +
        `Lead may still be in LP inbound queue, or has no LP record yet.\n` +
        `Manual action: set appointment in LP directly, OR queue create_lp_lead action.`;
      await sendGroupMeMessage(skipMsg).catch(() => {});

      if (ghlContact) {
        await addGHLNote(contactId,
          `[LP SYNC v4.3] Appointment NOT synced to LP — no valid Lead ID found.\n` +
          `Possible causes: lead still in inbound queue, no LP match, or only in1_id available.\n` +
          `Recommendation: queue a create_lp_lead action to push the contact + appointment to LP in one shot.`
        ).catch(() => {});
      }

      console.warn(`[LP-APPT] ⚠️ SKIPPED: No valid lds_id for contact ${contactId}`);
      return {
        action: 'skipped_no_valid_lead_id',
        contact_id: contactId,
        reason: 'No valid LP Lead ID found through any resolution path',
        resolution_attempted: ['supabase', 'lp_api_customers3', 'ghl_field'],
      };
    }

    lpLeadId = resolution.ldsId;
    resolvedProspectId = resolution.prospectId;
    resolutionSource = resolution.source;

    try {
      const writebackFields = [
        { id: FIELD_LP_LEAD_ID, field_value: lpLeadId },
      ];
      if (resolvedProspectId) {
        writebackFields.push({ id: FIELD_LP_PROSPECT_ID, field_value: resolvedProspectId });
      }
      await updateGHLContactFields(contactId, writebackFields);
      console.log(`[LP-APPT] ✅ Wrote back confirmed lds_id=${lpLeadId}, prospect=${resolvedProspectId} to GHL`);
    } catch (err) {
      console.warn(`[LP-APPT] GHL writeback failed (non-blocking): ${err.message}`);
    }
  }

  if (!lpLeadId) throw new Error(`No LP Lead ID for contact ${contactId}`);

  // ─── Resolve appointment date ──────────────────────────────────────
  let rawDate = payload.appt_date || payload.appointment_date || eventPayload.appt_date
    || eventPayload.appointment_date || eventPayload.startDate || eventPayload.start_date || null;
  if (!rawDate && eventPayload.start_time && String(eventPayload.start_time).includes('T')) {
    rawDate = eventPayload.start_time;
  }
  if (!rawDate && contactId && !isLPLeadId(contactId)) {
    try {
      const ghlRes = await ghlFetch('GET', `/contacts/${contactId}`);
      rawDate = ghlRes?.contact?.last_appointment_start_date || ghlRes?.contact?.lastAppointmentStartDate || null;
    } catch {}
  }
  if (!rawDate) throw new Error('Cannot resolve appointment date');

  let apptDate;
  if (rawDate.includes('-')) {
    const [y, m, d] = rawDate.split('T')[0].split('-');
    apptDate = `${m}/${d}/${y}`;
  } else {
    const longParsed = parseLongDate(rawDate);
    apptDate = longParsed || rawDate;
  }

  // ─── Resolve appointment time ──────────────────────────────────────
  let rawTime = payload.appt_time || payload.appointment_time || eventPayload.appt_time || eventPayload.appointment_time || null;
  if (!rawTime && eventPayload.start_time) {
    const st = String(eventPayload.start_time);
    rawTime = st.includes('T') ? st.split('T')[1]?.slice(0, 5) : st;
  }
  if (!rawTime && contactId && !isLPLeadId(contactId)) {
    try {
      const ghlRes = await ghlFetch('GET', `/contacts/${contactId}`);
      rawTime = ghlRes?.contact?.last_appointment_start_time || ghlRes?.contact?.lastAppointmentStartTime || null;
    } catch {}
  }
  if (!rawTime) throw new Error('Cannot resolve appointment time');

  let apptTime = rawTime;
  const match12 = apptTime.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (match12) {
    let h = parseInt(match12[1], 10);
    const min = match12[2], p = match12[3].toUpperCase();
    if (p === 'AM' && h === 12) h = 0;
    if (p === 'PM' && h !== 12) h += 12;
    apptTime = `${String(h).padStart(2, '0')}:${min}`;
  }
  if (apptTime.length > 5) apptTime = apptTime.slice(0, 5);

  const setBy = payload.set_by || '5686';
  const calendarName = payload.calendar_name || eventPayload.calendar_name || eventPayload.title || 'N/A';

  // ─── Idempotency: skip if LP already has appointment on same date ──
  const ghlDateNormalized = normalizeDateForComparison(rawDate);
  try {
    const { data: existingLead } = await supabase.from('lp_leads')
      .select('appointment_set, appointment_date')
      .eq('lp_lead_id', lpLeadId)
      .maybeSingle();
    if (existingLead?.appointment_set && existingLead.appointment_date) {
      const lpDateNormalized = normalizeDateForComparison(existingLead.appointment_date);
      if (ghlDateNormalized && lpDateNormalized && ghlDateNormalized === lpDateNormalized) {
        console.log(`[LP-APPT] ⏭️ LP already has appointment on ${lpDateNormalized} for lds_id=${lpLeadId}`);
        if (!isLPLeadId(contactId)) {
          await addGHLNote(contactId,
            `[LP SYNC v4.3] Appointment already exists in LP — skipped\n` +
            `LP Lead ID: ${lpLeadId} | Prospect: ${resolvedProspectId || 'N/A'}\n` +
            `Date: ${lpDateNormalized}`
          ).catch(() => {});
        }
        return {
          action: 'already_set_in_lp',
          lp_lead_id: lpLeadId,
          lp_prospect_id: resolvedProspectId,
          lp_appointment_date: lpDateNormalized,
          ghl_appointment_date: ghlDateNormalized,
          calendar_name: calendarName,
          contact_id: contactId,
          resolution_source: resolutionSource,
        };
      }
    }
  } catch (err) {
    console.warn(`[LP-APPT] LP pre-check failed for ${lpLeadId}: ${err.message}`);
  }

  // ─── Write to LP ──────────────────────────────────────────────────
  console.log(`[LP-APPT] Setting appointment: lds_id=${lpLeadId}, date=${apptDate}, time=${apptTime}, resolved_via=${resolutionSource}`);
  const result = await lpSetAppointment({ ldsId: lpLeadId, setBy, apptDate, apptTime });

  if (!isLPLeadId(contactId)) {
    await addGHLNote(contactId,
      `[LP SYNC v4.3] Appointment set in LP\n` +
      `LP Lead ID: ${lpLeadId} (confirmed via ${resolutionSource})\n` +
      `Prospect ID: ${resolvedProspectId || 'N/A'}\n` +
      `Date: ${apptDate}\nTime: ${apptTime}\nCalendar: ${calendarName}`
    ).catch(() => {});
  }
  const { name } = await resolveContactInfo(contactId, eventPayload);
  await sendGroupMeMessage(
    `📅 LP Appointment Set\n` +
    `Contact: ${name || contactId}\n` +
    `📋 Contact: ${contactId} | Prospect: ${resolvedProspectId || 'N/A'} | LP Lead: ${lpLeadId} (${resolutionSource})\n` +
    `Date: ${apptDate} ${apptTime}\nCalendar: ${calendarName}`
  ).catch(() => {});

  console.log(`[LP-APPT] ✅ LP appointment set: lds_id=${lpLeadId}, ${apptDate} ${apptTime}, resolved_via=${resolutionSource}`);
  return {
    action: 'lp_appointment_set',
    lp_lead_id: lpLeadId,
    lp_prospect_id: resolvedProspectId || null,
    appt_date: apptDate,
    appt_time: apptTime,
    set_by: setBy,
    calendar_name: calendarName,
    resolution_source: resolutionSource,
    lp_response: result,
    contact_id: contactId,
  };
}

// ═══════════════════════════════════════════════════════════════════
// executeCreateLPLead — push a GHL contact into LP's inbound queue
// ═══════════════════════════════════════════════════════════════════
//
// Action payload (all optional):
//   sender         — string identifier for LP (defaults to "GHL-<source>")
//   srs_id         — LP SubSource ID; if omitted, falls back to
//                    contact.lp_source_id custom field, then DEFAULT_CHATBOT_SRS_ID
//   pro_id         — LP Promoter / employee ID; defaults to contact's pro_id
//                    custom field, then '' (empty — fine for non-canvassing leads)
//   product        — LP product code (defaults to "Win" for Reece Windows)
//   notes          — note body for LP (defaults to contact.contact_summary
//                    custom field, then "Lead from GHL — see contact for chat history")
//   include_appt   — when true (default), include adate/atime if the contact
//                    has a future appointment booked. Set false to push the
//                    lead WITHOUT an appointment — useful for stall sweeps.
//   adate          — explicit MM/DD/YYYY override (otherwise resolved from
//                    contact.last_appointment_start_date)
//   atime          — explicit time override ("10:00 AM" or "14:00")
//
// Idempotency: the handler short-circuits if either lp_inbound_lead_id or
// lp_lead_id is already populated on the contact. This means the same
// action can be safely re-queued or retried without creating duplicate
// LP records — important because the reaper categorizes create_lp_lead
// as non-idempotent (creates side effects) and we want the action to
// have its OWN cheap idempotency check before the side effect.
//
export async function executeCreateLPLead(action) {
  const contactId = action.target_id;
  const payload = action.action_payload || {};

  if (!contactId || isLPLeadId(contactId)) {
    throw new Error(`create_lp_lead: target_id must be a GHL contact ID (got: ${contactId})`);
  }

  // Pull event payload for appointment data fallback
  let eventPayload = {};
  if (action.event_id) {
    try {
      const { data: evt } = await supabase.from('system_events').select('payload').eq('id', action.event_id).maybeSingle();
      if (evt?.payload) eventPayload = typeof evt.payload === 'string' ? JSON.parse(evt.payload) : evt.payload;
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

  // ─── Idempotency check — already in LP? ───────────────────────────
  // If the contact already has either the inbound queue ID OR the real
  // lp_lead_id, we don't push again. This makes the action safe to retry.
  const existingInboundId = readCF(ghlContact, FIELD_LP_INBOUND_LEAD_ID);
  const existingLeadId    = readCF(ghlContact, FIELD_LP_LEAD_ID);
  if (existingInboundId || existingLeadId) {
    console.log(`[LP-CREATE] ⏭️ Contact ${contactId} already in LP (in1_id=${existingInboundId || 'none'}, lds_id=${existingLeadId || 'none'}) — skipping push`);
    return {
      action: 'already_in_lp',
      contact_id: contactId,
      lp_inbound_lead_id: existingInboundId || null,
      lp_lead_id: existingLeadId || null,
    };
  }

  // ─── Validate required GHL fields ─────────────────────────────────
  // We need phone, address, email, srs_id at minimum. If any are missing,
  // skip cleanly with a notification — DON'T throw, because the action
  // would retry and we'd just notify again. The skip is its own success.
  const phone = (ghlContact.phone || '').replace(/\D/g, '').slice(-10);
  const firstName = ghlContact.firstName || '';
  const address1 = ghlContact.address1 || '';
  const city = ghlContact.city || '';
  const state = ghlContact.state || '';
  const zip = ghlContact.postalCode || '';
  const email = ghlContact.email || '';

  const missing = [];
  if (!firstName) missing.push('firstName');
  if (!phone) missing.push('phone');
  if (!address1) missing.push('address1');
  if (!city) missing.push('city');
  if (!state) missing.push('state');
  if (!zip) missing.push('postalCode');
  if (!email) missing.push('email');

  if (missing.length) {
    const { name } = await resolveContactInfo(contactId, eventPayload);
    const msg =
      `⚠️ LP CREATE SKIP: ${name || contactId} missing required field(s): ${missing.join(', ')}\n` +
      `📋 Contact: ${contactId} | Prospect: pending (not in LP)\n` +
      `Add the missing fields in GHL and the next heartbeat will retry.`;
    await sendGroupMeMessage(msg).catch(() => {});
    await addGHLNote(contactId,
      `[LP CREATE v1.0] Skipped — required field(s) missing: ${missing.join(', ')}\n` +
      `Lead cannot be pushed to Lead Perfection until these are populated.`
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

  // ─── Resolve appointment (optional) ───────────────────────────────
  // Default behavior: include appointment if the contact has one. Caller
  // can disable via include_appt: false (e.g., for stall-sweep pushes
  // where we just want the lead in LP without an appointment).
  const includeAppt = payload.include_appt !== false;
  let adate = '';
  let atime = '';

  if (includeAppt) {
    let rawDate = payload.adate
      || eventPayload.appointment_date || eventPayload.startDate || eventPayload.start_date
      || ghlContact.last_appointment_start_date || ghlContact.lastAppointmentStartDate
      || null;
    if (!rawDate && eventPayload.start_time && String(eventPayload.start_time).includes('T')) {
      rawDate = eventPayload.start_time;
    }
    let rawTime = payload.atime
      || eventPayload.appointment_time
      || ghlContact.last_appointment_start_time || ghlContact.lastAppointmentStartTime
      || null;
    if (!rawTime && eventPayload.start_time) {
      const st = String(eventPayload.start_time);
      rawTime = st.includes('T') ? st.split('T')[1]?.slice(0, 5) : st;
    }

    // Format adate as MM/DD/YYYY (LP legacy lppost requirement)
    if (rawDate) {
      if (String(rawDate).includes('-')) {
        const [y, m, d] = String(rawDate).split('T')[0].split('-');
        adate = `${m}/${d}/${y}`;
      } else {
        const long = parseLongDate(String(rawDate));
        adate = long || String(rawDate);
      }
    }
    // atime: lppost accepts both "10:00 AM" and 24-hour "14:00" — pass through
    if (rawTime) atime = String(rawTime).trim();
  }

  // ─── Build payload and POST to lppost ─────────────────────────────
  const lppostFields = {
    firstname: firstName,
    lastname: ghlContact.lastName || '',
    address1,
    city,
    state,
    zip,
    phone1: phone,
    email,
    sender,
    srs_id: srsId,
    pro_id: proId,
    productid: product,
    proddescr: product,
    notes,
    lognumber: contactId,
    User1: contactId,
    HasConsent: 'true',
    ConsentDate: ghlContact.dateAdded || new Date().toISOString(),
    TextOptIn: 'true',
    EmailOptIn: 'true',
  };
  if (adate && atime) {
    lppostFields.adate = adate;
    lppostFields.atime = atime;
  }

  let result;
  try {
    result = await lpAddLead(lppostFields);
  } catch (err) {
    // The lppost endpoint is unauthenticated and reasonably stable, so a
    // failure here is exceptional — let the action retry. Include enough
    // context in the GroupMe alert that the human can intervene if it
    // doesn't recover on its own.
    const { name } = await resolveContactInfo(contactId, eventPayload);
    await sendGroupMeMessage(
      `❌ LP CREATE FAILED: ${name || contactId}\n` +
      `📋 Contact: ${contactId} | Prospect: pending (not in LP)\n` +
      `Error: ${String(err.message).slice(0, 200)}\n` +
      `Action will retry. Manual recovery: POST to lppost with phone1=${phone}, adate=${adate || 'none'}.`
    ).catch(() => {});
    throw err;
  }

  const inboundId = extractInboundLeadId(result);
  if (!inboundId) {
    // LP returned OK but with no parseable in1_id — log the raw response
    // for forensics, treat as failure so we retry. This shouldn't happen
    // in practice; the lppost endpoint always echoes "lead added: <id>".
    console.error(`[LP-CREATE] LP returned OK but no in1_id parseable from message: ${JSON.stringify(result).slice(0, 300)}`);
    throw new Error(`LP addLead returned OK but in1_id could not be parsed: ${result?.message || '(no message)'}`);
  }

  // ─── Write back to GHL ────────────────────────────────────────────
  // Only the inbound queue ID is known at this point. The real lp_lead_id
  // and lp_prospect_id will be written back by the LP-Inbound Webhook
  // callback once LP finishes processing the inbound queue (~60s).
  try {
    await updateGHLContactFields(contactId, [
      { id: FIELD_LP_INBOUND_LEAD_ID, field_value: inboundId },
    ]);
  } catch (err) {
    console.warn(`[LP-CREATE] GHL writeback failed (non-blocking): ${err.message}`);
  }

  // ─── Annotate the contact ─────────────────────────────────────────
  await addGHLNote(contactId,
    `[LP CREATE v1.0] Lead pushed to Lead Perfection inbound queue\n` +
    `LP Inbound ID (in1_id): ${inboundId}\n` +
    `srs_id: ${srsId} | pro_id: ${proId || '(none)'} | product: ${product}\n` +
    (adate && atime ? `Appointment included: ${adate} at ${atime}\n` : `No appointment included.\n`) +
    `LP will issue real lds_id within ~60s and the LP-Inbound Webhook callback will write lp_lead_id + lp_prospect_id back to this contact.`
  ).catch(() => {});

  // ─── Notify GroupMe ───────────────────────────────────────────────
  // Prospect ID is "pending" because LP hasn't issued the lds_id yet.
  // The follow-up callback (within ~60s) writes lp_prospect_id; if the
  // reviewer needs the prospect ID right away they can refresh the GHL
  // contact in 60-90 seconds.
  const { name } = await resolveContactInfo(contactId, eventPayload);
  await sendGroupMeMessage(
    `🆕 LP Lead Created\n` +
    `Contact: ${name || contactId}\n` +
    `📋 Contact: ${contactId} | Prospect: pending (LP callback within ~60s) | LP Inbound: ${inboundId}\n` +
    (adate && atime ? `Appointment: ${adate} ${atime}\n` : '') +
    `srs_id: ${srsId} | sender: ${sender}`
  ).catch(() => {});

  console.log(`[LP-CREATE] ✅ Lead pushed to LP: in1_id=${inboundId} for contact ${contactId} (appt: ${adate ? `${adate} ${atime}` : 'none'})`);
  return {
    action: 'lp_lead_created',
    contact_id: contactId,
    lp_inbound_lead_id: inboundId,
    srs_id: srsId,
    pro_id: proId || null,
    product,
    appt_date: adate || null,
    appt_time: atime || null,
    appt_included: !!(adate && atime),
    lp_response: result,
  };
}
