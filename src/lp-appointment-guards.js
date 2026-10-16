/**
 * LP Appointment Guards — src/lp-appointment-guards.js
 *
 * Two pure guards that make LP appointment failures LOUD.
 *
 * ─── Why this module exists ──────────────────────────────────────────────
 * 2026-08-26, contact q5GehRye7DNkN6jlmjl3 (Myron Thorner). The agentic layer
 * booked a Friday 6:00 PM estimate in GHL. The LP sync fired. LP replied:
 *
 *     { "Result": 1, "Message": "market is OOA.  " }
 *
 * setAppointment() checks only `result.error`, which LP does not populate on
 * this endpoint. Result:1 was read as success, the Message was discarded, the
 * GHL contact was tagged `lp-appt-synced`, and the appointment never appeared
 * on any rep's schedule. Confirmed live via GetSalesSchedule: zero St. Pete
 * appointments that day.
 *
 * Two compounding defects made it worse:
 *
 *   1. The dedup marker in lp_appointment_sync_marks is written on DISPATCH,
 *      26 seconds after the webhook — not after a confirmed LP write. Every
 *      subsequent retry returned duplicate_sync_suppressed. The failure was
 *      self-locking.
 *   2. LP stamps brn_id (market) on the LEAD at creation time. The lead had
 *      been created from an intake body carrying address1 = "undefined", so
 *      no market could be resolved. UpdateProspectInfo repairs the PROSPECT
 *      record but cannot backfill a lead's market — verified live: after a
 *      successful, read-back-confirmed prospect repair, SetAppointment STILL
 *      returned "market is OOA". That lead is permanently unbookable.
 *
 * The lesson encoded here: a 200 response is not an accepted appointment.
 * Read the body.
 *
 * ─── Scope ───────────────────────────────────────────────────────────────
 * Pure functions only — no I/O, no imports beyond the address normaliser.
 * Unit tested in scripts/test-lp-address-validity.js,
 * scripts/test-lp-appointment-guard-wiring.js and scripts/test-lp-appt-guard-replay.js.
 */

import { isBlankAddress } from './lp-address-validity.js';

/**
 * Substrings that mark an LP SetAppointment reply as a REFUSAL. Matched
 * case-insensitively against the Message field.
 *
 * Since 2026-10-12 the Result code decides first (see inspectAppointmentResponse);
 * this list is the backstop for a reply with no Result, and for a Result:0 whose
 * text says it was refused. "future appt" and "dispo is" are LP's own words and
 * were missing until then: 29 of LP's 39 recorded refusals carried them.
 * Extend this list rather than loosening the check.
 */
export const LP_APPT_REFUSAL_MARKERS = Object.freeze([
  'ooa',
  'out of area',
  'market is',
  'future appt',
  'dispo is',
  'not found',
  'does not exist',
  'invalid',
  'cannot',
  'unable',
  'already has',
  'not allowed',
  'no such lead',
  'error',
]);

/** LP's own success wording on this endpoint ("Appointment set successfully."). */
const SUCCESS_RX = /\bset successfully\b/i;

/**
 * Unwrap LP's inconsistent reply shapes: bare object, or single-element array.
 * @param {*} resp
 * @returns {Object}
 */
export function unwrapLpResponse(resp) {
  if (Array.isArray(resp)) return resp[0] || {};
  return resp || {};
}

/**
 * Name the refusal from LP's message. A combined message ("market is OOA.
 * record has future appt date …") takes the first match in this order, the
 * one a person can least fix by waiting.
 */
function refusalReason(lower) {
  if (lower.includes('ooa') || lower.includes('out of area') || lower.includes('market is')) {
    return 'lp_market_out_of_area';
  }
  if (lower.includes('dispo is')) return 'lp_lead_dispo_blocked';
  if (lower.includes('does not exist') || lower.includes('no such lead') || lower.includes('not found')) {
    return 'lp_lead_not_found';
  }
  if (lower.includes('future appt')) return 'lp_lead_has_future_appt';
  return 'lp_refused';
}

