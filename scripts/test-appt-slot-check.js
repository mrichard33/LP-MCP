/**
 * Tests — GHL slot-uniqueness check (src/appointments/slot-check.js)
 * scripts/test-appt-slot-check.js
 *
 * Uses Node 18+ built-in test runner (`node:test`). Run with:
 *
 *   node --test scripts/test-appt-slot-check.js
 *
 * Pure-function tests for the slot-matching predicate — no DB, no network.
 * Guards the invariants that actually decide whether a duplicate gets created:
 *
 *   • the match window is a TOLERANCE on absolute instants, not a string compare
 *   • equivalent instants written with different UTC offsets are the same slot
 *   • only 'new'/'confirmed' occupy a slot (a cancelled one frees it)
 *   • a different calendar is never a match
 *   • GHL's misspelled `appoinmentStatus` is still read
 */

// Supabase client construction in src/supabase.js reads env at import time, and
// slot-check imports it transitively via the event emitter. Harmless dummies so
// the module graph loads without a live config.
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';
process.env.APPT_SLOT_MATCH_WINDOW_S ||= '60';

import test from 'node:test';
import assert from 'node:assert/strict';

import { occupiesSlot, readStatus, matchWindowSeconds, isSlotCheckEnabled } from '../src/appointments/slot-check.js';

const CAL = 'aJj14ONxh1oFyDcQ706O';
const TARGET = '2026-07-29T19:00:00-04:00';
const targetMs = Date.parse(TARGET);
const windowMs = 60 * 1000;

const appt = (over = {}) => ({
  appointment_id: 'appt_1',
  calendar_id: CAL,
  start_time: TARGET,
  status: 'confirmed',
  ...over,
});

test('exact instant on the same calendar is a match', () => {
  assert.equal(occupiesSlot(appt(), { calendarId: CAL, targetMs, windowMs }), true);
});

test('within the window matches; outside it does not', () => {
  const at30s = appt({ start_time: '2026-07-29T19:00:30-04:00' });
  const at90s = appt({ start_time: '2026-07-29T19:01:30-04:00' });
  assert.equal(occupiesSlot(at30s, { calendarId: CAL, targetMs, windowMs }), true, '30s inside a 60s window');
  assert.equal(occupiesSlot(at90s, { calendarId: CAL, targetMs, windowMs }), false, '90s outside a 60s window');
});

test('window is symmetric — 30s EARLIER also matches', () => {
  const before = appt({ start_time: '2026-07-29T18:59:30-04:00' });
  assert.equal(occupiesSlot(before, { calendarId: CAL, targetMs, windowMs }), true);
});

test('same instant written with a different offset is the same slot', () => {
  // 23:00Z === 19:00-04:00. A wall-clock string compare would miss this, which
  // is the whole reason the comparison is on epoch ms.
  const utc = appt({ start_time: '2026-07-29T23:00:00Z' });
  assert.equal(occupiesSlot(utc, { calendarId: CAL, targetMs, windowMs }), true);
});

test('a different calendar is never a match', () => {
  const other = appt({ calendar_id: 'zEdPmkNccR2ovo3rQAd3' });
  assert.equal(occupiesSlot(other, { calendarId: CAL, targetMs, windowMs }), false);
});

test('only new/confirmed occupy the slot', () => {
  assert.equal(occupiesSlot(appt({ status: 'new' }), { calendarId: CAL, targetMs, windowMs }), true);
  for (const status of ['cancelled', 'noshow', 'showed', 'invalid', '']) {
    assert.equal(
      occupiesSlot(appt({ status }), { calendarId: CAL, targetMs, windowMs }),
      false,
      `status '${status}' must not occupy the slot`,
    );
  }
});

test('a GHL-deleted appointment does not occupy the slot', () => {
  assert.equal(occupiesSlot(appt({ deleted: true }), { calendarId: CAL, targetMs, windowMs }), false);
});

test('unparseable start times never match (never silently free or occupy)', () => {
  assert.equal(occupiesSlot(appt({ start_time: 'not-a-date' }), { calendarId: CAL, targetMs, windowMs }), false);
  assert.equal(occupiesSlot(appt({ start_time: null }), { calendarId: CAL, targetMs, windowMs }), false);
  assert.equal(occupiesSlot(null, { calendarId: CAL, targetMs, windowMs }), false);
});

test("readStatus absorbs GHL's misspelled appoinmentStatus", () => {
  // Real quirk: 7,410 of 8,087 cached rows carry `appoinmentStatus` (no 't')
  // alongside the correct spelling.
  assert.equal(readStatus({ appoinmentStatus: 'Confirmed' }), 'confirmed');
  assert.equal(readStatus({ appointmentStatus: 'NEW' }), 'new');
  assert.equal(readStatus({ status: 'confirmed' }), 'confirmed');
  assert.equal(readStatus({}), '');
  assert.equal(readStatus(null), '');
});

test('an appointment carrying ONLY the misspelled status still occupies the slot', () => {
  const misspelled = { appointment_id: 'a', calendar_id: CAL, start_time: TARGET, appoinmentStatus: 'confirmed' };
  assert.equal(occupiesSlot(misspelled, { calendarId: CAL, targetMs, windowMs }), true);
});

test('matchWindowSeconds reads env and falls back to 60', () => {
  const prev = process.env.APPT_SLOT_MATCH_WINDOW_S;
  process.env.APPT_SLOT_MATCH_WINDOW_S = '120';
  assert.equal(matchWindowSeconds(), 120);
  process.env.APPT_SLOT_MATCH_WINDOW_S = 'garbage';
  assert.equal(matchWindowSeconds(), 60, 'unparseable falls back to the default');
  delete process.env.APPT_SLOT_MATCH_WINDOW_S;
  assert.equal(matchWindowSeconds(), 60, 'unset falls back to the default');
  process.env.APPT_SLOT_MATCH_WINDOW_S = prev;
});

test('the feature flag is strictly true-only (ships dark)', () => {
  const prev = process.env.APPT_SLOT_CHECK_ENABLED;
  for (const v of [undefined, '', 'false', '1', 'yes', 'TRUE ']) {
    if (v === undefined) delete process.env.APPT_SLOT_CHECK_ENABLED;
    else process.env.APPT_SLOT_CHECK_ENABLED = v;
    const expected = String(v || '').trim().toLowerCase() === 'true';
    assert.equal(isSlotCheckEnabled(), expected, `APPT_SLOT_CHECK_ENABLED='${v}'`);
  }
  process.env.APPT_SLOT_CHECK_ENABLED = prev;
});
