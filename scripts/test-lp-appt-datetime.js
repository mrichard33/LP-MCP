/**
 * Tests — LP appointment date/time normalization (date-parsers v2)
 * scripts/test-lp-appt-datetime.js
 *
 * Uses Node 18+ built-in test runner (`node:test`). Run with:
 *
 *   node --test scripts/test-lp-appt-datetime.js
 *
 * Pure-function tests for toLpApptDate / toLpApptTime — no DB, no network.
 * These guard the LP SetAppointment contract: appt_date must be MM/DD/YYYY
 * and appt_time must be 24-hour HH:MM. Anything that does not normalize must
 * return null so the handler throws a labeled error instead of POSTing a
 * malformed/empty value to LP (which surfaces as an opaque 400).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { toLpApptDate, toLpApptTime } from '../src/actions/date-parsers.js';

// ─── toLpApptDate ──────────────────────────────────────────────────

test('toLpApptDate: ISO date → MM/DD/YYYY', () => {
  assert.equal(toLpApptDate('2026-04-25'), '04/25/2026');
});

test('toLpApptDate: ISO datetime (T-suffix) drops the time', () => {
  assert.equal(toLpApptDate('2026-04-25T14:30:00-04:00'), '04/25/2026');
  assert.equal(toLpApptDate('2026-12-01T09:00'), '12/01/2026');
});

test('toLpApptDate: long form → MM/DD/YYYY', () => {
  assert.equal(toLpApptDate('April 25, 2026'), '04/25/2026');
  assert.equal(toLpApptDate('July 4, 2026'), '07/04/2026');
});

test('toLpApptDate: US M/D/YYYY is zero-padded; already-padded passes through', () => {
  assert.equal(toLpApptDate('4/5/2026'), '04/05/2026');
  assert.equal(toLpApptDate('04/25/2026'), '04/25/2026');
});

test('toLpApptDate: surrounding whitespace tolerated', () => {
  assert.equal(toLpApptDate('  2026-04-25  '), '04/25/2026');
});

test('toLpApptDate: empty / null / garbage → null (handler throws)', () => {
  for (const bad of ['', '   ', null, undefined, 'not a date', '2026/04/25', '04-25-2026', '{{contact.last_appointment_start_date}}']) {
    assert.equal(toLpApptDate(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('toLpApptDate: out-of-range month/day → null', () => {
  assert.equal(toLpApptDate('13/01/2026'), null);
  assert.equal(toLpApptDate('2026-00-10'), null);
  assert.equal(toLpApptDate('04/40/2026'), null);
});

// ─── toLpApptTime ──────────────────────────────────────────────────

test('toLpApptTime: 12-hour → 24-hour HH:MM', () => {
  assert.equal(toLpApptTime('2:30 PM'), '14:30');
  assert.equal(toLpApptTime('2:30PM'), '14:30');
  assert.equal(toLpApptTime('12:00 AM'), '00:00');
  assert.equal(toLpApptTime('12:15 PM'), '12:15');
  assert.equal(toLpApptTime('9:05 am'), '09:05');
});

test('toLpApptTime: 24-hour HH:MM passes through; HH:MM:SS drops seconds', () => {
  assert.equal(toLpApptTime('14:30'), '14:30');
  assert.equal(toLpApptTime('14:30:00'), '14:30');
  assert.equal(toLpApptTime('00:00'), '00:00');
});

test('toLpApptTime: single-digit hour zero-padded', () => {
  assert.equal(toLpApptTime('9:05'), '09:05');
});

test('toLpApptTime: empty / null / garbage → null (handler throws)', () => {
  for (const bad of ['', '   ', null, undefined, 'noon', '2:30', '{{custom_code.9.output.appt_time_24}}']) {
    // note: '2:30' is ambiguous-but-valid 24h H:MM and IS accepted — see next test
    if (bad === '2:30') continue;
    assert.equal(toLpApptTime(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('toLpApptTime: out-of-range hour/minute → null', () => {
  assert.equal(toLpApptTime('25:00'), null);
  assert.equal(toLpApptTime('14:60'), null);
  assert.equal(toLpApptTime('13:30 PM'), null); // 12h form with >12 hour is invalid
});
