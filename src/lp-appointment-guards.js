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
 * Unit tested in scripts/test-lp-appointment-guards.js.
 */

import { isBlankAddress } from './lp-address-validity.js';

/**
 * Substrings that mark an LP SetAppointment reply as a REFUSAL, even when
 * Result is 1. Matched case-insensitively against the Message field.
 *
 * "market is OOA" is the confirmed one (observed live, twice, 2026-08-26/27).
 * The others are defensive: LP's soft-failure vocabulary is not documented,
 * and the failure mode of missing one is a silent false positive — the exact
 * bug this module exists to prevent. Extend this list rather than loosening
 * the check.
 */
export const LP_APPT_REFUSAL_MARKERS = Object.freeze([
  'ooa',
  'out of area',
  'market is',
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
 * Inspect a SetAppointment reply without throwing.
 *
 * @param {*} resp — raw LP response
 * @returns {{accepted: boolean, resultCode: *, message: string, reason: string|null}}
 */
export function inspectAppointmentResponse(resp) {
  const item = unwrapLpResponse(resp);
  const resultCode = item.Result ?? item.result ?? null;
  const message = String(item.Message ?? item.message ?? '').trim();
  const lower = message.toLowerCase();

  // Explicit failure code.
  if (resultCode === 0 || resultCode === '0') {
    return { accepted: false, resultCode, message, reason: 'lp_result_zero' };
  }

  // Result:1 with a refusal message — the silent killer.
  const marker = LP_APPT_REFUSAL_MARKERS.find((m) => lower.includes(m));
  if (marker) {
    return {
      accepted: false,
      resultCode,
      message,
      reason: lower.includes('ooa') || lower.includes('out of area') || lower.includes('market is')
        ? 'lp_market_out_of_area'
        : 'lp_refused',
    };
  }

  return { accepted: true, resultCode, message, reason: null };
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

  const where = ctx.ldsId ? ` (lds_id=${ctx.ldsId}` +
    (ctx.apptDate ? `, ${ctx.apptDate} ${ctx.apptTime || ''}`.trimEnd() : '') + ')' : '';

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
  err.reason = verdict.reason;
  err.lpMessage = verdict.message;
  err.lpResult = verdict.resultCode;
  throw err;
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
      `LP lead ${ldsId} has no market (brn_id is blank) — it can never accept an ` +
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
      `LP lead ${ldsId} is dispositioned "${lead.disposition}" — LP will refuse the appointment.`
    );
    err.code = 'LP_LEAD_OUT_OF_AREA';
    err.ldsId = ldsId;
    throw err;
  }

  if (!opts.allowExistingAppointment) {
    const hasFuture = Array.isArray(lead.appointments) && lead.appointments.length > 0;
    if (hasFuture || String(lead.apptset || '').toLowerCase() === 'true') {
      const err = new Error(
        `LP lead ${ldsId} already holds an appointment — SetAppointment cannot ` +
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
  assertLeadCanTakeAppointment,
};
