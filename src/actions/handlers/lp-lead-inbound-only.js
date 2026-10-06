// ─── create_lp_lead: the contact has an inquiry id and no lead id ─────────────
//     src/actions/handlers/lp-lead-inbound-only.js
//
// WHY (2026-10-06, Shelley u5JV2SkaPh8O4XqkCDyM, in1 428940, visit 10/08 6 PM)
//   create_lp_lead's idempotency guard returned `already_in_lp` whenever the
//   GHL "LP Inbound Lead ID" field was set — including when LP had NOT issued a
//   lead yet. An inquiry (in1) only becomes a lead (lds) when somebody checks
//   it out of LP's inbound queue, and ~49% wait for a person (4–15h overnight).
//   So the skip was silent: nothing wrote the lds back, nothing set the
//   appointment on it (set_lp_appointment had already run and returned
//   skipped_no_valid_lead_id, never retried), and nothing said the inquiry was
//   still waiting.
//
// WHAT THIS DOES — only when in1 is set and lds is not:
//   a. the inquiry HAS been issued (lds_id on the row) → write the lds to GHL;
//      set the appointment on it when the contact has one and the row does not
//      → `inbound_issued_appt_set` (or `inbound_issued_appt_failed` when LP
//      refused it — never reported as a repair), else
//      `inbound_issued_appt_present`.
//   b. the inquiry is still waiting → `pending_lp_checkout` + one GHL note. No
//      alert here: src/jobs/inbound-checkout-watch.js owns the alerts.
//   c. no row found, or the reads failed → `inbound_unverified`.
//   NEVER addLead: the inquiry exists, and a second one is a duplicate lead.
//
// Look-up order: the lp_inbound_queue mirror (sql/149) first; a mirror row
// that already shows the lds is enough. Otherwise LP live (fresher — the
// mirror is refreshed every 5 minutes); if LP cannot be read, a mirror row
// still answers "waiting". Every read goes through deps, so this is testable
// without LP, GHL or Supabase.

import { etDateKey, lpDateToKey } from '../../new-lead-dial-backstop.js';
import { lpStoredToUtcMs } from '../../lp-dates.js';

export const INBOUND_ONLY_ACTIONS = Object.freeze([
  'inbound_issued_appt_set',
  'inbound_issued_appt_failed',
  'inbound_issued_appt_present',
  'pending_lp_checkout',
  'inbound_unverified',
]);

const t = (v) => String(v ?? '').trim();
const lpDay = (ms) => {
  const [y, m, d] = etDateKey(ms).split('-');
  return `${m}/${d}/${y}`;
};

/** A mirror row or a live LP row → one shape. */
export function normalizeQueueRow(row, origin) {
  if (!row) return null;
  if (origin === 'mirror') {
    const receivedMs = Date.parse(row.received_at_lp || '');
    return {
      in1: t(row.in1_id), lds: t(row.lds_id) || null,
      apptDate: row.appt_date ? String(row.appt_date).slice(0, 10) : null, apptTime: t(row.appt_time) || null,
      receivedMs: Number.isFinite(receivedMs) ? receivedMs : null, origin,
    };
  }
  return {
    in1: t(row.id ?? row.in1_id), lds: t(row.lds_id) || null,
    apptDate: lpDateToKey(row.apptdate), apptTime: t(row.appttime) || null,
    receivedMs: lpStoredToUtcMs(t(row.datereceived) || null), origin,
  };
}

const rowsOf = (res) => {
  const rows = Array.isArray(res) ? res : (res?.data || res?.leads || res?.results || res?.items || []);
  return Array.isArray(rows) ? rows : [];
};

