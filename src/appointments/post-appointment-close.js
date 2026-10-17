/**
 * Close a GHL estimate after the visit — src/appointments/post-appointment-close.js
 *
 * WHY (Roberta Ritchie, GHL 0Hwk6Mw05TSkKfQDhssm, 2026-10-16). LP lead 583833
 * had its demo at 2 PM and went OPPFDN at 4:33 PM. Her GHL estimate stayed
 * `new` (and at the wrong day), and the P1 opportunity sat at stage 6. Nothing
 * in LP-MCP ever set a GHL appointment to `showed`, and the only P1 move to
 * "Appointment Completed" lives in GHL's I.LP-IN, which waits on an LP webhook
 * that all but stopped on 2026-09-24. LP is the authority, so once LP says what
 * happened at the visit, GHL says the same.
 *
 * The user's ruling (2026-10-16), once LP's visit time has passed:
 *   demo disposition (Sale, OPPFDN, NoRehash, FDNS, SW, PM)  → `showed`, P1 → Appointment Completed
 *   NoHome                                                   → `noshow`
 *   CXL, CCC, NG                                             → `cancelled`
 *   still Set / Cnf / Issue / Verif                          → wait (LP has not dispositioned it)
 * When GHL holds the visit at another time than LP, it is moved to LP's time
 * first, so the record shows when the visit really was.
 *
 * Never `invalid` (that is ND / No Demo's, LP_DISP_DISQUALIFIED). Never a future
 * visit, except the Roberta shape: a GHL estimate still ahead while LP says the
 * demo already happened (that one gets LP's past time and `showed`). A cancel of a
 * FUTURE GHL appointment stays Class E's escalation.
 *
 * POST_APPT_CLOSE_MODE off | shadow | live, default shadow: a status change to
 * `cancelled` / `noshow` can start GHL workflows (A.WE, S5.2), so a person reads
 * the would-apply rows (appt.close_would_apply) before it writes.
 *
 * PURE here; the I/O is runPostAppointmentClose / closeForContact below, all
 * behind a deps seam.
 */

import { isDemoDisposition } from '../demo-truth.js';
import { isLiveAppointmentDisposition, isHoldDisposition } from '../lp-disposition-classes.js';
import {
  resolveSyncStartTime, sameStartTime, normalizeGhlStartTime, ESTIMATE_CALENDAR_IDS,
} from '../services/lp-ghl-appointment-reconciler.js';
import { lpVisitMs } from './lp-origin-guard.js';

export const CLOSE_RULE = 'LP_APPT_CLOSE';
export const CLOSE_LOOKBACK_HOURS = 72;
// The future side of the sweep's read (the Roberta shape: a GHL estimate still
// ahead after the demo). Beyond the watchdog's own 45-day window is not needed.
export const FUTURE_DAYS = 45;
export const READ_CAP = 60;
export const NOSHOW_DISPOSITIONS = Object.freeze(['NoHome']);
export const CANCEL_DISPOSITIONS = Object.freeze(['CXL', 'CCC', 'NG']);
const OPEN_STATUSES = new Set(['new', 'confirmed']);
const MODES = ['off', 'shadow', 'live'];

export function postApptCloseMode(env = process.env) {
  const raw = String(env.POST_APPT_CLOSE_MODE ?? '').trim().toLowerCase();
  if (!raw) return 'shadow';
  return MODES.includes(raw) ? raw : 'shadow'; // a typo must never start writing to GHL
}

const norm = (v) => String(v ?? '').trim();

/** The GHL status LP's disposition implies after the visit; null when it implies none yet. */
export function closedStatusFor(code) {
  const c = norm(code);
  if (isDemoDisposition(c)) return 'showed';
  if (NOSHOW_DISPOSITIONS.includes(c)) return 'noshow';
  if (CANCEL_DISPOSITIONS.includes(c)) return 'cancelled';
  return null;
}

/**
 * Pure.
 * @param {object} a
 * @param {object} a.appt  GHL row { ghl_appointment_id, ghl_calendar_id, status, start_time }
 * @param {object} a.lead  the owning lp_leads row
 * @param {object} a.live  readLiveLpAppointment(lead) result ({ ok, disposition, date, time, timeStatus })
 * @param {number} [a.nowMs]
 * @returns {{ op: 'close'|'wait'|'none'|'skip', reason: string, status?: string,
 *             rescheduleTo?: string|null, moveP1?: boolean }}
 */
