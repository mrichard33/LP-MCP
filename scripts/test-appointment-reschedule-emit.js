/**
 * WO-4a — lp.appointment_rescheduled emit decision and event body.
 *
 * Guards the fix for the defect where an LP reschedule that did NOT change the
 * disposition emitted nothing, so reconcileLpAppointmentToGhl never ran and GHL
 * kept the old date. Over 30 days: appt.booking = 2,823 created, 34
 * noop_already_exists, ONE updated.
 *
 * The module under test is pure (CLAUDE.md convention), so this suite runs
 * without supabase, GroupMe or the event emitter.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  shouldEmitReschedule,
  buildRescheduleEvent,
  sameApptInstant,
  RESCHEDULE_ELIGIBLE_DISPOSITIONS,
} from '../src/services/appointment-reschedule-emit.js';

// The canary: prospect 230117 / lead 575494 (Pat Maidment). LP moved the
// appointment from 9/14 10:00 to 9/15 10:00 on 9/13 16:25Z with the
// disposition left at Cnf. Nothing was emitted and GHL kept 9/14.
const PREV = '2026-09-14T10:00:00+00:00';
const NEXT = '2026-09-15T10:00:00+00:00';

test('the canary: a date change with the disposition unchanged emits', () => {
  const d = shouldEmitReschedule({
    previousAppointmentDate: PREV, appointmentDate: NEXT, dispositionCode: 'Cnf',
  });
  assert.deepEqual(d, { emit: true, reason: 'rescheduled' });
});

test('an unchanged date emits nothing', () => {
  const d = shouldEmitReschedule({
    previousAppointmentDate: PREV, appointmentDate: PREV, dispositionCode: 'Cnf',
  });
  assert.equal(d.emit, false);
  assert.equal(d.reason, 'unchanged');
});

test('the same instant spelled two ways is NOT a reschedule', () => {
  // The stored column is timestamptz and comes back from PostgREST in its own
  // rendering; the incoming value is whatever lpDateToEastern produced. A naive
  // string compare would emit on every single sync pass for every booked lead.
  const d = shouldEmitReschedule({
    previousAppointmentDate: '2026-09-15T10:00:00+00:00',
    appointmentDate: '2026-09-15T10:00:00Z',
    dispositionCode: 'Cnf',
  });
  assert.equal(d.emit, false, 'two spellings of one instant must not emit');
  assert.equal(d.reason, 'unchanged');
  assert.equal(sameApptInstant('2026-09-15T10:00:00+00:00', '2026-09-15T10:00:00Z'), true);
  assert.equal(sameApptInstant(null, null), true, 'no appointment, still none');
  assert.equal(sameApptInstant(null, NEXT), false);
});

test('a new date of null emits nothing — that is a cancel, not a move', () => {
  const d = shouldEmitReschedule({
    previousAppointmentDate: PREV, appointmentDate: null, dispositionCode: 'Cnf',
  });
  assert.equal(d.emit, false);
  assert.equal(d.reason, 'no_new_date');
});

test('a first booking emits nothing — the disposition transition already routes', () => {
  // Emitting here as well would double-drive the reconciler and, per acceptance
  // 4, would show up as a RISE in appt.booking:created. This change must
  // produce updates, not creates.
  const d = shouldEmitReschedule({
    previousAppointmentDate: null, appointmentDate: NEXT, dispositionCode: 'Set',
  });
  assert.equal(d.emit, false);
  assert.equal(d.reason, 'no_previous_date');
});

test('CXL never emits — rule 271 owns cancels', () => {
  const d = shouldEmitReschedule({
    previousAppointmentDate: PREV, appointmentDate: NEXT, dispositionCode: 'CXL',
  });
  assert.equal(d.emit, false);
  assert.equal(d.reason, 'disposition_not_eligible');
});

test('only Set, Verif and Cnf are eligible', () => {
  assert.deepEqual([...RESCHEDULE_ELIGIBLE_DISPOSITIONS].sort(), ['Cnf', 'Set', 'Verif']);
  for (const code of ['Set', 'Verif', 'Cnf']) {
    assert.equal(
      shouldEmitReschedule({ previousAppointmentDate: PREV, appointmentDate: NEXT, dispositionCode: code }).emit,
      true, `${code} should emit`);
  }
  // A date move after the appointment happened is history, not a held slot.
  for (const code of ['Issue', 'Sold', 'NS', 'Data', '', null]) {
    assert.equal(
      shouldEmitReschedule({ previousAppointmentDate: PREV, appointmentDate: NEXT, dispositionCode: code }).emit,
      false, `${code} should not emit`);
  }
});

test('the event body carries both ids as COLUMNS, not only in the payload', () => {
  // The lp.disposition_changed payload carries neither lp_lead_id nor
  // ghl_contact_id, and the decision engine's newest-lead guard plus every
  // downstream join read the COLUMNS.
  const e = buildRescheduleEvent({
    lpLeadId: '575494', lpProspectId: '230117', ghlContactId: '3a3rAaHxnICmykJKGDt1',
    previousAppointmentDate: PREV, appointmentDate: NEXT, dispositionCode: 'Cnf',
    leadName: 'Pat Maidment', leadSource: 'Lead Gurus', priority: 'high',
  });
  assert.equal(e.event_type, 'lp.appointment_rescheduled');
  assert.equal(e.event_subtype, 'Cnf', 'subtype IS the disposition code');
  assert.equal(e.lp_lead_id, '575494');
  assert.equal(e.ghl_contact_id, '3a3rAaHxnICmykJKGDt1');
  assert.equal(e.lp_prospect_id, '230117');
  assert.equal(e.priority, 'high');
  assert.equal(e.payload.previous_appointment_date, PREV);
  assert.equal(e.payload.appointment_date, NEXT);
  assert.equal(e.payload.disposition_code, 'Cnf');
  assert.equal(e.payload.lp_lead_id, '575494');
  assert.equal(e.payload.source, 'sync-leads');
});

test('entity_id is the LEAD id — the handler resolves the row from it', () => {
  // sync_lp_appointment_to_ghl is deliberately NOT context-aware: it re-reads
  // lp_leads from system_events.entity_id via action.event_id. A contact id
  // here resolves the wrong row, or none.
  const e = buildRescheduleEvent({
    lpLeadId: '575494', lpProspectId: '230117', ghlContactId: '3a3rAaHxnICmykJKGDt1',
    previousAppointmentDate: PREV, appointmentDate: NEXT, dispositionCode: 'Cnf',
  });
  assert.equal(e.entity_type, 'lead');
  assert.equal(e.entity_id, '575494');
  assert.notEqual(e.entity_id, '3a3rAaHxnICmykJKGDt1');
});

test('idempotency: one reschedule emits once, a second move gets its own event', () => {
  const key = (prev, next) => buildRescheduleEvent({
    lpLeadId: '575494', lpProspectId: '230117', ghlContactId: 'c1',
    previousAppointmentDate: prev, appointmentDate: next, dispositionCode: 'Cnf',
  }).idempotency_key;
  // Same move re-read by the sweep → same key → emitEvent dedups.
  assert.equal(key(PREV, NEXT), key(PREV, NEXT));
  // A SECOND move of the same appointment must not be swallowed by the first.
  assert.notEqual(key(PREV, NEXT), key(NEXT, '2026-09-16T10:00:00+00:00'));
  // No separators that could collide two different pairs into one key.
  assert.match(key(PREV, NEXT), /^appt_resched_575494_[0-9A-Za-z]+_[0-9A-Za-z]+$/);
});

test('lp.appointment_rescheduled is on the intake allowlist', () => {
  // Asserted, not assumed. The allowlist is default-DROP: without the entry the
  // event lands in system_events_filtered and GHL keeps the stale slot — the
  // exact defect this event exists to fix. Read as source rather than imported,
  // so this assertion does not drag supabase into a pure suite.
  const src = readFileSync(new URL('../src/services/event-intake-filter.js', import.meta.url), 'utf8');
  const allowlist = src.slice(src.indexOf('const ALLOWED_EVENT_TYPES'), src.indexOf('// Quiet but rule-watched'));
  assert.ok(allowlist.includes("'lp.appointment_rescheduled'"),
    'lp.appointment_rescheduled must be in ALLOWED_EVENT_TYPES');
});

test('both decision-engine newest-lead type checks cover the new event', () => {
  // The guard is opt-in by event type and has TWO checks — the caller in
  // processSingleEventInner and the early return inside
  // isNewestLeadForContact. Widening only one leaves a guard that reads as
  // working and waves every superseded lead through. Canary: prospect 230117
  // holds four lead rows on one contact and only 575494 is live.
  const src = readFileSync(new URL('../src/decision-engine.js', import.meta.url), 'utf8');
  const hits = src.split("'lp.appointment_rescheduled'").length - 1;
  assert.ok(hits >= 2, `expected both type checks to name the event, found ${hits}`);
});
