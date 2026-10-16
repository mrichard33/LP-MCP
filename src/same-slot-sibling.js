/**
 * Same-slot live sibling — src/same-slot-sibling.js
 *
 * WHY (Badley, 2026-10-16, handoff v3.4 Fix 1). One contact carried two LP
 * leads for the SAME visit: 583460 (SAR, CXL) and 583453 (FTMYR, Cnf), both
 * 10/17 10:00. The CXL on the duplicate cancelled the real GHL appointment, sent
 * the contact to S5.2, and repointed the contact's LP Lead ID fields at the
 * cancelled lead. A cancel on one lead says nothing about a live sibling holding
 * the same slot.
 *
 * THE RULE (Mark, 2026-10-16), deliberately narrow: another lead of the same
 * contact, not soft-deleted, in a LIVE disposition (Set / Cnf / Issue — never
 * Verif, never ND / No Demo) at the SAME appointment date AND time (ET wall
 * clock, as lp_leads stores it). A sibling at a different time does not count,
 * and every other cancel goes through exactly as before (the CXL canaries in
 * scripts/test-lp-ghl-appointment-lead-select.js).
 *
 * Pure. lp_leads.appointment_date is ET wall-clock digits tagged +00:00
 * (src/lp-dates.js), so the slot is compared on those digits, never converted.
 */

import { isLiveAppointmentDisposition } from './lp-disposition-classes.js';

/** 'YYYY-MM-DDTHH:MM' of a stored appointment, or null (missing, pre-2000 sentinel, or no time). */
export function slotKeyOf(appointmentDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(appointmentDate || ''));
  if (!m) return null;
  if (Number(m[1]) < 2000) return null;
  if (m[4] === '00' && m[5] === '00') return null; // midnight = "no time" (lpWallClockToGhlStartTime)
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
}

/**
 * The live sibling holding `lead`'s exact slot, or null.
 * @param {object[]} leads  every lp_leads row for the contact
 * @param {object} lead     the lead whose slot is asked about (usually the cancelling one)
 */
export function findSameSlotLiveSibling(leads, lead) {
  const slot = slotKeyOf(lead?.appointment_date);
  if (!slot) return null;
  const own = String(lead?.lp_lead_id ?? '');
  for (const row of Array.isArray(leads) ? leads : []) {
    if (!row || row.lp_deleted_at) continue;
    if (String(row.lp_lead_id ?? '') === own) continue;
    if (!isLiveAppointmentDisposition(row.disposition_code)) continue;
    if (slotKeyOf(row.appointment_date) === slot) return row;
  }
  return null;
}

/** Does LP live still show this lead's appointment at `slot`, in a live disposition? */
export function liveStillHoldsSlot(live, slot) {
  if (!live?.ok || !slot) return false;
  if (!isLiveAppointmentDisposition(live.disposition)) return false;
  return slotKeyOf(live.mirrorAppointmentDate) === slot;
}

/**
 * Contacts with 2+ LP leads whose appointments fall within `days` of each other
 * (the "clean up in LP" notice, Fix 1.6). Pure over rows of
 * { ghl_contact_id, lp_lead_id, disposition_code, appointment_date, lp_branch_id, first_name, last_name }.
 * @returns {{ contactId: string, leads: object[] }[]}
 */
export function findDuplicateLeadGroups(rows, { days = 7 } = {}) {
  const byContact = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r?.ghl_contact_id || r.lp_deleted_at || !slotKeyOf(r.appointment_date)) continue;
    const list = byContact.get(r.ghl_contact_id) || [];
    list.push(r);
    byContact.set(r.ghl_contact_id, list);
  }
  const out = [];
  const windowMs = days * 86400000;
  for (const [contactId, list] of byContact) {
    if (list.length < 2) continue;
    const ms = list.map((r) => Date.parse(`${slotKeyOf(r.appointment_date)}:00Z`)).sort((a, b) => a - b);
    let close = false;
    for (let i = 1; i < ms.length; i++) if (ms[i] - ms[i - 1] <= windowMs) close = true;
    if (close) out.push({ contactId, leads: list });
  }
  return out;
}