export function decideClose({ appt, lead, live, nowMs = Date.now() }) {
  if (!appt?.ghl_appointment_id) return { op: 'none', reason: 'no_appointment' };
  if (!ESTIMATE_CALENDAR_IDS.has(appt.ghl_calendar_id)) return { op: 'none', reason: 'not_estimate_calendar' };
  if (!OPEN_STATUSES.has(String(appt.status || '').toLowerCase())) return { op: 'none', reason: 'already_closed' };
  if (!lead) return { op: 'skip', reason: 'no_lp_lead' };
  if (!live?.ok) return { op: 'skip', reason: 'lp_unreadable' };

  const code = norm(live.disposition || lead.disposition_code);
  // LP's time for the visit: live first, then the row.
  const lpStart = (live.timeStatus === 'known' ? resolveSyncStartTime(lead, live).startTime : null)
    || (() => { const ms = lpVisitMs(lead.appointment_date); return ms === null ? null : new Date(ms).toISOString(); })();
  const lpMs = Date.parse(lpStart || '');
  const ghlMs = Date.parse(normalizeGhlStartTime(appt.start_time) || '');
  const visitMs = Number.isFinite(lpMs) ? lpMs : ghlMs;
  if (!Number.isFinite(visitMs)) return { op: 'skip', reason: 'no_visit_time' };
  if (visitMs > nowMs) return { op: 'wait', reason: 'visit_not_passed' };
  if (visitMs < nowMs - CLOSE_LOOKBACK_HOURS * 3600_000) return { op: 'none', reason: 'outside_lookback' };

  if (isHoldDisposition(code) || isLiveAppointmentDisposition(code)) return { op: 'wait', reason: 'lp_not_dispositioned' };
  const status = closedStatusFor(code);
  if (!status) return { op: 'none', reason: `out_of_scope:${code || 'blank'}` };

  // A GHL estimate still ahead is closed only on a demo (the Roberta shape). A
  // future GHL row against an LP cancel is Class E's escalation, never ours.
  if (Number.isFinite(ghlMs) && ghlMs > nowMs && status !== 'showed') {
    return { op: 'none', reason: 'future_ghl_cancel_is_class_e' };
  }
  const rescheduleTo = Number.isFinite(lpMs) && !sameStartTime(appt.start_time, lpStart) ? lpStart : null;
  return { op: 'close', reason: `lp_${code}`, status, rescheduleTo, moveP1: status === 'showed' };
}

/**
 * Pure: which of a contact's leads owns this GHL appointment?
 *   1. the NEWEST lead, when its LP visit fell in the look-back (it is the
 *      current lead, and its visit just happened);
 *   2. the lead whose LP visit is at the GHL time;
 *   3. the one with the most recent past visit in the look-back;
 *   4. the newest lead.
 * (1) comes first for Roberta Ritchie: the watchdog had written GHL's stale
 * 10/17 10 AM onto her OLDER lead 579742, so "the lead at the GHL time" was the
 * phantom, while her newest lead 583833 had its demo on 10/16.
 */
export function owningLead(leads, appt, nowMs = Date.now()) {
  const rows = Array.isArray(leads) ? leads.filter(Boolean) : [];
  if (!rows.length) return null;
  const since = nowMs - CLOSE_LOOKBACK_HOURS * 3600_000;
  const newest = [...rows].sort((a, b) => Number(b.lp_lead_id) - Number(a.lp_lead_id))[0];
  const newestMs = lpVisitMs(newest?.appointment_date);
  if (newestMs !== null && newestMs >= since && newestMs <= nowMs) return newest;
  const ghlStart = normalizeGhlStartTime(appt?.start_time);
  const atSlot = rows.find((r) => {
    const ms = lpVisitMs(r.appointment_date);
    return ms !== null && ghlStart && sameStartTime(new Date(ms).toISOString(), ghlStart);
  });
  if (atSlot) return atSlot;
  const recent = rows
    .map((r) => ({ r, ms: lpVisitMs(r.appointment_date) }))
    .filter((x) => x.ms !== null && x.ms >= since && x.ms <= nowMs)
    .sort((a, b) => b.ms - a.ms)[0];
  if (recent) return recent.r;
  return newest;
}

