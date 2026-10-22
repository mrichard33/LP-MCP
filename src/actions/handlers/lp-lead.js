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
 * Idempotency: handler short-circuits if lp_lead_id is already populated on
 * the contact. An lp_inbound_lead_id ALONE (2026-10-06) is looked up in LP's
 * inbound queue instead of skipped — see lp-lead-inbound-only.js. Since 2026-09-28 it then
 * asks LP by phone whether this person already has a lead from the last 15
 * days, and reuses it instead of creating a duplicate (see
 * src/services/lp-existing-lead-guard.js). The reaper marks
 * create_lp_lead non-idempotent (2026-05-01) so retries on stuck rows
 * are failed rather than retried — the in-handler check is the safety
 * net for normal duplicate fires.
 *
 * Field validation: requires firstname and phone ONLY (Mark, 2026-09-28).
 * Address, city, state, zip and email are sent when present, never
 * required — 7 of 8 missed chat leads had no address and were rejected
 * here. (Email was already optional since 2026-05-02.)
 * Missing-field case is a clean SKIP (not a throw) so the action
 * doesn't churn through retries — operator must update the contact
 * in GHL and the next event-driven fire will retry.
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
 *
 * 2026-05-02 fixes (Jeanne Jewell recovery):
 *   - Email no longer required. Mark confirmed LP accepts emailless leads.
 *   - Email is conditionally included only when present.
 *   - lp-client.js addLead now defaults to LEGACY-FIRST path ordering,
 *     which preserves srs_id/pro_id attribution that REST silently dropped.
 *
 * ═════════════════════════════════════════════════════════════════════
 * v1.3 (2026-08-18) — THE FIELD CONSTANTS WERE SWAPPED. This is the root
 * cause of the whole chatbot-attribution failure; everything else was a
 * symptom.
 *
 * FIELD_LP_SOURCE_ID pointed at BbUJ6RrdTjjEqqRA8JVx and
 * FIELD_LP_PROMOTER_ID at k6j4IBh5IejPooSCsj49. Both are backwards:
 *
 *   BbUJ6RrdTjjEqqRA8JVx  holds the PRO ID     (Elena: 5574)
 *   k6j4IBh5IejPooSCsj49  holds the LP SOURCE  (Elena: 830)
 *
 * Two independent sources agree, and the code was the only dissenter:
 *   - Notion "UTM Parameters" — Chatbot Leads: LP Source ID 830, Pro ID 5574
 *   - src/ghl-field-decoder.js — BbUJ… "Pro ID", k6j4… "LP Source ID"
 *
 * So every push read the promoter into the srs_id slot and the subsource
 * into the pro_id slot. LP then received srs_id=5574 (not a SubSource —
 * resolves to blank) and pro_id=830 (a real promoter — "Godlewski, Paul").
 * That is exactly what Elena's LP record shows: no source, no subsource,
 * and a promoter who never touched the lead.
 *
 * ALSO IN v1.3, correcting v1.2 from earlier the same day:
 *   - pro_id is NOT dropped for digital sources. v1.2 removed it on the
 *     reasoning that a self-serve lead has no promoter. Backwards: the
 *     Notion table gives every digital channel a FIXED per-channel
 *     pseudo-promoter (chatbot 5574, calculator-landing 5862,
 *     calculator-directmail 5396) — that is how LP segments self-serve
 *     traffic in promoter reporting. CANVASSING is the row with no static
 *     Pro ID, because its promoter is a real varying human passed per
 *     lead. resolvePromoterForSource() now fills the registry pair when
 *     the contact carries none, and an explicit value always wins.
 *
 * RETAINED FROM v1.2 (both still correct):
 *   - Chatbot SubSource default is 830, from the registry.
 *   - LP notes carry the full agentic setter brief rather than the AI
 *     Short Summary alone. Elena's LP note was one sentence while her
 *     contact held window count 4, Decision Timeline ASAP, a price
 *     objection, trust score 4/10, Marion county and an 8-turn transcript.
 *
 * IF THE GUARD THROWS on a contact: the contact's custom fields are
 * genuinely swapped. Fix the contact. Do not "fix" the constants below —
 * they now match the Notion table and the decoder.
 * ═════════════════════════════════════════════════════════════════════
 */

import supabase from '../../supabase.js';
import { addLead as lpAddLead, extractInboundLeadId, getCustomers3, getLeads, getInboundLeadInfo } from '../../lp-client.js';
import { readInboundQueueRow } from '../../lp-inbound-queue.js';
import { resolveInboundOnly } from './lp-lead-inbound-only.js';
import { sendGroupMeMessage } from '../../groupme.js';
import { addGHLNote, updateGHLContactFields, applyGHLTag } from '../../ghl.js';
import { isLPLeadId, ghlFetch } from '../helpers.js';
import { parseLongDate } from '../date-parsers.js';
import { isGhlOnlyCalendarId } from '../../knowledge/booking-calendar-router.js';
import { checkConfirmationCallSlot } from '../../services/confirmation-call-slot.js';
import { resolveContactInfo } from '../resolvers.js';
import { buildRichNotification } from '../enrichment.js';
import { LP_SRS, assertNotTransposed, resolvePromoterForSource } from '../../lp-source-ids.js';
import {
  existingLeadGuardMode, existingLeadWindowDays, decideExistingLeadAction,
  flattenLpLeads, pickNewestLead, formatGuardDecisionLine, buildGuardCheck,
  calculatorLeadGuardMode, calcDedupeKey, pickNewestCalculatorLead,
} from '../../services/lp-existing-lead-guard.js';
import { earlierCreateInFlight } from '../../services/lp-appointment-target.js';
import { needsNameRecovery, recoverPlaceholderName } from '../../services/placeholder-name-recovery.js';
import { NAME_PLACEHOLDER_TAG, isPlaceholderSurname } from '../../services/identity-extraction.js';
// v1.2 — the deterministic call-center brief. Pure builder + a fetch
// wrapper that returns null on ANY failure, so this stays fail-soft.
import { buildAgenticLeadNotes, isWeakNotes } from '../../services/agentic-lead-notes.js';
import { fetchAndBuildRepBrief, repBriefMode } from '../../services/rep-brief-io.js';
import { prospectLabel } from '../../format-helpers.js';