/**
 * Inspect a SetAppointment reply without throwing.
 *
 * LP's SetAppointment answers the OPPOSITE way to most of its endpoints
 * (UpdateDNCStatus says Result 1 for success). Every SetAppointment reply we
 * stored up to 2026-10-12 (agent_actions.execution_result.lp_response):
 *
 *   Result 0  "Appointment set successfully."                          48  success
 *   Result 1  "record has future appt date that has not occured."      27  refused
 *   Result 1  "market is OOA."                                          6  refused
 *   Result 1  "dispo is Issue, DNC or Sale."                            2  refused
 *   Result 1  "lds_id does not exist."                                  2  refused
 *   Result 1  two of the above joined                                   2  refused
 *
 * The first version of this guard read Result 0 as a refusal and Result 1 as a
 * success unless a word list matched, and the list had neither "future appt"
 * nor "dispo is". Enforce would have refused both real bookings of the two
 * weeks before and let 29 of the 39 refusals through. So: Result 0 is
 * accepted (unless its text says otherwise), Result 1 is refused, and a reply
 * with no Result is read by its words. A reply nothing recognises is accepted
 * but named (`lp_reply_unrecognised`), so it is recorded rather than trusted
 * silently.
 *
 * @param {*} resp — raw LP response
 * @returns {{accepted: boolean, resultCode: *, message: string, reason: string|null}}
 */
export function inspectAppointmentResponse(resp) {
  const item = unwrapLpResponse(resp);
  const resultCode = item.Result ?? item.result ?? null;
  const code = resultCode === null || resultCode === undefined ? null : String(resultCode).trim();
  const message = String(item.Message ?? item.message ?? '').trim();
  const lower = message.toLowerCase();
  const marker = LP_APPT_REFUSAL_MARKERS.find((m) => lower.includes(m));
  const refused = (reason) => ({ accepted: false, resultCode, message, reason });

  if (code === '1') return refused(refusalReason(lower));

  if (code === '0') {
    if (marker && !SUCCESS_RX.test(message)) return refused(refusalReason(lower));
    return { accepted: true, resultCode, message, reason: null };
  }

  // No Result (or one LP has never sent): read the words.
  if (SUCCESS_RX.test(message)) return { accepted: true, resultCode, message, reason: null };
  if (marker) return refused(refusalReason(lower));
  return { accepted: true, resultCode, message, reason: 'lp_reply_unrecognised' };
}

/**
 * Throw unless LP actually accepted the appointment.
 *
 * Call this on the SetAppointment reply BEFORE writing any dedup marker,
 * applying `lp-appt-synced`, or reporting success upstream.
 *
 * @param {*} resp
 * @param {Object} [ctx] — { ldsId, apptDate, apptTime } for the error message
 * @throws {Error} with .code and .lpMessage set
 */
export function assertAppointmentAccepted(resp, ctx = {}) {
  const verdict = inspectAppointmentResponse(resp);
  if (verdict.accepted) return verdict;

  // No lead id in the text: it reaches Slack (the user, 2026-10-16); err.ldsId
  // still carries it for code.
  const where = ctx.apptDate ? ` (${`${ctx.apptDate} ${ctx.apptTime || ''}`.trimEnd()})` : '';

  const err = new Error(
    `LP SetAppointment REFUSED${where}: ${verdict.message || '(no message)'} ` +
    `[Result=${verdict.resultCode}, reason=${verdict.reason}]. ` +
    (verdict.reason === 'lp_market_out_of_area'
      ? 'LP could not resolve a market for this lead — almost always a lead created ' +
        'without a resolvable address. Repairing the prospect address does NOT fix this; ' +
        'the lead needs to be re-created with a real address.'
      : 'Do NOT tag this contact as synced.')
  );
  err.code = 'LP_APPT_REFUSED';
  err.ldsId = ctx.ldsId || null;
  err.reason = verdict.reason;
  err.lpMessage = verdict.message;
  err.lpResult = verdict.resultCode;
  throw err;
}

