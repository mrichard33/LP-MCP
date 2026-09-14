/**
 * Appointment-reschedule emit decision — src/services/appointment-reschedule-emit.js
 *
 * WHAT THIS DEFENDS AGAINST (WO-4a, 2026-09-14).
 * LP→GHL appointment sync fired only on `lp.disposition_changed`. An LP
 * reschedule that does NOT change the disposition emitted nothing, so
 * reconcileLpAppointmentToGhl never ran and GHL kept the old date — holding a
 * stale slot and double-counting the appointment across two days.
 *
 * Telemetry over 30 days: appt.booking = 2,823 `created`, 34
 * `noop_already_exists`, ONE `updated`. The reconciler has handled reschedules
 * correctly the whole time (planReconciliation returns reschedule /
 * reschedule_confirm on a start-time mismatch). It was simply never invoked.
 *
 * Canary — prospect 230117 / lead 575494 (Pat Maidment, GHL contact
 * 3a3rAaHxnICmykJKGDt1). 9/12 18:39Z lp.disposition_changed:Cnf → 18:41Z
 * appt.booking:created for 2026-09-14 10:00. 9/13 16:25Z LP moved it to
 * 2026-09-15 10:00 with the disposition unchanged. No event followed; GHL
 * still held 9/14. Note that `lp_leads.appointment_date` DID update to 9/15 and
 * `updated_at_lp` DID bump to the reschedule time — the row was right, only the
 * event was missing.
 *
 * PURE and dependency-free, per the convention in CLAUDE.md: the decision and
 * the event body unit-test without importing supabase or the emitter. The
 * caller (src/sync-leads.js) owns the read, the emit and the ordering.
 */

/**
 * Dispositions that own a live appointment worth propagating.
 *
 * CXL is deliberately absent — rule 271 owns cancels, and emitting a
 * reschedule for a cancelled lead would race it. Everything past the
 * appointment (Issue, Sold, ...) is likewise out: a date move there is
 * history, not a slot GHL is still holding.
 */
export const RESCHEDULE_ELIGIBLE_DISPOSITIONS = new Set(['Set', 'Verif', 'Cnf']);

/** Epoch ms for a stored/derived appointment timestamp, or null. */
function toMs(value) {
  if (value == null || value === '') return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Do two appointment timestamps denote the same instant?
 *
 * Exported because the funnel-flag staleness guard in sync-leads.js needs the
 * same comparison: the stored column is timestamptz and comes back from
 * PostgREST in its own rendering, while the incoming value is whatever
 * lpDateToEastern produced. A string compare would call two spellings of the
 * same instant a change and force a pointless upsert on every pass.
 * Two nulls are "the same" (no appointment, still no appointment).
 */
export function sameApptInstant(a, b) {
  const am = toMs(a), bm = toMs(b);
  if (am == null && bm == null) return true;
  return am === bm;
}

/**
 * Should this lead emit lp.appointment_rescheduled on this sync pass?
 *
 * Compared as epoch ms, NOT as strings. The stored column is timestamptz and
 * comes back from PostgREST in its own rendering, while the incoming value is
 * whatever lpDateToEastern produced. Two spellings of the same instant must
 * not read as a reschedule.
 *
 * @returns {{ emit: boolean, reason: string }} reason is always set, so the
 *   caller can log WHY it stayed quiet — a silent false is how the original
 *   defect hid for the better part of a year.
 */
export function shouldEmitReschedule({ previousAppointmentDate, appointmentDate, dispositionCode } = {}) {
  const code = (dispositionCode == null ? '' : String(dispositionCode)).trim();
  if (!RESCHEDULE_ELIGIBLE_DISPOSITIONS.has(code)) {
    return { emit: false, reason: 'disposition_not_eligible' };
  }
  const next = toMs(appointmentDate);
  if (next == null) return { emit: false, reason: 'no_new_date' };
  const prev = toMs(previousAppointmentDate);
  // A lead that had no appointment and now has one is a BOOKING, not a
  // reschedule — the disposition transition that created it already emits and
  // already routes. Emitting here too would double-drive the reconciler.
  if (prev == null) return { emit: false, reason: 'no_previous_date' };
  if (prev === next) return { emit: false, reason: 'unchanged' };
  return { emit: true, reason: 'rescheduled' };
}

/**
 * The event body for emitEvent(). Shape mirrors the lp.disposition_changed
 * emits in sync-leads.js.
 *
 * `entity_id` is the LP LEAD id and is load-bearing: sync_lp_appointment_to_ghl
 * is deliberately NOT context-aware (src/actions/index.js) — it re-reads the
 * authoritative lp_leads row from system_events.entity_id via action.event_id.
 * Hand it a contact id and it resolves the wrong row, or none.
 *
 * `lp_lead_id` and `ghl_contact_id` are set as COLUMNS, not only in the
 * payload: the decision engine's newest-lead guard and every downstream join
 * read the columns.
 *
 * The idempotency key carries BOTH dates, so one reschedule emits exactly once
 * however many times the sweep re-reads the lead, while a SECOND move of the
 * same appointment still gets its own event.
 */
export function buildRescheduleEvent({
  lpLeadId, lpProspectId, ghlContactId,
  previousAppointmentDate, appointmentDate, dispositionCode,
  leadName = null, leadSource = null, priority = 'high',
}) {
  const keyPart = (v) => String(v ?? 'null').replace(/[^0-9A-Za-z]/g, '');
  return {
    event_type: 'lp.appointment_rescheduled',
    // Subtype IS the disposition code, matching the lp.disposition_changed
    // convention the LP_APPT_GHL_SYNC_* rules were written against.
    event_subtype: dispositionCode,
    source: 'lp_sync',
    entity_type: 'lead',
    entity_id: lpLeadId,
    ghl_contact_id: ghlContactId || null,
    lp_lead_id: lpLeadId,
    lp_prospect_id: lpProspectId || null,
    payload: {
      previous_appointment_date: previousAppointmentDate,
      appointment_date: appointmentDate,
      disposition_code: dispositionCode,
      lp_lead_id: lpLeadId,
      lead_name: leadName,
      lead_source: leadSource,
      source: 'sync-leads',
    },
    previous_state: { appointment_date: previousAppointmentDate },
    new_state: { appointment_date: appointmentDate },
    // Injected rather than computed, so this module stays dependency-free.
    // sync-leads passes dispositionPriority(code) — the same lane the
    // disposition-driven appointment sync runs in ('high' for Set/Cnf).
    priority,
    idempotency_key: `appt_resched_${lpLeadId}_${keyPart(previousAppointmentDate)}_${keyPart(appointmentDate)}`,
  };
}
