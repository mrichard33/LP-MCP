/**
 * Regression lock for the LP zero-date guard.
 *
 * Motivating data (2026-09-16): lead 575791 mirrored
 * appointment_date = 1900-01-01T14:00 straight from LP's raw payload, and a
 * sibling row carried the literal Delphi zero 1899-12-30T11:00:00. 71 of
 * 134,257 dated leads were affected.
 *
 * Run: node scripts/test-lp-appt-date-guard.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeLpApptDate, lpDateToEastern } from '../src/lp-dates.js';

test('the Delphi zero date is not an appointment', () => {
  assert.equal(sanitizeLpApptDate('1899-12-30T11:00:00'), null);
});

test('LP 1900 sentinel is dropped whatever the time', () => {
  for (const t of ['10:00:00', '14:00:00', '10:30:00', '18:00:00', '19:00:00']) {
    assert.equal(sanitizeLpApptDate(`1900-01-01T${t}`), null, `failed for ${t}`);
  }
});

test('plausible-but-wrong years seen in the data are dropped too', () => {
  // Human typos in LP, not the zero date — the year floor catches both.
  assert.equal(sanitizeLpApptDate('1971-03-17T10:00:00'), null);
  assert.equal(sanitizeLpApptDate('1983-03-04T14:00:00'), null);
  assert.equal(sanitizeLpApptDate('1988-04-22T18:00:00'), null);
});

test('a real appointment date passes through UNCHANGED', () => {
  const real = '2026-09-15T14:00:00';
  assert.equal(sanitizeLpApptDate(real), lpDateToEastern(real));
  assert.equal(sanitizeLpApptDate(real), '2026-09-15T14:00:00+00:00');
});

test('boundary: 1999 drops, 2000-01-01 is kept', () => {
  assert.equal(sanitizeLpApptDate('1999-12-31T23:59:59'), null);
  assert.ok(sanitizeLpApptDate('2000-01-01T00:00:00'));
});

test('empty and unparseable input yield null, never a throw', () => {
  for (const v of ['', null, undefined, '   ']) {
    assert.equal(sanitizeLpApptDate(v), null);
  }
  assert.equal(sanitizeLpApptDate('not-a-date'), null);
});

test('already-offset-tagged real dates survive', () => {
  assert.equal(sanitizeLpApptDate('2026-09-15T14:00:00+00:00'), '2026-09-15T14:00:00+00:00');
  assert.equal(sanitizeLpApptDate('2026-09-15T14:00:00Z'), '2026-09-15T14:00:00Z');
});

test('an offset-tagged sentinel is still dropped', () => {
  // Guard must not be fooled by a pre-tagged zero date.
  assert.equal(sanitizeLpApptDate('1900-01-01T14:00:00+00:00'), null);
});
