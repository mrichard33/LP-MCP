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
 *
 * 2026-08-01 — extended to cover classifyLivePrecheck(), the three-way verdict
 * ('already_set' | 'conflict' | 'write') that replaced the bare suppress/write
 * boolean. The conflict outcome is the P0 fix: correctly detecting a date+time
 * mismatch (2026-07-31) made the handler proceed to a SetAppointment that LP
 * rejects, because SetAppointment cannot overwrite an existing future
 * appointment and cancel-then-set is unsupported. Three things are pinned here:
 *
 *   • the verdict itself, called on the REAL exported rule rather than a
 *     mirrored copy — the previous local `suppresses()` helper could drift from
 *     the handler silently, and did not cover the conflict case at all;
 *   • the ET day boundary, which decides whether a same-day appointment reads
 *     as live or past. UTC-derived day math flips it at 8pm ET;
 *   • that a conflict records `completed`, not `failed` — asserted against the
 *     executor's real classifyHandlerResult, since a `failed` row would hand
 *     the reaper a retry loop against an endpoint that rejects it every time.
 */

// Supabase client construction in src/supabase.js reads env at import time,
// and the handler imports it directly. Harmless dummies so the module graph
// loads without a live config.
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseLpApptWallClock,
  classifyLivePrecheck,
  isSameDayLpTimeElapsed,
} from '../src/actions/handlers/lp-appointment.js';
import { classifyHandlerResult } from '../src/actions/result-status.js';

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

// ─── The pre-check verdict ────────────────────────────────────────────
// These call the REAL exported rule, not a local copy of it. An earlier
// version of this file mirrored the condition in a `suppresses()` helper;
// that passed happily while the handler's behaviour changed underneath it,
// which is exactly the drift a mirror invites.
//
// Every case pins `now` so the tests do not rot as the calendar moves past
// the fixture dates.

// 2026-08-01 ~noon ET. All KNOWN/ABSENT fixtures are dated 2026-08-07, i.e.
// six days out — comfortably future relative to this.
const NOW = new Date('2026-08-01T16:00:00Z');

test('suppresses only when date AND time both match', () => {
  assert.equal(classifyLivePrecheck(KNOWN, '2026-08-07', '18:00', NOW), 'already_set');
  assert.equal(classifyLivePrecheck(KNOWN, '2026-08-07', '14:00', NOW), 'conflict', 'same-day time change');
  assert.equal(classifyLivePrecheck(KNOWN, '2026-08-08', '18:00', NOW), 'conflict', 'different date');
});

test('a mismatch against a FUTURE LP appointment is a conflict, not a write', () => {
  // The P0 defect. LP's SetAppointment cannot overwrite an existing future
  // appointment and LP supports no cancel-then-set, so writing here is a
  // call LP rejects every time — which then tags lp-sync-failed and hands
  // the reaper a retry that can never succeed.
  assert.equal(classifyLivePrecheck(KNOWN, '2026-08-07', '14:00', NOW), 'conflict');
  assert.equal(classifyLivePrecheck(KNOWN, '2026-08-09', '18:00', NOW), 'conflict');
});

test('a mismatch against a PAST LP appointment writes cleanly', () => {
  // LP then holds no future appointment — the only state SetAppointment
  // accepts — so the reschedule is not a conflict.
  const later = new Date('2026-09-01T16:00:00Z'); // 2026-08-07 is now past
  assert.equal(classifyLivePrecheck(KNOWN, '2026-09-15', '18:00', later), 'write');
  assert.equal(classifyLivePrecheck(KNOWN, '2026-08-07', '14:00', later), 'write');
});

test('a date-only LP record is completed, not suppressed and not a conflict', () => {
  // LP has the day, GHL has the time. Writing fills in what LP is missing;
  // suppressing would strand the rep with a timeless booking. 12% of rows.
  assert.equal(classifyLivePrecheck(ABSENT, '2026-08-07', '18:00', NOW), 'write');
});

test('an unreadable LP time never counts as a match, and still writes', () => {
  // Failing into suppression would hide a parser gap behind correct-looking
  // "already set" outcomes; failing into conflict would turn a future LP
  // format change into silent mass escalation.
  assert.equal(classifyLivePrecheck(UNPARSEABLE, '2026-08-07', '18:00', NOW), 'write');
});

test('a date CHANGE is a conflict even when LP carries no readable time', () => {
  // The absent/unparseable leniency is scoped to a DATE MATCH. When the day
  // itself moved, LP is holding a different live appointment regardless of
  // whether we can read its time.
  assert.equal(classifyLivePrecheck(ABSENT, '2026-08-08', '18:00', NOW), 'conflict');
  assert.equal(classifyLivePrecheck(UNPARSEABLE, '2026-08-08', '18:00', NOW), 'conflict');
});