// ─── GHL custom field IDs (canonical Reece location field map) ─────
// v1.3: SOURCE and PROMOTER were swapped here from the file's creation
// until 2026-08-18. Verified against Notion "UTM Parameters" AND
// src/ghl-field-decoder.js — both agree with the mapping below.
// DO NOT SWAP THESE BACK.
const FIELD_LP_INBOUND_LEAD_ID  = '3YMxheIlPyhACB8zyc3W'; // in1_id (LP inbound queue)
const FIELD_LP_LEAD_ID          = 'GmAVmW6V9sekD7pVONKr'; // real lds_id
const FIELD_LP_SOURCE_ID        = 'k6j4IBh5IejPooSCsj49'; // srs_id — LP SubSource (3-digit)
const FIELD_LP_PROMOTER_ID      = 'BbUJ6RrdTjjEqqRA8JVx'; // pro_id — LP Promoter (4-digit)
const FIELD_CONTACT_SUMMARY     = 'dDFaBRpRn2aHVZTboUeB'; // AI Short Summary (brief fallback)
const FIELD_CHAT_TRANSCRIPT     = 'RF710H9k39oLl9TsQIy4'; // Chat Transcript (visitor's side of the widget chat)

// Default LP SubSource ID for chatbot leads. Sourced from the registry
// (830 = "Reece ChatBot"). Override via env only if Reece's SubSource map
// changes — and confirm against the Notion "UTM Parameters" table first.
const DEFAULT_CHATBOT_SRS_ID = process.env.LP_DEFAULT_CHATBOT_SRS_ID || LP_SRS.CHATBOT;

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

/**
 * resolveAppointment, minus a Confirmation Call (the user, 2026-10-09: never an
 * LP appointment for a confirmation call). The lead still goes to LP, with no
 * appointment. resolveAppointment falls back to GHL's last_appointment fields,
 * which a booking on ANY calendar fills, so a contact whose last booking is a
 * Confirmation Call would otherwise send the call's time as the LP visit. A
 * payload or event that names an in-home calendar is trusted; one naming a
 * GHL-only calendar is refused; with no calendar, the time is checked against
 * the contact's GHL calendar (fails open on a read failure). Covers all three
 * callers below: a new lead, a reused lead, and an issued inquiry.
 */
async function resolveLpAppointment(payload, eventPayload, ghlContact, includeAppt, contactId, deps = {}) {
  const appt = resolveAppointment(payload, eventPayload, ghlContact, includeAppt);
  if (!appt) return null;
  const calendarId = payload.calendar_id || payload.calendarId || eventPayload.calendar_id || eventPayload.calendarId || null;
  if (calendarId && isGhlOnlyCalendarId(calendarId)) {
    console.log(`[LP-CREATE] ${contactId}: appointment ${appt.adate} ${appt.atime} is on GHL-only calendar ${calendarId} — lead goes to LP without it`);
    return null;
  }
  if (calendarId || !contactId || isLPLeadId(contactId)) return appt;
  const check = deps.checkConfirmationCallSlot || checkConfirmationCallSlot;
  const slot = await check({ contactId, apptDate: appt.adate, apptTime: appt.atime });
  if (slot.blocked) {
    console.log(`[LP-CREATE] ${contactId}: ${appt.adate} ${appt.atime} is GHL-only appointment ${slot.appointment?.appointment_id} (Confirmation Call) — lead goes to LP without it`);
    return null;
  }
  if (slot.reason === 'lookup_failed') {
    console.warn(`[LP-CREATE] ${contactId}: Confirmation Call slot check could not read GHL — keeping ${appt.adate} ${appt.atime} (fail open)`);
  }
  return appt;
}

/**
 * v1.2 — resolve the LP `notes` payload.
 *
 * Priority: explicit payload.notes → full agentic setter brief → AI Short
 * Summary → generic stub. The brief is built from the contact we already
 * fetched, so this costs no extra GHL call.
 *
 * buildAgenticLeadNotes is a pure function over the contact object and
 * never throws on missing fields (each section is dropped when empty), but
 * it is wrapped anyway: a malformed brief must never block a lead reaching
 * LP. Losing detail in the note is recoverable; losing the lead is not.
 */
function resolveNotes(payload, ghlContact, contactId, hasAppointment) {
  if (payload.notes) return String(payload.notes);

  let brief = null;
  try {
    brief = buildAgenticLeadNotes(ghlContact, { hasAppointment });
  } catch (err) {
    console.warn(`[LP-CREATE] brief build failed for ${contactId} (falling back to short summary): ${err.message}`);
  }
  if (brief && !isWeakNotes(brief)) return brief;

  const contactSummary = readCF(ghlContact, FIELD_CONTACT_SUMMARY);
  if (contactSummary) return contactSummary;

  return `Lead from GHL Agentic system. Contact ID: ${contactId}. See chat history in GHL for details.`;
}

