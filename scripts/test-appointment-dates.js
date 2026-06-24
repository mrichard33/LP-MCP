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

import { appointmentDelta, formatDateHuman } from '../src/appointment-dates.js';

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
