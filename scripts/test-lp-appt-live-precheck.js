/**
 * Tests — live LP appointment pre-check (src/actions/handlers/lp-appointment.js)
 * scripts/test-lp-appt-live-precheck.js
 *
 * Uses Node 18+ built-in test runner (`node:test`). Run with:
 *
 *   node --test scripts/test-lp-appt-live-precheck.js
 *
 * Pure-function tests for parseLpApptWallClock — no DB, no LP, no network.
 * It is exported for exactly this reason: it is the whole decision surface of
 * the pre-check, and every duplicate LP write turns on it reading LP's
 * apptdate correctly.
 *
 * The three shapes that actually decide correctness, each a regression guard
 * for a defect found while building this (verified live 2026-07-31):
 *
 *   • "8/7/2026 6:00:00 PM" — single-digit month AND day, plus seconds before
 *     the meridiem. This is what LP's older endpoints return, and it is the
 *     shape that breaks a naive parser: normalizeDateForComparison's US branch
 *     requires TWO digits (/^(\d{2})\/(\d{2})\/(\d{4})/), so calling it
 *     directly on the date part yields null and the pre-check goes blind.
 *     Composing through toLpApptDate is what makes it work.
 *
 *   • exact midnight — LP's way of saying "date known, time TBD". It does NOT
 *     omit the field. 15,890 of 128,766 lp_leads appointment rows (12%) carry
 *     it. Read literally as '00:00' it never equals a real GHL time, so those
 *     leads would never suppress. Same rule lpWallClockToGhlStartTime applies
 *     in appointment-dates.js.
 *
 *   • unparseable — must stay DISTINCT from 'absent'. Both fall through to the
 *     write, but conflating them means a future LP format change becomes
 *     silent mass suppression with nothing in the logs pointing at the cause.
 */

// Supabase client construction in src/supabase.js reads env at import time,
// and the handler imports it directly. Harmless dummies so the module graph
// loads without a live config.
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseLpApptWallClock } from '../src/actions/handlers/lp-appointment.js';

const KNOWN = { date: '2026-08-07', time: '18:00', timeStatus: 'known' };
const ABSENT = { date: '2026-08-07', time: null, timeStatus: 'absent' };
const UNPARSEABLE = { date: '2026-08-07', time: null, timeStatus: 'unparseable' };

test('parses the shape LP actually returns today', () => {
  // Verified live 2026-07-31 via /api/Customers/GetLead (lds_id 455701):
  // "apptdate": "2026-09-27T18:00:00" — no offset, no Z. Wall clock.
  assert.deepEqual(parseLpApptWallClock('2026-08-07T18:00:00'), KNOWN);
});

test('parses a space separator as well as T', () => {
  assert.deepEqual(parseLpApptWallClock('2026-08-07 18:00:00'), KNOWN);
});

test('parses single-digit M/D with seconds before the meridiem', () => {
  // The one that matters most — LP's older endpoints return this, and it is
  // null if the date part goes straight to normalizeDateForComparison.
  assert.deepEqual(parseLpApptWallClock('8/7/2026 6:00:00 PM'), KNOWN);
});

test('parses zero-padded 12-hour without seconds', () => {
  assert.deepEqual(parseLpApptWallClock('08/07/2026 6:00 PM'), KNOWN);
});

test('tolerates fractional seconds and a trailing Z', () => {
  // LP emits ".373" on sibling timestamps (dateadded, setdate); toLpApptTime
  // rejects both that and the Z, so they are stripped before parsing.
  assert.deepEqual(parseLpApptWallClock('2026-08-07T18:00:00.000Z'), KNOWN);
  assert.deepEqual(parseLpApptWallClock('2026-08-07T18:00:00.373'), KNOWN);
});

test('treats exact midnight as time-unknown, not as 12:00 AM', () => {
  // 12% of live rows. Read literally, these never match and never suppress.
  assert.deepEqual(parseLpApptWallClock('2026-08-07T00:00:00'), ABSENT);
  assert.deepEqual(parseLpApptWallClock('2026-08-07 00:00'), ABSENT);
});

test('treats a bare date as time-absent', () => {
  assert.deepEqual(parseLpApptWallClock('2026-08-07'), ABSENT);
  assert.deepEqual(parseLpApptWallClock('8/7/2026'), ABSENT);
});

test('flags an unreadable time separately from an absent one', () => {
  assert.deepEqual(parseLpApptWallClock('2026-08-07T25:99:00'), UNPARSEABLE);
  assert.deepEqual(parseLpApptWallClock('2026-08-07 half past six'), UNPARSEABLE);
});

test('returns null when no date parses at all', () => {
  for (const input of ['', '   ', null, undefined, 'garbage', '2026-13-45']) {
    assert.equal(parseLpApptWallClock(input), null, `expected null for ${JSON.stringify(input)}`);
  }
});

// ─── The match predicate ──────────────────────────────────────────────
// Mirrors the condition in executeSetLPAppointment's live pre-check. Kept
// here as an executable statement of the rule: suppression requires BOTH
// legs, and neither 'absent' nor 'unparseable' may stand in for a match.
const suppresses = (parsed, ghlDate, ghlTime) =>
  !!parsed &&
  parsed.date === ghlDate &&
  parsed.timeStatus === 'known' &&
  parsed.time === ghlTime;

test('suppresses only when date AND time both match', () => {
  assert.equal(suppresses(KNOWN, '2026-08-07', '18:00'), true);
  assert.equal(suppresses(KNOWN, '2026-08-07', '14:00'), false, 'same-day time change must write');
  assert.equal(suppresses(KNOWN, '2026-08-08', '18:00'), false, 'different date must write');
});

test('a date-only LP record is completed, not suppressed', () => {
  // LP has the day, GHL has the time. Writing fills in what LP is missing;
  // suppressing would strand the rep with a timeless booking.
  assert.equal(suppresses(ABSENT, '2026-08-07', '18:00'), false);
});

test('an unreadable LP time never counts as a match', () => {
  // Failing into suppression would hide a parser gap behind correct-looking
  // "already set" outcomes.
  assert.equal(suppresses(UNPARSEABLE, '2026-08-07', '18:00'), false);
});

test('an unparseable apptdate never counts as a match', () => {
  assert.equal(suppresses(null, '2026-08-07', '18:00'), false);
});