/**
 * 2026-09-28 — find this person's newest LP lead by phone, on ANY prospect.
 * Deliberately not resolveLPLeadId: that resolver only accepts a phone match
 * whose lognumber is this GHL contact, and vendor leads posted straight into
 * LP have an empty lognumber — the exact leads we were duplicating. See the
 * header of src/services/lp-existing-lead-guard.js. Throws on an LP error so
 * the caller fails open.
 */
export async function findExistingLpLead(phone, { calculatorOnly = false } = {}) {
  const prospects = await getCustomers3({ phone }, { fast: true });
  const list = (Array.isArray(prospects) ? prospects : [prospects]).filter(Boolean);
  const leads = [];
  // Cap: a phone shared by more than a handful of prospects is a data problem,
  // and every prospect costs one LP round trip on the create path.
  for (const p of list.slice(0, 5)) {
    const pid = p.ProspectID || p.prospectid || p.CstID || p.cst_id;
    if (!pid) continue;
    const res = await getLeads({ cst_id: pid, PageSize: 50 }, { fast: true });
    for (const l of flattenLpLeads(res)) leads.push({ ...l, _prospectId: l._prospectId || String(pid) });
  }
  const newest = calculatorOnly ? pickNewestCalculatorLead(leads) : pickNewestLead(leads);
  if (newest && !newest.createdAtLp) {
    // LP gave no entry time — fall back to our cache. Still nothing means the
    // lead is too new to be synced, which decideExistingLeadAction reads as new.
    try {
      const { data } = await supabase
        .from('lp_leads')
        .select('created_at_lp')
        .eq('lp_lead_id', newest.ldsId)
        .maybeSingle();
      newest.createdAtLp = data?.created_at_lp || null;
    } catch {}
  }
  return newest;
}

/**
 * 2026-09-28 — reuse an existing LP lead instead of creating a duplicate.
 * Writes the lds_id back to GHL and, when there is an appointment to set,
 * hands it to executeSetLPAppointment with the LEAD ID as the target. Passing
 * the contact id instead would re-run resolveLPLeadId, which cannot see a
 * vendor lead with no lognumber and would skip the appointment. The date and
 * time go in the payload because SetAppointment only reads them off the GHL
 * contact when its target is a contact.
 */
async function reuseExistingLpLead(action, contactId, existing, appt) {
  await updateGHLContactFields(contactId, [{ id: FIELD_LP_LEAD_ID, field_value: existing.ldsId }]).catch(() => {});
  await applyGHLTag(contactId, 'lp-existing-lead-reused').catch(() => {});

  let apptResult = null;
  if (appt) {
    try {
      const { executeSetLPAppointment } = await import('./lp-appointment.js');
      apptResult = await executeSetLPAppointment({
        ...action,
        target_id: existing.ldsId,
        action_payload: { ...(action.action_payload || {}), appt_date: appt.adate, appt_time: appt.atime },
      });
      // 2026-10-12: an LP refusal is now RETURNED, not thrown, so it keeps the
      // same "set it by hand" card as a thrown failure below.
      if (apptResult?.action === 'lp_appointment_refused') {
        await sendGroupMeMessage(
          `⚠️ LP APPT NOT SET on the reused LP lead of ${prospectLabel(existing._prospectId)} (contact ${contactId}, ${appt.adate} ${appt.atime}): ` +
          `LP said "${String(apptResult.lp_message || '').slice(0, 200)}"\n👉 Set the appointment in LP by hand.`
        ).catch(() => {});
      }
    } catch (err) {
      apptResult = { action: 'set_appt_error', error: err.message };
      // We did not create a lead, so this appointment now exists only in GHL.
      // Say so loudly — the reuse must not turn a booking into a silent miss.
      await sendGroupMeMessage(
        `⚠️ LP APPT NOT SET on the reused LP lead of ${prospectLabel(existing._prospectId)} (contact ${contactId}, ${appt.adate} ${appt.atime}): ${String(err.message).slice(0, 200)}\n👉 Set the appointment in LP by hand.`
      ).catch(() => {});
    }
  }

  const srcLabel = existing.lpSourceDetail || existing.lpSource || 'source unknown';
  await addGHLNote(contactId,
    `[LP CREATE v1.4] Did NOT create a new LP lead — this person already has LP lead ${existing.ldsId} ` +
    `(${srcLabel}, created ${existing.createdAtLp || 'within the last sync cycle'}).\n` +
    (apptResult
      ? `Appointment ${appt.adate} ${appt.atime} handed to SetAppointment → ${apptResult.action}${apptResult.error ? ` (${apptResult.error})` : ''}`
      : 'No appointment to set.')
  ).catch(() => {});

  console.log(`[LP-CREATE] ♻️ Reused existing LP lead ${existing.ldsId} for ${contactId} (${srcLabel}); appt=${apptResult?.action || 'none'}`);
  return {
    action: 'existing_lp_lead_reused',
    contact_id: contactId,
    lp_lead_id: existing.ldsId,
    lp_prospect_id: existing.prospectId,
    existing_source: srcLabel,
    existing_created_at_lp: existing.createdAtLp,
    appointment_result: apptResult,
  };
}

