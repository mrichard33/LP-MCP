/**
 * LP Appointment Handler — src/actions/handlers/lp-appointment.js
 *
 * Phase 2 write: push GHL-booked appointments into LeadPerfection via
 * the SetAppointment API. Resolves LP Lead ID through Supabase cache →
 * LP API → GHL field, then calls /api/Leads/SetAppointment with
 * form-encoded payload.
 *
 * Resolution order:
 *   1. target_id is already an LP Lead ID (numeric) → use directly
 *   2. Fetch GHL contact → try resolveLPLeadId() (Supabase cache → LP
 *      GetCustomers3 → GHL field)
 *   3. If no valid lds_id found → notify via GroupMe, add note, SKIP
 *      (not fail). The skip notification points the operator at the
 *      create_lp_lead action as the right next step — that handler
 *      will push the contact into LP's inbound queue with the appt
 *      baked in.
 *
 * Pre-check: if LP already has an appointment on the same normalized
 * date, skip the write (idempotency against retries).
 *
 * 2026-05-01 — REMOVED duplicate executeCreateLPLead from this file.
 * The canonical handler is now src/actions/handlers/lp-lead.js. That
 * version uses srs_id=5574 (corrected from the incorrect '830' that
 * was here — '830' is actually pro_id in Reece's LP source map; the
 * legacy GHL workflow has them swapped) and uses REST field naming
 * so addLead's REST path works without translation.
 *
 * Extracted from action-executor.js v4.2 refactor.
 */

import supabase from '../../supabase.js';
import { setAppointment as lpSetAppointment } from '../../lp-client.js';
import { resolveLPLeadId } from '../../lp-appointment-sync.js';
import { sendGroupMeMessage } from '../../groupme.js';
import { addGHLNote, updateGHLContactFields } from '../../ghl.js';
import { isLPLeadId, ghlFetch } from '../helpers.js';
import { parseLongDate, normalizeDateForComparison } from '../date-parsers.js';
import { resolveContactInfo } from '../resolvers.js';
import { buildRichNotification } from '../enrichment.js';

// GHL custom field IDs used by the writeback path. Keep in sync with
// ghl-field-map.js.
const FIELD_LP_PROSPECT_ID = 'ZRQAVrzhtzApzLlHmT87'; // lp_prospect_id
const FIELD_LP_LEAD_ID     = 'GmAVmW6V9sekD7pVONKr'; // lp_lead_id (real lds_id)

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
      // Use buildRichNotification (v4.2) so the always-on Prospect line
      // renders "Prospect: NONE" — making it visually consistent with
      // create_lp_lead notifications and clearly signaling the gap.
      const skipMsg = buildRichNotification({
        baseMessage: `⚠️ LP APPT SKIP: No valid LP Lead ID — lead may still be in inbound queue or has no LP record yet`,
        name,
        phone,
        contactId,
        prospectId: null, // forces "Prospect: NONE"
        enrichment: {},
      });
      await sendGroupMeMessage(`${skipMsg}\n👉 Manual: set appt directly in LP, OR queue create_lp_lead to push contact + appt in one shot.`).catch(() => {});

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
  // Success notification uses inline formatting (not buildRichNotification)
  // because the LP Lead/Prospect IDs are the authoritative known-good values
  // we want surfaced prominently — not the GHL-derived enrichment fallback.
  await sendGroupMeMessage(
    `📅 LP Appointment Set\n` +
    `Contact: ${name || contactId}\n` +
    `📋 Contact: ${contactId} | Prospect: ${resolvedProspectId || 'NONE'} | LP Lead: ${lpLeadId} (${resolutionSource})\n` +
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
