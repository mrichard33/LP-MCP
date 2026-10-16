/**
 * LP disposition classes — src/lp-disposition-classes.js
 *
 * ONE place for the three appointment-relevant classes (Mark, 2026-10-16,
 * handoff v3.4). Pure: no I/O, safe to import anywhere.
 *
 *   LIVE_APPOINTMENT_DISPOSITIONS  Set, Cnf, Issue — a real visit on the books.
 *     Issue = issued to a rep: as live as a Cnf.
 *   HOLD_DISPOSITIONS              Verif — "there is an issue with the lead".
 *     It STARTS NOTHING: no GHL create/reschedule/confirm/cancel, no routing or
 *     stage tag, no Confirmation-list add, no DNC lift, no workflow. Where a
 *     list SUPPRESSES something (off the dial lists, out of the new-lead
 *     backstops, out of leak alerts) Verif stays suppressed. This REVERSES the
 *     2026-07-09 reconciler rule ("LP Verif = a live Window Estimate, exactly
 *     like Set") and the 2026-10-06 booked-dial-routing note "Verif counts as
 *     Set". Verif is neither "booked" nor "dialable".
 *   DISQUALIFIED_DISPOSITIONS      ND, No Demo — an end state. No S5.2, no
 *     rebook, no Five9, no F.0, no nurture, no booking. An open GHL estimate is
 *     marked `invalid` (never `cancelled`, which fires the cancel/rebook paths).
 *
 * GHL status implied by LP: Set → new; Cnf, Issue → confirmed. Never upgrade a
 * Set to confirmed on the CODE alone.
 *
 * ONE exception (the user, 2026-10-16, Roberta Ritchie 583833): LP's own
 * "confirmed" checkbox. A Set lead whose LP row says confirmed IS confirmed —
 * the 10/16 ruling was about the Set code, not LP's checkbox (the capacity board
 * already reads it this way, capacity-sweep.js). `confirmed` is that checkbox.
 */

export const LIVE_APPOINTMENT_DISPOSITIONS = Object.freeze(['Set', 'Cnf', 'Issue']);
export const HOLD_DISPOSITIONS = Object.freeze(['Verif']);
export const DISQUALIFIED_DISPOSITIONS = Object.freeze(['ND', 'No Demo']);

const norm = (code) => String(code ?? '').trim();
const LIVE = new Set(LIVE_APPOINTMENT_DISPOSITIONS);
const HOLD = new Set(HOLD_DISPOSITIONS);
const DQ = new Set(DISQUALIFIED_DISPOSITIONS);

export function isLiveAppointmentDisposition(code) { return LIVE.has(norm(code)); }
export function isHoldDisposition(code) { return HOLD.has(norm(code)); }
export function isDisqualifiedDisposition(code) { return DQ.has(norm(code)); }

/** GHL appointment status LP implies for a live disposition; null for anything else. */
export function ghlStatusForDisposition(code, { confirmed = false } = {}) {
  const c = norm(code);
  if (c === 'Set') return confirmed === true ? 'confirmed' : 'new';
  if (c === 'Cnf' || c === 'Issue') return 'confirmed';
  return null;
}
