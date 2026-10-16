/**
 * Stamp "Integration, GoHighLevel" (5686) as the setter on a bot-booked LP lead —
 * src/lp-setter-stamp.js
 *
 * 2026-10-16 (Melissa, LP lead 584060): the lead reached LP through GHL workflow
 * 8e30ff37's addlead with the appointment on it, and addlead carries no setter,
 * so LP shows "No, Setter". The set_lp_appointment that followed found LP
 * already holding the same date and time (already_set_in_lp) and skipped the
 * only write that carries set_by 5686.
 *
 * Interim fix (the user's ruling): when LP already holds this exact appointment
 * and its setter is blank or "No, Setter", call SetAppointment ONCE with
 * set_by 5686 and the same date and time. Never retried: one claim per lead
 * (the event's idempotency key), and every failure is caught and reported, not
 * thrown. Only a lead in Set (a live, unissued appointment) is touched.
 * LP may refuse a same-time re-set ("record has future appt date"): that is
 * logged as lp.setter_stamp_refused and the permanent fix (the setter key on
 * 8e30ff37's addlead body, LP_ADDLEAD_SETTER_FIELD) is the only route.
 *
 * Pure decision + deps (CLAUDE.md "Writing code here").
 */

export const GHL_INTEGRATION_SETTER = '5686';

/** Blank or LP's "No, Setter" placeholder. Pure. */
export function needsSetterStamp(setByName) {
  const s = String(setByName ?? '').trim();
  return !s || /^no,?\s*setter$/i.test(s);
}

/** Stamp only a Set lead whose setter is missing. Pure. */
export function setterStampDecision({ setByName, disposition }) {
  if (!needsSetterStamp(setByName)) return { stamp: false, reason: 'setter_present' };
  if (String(disposition || '').trim().toLowerCase() !== 'set') return { stamp: false, reason: `disposition_${String(disposition || 'unknown').trim() || 'unknown'}` };
  return { stamp: true, reason: 'no_setter' };
}

/**
 * One attempt. Never throws.
 * deps: claim(key) → true when this is the first claim; setAppointment({ ldsId, setBy, apptDate, apptTime });
 *       readSetter(ldsId) → string|null; emit(event); log; warn.
 */
export async function stampSetterOnce({ contactId, ldsId, apptDate, apptTime, setByName, disposition }, deps) {
  const log = deps.log || ((m) => console.log(m));
  const warn = deps.warn || ((m) => console.warn(m));
  const decision = setterStampDecision({ setByName, disposition });
  if (!decision.stamp) return { stamped: false, reason: decision.reason };
  let first = false;
  try { first = await deps.claim(`lp-setter-stamp:${ldsId}`); } catch { first = false; }
  if (!first) return { stamped: false, reason: 'already_attempted' };
  let refused = null;
  try {
    await deps.setAppointment({ ldsId, setBy: GHL_INTEGRATION_SETTER, apptDate, apptTime });
  } catch (err) {
    refused = String(err?.message || err).slice(0, 300);
  }
  let after = null;
  try { after = await deps.readSetter(ldsId); } catch { after = null; }
  const stamped = !refused && after != null && !needsSetterStamp(after);
  const event = {
    event_type: stamped ? 'lp.setter_stamped' : 'lp.setter_stamp_refused',
    source: 'lp_mcp', entity_type: 'lp_lead', entity_id: String(ldsId), ghl_contact_id: contactId || null,
    payload: { lp_lead_id: String(ldsId), set_by: GHL_INTEGRATION_SETTER, before: setByName || null, after, refused, appt_date: apptDate, appt_time: apptTime },
    priority: 'low', bypass_filter: true,
  };
  try { await deps.emit(event); } catch { /* best-effort */ }
  if (stamped) log(`[LP-SETTER] lds_id=${ldsId} setter stamped 5686 (was "${setByName || ''}")`);
  else warn(`[LP-SETTER] lds_id=${ldsId} setter NOT stamped (${refused ? `LP refused: ${refused}` : `read back "${after ?? 'unreadable'}"`}) — needs the 8e30ff37 setter key`);
  return { stamped, reason: stamped ? 'stamped' : (refused ? 'refused' : 'not_confirmed'), after };
}

/**
 * LP's apptdate ("2026-10-18T14:00:00", Eastern wall clock) → SetAppointment's
 * { apptDate: "10/18/2026", apptTime: "14:00" }, or null. Pure.
 */
export function lpApptToSetArgs(apptdate) {
  const m = String(apptdate || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  if (m[4] === '00' && m[5] === '00') return null; // a date with no time: nothing to re-set
  return { apptDate: `${m[2]}/${m[3]}/${m[1]}`, apptTime: `${m[4]}:${m[5]}` };
}