/**
 * 2026-10-08 — calculator lane gate (payload.lead_lane === 'calculator').
 * Order: (1) idempotency ledger: a completed calculator push for this phone
 * in the last N days → stop; (2) LP by phone: a CALCULATOR-source lead in the
 * last N days → reuse it (no new lead); (3) otherwise create a new
 * calculator-source lead, even when the person has leads from other sources.
 * The contact's LP Lead ID field is ignored here on purpose: enrichment fills
 * it with whatever lead is newest, regardless of source or age (Nancy Marin,
 * Annie, 2026-10). FAIL-OPEN on lookup errors (create), matching the house
 * posture: a duplicate is repairable, a lost lead is not.
 * Returns { stop, response, check }.
 */
async function runCalculatorLaneGate(action, contactId, ghlContact) {
  const mode = calculatorLeadGuardMode();
  const windowDays = existingLeadWindowDays();
  const phone = normalizePhone(ghlContact.phone);
  const key = calcDedupeKey(phone);
  const check = { mode, key, window_days: windowDays, decision: 'none' };
  if (mode === 'off' || !key) {
    check.decision = mode === 'off' ? 'off' : 'no_phone';
    return { stop: false, check };
  }

  // (1) Ledger
  try {
    const since = new Date(Date.now() - windowDays * 86400000).toISOString();
    let q = supabase
      .from('agent_actions')
      .select('id, created_at, target_id, execution_result')
      .eq('action_type', 'create_lp_lead')
      .eq('status', 'completed')
      .eq('execution_result->>calc_dedupe_key', key)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(1);
    if (action.id) q = q.neq('id', action.id);
    const { data } = await q;
    const prior = data?.[0];
    if (prior) {
      check.decision = mode === 'live' ? 'ledger_hit' : 'would_ledger_hit';
      check.prior_action_id = prior.id;
      check.prior_lp_lead_id = prior.execution_result?.lp_lead_id || null;
      check.prior_in1_id = prior.execution_result?.lp_inbound_lead_id || null;
      console.log(`[LP-CREATE] CALC-LANE decision=${check.decision} contact=${contactId} key=${key} prior_action=${prior.id}`);
      if (mode === 'live') {
        await addGHLNote(contactId,
          `[LP CREATE calc] Did NOT create a new LP lead — a calculator lead for this phone was already sent ` +
          `on ${prior.created_at} (action ${prior.id}${check.prior_lp_lead_id ? `, LP lead ${check.prior_lp_lead_id}` : ''}).`
        ).catch(() => {});
        return {
          stop: true,
          check,
          response: { action: 'calculator_already_sent', contact_id: contactId, calc_dedupe_key: key, calculator_check: check },
        };
      }
    }
  } catch (err) {
    check.ledger_error = String(err.message).slice(0, 200);
    console.warn(`[LP-CREATE] CALC-LANE ledger lookup failed for ${contactId} (fail-open): ${err.message}`);
  }

  // (2) LP by phone — calculator-source leads only
  try {
    const existing = await findExistingLpLead(phone, { calculatorOnly: true });
    if (existing) {
      const verdict = decideExistingLeadAction({ createdAtLp: existing.createdAtLp, now: new Date(), windowDays });
      check.existing_calc_lead = existing.ldsId;
      check.existing_created_at_lp = existing.createdAtLp || null;
      if (verdict === 'reuse') {
        check.decision = mode === 'live' ? 'reused_calc_lead' : 'would_reuse_calc_lead';
        console.log(`[LP-CREATE] CALC-LANE decision=${check.decision} contact=${contactId} lds=${existing.ldsId}`);
        if (mode === 'live') {
          const reused = await reuseExistingLpLead(action, contactId, existing, null);
          return { stop: true, check, response: { ...reused, calc_dedupe_key: key, calculator_check: check } };
        }
      } else {
        check.decision = 'create_calc_lead_older_than_window';
      }
    } else {
      check.decision = 'create_no_calc_lead';
    }
  } catch (err) {
    check.decision = 'create_lookup_error';
    check.lookup_error = String(err.message).slice(0, 200);
    console.warn(`[LP-CREATE] CALC-LANE LP lookup failed for ${contactId} (fail-open → create): ${err.message}`);
  }
  console.log(`[LP-CREATE] CALC-LANE decision=${check.decision} contact=${contactId} key=${key}`);
  return { stop: false, check };
}