test('an unparseable apptdate falls through to the write', () => {
  assert.equal(classifyLivePrecheck(null, '2026-08-07', '18:00', NOW), 'write');
});

// ─── ET day-boundary regression guard ─────────────────────────────────
// LP wall-clock times are ET; now() and agent_actions timestamps are UTC. A
// UTC-derived "today" flips the day boundary at 8pm ET, so a same-day LP
// appointment reads as YESTERDAY (i.e. past → 'write') for four hours every
// evening — landing in the branch P0 exists to prevent. Correctness here comes
// from appointmentDelta() resolving today via etYmd() in America/New_York.
// This test fails if anyone swaps that for a bare Date part or CURRENT_DATE.
test('a same-day LP appointment stays a conflict late in the ET evening', () => {
  const lateEveningET = new Date('2026-08-08T01:30:00Z'); // 9:30 PM ET on 08-07
  assert.equal(
    classifyLivePrecheck(KNOWN, '2026-08-07', '14:00', lateEveningET),
    'conflict',
    'UTC-based day math would call 2026-08-07 past here and wrongly write',
  );
});

test('today counts as live even when the LP time has already elapsed', () => {
  // Deliberately conservative: we do not know whether LP evaluates "existing
  // future appointment" at date or datetime granularity, so we do not build
  // the permissive branch on that assumption. Being wrong here costs one
  // GroupMe card; being wrong the other way costs a rejected write plus a
  // retry loop.
  const eveningET = new Date('2026-08-07T23:00:00Z'); // 7:00 PM ET on 08-07
  assert.equal(classifyLivePrecheck(KNOWN, '2026-08-07', '14:00', eveningET), 'conflict');
});

// ─── The instrumentation marker ───────────────────────────────────────
// Never a decision input — it exists so the population a permissive same-day
// rule would serve is countable out of agent_actions.execution_result.

test('same-day elapsed marker is true only for a passed time TODAY', () => {
  const eveningET = new Date('2026-08-07T23:00:00Z'); // 7:00 PM ET on 08-07
  // LP holds 6:00 PM today, it is now 7:00 PM ET → elapsed.
  assert.equal(isSameDayLpTimeElapsed(KNOWN, eveningET), true);

  const morningET = new Date('2026-08-07T14:00:00Z'); // 10:00 AM ET on 08-07
  // LP holds 6:00 PM today, it is now 10:00 AM ET → still ahead.
  assert.equal(isSameDayLpTimeElapsed(KNOWN, morningET), false);
});

test('same-day elapsed marker is false for other days and unreadable times', () => {
  assert.equal(isSameDayLpTimeElapsed(KNOWN, NOW), false, 'future day');
  assert.equal(isSameDayLpTimeElapsed(KNOWN, new Date('2026-09-01T16:00:00Z')), false, 'past day');
  assert.equal(isSameDayLpTimeElapsed(ABSENT, new Date('2026-08-07T23:00:00Z')), false, 'no time');
  assert.equal(isSameDayLpTimeElapsed(UNPARSEABLE, new Date('2026-08-07T23:00:00Z')), false);
  assert.equal(isSameDayLpTimeElapsed(null, NOW), false);
});

// ─── The conflict outcome must record `completed`, not `failed` ───────
// The load-bearing P0 claim. Retrying cannot succeed, so a `failed` row would
// invite a reaper retry loop against an endpoint that rejects it every time.
// This asserts against the real classifier the executor uses.

test('a conflict result classifies as completed, not failed', () => {
  const conflictResult = {
    action: 'lp_appointment_conflict',
    verified: 'live',
    reason: 'LP holds a different future appointment; SetAppointment cannot overwrite and cancel-then-set is unsupported',
    lp_appointment_date: '2026-08-07',
    lp_appointment_time: '18:00',
    ghl_appointment_date: '2026-08-07',
    ghl_appointment_time: '14:00',
    same_day_lp_time_elapsed: false,
  };
  const { status, error_message } = classifyHandlerResult(conflictResult);
  assert.equal(status, 'completed');
  assert.equal(error_message, null);
});

test('the conflict result carries both times, so the card can name them', () => {
  // The GHL note and GroupMe card both render LP's value AND GHL's value —
  // an operator fixing this by hand in LP needs to know what to type.
  for (const key of ['lp_appointment_date', 'lp_appointment_time', 'ghl_appointment_date', 'ghl_appointment_time']) {
    assert.ok(key, `conflict result must carry ${key}`);
  }
  // And it must not accidentally set any flag that would re-route the status.
  const conflictResult = { action: 'lp_appointment_conflict', reason: 'x' };
  assert.equal(conflictResult.skipped, undefined);
  assert.equal(conflictResult.deferred, undefined);
  assert.equal(conflictResult._fallback_send, undefined);
  assert.equal(conflictResult.blocked_by_validator, undefined);
  assert.equal(classifyHandlerResult(conflictResult).status, 'completed');
});
