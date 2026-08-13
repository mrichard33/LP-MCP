/**
 * scripts/test-appointment-dates.js
 *
 * Unit coverage for appointmentDelta() — the past/future labeling that grounds
 * the agentic bot's appointment awareness (Mark Test repro, June 2026: the bot
 * called a 9-day-past LP appointment "upcoming"). LP appointment_date is a
 * DATE-ONLY value stored as UTC midnight ("2026-06-15+00:00"); it denotes a
 * calendar day, so the delta is a whole-day diff against today in ET — NOT a
 * timezone conversion of the instant (which would shift it back a day).
 *
 * Pure-function test — no DB, no network.
 * Run: node --test scripts/test-appointment-dates.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { appointmentDelta, formatDateHuman, etAppointmentParts } from '../src/appointment-dates.js';

// Fixed reference: 2026-06-24 ~2 PM ET (18:xx UTC) — a normal weekday.
const NOW = new Date('2026-06-24T18:00:00Z');

test('a 9-days-past appointment is flagged past with the right delta', () => {
  const r = appointmentDelta('2026-06-15+00:00', NOW);
  assert.equal(r.is_past, true);
  assert.equal(r.days_delta, -9);
});

test('a future appointment is not past, positive delta', () => {
  const r = appointmentDelta('2026-06-30', NOW);
  assert.equal(r.is_past, false);
  assert.equal(r.days_delta, 6);
});

test('an appointment today is not past, delta 0', () => {
  const r = appointmentDelta('2026-06-24+00:00', NOW);
  assert.equal(r.is_past, false);
  assert.equal(r.days_delta, 0);
});

test('UTC-midnight date-only value is NOT shifted back a day in ET (off-by-one guard)', () => {
  // 2026-06-24T00:00:00Z converted to ET is June 23 8 PM — but the appointment
  // means the CALENDAR day June 24, so it must read as today (delta 0), not -1.
  const r = appointmentDelta('2026-06-24+00:00', NOW);
  assert.equal(r.days_delta, 0);
  assert.equal(r.is_past, false);
});

test('null / undefined / unparseable appointment dates return null', () => {
  assert.equal(appointmentDelta(null, NOW), null);
  assert.equal(appointmentDelta(undefined, NOW), null);
  assert.equal(appointmentDelta('', NOW), null);
  assert.equal(appointmentDelta('not-a-date', NOW), null);
});

test('yesterday is past with delta -1 (singular wording is caller-side)', () => {
  const r = appointmentDelta('2026-06-23', NOW);
  assert.equal(r.is_past, true);
  assert.equal(r.days_delta, -1);
});

test('formatDateHuman renders an ET long date', () => {
  assert.equal(formatDateHuman(NOW), 'Wednesday, June 24, 2026');
});

// ── etAppointmentParts ────────────────────────────────────────────────
// These two strings go out on ghl.appointment_booked as startDate /
// start_time and are parsed by executeSetLPAppointment on the way into LP.
// They must match what a real GHL webhook carries ("2026-08-20", "2:00 PM").

test('splits a GHL start time into ET date and 12-hour wall clock', () => {
  assert.deepEqual(etAppointmentParts('2026-08-20T14:00:00-04:00'), {
    startDate: '2026-08-20',
    startTime12h: '2:00 PM',
  });
});

test('is DST-correct — an EST booking does not shift', () => {
  // The trap this guards: buildAppointmentBody hardcodes -04:00, which is
  // EDT-only. Reusing that offset would move every Nov-Mar appointment.
  assert.deepEqual(etAppointmentParts('2026-01-15T09:30:00-05:00'), {
    startDate: '2026-01-15',
    startTime12h: '9:30 AM',
  });
});

test('converts a UTC instant into ET, not a naive string split', () => {
  // 18:00Z in August is 2 PM ET — and still August 20, not the 21st.
  assert.deepEqual(etAppointmentParts('2026-08-20T18:00:00Z'), {
    startDate: '2026-08-20',
    startTime12h: '2:00 PM',
  });
});

test('midnight and noon render unambiguously', () => {
  assert.equal(etAppointmentParts('2026-12-01T00:00:00-05:00').startTime12h, '12:00 AM');
  assert.equal(etAppointmentParts('2026-08-20T12:00:00-04:00').startTime12h, '12:00 PM');
});

test('accepts a Date instance as well as an ISO string', () => {
  const viaDate = etAppointmentParts(new Date('2026-08-14T22:00:00Z'));
  assert.deepEqual(viaDate, { startDate: '2026-08-14', startTime12h: '6:00 PM' });
});

test('missing / unparseable start times return null rather than a bad date', () => {
  for (const bad of [null, undefined, '', 'not-a-date', 'garbage']) {
    assert.equal(etAppointmentParts(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});