export { resolveLpAppointment };

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

  // ─── Calculator lane (2026-10-08) ──────────────────────────────────
  // Source-aware dedupe replaces the contact-field checks below for
  // calculator pushes. See runCalculatorLaneGate.
  const isCalcLane = payload.lead_lane === 'calculator';
  let calcCheck = null;
  if (isCalcLane) {
    const gate = await runCalculatorLaneGate(action, contactId, ghlContact);
    calcCheck = gate.check;
    if (gate.stop) return gate.response;
  }

  // ─── Idempotency guard ─────────────────────────────────────────────
  // If either LP ID is already populated, lead is already in (or about
  // to be in) LP. Never re-post. (Skipped for the calculator lane — its
  // gate above already decided, and these fields may hold another
  // source's old lead.)
  // 2026-10-22 — the 15-day lead rule (services/lp-appointment-target.js) sent
  // this row because the person's newest LP lead is older than 15 days (or
  // there is none). The stored LP Lead ID is that old lead, a cache and not an
  // authority, so it is ignored and cleared: kept, it would make this action
  // answer already_in_lp, and GHL's I.LP-A fallback would SetAppointment onto
  // it from {{contact.lp_lead_id}} (prospect 119890). The existing-lead guard
  // below still runs, so a lead entered in the last 15 days is reused.
  const targetRuleNewLead = payload.target_rule === 'create_new';
  if (targetRuleNewLead && !isCalcLane && readCF(ghlContact, FIELD_LP_LEAD_ID)) {
    const old = readCF(ghlContact, FIELD_LP_LEAD_ID);
    await updateGHLContactFields(contactId, [{ id: FIELD_LP_LEAD_ID, field_value: '' }])
      .then(() => console.log(`[LP-CREATE] 15-day rule: cleared the stored LP Lead ID of ${contactId} (an older lead) before creating a new one`))
      .catch((err) => console.warn(`[LP-CREATE] 15-day rule: could not clear the stored LP Lead ID of ${contactId}: ${err.message}`));
    await addGHLNote(contactId,
      `[LP CREATE] 15-day lead rule: the stored LP Lead ID (${old}) is an older lead, so it was cleared and a NEW LP lead is being created for this appointment.`
    ).catch(() => {});
  }
  const existingInbound = (isCalcLane || targetRuleNewLead) ? '' : readCF(ghlContact, FIELD_LP_INBOUND_LEAD_ID);
  const existingLeadId  = (isCalcLane || targetRuleNewLead) ? '' : readCF(ghlContact, FIELD_LP_LEAD_ID);
  // 2026-10-06 — an inquiry id with NO lead id is not "already in LP": the
  // inquiry may still be waiting in LP's inbound queue (Shelley, in1 428940).
  // Look it up; write back an issued lds and set the appointment on it, or say
  // it is waiting. Never addLead. See lp-lead-inbound-only.js.
  if (existingInbound && !existingLeadId) {
    const appt = await resolveLpAppointment(payload, eventPayload, ghlContact, payload.include_appt !== false, contactId);
    return resolveInboundOnly({
      action, contactId, in1: existingInbound, appt,
      deps: {
        readQueueRow: (in1) => readInboundQueueRow(supabase, in1),
        getInboundLeadInfo: (params) => getInboundLeadInfo(params, { fast: true }),
        writeLeadId: (cid, lds) => updateGHLContactFields(cid, [{ id: FIELD_LP_LEAD_ID, field_value: lds }]),
        setAppointment: async (a) => (await import('./lp-appointment.js')).executeSetLPAppointment(a),
        addNote: (cid, text) => addGHLNote(cid, text),
      },
    });
  }
  if (existingLeadId) {
    console.log(`[LP-CREATE] ⏭️ Skip: contact ${contactId} already in LP (in1=${existingInbound || 'none'}, lds=${existingLeadId || 'none'})`);
    // 2026-10-16 (Melissa, 584060): a lead 8e30ff37 added with the appointment
    // on it shows "No, Setter". One SetAppointment with set_by 5686 at the time
    // LP already holds, never retried (src/lp-setter-stamp.js). Fire-and-forget.
    stampSetterFromLive(contactId, existingLeadId).catch(() => {});
    return {
      action: 'already_in_lp',
      contact_id: contactId,
      lp_inbound_lead_id: existingInbound || null,
      lp_lead_id: existingLeadId || null,
    };
  }

  // ─── Existing-LP-lead guard (2026-09-28) ──────────────────────────
  // The GHL-field check above misses vendor leads that went straight into
  // LP and never wrote back to this contact. Ask LP by phone. FAIL-OPEN:
  // any error proceeds to create — a duplicate is repairable, a lost lead
  // is not. Mode: LP_CREATE_EXISTING_LEAD_GUARD_MODE (shadow | live | off).
  // 2026-09-29: every evaluation logs ONE "EXISTING-LEAD decision=" line and
  // returns the same decision as execution_result.existing_lead_check — see
  // formatGuardDecisionLine for why (the first shadow review had no count).
  const guardMode = isCalcLane ? 'off' : existingLeadGuardMode();
  const guardPhone = normalizePhone(ghlContact.phone);
  const windowDays = existingLeadWindowDays();
  let guard = { decision: guardMode === 'off' ? 'off' : 'no_phone', existing: null, error: null };
  if (guardMode !== 'off' && guardPhone) {
    try {
      const existing = await findExistingLpLead(guardPhone);
      if (!existing) {
        guard = { decision: 'none', existing: null, error: null };
      } else {
        const verdict = decideExistingLeadAction({ createdAtLp: existing.createdAtLp, now: new Date(), windowDays });
        const decision = verdict !== 'reuse' ? 'create' : (guardMode === 'live' ? 'reused' : 'would_reuse');
        guard = { decision, existing, error: null };
      }
    } catch (err) {
      guard = { decision: 'error', existing: null, error: err.message };
    }
  }
  if (guardMode !== 'off') {
    const line = formatGuardDecisionLine({ contactId, mode: guardMode, windowDays, ...guard });
    if (guard.decision === 'error') console.warn(line); else console.log(line);
  }
  const existingLeadCheck = buildGuardCheck({ mode: guardMode, ...guard });
  if (guard.decision === 'reused') {
    const appt = await resolveLpAppointment(payload, eventPayload, ghlContact, payload.include_appt !== false, contactId);
    const reused = await reuseExistingLpLead(action, contactId, guard.existing, appt);
    return { ...reused, existing_lead_check: existingLeadCheck };
  }

  // ─── One create per booking (2026-10-22) ──────────────────────────
  // The 15-day lead rule (services/lp-appointment-target.js) queues its own
  // create_lp_lead next to the booking rule's; an earlier one that already sent
  // a lead (or is sending it now) wins. Fails open: a duplicate is repairable,
  // a lost lead is not.
  if (!isCalcLane && action.id != null) {
    try {
      const since = new Date(Date.now() - 2 * 3600_000).toISOString();
      const { data } = await supabase.from('agent_actions')
        .select('id, status, execution_result')
        .eq('action_type', 'create_lp_lead').eq('target_id', contactId)
        .gte('created_at', since).limit(10);
      const earlier = earlierCreateInFlight(data || [], action.id);
      if (earlier) {
        console.log(`[LP-CREATE] ⏭️ ${contactId}: create_lp_lead ${earlier.id} already ${earlier.result || earlier.status} — not sending a second lead`);
        return { action: 'skipped_create_in_flight', contact_id: contactId, earlier_action_id: earlier.id, earlier_result: earlier.result || earlier.status, existing_lead_check: existingLeadCheck };
      }
    } catch (err) {
      console.warn(`[LP-CREATE] in-flight create check failed for ${contactId} (proceeding): ${err.message}`);
    }
  }

  // ─── Placeholder-name recovery (2026-09-28) ───────────────────────
  // Chat contacts are created as "Guest Visitor xxxxx" (often normalised to
  // a bare "guest"). If the visitor gave their name in the chat, write it to
  // GHL and send LP the real name. If not, the contact is skipped below as
  // missing a first name — LP never gets a placeholder (Mark, 2026-09-28).
  // Runs after the existing-lead guard on purpose: a reused lead already has
  // its name in LP, so there is nothing to recover.
  let nameRecovery = null;
  if (needsNameRecovery(ghlContact.firstName, ghlContact.lastName)) {
    const wasName = [ghlContact.firstName, ghlContact.lastName].filter(Boolean).join(' ') || '(blank)';
    let rec = null;
    if (!normalizePhone(ghlContact.phone)) {
      // Skipped below for the phone anyway — do not spend a model call on it.
      rec = { found: false, reason: 'no phone, chat not read' };
    } else {
      try {
        rec = await recoverPlaceholderName(contactId, ghlContact, { transcript: readCF(ghlContact, FIELD_CHAT_TRANSCRIPT) });
      } catch (err) {
        rec = { found: false, reason: `recovery failed: ${err.message}` };
      }
    }
    if (rec.found) {
      ghlContact = { ...ghlContact, ...rec.payload };
      nameRecovery = { from: wasName, to: [rec.firstName, rec.lastName].filter(Boolean).join(' '), ghl_write: rec.ghlWrite, fields: Object.keys(rec.payload) };
      await addGHLNote(contactId,
        `[LP CREATE v1.4] Name recovered from the chat: "${nameRecovery.to}" (was "${wasName}").\n` +
        `Updated on this contact: ${nameRecovery.fields.join(', ')}` +
        (rec.ghlWrite === true ? '' : ` — GHL update did NOT save (${rec.ghlWrite}); LP still gets the real name.`)
      ).catch(() => {});
      console.log(`[LP-CREATE] 🪪 ${contactId}: recovered name "${nameRecovery.to}" from chat (was "${wasName}", ghl_write=${rec.ghlWrite})`);
    } else {
      nameRecovery = { from: wasName, to: null, reason: rec.reason };
      ghlContact = { ...ghlContact, firstName: '', lastName: '' };
      await applyGHLTag(contactId, NAME_PLACEHOLDER_TAG).catch(() => {});
      console.warn(`[LP-CREATE] 🪪 ${contactId}: placeholder name "${wasName}", none recovered (${rec.reason})`);
    }
  }

  // 2026-10-16 (Melissa): a real first name next to the widget's surname
  // ("Visitor Anlxy") reaches LP with the first name only.
  if (isPlaceholderSurname(ghlContact.lastName)) ghlContact = { ...ghlContact, lastName: '' };

  // ─── Validate required GHL fields ─────────────────────────────────
  // LP needs a first name and a phone — nothing else (Mark, 2026-09-28).
  // EMAIL IS NOT REQUIRED — LP accepts leads without email (2026-05-02).
  // Skip cleanly (don't throw) if any required field is missing — the
  // action would just retry and we'd churn notifications. The skip is
  // its own success state.
  const phone     = normalizePhone(ghlContact.phone);
  const firstName = ghlContact.firstName || '';
  const address1  = ghlContact.address1 || '';
  const city      = ghlContact.city || '';
  const state     = ghlContact.state || '';
  const zip       = ghlContact.postalCode || '';
  const email     = ghlContact.email || ''; // optional — included only if present

  const missing = [];
  if (!firstName) missing.push('firstName');
  if (!phone)     missing.push('phone');
  // 2026-09-28 (Mark): LP needs a NAME and a PHONE — nothing else is
  // required. Address, city, state, zip and email are sent when present
  // (lp-client's addLead strips blanks) but never block the push.

  if (missing.length) {
    const { name } = await resolveContactInfo(contactId, eventPayload);
    // v4.2 enrichment: always render the Prospect line. NONE here means
    // the contact isn't in LP yet, which is exactly the state we're trying
    // to fix — so the GroupMe alert points the operator to the missing
    // fields blocking the push.
    const placeholderLine = nameRecovery && !nameRecovery.to
      ? ` (name on file was "${nameRecovery.from}"; ${nameRecovery.reason})`
      : '';
    const skipMsg = buildRichNotification({
      baseMessage: `⚠️ LP CREATE SKIP: missing required field(s) — ${missing.join(', ')}${placeholderLine}`,
      name,
      phone,
      contactId,
      prospectId: null, // forces "Prospect: NONE"
      enrichment: {},
    });
    await sendGroupMeMessage(skipMsg).catch(() => {});
    await addGHLNote(contactId,
      `[LP CREATE v1.3] Skipped — required field(s) missing: ${missing.join(', ')}${placeholderLine}\n` +
      `Lead cannot be pushed to Lead Perfection until these are populated.\n` +
      `Add the missing fields in GHL; the next appointment_booked event will retry the push.`
    ).catch(() => {});
    console.warn(`[LP-CREATE] ⚠️ SKIPPED ${contactId}: missing ${missing.join(', ')}`);
    return {
      action: 'skipped_missing_fields',
      contact_id: contactId,
      missing_fields: missing,
      name_recovery: nameRecovery,
      existing_lead_check: existingLeadCheck,
    };
  }

  // ─── Resolve LP source / promoter / product / notes ───────────────
  // v1.3: FIELD_LP_SOURCE_ID / FIELD_LP_PROMOTER_ID were swapped until
  // today. See the header. srs_id is 3-digit, pro_id is 4-digit.
  const srsId = String(payload.srs_id || readCF(ghlContact, FIELD_LP_SOURCE_ID) || DEFAULT_CHATBOT_SRS_ID);
  const contactProId = String(payload.pro_id || readCF(ghlContact, FIELD_LP_PROMOTER_ID) || '');

  // Transposition guard, BEFORE the registry fills anything in — so it
  // inspects what the contact actually carries rather than what we would
  // have substituted. A throw here means the CONTACT's custom fields are
  // swapped: fix the contact, not this file.
  assertNotTransposed(srsId, contactProId);

  // v1.3 — every digital channel has a FIXED per-channel pseudo-promoter
  // in the Notion "UTM Parameters" table (chatbot 5574, calculator-landing
  // 5862, calculator-directmail 5396). An explicit value on the contact or
  // payload always wins, so canvassing and events keep the real human
  // promoter they pass per lead.
  const proId = resolvePromoterForSource(srsId, contactProId);
  const proIdFromRegistry = !contactProId && !!proId;

  const product = String(payload.product || 'Win');
  const sender = String(payload.sender || `GHL-${ghlContact.source || 'Agentic'}`);

  // ─── Resolve appointment (optional, default include) ──────────────
  const includeAppt = payload.include_appt !== false;
  const appt = await resolveLpAppointment(payload, eventPayload, ghlContact, includeAppt, contactId);
  const adate = appt?.adate || '';
  const atime = appt?.atime || '';

  // v1.2 — full setter brief. Resolved after the appointment so the brief's
  // header line ("appointment attached." vs "NO APPOINTMENT. Call to book.")
  // reflects what we are actually sending LP.
  let notes = resolveNotes(payload, ghlContact, contactId, !!(adate && atime));

  // 2026-10-05 — the 2–3 sentence rep brief (services/rep-brief.js) replaces
  // the long sectioned brief when LP_REP_BRIEF_MODE=live. An explicit
  // payload.notes is never replaced. Null (any failure) keeps the note above.
  if (!payload.notes && repBriefMode() === 'live') {
    const brief = await fetchAndBuildRepBrief(contactId, {
      contact: ghlContact,
      body: { adate, atime, address1, city, zip, firstname: firstName },
      hasAppointment: !!(adate && atime),
    }).catch(() => null);
    if (brief?.notes) notes = brief.notes;
  }

  // ─── Build payload ───────────────────────────────────────────────
  // Use REST-style names; lp-client's addLead translates to legacy
  // names automatically when calling the lppost endpoint (which is
  // now the PRIMARY path as of 2026-05-02 because it preserves srs_id
  // and pro_id attribution that REST silently dropped).
  //
  // Optional fields (email, pro_id) are included only when populated.
  // lp-client's addLead also strips blank values defensively, so this
  // is belt-and-suspenders.
  const leadFields = {
    firstname: firstName,
    lastname: ghlContact.lastName || '',
    address1,
    city,
    state,
    zip,
    phone,                                   // REST naming → translates to phone1 for legacy
    sender,
    srs_id: srsId,
    productID: product,                      // REST naming → translates to productid for legacy
    proddescr: product,
    notes,
    lognumber: contactId,
    User1: contactId,                        // cross-attribution: GHL contact ID in LP
    HasConsent: 'true',
    ConsentDate: ghlContact.dateAdded || new Date().toISOString(),
    TextOptIn: 'true',
    EmailOptIn: 'true',
  };
  // Conditional optional fields — only set when populated.
  if (email)     leadFields.email = email;
  if (proId)     leadFields.pro_id = proId;
  // 2026-08-18 — re-queue marker passthrough (lp_callback_requeue delegates
  // its no-LP-lead branch here). user1 is taken (GHL contact id / HLCID);
  // user2 carries "requeue:callback:<ISO8601>", a zero-reporting-weight flag.
  if (payload.user2) leadFields.user2 = String(payload.user2);
  if (adate && atime) {
    leadFields.apptdate = adate;             // REST naming → translates to adate for legacy
    leadFields.appttime = atime;             // REST naming → translates to atime for legacy
  }

  // ─── POST TO LP (legacy lppost is primary; REST is fallback) ──────
  let lpResponse;
  try {
    lpResponse = await lpAddLead(leadFields);
  } catch (err) {
    // Both legacy and REST paths exhausted. Tag for visibility, escalate
    // to GroupMe with full context, throw so the action goes to 'failed'
    // (reaper marks create_lp_lead non-idempotent so it won't retry).
    const { name } = await resolveContactInfo(contactId, eventPayload);
    await applyGHLTag(contactId, 'lp-sync-failed').catch(() => {});
    const failMsg = buildRichNotification({
      baseMessage: `❌ LP CREATE FAILED: both legacy lppost and REST paths exhausted`,
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

  const pathTaken = lpResponse?._path || 'unknown'; // 'legacy' | 'rest'

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
  const pathLabel =
    pathTaken === 'legacy' ? 'lppost (legacy — primary path, preserves srs/pro)'
    : pathTaken === 'rest' ? 'REST /api/Leads/LeadAdd (fallback path)'
    : 'unknown';
  const proLine = proId
    ? `${proId}${proIdFromRegistry ? ' (from channel registry)' : ''}`
    : '(none)';
  await addGHLNote(contactId,
    `[LP CREATE v1.3] Lead pushed to Lead Perfection inbound queue\n` +
    `LP Inbound ID (in1_id): ${inboundId}\n` +
    `Path: ${pathLabel}\n` +
    `srs_id: ${srsId} | pro_id: ${proLine} | product: ${product} | sender: ${sender}\n` +
    `Email: ${email || '(none — LP accepts emailless leads)'}\n` +
    `Notes sent: ${notes.length} chars (full agentic setter brief)\n` +
    `${apptLine}\n` +
    `LP will issue real lds_id within ~60s and the LP-Inbound Webhook callback will write lp_lead_id + lp_prospect_id back to this contact.`
  ).catch(() => {});

  // ─── Notify GroupMe (always include Prospect line) ────────────────
  // Prospect is "PENDING" because LP hasn't issued the lds_id yet. The
  // follow-up callback (within ~60s) writes lp_prospect_id; reviewer can
  // refresh the contact in 60-90s to see it populated.
  const { name } = await resolveContactInfo(contactId, eventPayload);
  const successMsg = buildRichNotification({
    baseMessage: `🆕 LP Lead Created via ${pathTaken === 'legacy' ? 'lppost' : 'REST'} (Inbound: ${inboundId})`,
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

  console.log(`[LP-CREATE] ✅ Lead pushed to LP (${pathTaken}): in1_id=${inboundId} for contact ${contactId} (srs=${srsId}, pro=${proId || 'none'}${proIdFromRegistry ? ':registry' : ''}, email=${email || 'none'}, notes=${notes.length}ch, appt=${adate ? `${adate} ${atime}` : 'none'})`);

  return {
    action: 'lp_lead_created',
    contact_id: contactId,
    lp_inbound_lead_id: inboundId,
    path: pathTaken,
    srs_id: srsId,
    pro_id: proId || null,
    pro_id_from_registry: proIdFromRegistry,
    email: email || null,
    product,
    notes_chars: notes.length,
    appt_date: adate || null,
    appt_time: atime || null,
    appt_included: !!(adate && atime),
    name_recovery: nameRecovery,
    existing_lead_check: existingLeadCheck,
    ...(isCalcLane ? { calc_dedupe_key: calcCheck?.key || null, calculator_check: calcCheck } : {}),
    lp_response: lpResponse,
  };
}


/** The already_in_lp setter stamp: reads LP live, stamps only a Set lead with no setter. */
async function stampSetterFromLive(contactId, ldsId) {
  const [{ stampSetterOnce, lpApptToSetArgs }, lp, { getField }, { emitEvent: emit }, { findLeadInLpResponse }] = await Promise.all([
    import('../../lp-setter-stamp.js'), import('../../lp-client.js'), import('../../sync-utils.js'), import('../../event-emitter.js'), import('./lp-appointment.js'),
  ]);
  const leadOf = (resp) => findLeadInLpResponse(resp, ldsId);
  const lead = leadOf(await lp.getLeadByLdsId(ldsId, { fast: true }));
  const args = lead ? lpApptToSetArgs(getField(lead, 'apptdate', 'ApptDate')) : null;
  if (!args) return { stamped: false, reason: 'no_appointment' };
  return stampSetterOnce({
    contactId, ldsId, ...args,
    setByName: getField(lead, 'setbyname', 'SetByName'), disposition: getField(lead, 'disposition', 'Disposition'),
  }, {
    claim: async (key) => { const row = await emit({ event_type: 'lp.setter_stamp_attempt', source: 'lp_mcp', entity_type: 'lp_lead', entity_id: key, payload: { key }, priority: 'low', bypass_filter: true, idempotency_key: key }); return !!row && !row.filtered; },
    setAppointment: (a) => lp.setAppointment(a),
    readSetter: async (id) => { const l = findLeadInLpResponse(await lp.getLeadByLdsId(id, { fast: true }), id); return l ? (getField(l, 'setbyname', 'SetByName') ?? '') : null; },
    emit,
  });
}