/**
 * Apply (live) or record (shadow) one contact's close. Never throws.
 *
 * deps: { readLive(lead) → live, putAppointment(appointmentId, body), queueAction(row),
 *         emitEvent(evt), mode, nowMs, log }
 * @returns {Promise<{ op, reason, status?, applied: boolean, appointment_id }>}
 */
export async function closeOne({ contactId, appt, leads, deps = {} }) {
  const log = deps.log || console.log;
  const mode = deps.mode || postApptCloseMode();
  const nowMs = deps.nowMs ?? Date.now();
  const base = { contact_id: contactId, appointment_id: appt?.ghl_appointment_id || null, applied: false };
  if (mode === 'off') return { ...base, op: 'none', reason: 'mode_off' };
  try {
    const lead = owningLead(leads, appt, nowMs);
    const live = lead ? await deps.readLive(lead) : null;
    const plan = decideClose({ appt, lead, live, nowMs });
    const out = { ...base, ...plan, lp_lead_id: lead?.lp_lead_id || null };
    if (plan.op !== 'close') return out;

    log(`[ApptClose] ${mode} ${mode === 'live' ? 'set' : 'would set'} appt=${appt.ghl_appointment_id} contact=${contactId} → ${plan.status}${plan.rescheduleTo ? ` (moved to LP time ${plan.rescheduleTo})` : ''}${plan.moveP1 ? ' + P1 → Appointment Completed' : ''} reason=${plan.reason}`);
    if (mode !== 'live') {
      await deps.emitEvent?.({
        event_type: 'appt.close_would_apply', event_subtype: plan.status, source: 'post_appointment_close',
        entity_type: 'contact', entity_id: contactId, ghl_contact_id: contactId, priority: 'low', bypass_filter: true,
        payload: { appointment_id: appt.ghl_appointment_id, lp_lead_id: lead?.lp_lead_id || null, reason: plan.reason, status: plan.status, ghl_start: appt.start_time, reschedule_to: plan.rescheduleTo || null, move_p1: plan.moveP1, mode, applied: false },
        idempotency_key: `appt_close_${appt.ghl_appointment_id}_${plan.status}`,
      }).catch(() => {});
      return out;
    }

    // One PUT: LP's time (when it differs) and the closed status together.
    // toNotify false: the customer already lived this visit.
    const body = { appointmentStatus: plan.status, toNotify: false };
    if (plan.rescheduleTo) {
      body.startTime = plan.rescheduleTo;
      body.endTime = new Date(Date.parse(plan.rescheduleTo) + 90 * 60_000).toISOString();
      body.calendarId = appt.ghl_calendar_id;
      body.ignoreFreeSlotValidation = true;
    }
    await deps.putAppointment(appt.ghl_appointment_id, body);
    if (plan.moveP1) {
      await deps.queueAction({
        action_type: 'move_opportunity', target_system: 'ghl', target_entity: 'contact', target_id: contactId,
        action_payload: { stage: 'Appointment Completed', status: 'open', pipeline: 'P1' },
        // lead-id-ok: action reasoning on an agent_actions row, not a card
        reasoning: `LP lead ${lead?.lp_lead_id || '?'} is ${live?.disposition || lead?.disposition_code}: the visit happened, so GHL appointment ${appt.ghl_appointment_id} is showed and P1 moves forward (forward-only).`,
        rule_applied: CLOSE_RULE, status: 'pending', requires_approval: false, priority: 30,
      }).catch((err) => log(`[ApptClose] P1 move not queued for ${contactId}: ${err.message}`));
    }
    await deps.emitEvent?.({
      event_type: 'appointment.parity_auto_fixed', event_subtype: `closed_${plan.status}`, source: 'post_appointment_close',
      entity_type: 'contact', entity_id: contactId, ghl_contact_id: contactId, priority: 'low', bypass_filter: true,
      payload: { appointment_id: appt.ghl_appointment_id, lp_lead_id: lead?.lp_lead_id || null, status: plan.status, reschedule_to: plan.rescheduleTo || null, move_p1: plan.moveP1 },
      idempotency_key: `appt_closed_${appt.ghl_appointment_id}_${plan.status}`,
    }).catch(() => {});
    return { ...out, applied: true };
  } catch (err) {
    log(`[ApptClose] failed for appt=${appt?.ghl_appointment_id} contact=${contactId}: ${err.message}`);
    return { ...base, op: 'error', reason: err.message };
  }
}

