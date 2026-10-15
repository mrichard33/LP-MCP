/**
 * Live LP appointment read for the LP→GHL sync — src/services/lp-live-appointment.js
 *
 * 2026-10-15. reconcileLpAppointmentToGhl booked GHL Window Estimates straight
 * from lp_leads.appointment_date, and two kinds of bad row got through:
 *   - STALE rows. Rows last synced before ~2026-07-08 hold real UTC, not the ET
 *     wall clock lpWallClockToGhlStartTime assumes. Lead 475840: LP GetLead
 *     said 2026-11-30 10:00 AM, the row (synced 2026-03-25) said 15:00Z, and
 *     GHL got a 3:00 PM visit.
 *   - YEAR TYPOS. 2025 leads carrying visits about a year after LP last
 *     touched them; the contact backstop pulled them into GHL and the
 *     reconciler booked them as real visits (five on 2026-10-15).
 *
 * So every caller that can CREATE or MOVE a GHL appointment from LP reads LP
 * live first and hands the result to the reconciler, which stays
 * supabase-free (its `lead` row is injected the same way). This module owns
 * the read and the mirror write-back; the decisions live in the reconciler.
 *
 * Never throws: a failed read is { ok: false } and the reconciler decides
 * whether the row is fresh enough to trust on its own.
 */

import { getLeadByLdsId as defaultGetLeadByLdsId } from '../lp-client.js';
import { extractArray, getField } from '../sync-utils.js';
import { parseLpApptWallClock } from '../actions/date-parsers.js';

/**
 * Pull one lead out of an LP GetLead response by lds_id. Same unwrap as
 * findLeadInLpResponse in handlers/lp-appointment.js and findLeadByLdsId in
 * admin/data-freshness.js (prospect → leads[]).
 */
export function findLeadInGetLead(resp, ldsId) {
  for (const prospect of extractArray(resp)) {
    const leads = getField(prospect, 'leads', 'Leads') || [];
    const match = leads.find((l) => String(getField(l, 'id', 'lds_id', 'LeadID')) === String(ldsId));
    if (match) return match;
  }
  return null;
}

// LP sends its own timestamps (setdate, lastchangedon) as bare strings; only
// the calendar day is needed for the plausibility window, so take the
// YYYY-MM-DD the wall-clock parser reads and leave the zone alone.
function lpDay(raw) {
  const p = parseLpApptWallClock(raw);
  return p?.date || null;
}

/**
 * Pure: shape a GetLead lead object into what the reconciler reads.
 * @returns {{ ok: true, date: string|null, time: string|null, timeStatus: string|null,
 *            disposition: string|null, setDate: string|null, lastChangedOn: string|null,
 *            mirrorAppointmentDate: string|null }}
 */
export function liveAppointmentFromLead(lpLead) {
  const parsed = parseLpApptWallClock(getField(lpLead, 'apptdate', 'ApptDate'));
  return {
    ok: true,
    date: parsed?.date || null,
    time: parsed?.time || null,
    timeStatus: parsed?.timeStatus || null,
    disposition: getField(lpLead, 'disposition', 'Disposition') || null,
    setDate: lpDay(getField(lpLead, 'setdate', 'SetDate')),
    lastChangedOn: lpDay(getField(lpLead, 'lastchangedon', 'LastChangedOn')),
    mirrorAppointmentDate: mirrorAppointmentDate(parsed),
  };
}

/**
 * lp_leads.appointment_date in the convention the sync writes (sync-leads.js
 * via sanitizeLpApptDate): LP's wall-clock digits labelled +00:00. A date with
 * no time keeps midnight, which lpWallClockToGhlStartTime reads as "no time".
 */
export function mirrorAppointmentDate(parsed) {
  if (!parsed?.date) return null;
  return `${parsed.date}T${parsed.time || '00:00'}:00+00:00`;
}

/**
 * Read LP live for one lead. Never throws.
 * @returns {Promise<object>} liveAppointmentFromLead(...) or { ok: false, error }
 */
export async function readLiveLpAppointment(lpLeadId, deps = {}) {
  if (!lpLeadId) return { ok: false, error: 'no_lp_lead_id' };
  const getLead = deps.getLeadByLdsId || defaultGetLeadByLdsId;
  try {
    const resp = await getLead(String(lpLeadId), { fast: true });
    const lpLead = findLeadInGetLead(resp, lpLeadId);
    if (!lpLead) return { ok: false, error: 'lead_not_in_lp_response' };
    return liveAppointmentFromLead(lpLead);
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Pure: the lp_leads patch that brings a row in line with LP live, or null
 * when the row already says the same wall-clock day and minute (or the live
 * read has nothing to say).
 */
export function liveMirrorUpdate(lead, live, nowIso = new Date().toISOString()) {
  if (!live?.ok || !live.mirrorAppointmentDate) return null;
  const rowWall = String(lead?.appointment_date || '').slice(0, 16).replace(' ', 'T');
  const liveWall = live.mirrorAppointmentDate.slice(0, 16);
  if (rowWall === liveWall) return null;
  return { appointment_date: live.mirrorAppointmentDate, synced_at: nowIso };
}

/** One lp_leads update. Logs and returns false on failure; never throws. */
export async function writeMirrorUpdate(lpLeadId, patch, { db } = {}) {
  if (!lpLeadId || !patch) return false;
  try {
    const client = db || (await import('../supabase.js')).default;
    if (!client) return false;
    const { error } = await client.from('lp_leads').update(patch).eq('lp_lead_id', String(lpLeadId));
    if (error) {
      console.warn(`[LpLiveAppt] lp_leads mirror update failed for lead ${lpLeadId}: ${error.message}`);
      return false;
    }
    console.log(`[LpLiveAppt] lp_leads lead ${lpLeadId} appointment_date → ${patch.appointment_date} (from LP live)`);
    return true;
  } catch (err) {
    console.warn(`[LpLiveAppt] lp_leads mirror update threw for lead ${lpLeadId}: ${err.message}`);
    return false;
  }
}

/**
 * Whether a caller should read LP live before reconciling this row. Only
 * Set / Verif / Cnf can create or move an appointment; a cancel never reads.
 */
export function needsLiveRead(dispositionCode) {
  return ['Set', 'Verif', 'Cnf'].includes(String(dispositionCode || '').trim());
}

/**
 * Live LP read for a Set/Verif/Cnf row, plus the lp_leads write-back when LP
 * disagrees with the row. Null for a cancel (never read). Never throws.
 * Shared by the contact backstop and the admin backfill so every caller of
 * the reconciler reads LP the same way.
 */
export async function readLiveForSync(lead, { dryRun = false, deps = {} } = {}) {
  if (!lead || !needsLiveRead(lead.disposition_code)) return null;
  const live = await (deps.readLiveLpAppointment || readLiveLpAppointment)(lead.lp_lead_id);
  if (!live.ok) {
    console.warn(`[LpLiveAppt] live LP read failed for lead ${lead.lp_lead_id}: ${live.error} — row trusted only if synced since 2026-07-08`);
    return live;
  }
  const patch = liveMirrorUpdate(lead, live);
  if (patch) {
    console.log(`[LpLiveAppt] lead ${lead.lp_lead_id}: row ${lead.appointment_date} ≠ LP live ${patch.appointment_date}${dryRun ? ' (dry run, mirror not written)' : ''}`);
    if (!dryRun) await (deps.writeMirrorUpdate || writeMirrorUpdate)(lead.lp_lead_id, patch);
  }
  return live;
}