/** Find the inquiry. Returns { row|null, error|null }. Never throws. */
export async function findInquiry({ contactId, in1, deps, nowMs }) {
  let mirror = null;
  try {
    mirror = normalizeQueueRow(await deps.readQueueRow(in1), 'mirror');
  } catch {
    mirror = null;
  }
  if (mirror?.lds) return { row: mirror, error: null };
  try {
    const res = await deps.getInboundLeadInfo({
      lognumber: contactId,
      startdate: lpDay(nowMs - 14 * 86_400_000),
      // LP's enddate is EXCLUSIVE (issue #490): tomorrow, or today's rows vanish.
      enddate: lpDay(nowMs + 86_400_000),
    });
    const hit = rowsOf(res).find((r) => t(r.id ?? r.in1_id) === String(in1));
    if (hit) return { row: normalizeQueueRow(hit, 'lp'), error: null };
    return { row: mirror, error: mirror ? null : 'inquiry not found in LP inbound queue (last 14 days)' };
  } catch (err) {
    return { row: mirror, error: mirror ? null : `LP inbound read failed: ${err.message}` };
  }
}

/**
 * @param {object} a
 * @param {object} a.action      the create_lp_lead row
 * @param {string} a.contactId   GHL contact id (= LP lognumber)
 * @param {string} a.in1         the contact's LP Inbound Lead ID
 * @param {{adate:string, atime:string}|null} a.appt  resolveAppointment() output
 * @param {object} a.deps        { readQueueRow, getInboundLeadInfo, writeLeadId, setAppointment, addNote }
 */
export async function resolveInboundOnly({ action, contactId, in1, appt, deps, nowMs = Date.now() }) {
  const base = { contact_id: contactId, lp_inbound_lead_id: in1 };
  const { row, error } = await findInquiry({ contactId, in1, deps, nowMs });
  if (!row) {
    console.warn(`[LP-CREATE] ❔ ${contactId}: in1 ${in1} set, no lds, inquiry unverified (${error}) — NOT re-posting`);
    return { action: 'inbound_unverified', ...base, error };
  }

  const waitMin = Number.isFinite(row.receivedMs) ? Math.max(0, Math.round((nowMs - row.receivedMs) / 60000)) : null;
  const apptOnInquiry = row.apptDate ? `${row.apptDate}${row.apptTime ? ` ${row.apptTime}` : ''}` : null;

  if (!row.lds) {
    await Promise.resolve(deps.addNote(contactId,
      `[LP CREATE] In LP's inbound queue as inquiry ${in1}, waiting to be checked out. ` +
      `Appointment on inquiry: ${apptOnInquiry || 'NONE'}.`,
    )).catch(() => {});
    console.log(`[LP-CREATE] ⏳ ${contactId}: inquiry ${in1} still waiting for LP checkout (${waitMin ?? '?'} min, appt ${apptOnInquiry || 'none'})`);
    return {
      action: 'pending_lp_checkout', ...base,
      in1, apptdate: row.apptDate, appttime: row.apptTime, wait_min: waitMin, source: row.origin,
    };
  }

  await Promise.resolve(deps.writeLeadId(contactId, row.lds)).catch((err) =>
    console.warn(`[LP-CREATE] ${contactId}: lds ${row.lds} write-back failed: ${err.message}`));

  if (appt && !row.apptDate) {
    let apptResult;
    try {
      apptResult = await deps.setAppointment({
        ...action,
        target_id: row.lds,
        action_payload: { ...(action.action_payload || {}), appt_date: appt.adate, appt_time: appt.atime },
      });
    } catch (err) {
      apptResult = { action: 'set_appt_error', error: err.message };
    }
    const set = apptResult?.action === 'lp_appointment_set' || apptResult?.action === 'already_set_in_lp';
    console.log(`[LP-CREATE] ${set ? '✅' : '⚠️'} ${contactId}: inquiry ${in1} issued as lds ${row.lds}; appointment ${appt.adate} ${appt.atime} → ${apptResult?.action}`);
    return {
      action: set ? 'inbound_issued_appt_set' : 'inbound_issued_appt_failed', ...base,
      lp_lead_id: row.lds, appointment: appt, appointment_result: apptResult,
    };
  }

  console.log(`[LP-CREATE] ✅ ${contactId}: inquiry ${in1} issued as lds ${row.lds}; appointment ${apptOnInquiry ? `already on it (${apptOnInquiry})` : 'none to set'}`);
  return { action: 'inbound_issued_appt_present', ...base, lp_lead_id: row.lds, appointment_on_inquiry: apptOnInquiry };
}