/**
 * The sweep's candidates (pure): every open GHL estimate that started in the
 * look-back, plus a FUTURE one whose contact's leads show a demo in the
 * look-back (the Roberta shape). `ghlRows` are HL-mirror rows.
 */
export function closeCandidates({ ghlRows = [], leadsByContact = new Map(), nowMs = Date.now() }) {
  const since = nowMs - CLOSE_LOOKBACK_HOURS * 3600_000;
  const out = [];
  for (const row of ghlRows) {
    if (!row?.ghl_contact_id || !ESTIMATE_CALENDAR_IDS.has(row.ghl_calendar_id)) continue;
    if (!OPEN_STATUSES.has(String(row.status || '').toLowerCase())) continue;
    const ms = Date.parse(normalizeGhlStartTime(row.start_time) || '');
    if (!Number.isFinite(ms)) continue;
    if (ms >= since && ms <= nowMs) { out.push(row); continue; }
    if (ms > nowMs) {
      const demo = (leadsByContact.get(row.ghl_contact_id) || []).some((l) => {
        const v = lpVisitMs(l.appointment_date);
        return isDemoDisposition(l.disposition_code) && v !== null && v >= since && v <= nowMs;
      });
      if (demo) out.push(row);
    }
  }
  return out;
}

/**
 * The watchdog pass. Reads the HL mirror's estimates from the look-back on, the
 * candidates' lp_leads rows, closes each (shadow / live), capped by the caller.
 *
 * deps: { readGhlRows(fromIso, toIso) → rows, readLeads(contactIds) → Map(cid → rows),
 *         readLive, putAppointment, queueAction, emitEvent, mode, nowMs, log, cap, readCap }
 *
 * `readCap` bounds the LP live reads a pass makes (a past visit LP has not
 * dispositioned yet is re-read every sweep for 72h); the rest wait a sweep.
 */
export async function runPostAppointmentClose({ dryRun = false, deps = {} }) {
  const mode = dryRun ? 'shadow' : (deps.mode || postApptCloseMode());
  const summary = { mode, candidates: 0, closed: {}, would: {}, waiting: 0, skipped: {}, errors: 0, capped: 0 };
  if (mode === 'off') return summary;
  const nowMs = deps.nowMs ?? Date.now();
  const cap = deps.cap ?? 25;
  const readCap = deps.readCap ?? READ_CAP;
  const fromIso = new Date(nowMs - CLOSE_LOOKBACK_HOURS * 3600_000).toISOString();
  const toIso = new Date(nowMs + FUTURE_DAYS * 86400_000).toISOString();
  const rows = await deps.readGhlRows(fromIso, toIso);
  const cids = [...new Set(rows.map((r) => r.ghl_contact_id).filter(Boolean))];
  const leadsByContact = cids.length ? await deps.readLeads(cids) : new Map();
  const candidates = closeCandidates({ ghlRows: rows, leadsByContact, nowMs });
  summary.candidates = candidates.length;
  let writes = 0;
  let reads = 0;
  for (const appt of candidates) {
    const leads = leadsByContact.get(appt.ghl_contact_id) || [];
    if (!leads.length) { summary.skipped.no_lp_lead = (summary.skipped.no_lp_lead || 0) + 1; continue; }
    if (mode === 'live' && writes >= cap) { summary.capped++; continue; }
    if (reads >= readCap) { summary.capped++; continue; }
    reads++;
    const r = await closeOne({ contactId: appt.ghl_contact_id, appt, leads, deps: { ...deps, mode, nowMs } });
    if (r.op === 'close') {
      const bucket = r.applied ? summary.closed : summary.would;
      bucket[r.status] = (bucket[r.status] || 0) + 1;
      if (r.applied) writes++;
    } else if (r.op === 'wait') summary.waiting++;
    else if (r.op === 'error') summary.errors++;
    else summary.skipped[r.reason] = (summary.skipped[r.reason] || 0) + 1;
  }
  summary.writes = writes;
  return summary;
}