/**
 * The final answer a caller returns when LP refused the appointment
 * (enforce mode only: setAppointment throws LP_APPT_REFUSED there).
 *
 * 2026-10-12: a refusal is LP's answer, not a passing failure. Thrown, it was
 * re-sent by every loop above the call: the executor 3 times in ~3 minutes, the
 * parity watchdog every 30 minutes with no limit, inbound-checkout-watch every
 * 5, the post-issue retry for 2 hours, and each re-send is another
 * SetAppointment entry on the LP lead. Returned, like lp_appointment_conflict,
 * every one of them stops. Nothing is marked synced: no sync mark, no
 * `lp-appt-synced`.
 *
 * @param {*} err — whatever setAppointment threw
 * @param {Object} [extra] — fields the caller adds (contact_id, lp_lead_id, …)
 * @returns {Object|null} the answer, or null when err is not an LP refusal
 */
export function refusedAppointmentAnswer(err, extra = {}) {
  if (err?.code !== 'LP_APPT_REFUSED') return null;
  return {
    action: 'lp_appointment_refused',
    ...extra,
    reason: err.reason || 'lp_refused',
    lp_result: err.lpResult ?? null,
    lp_message: err.lpMessage || '',
  };
}

/**
 * Pre-flight on the LP lead record itself, BEFORE spending a SetAppointment
 * call. A lead whose brn_id is blank has no market and will be refused every
 * single time — there is no point attempting, and no point retrying.
 *
 * Accepts the lead object as returned inside /api/Customers/GetLead →
 * leads[]: { id, brn_id, disposition, apptset, appointments: [] }.
 *
 * @param {Object} lead
 * @param {Object} [opts]
 * @param {boolean} [opts.allowExistingAppointment=false] — LP's SetAppointment
 *        cannot overwrite an existing future appointment; by default a lead
 *        that already holds one is refused here rather than at LP.
 * @throws {Error} when the lead cannot accept an appointment
 */
export function assertLeadCanTakeAppointment(lead = {}, opts = {}) {
  const ldsId = lead.id ?? lead.lds_id ?? '(unknown)';

  if (isBlankAddress(lead.brn_id)) {
    const err = new Error(
      `The LP lead has no market (brn_id is blank) — it can never accept an ` +
      `appointment. This lead was created without a resolvable address. ` +
      `UpdateProspectInfo cannot repair a lead's market; the lead must be re-created ` +
      `with a real address, or the appointment set on a different lead.`
    );
    err.code = 'LP_LEAD_NO_MARKET';
    err.ldsId = ldsId;
    throw err;
  }

  const dispo = String(lead.disposition || '').trim().toLowerCase();
  if (dispo.includes('out of area') || dispo === 'ooa') {
    const err = new Error(
      `The LP lead is dispositioned "${lead.disposition}" — LP will refuse the appointment.`
    );
    err.code = 'LP_LEAD_OUT_OF_AREA';
    err.ldsId = ldsId;
    throw err;
  }

  if (!opts.allowExistingAppointment) {
    const hasFuture = Array.isArray(lead.appointments) && lead.appointments.length > 0;
    if (hasFuture || String(lead.apptset || '').toLowerCase() === 'true') {
      const err = new Error(
        `The LP lead already holds an appointment — SetAppointment cannot ` +
        `overwrite one, and cancel-then-set is unsupported by the LP API.`
      );
      err.code = 'LP_LEAD_APPT_EXISTS';
      err.ldsId = ldsId;
      throw err;
    }
  }

  return true;
}

export default {
  LP_APPT_REFUSAL_MARKERS,
  unwrapLpResponse,
  inspectAppointmentResponse,
  assertAppointmentAccepted,
  refusedAppointmentAnswer,
  assertLeadCanTakeAppointment,
};
