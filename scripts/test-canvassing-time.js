/**
 * test-canvassing-time.js — Canvassing Pilot v2 appointment time handling.
 *
 * The slot contract: appt_date + appt_slot are ET wall-clock by
 * definition (no timezone parsing of the input). DST-aware instants are
 * built ONLY for the past / 48h-window / Friday→Monday checks, and the
 * "48h" policy is enforced as ET calendar days ≤ 2 (the spec's own
 * acceptance table passes Tue 10 AM → Thu 2 PM, which is 52 literal
 * hours).
 *
 * 2026 calendar facts used below: Jul 14 = Tue, Jul 16 = Thu, Jul 17 =
 * Fri, Jul 18 = Sat, Jul 20 = Mon; Oct 30 = Fri; Nov 1 = Sun (DST ends —
 * EDT→EST); Nov 2 = Mon.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeApptSlot,
  normalizeApptDate,
  convertCanvassAppointment,
  fridayExceptionDeadline,
  APPT_SLOTS,
} from '../src/canvassing-time.js';

// ─── Slot whitelist ─────────────────────────────────────────────

test('slot whitelist: canonical values pass through', () => {
  for (const slot of APPT_SLOTS) {
    assert.equal(normalizeApptSlot(slot), slot);
  }
});

test('slot whitelist: case-insensitive, trimmed, space-tolerant', () => {
  assert.equal(normalizeApptSlot(' 2:00 pm '), '2:00 PM');
  assert.equal(normalizeApptSlot('6:00PM'), '6:00 PM');
  assert.equal(normalizeApptSlot('10:00  am'), '10:00 AM');
  assert.equal(normalizeApptSlot('6:30 Pm'), '6:30 PM');
});

test('slot whitelist: misses are rejected', () => {
  assert.equal(normalizeApptSlot('7:00 AM'), null);
  assert.equal(normalizeApptSlot('11:00 AM'), null);
  assert.equal(normalizeApptSlot('2:30 PM'), null);
  assert.equal(normalizeApptSlot(''), null);
  assert.equal(normalizeApptSlot(null), null);
  assert.equal(normalizeApptSlot(undefined), null);
  assert.equal(normalizeApptSlot('tomorrow'), null);
});

// ─── Date normalization (three GHL merge-field formats) ─────────

test('date normalization: YYYY-MM-DD, MM/DD/YYYY, MM-DD-YYYY', () => {
  assert.equal(normalizeApptDate('2026-07-20'), '07/20/2026');
  assert.equal(normalizeApptDate('07/20/2026'), '07/20/2026');
  assert.equal(normalizeApptDate('7/20/2026'), '07/20/2026');
  assert.equal(normalizeApptDate('07-20-2026'), '07/20/2026');
  assert.equal(normalizeApptDate('7-20-2026'), '07/20/2026');
  assert.equal(normalizeApptDate(' 2026-07-20 '), '07/20/2026');
});

test('date normalization: garbage and impossible dates rejected', () => {
  assert.equal(normalizeApptDate('02/30/2026'), null);
  assert.equal(normalizeApptDate('13/01/2026'), null);
  assert.equal(normalizeApptDate('July 20, 2026'), null);
  assert.equal(normalizeApptDate('2026/07/20'), null);
  assert.equal(normalizeApptDate(''), null);
  assert.equal(normalizeApptDate(null), null);
  assert.equal(normalizeApptDate('{{form.appointment_date}}'), null); // unresolved merge tag
});

// ─── DST-correct instant construction ───────────────────────────

test('ET slot instants are DST-correct (EDT July vs EST November)', () => {
  // July: 10:00 AM EDT = 14:00 UTC
  const jul = convertCanvassAppointment(
    { appt_date: '2026-07-20', appt_slot: '10:00 AM' },
    new Date('2026-07-19T14:00:00Z') // Sun Jul 19, 10:00 ET
  );
  assert.equal(jul.status, 'ok');
  assert.equal(jul.adate, '07/20/2026');
  assert.equal(jul.atime, '10:00 AM');
  assert.equal(jul.apptInstant.toISOString(), '2026-07-20T14:00:00.000Z');

  // November (after fall-back): 10:00 AM EST = 15:00 UTC
  const nov = convertCanvassAppointment(
    { appt_date: '2026-11-02', appt_slot: '10:00 AM' },
    new Date('2026-11-01T14:00:00Z') // Sun Nov 1 (DST-end day), 9:00 ET
  );
  assert.equal(nov.status, 'ok');
  assert.equal(nov.adate, '11/02/2026');
  assert.equal(nov.apptInstant.toISOString(), '2026-11-02T15:00:00.000Z');
});

// ─── Guard statuses ─────────────────────────────────────────────

test('past appointment → status past, no adate/atime', () => {
  const r = convertCanvassAppointment(
    { appt_date: '2026-07-13', appt_slot: '2:00 PM' },
    new Date('2026-07-14T14:00:00Z') // Tue Jul 14, 10:00 ET
  );
  assert.equal(r.status, 'past');
  assert.equal(r.adate, null);
  assert.equal(r.atime, null);
});

test('unparseable slot or date → status unparseable, no adate/atime', () => {
  const badSlot = convertCanvassAppointment(
    { appt_date: '2026-07-16', appt_slot: '3:00 PM' },
    new Date('2026-07-14T14:00:00Z')
  );
  assert.equal(badSlot.status, 'unparseable');
  assert.equal(badSlot.adate, null);

  const badDate = convertCanvassAppointment(
    { appt_date: 'not a date', appt_slot: '2:00 PM' },
    new Date('2026-07-14T14:00:00Z')
  );
  assert.equal(badDate.status, 'unparseable');
  assert.equal(badDate.atime, null);

  const missing = convertCanvassAppointment({}, new Date('2026-07-14T14:00:00Z'));
  assert.equal(missing.status, 'unparseable');
});

// ─── Window guard (spec acceptance table) ───────────────────────

const TUE_10AM_ET = new Date('2026-07-14T14:00:00Z'); // Tue Jul 14, 10:00 EDT
const FRI_3PM_ET = new Date('2026-07-17T19:00:00Z');  // Fri Jul 17, 15:00 EDT

test('window: Tuesday 10 AM submit for Thursday 2 PM → pass', () => {
  const r = convertCanvassAppointment({ appt_date: '2026-07-16', appt_slot: '2:00 PM' }, TUE_10AM_ET);
  assert.equal(r.status, 'ok');
  assert.equal(r.adate, '07/16/2026');
});

test('window: Tuesday submit for Saturday → beyond_window (notify+flag, adate retained)', () => {
  const r = convertCanvassAppointment({ appt_date: '2026-07-18', appt_slot: '10:00 AM' }, TUE_10AM_ET);
  assert.equal(r.status, 'beyond_window');
  // Notify-not-block: the values are still returned so the lead posts as Set.
  assert.equal(r.adate, '07/18/2026');
  assert.equal(r.atime, '10:00 AM');
});

test('window: Friday 3 PM submit for Monday 10 AM → pass (Friday exception)', () => {
  const r = convertCanvassAppointment({ appt_date: '2026-07-20', appt_slot: '10:00 AM' }, FRI_3PM_ET);
  assert.equal(r.status, 'ok');
});

test('window: Friday 3 PM submit for Monday 7 PM → still within the Monday 8 PM ET deadline', () => {
  const r = convertCanvassAppointment({ appt_date: '2026-07-20', appt_slot: '7:00 PM' }, FRI_3PM_ET);
  assert.equal(r.status, 'ok');
});

test('window: Friday submit for TUESDAY → beyond_window (exception covers Monday only)', () => {
  const r = convertCanvassAppointment({ appt_date: '2026-07-21', appt_slot: '10:00 AM' }, FRI_3PM_ET);
  assert.equal(r.status, 'beyond_window');
});

test('window: DST fall-back crossing — Fri Oct 30 set → Sun Nov 1 → pass', () => {
  // Fri Oct 30 2026 15:00 EDT (19:00Z) → Sun Nov 1 10:00 AM EST. The
  // fall-back happens Nov 1 02:00 ET; day-delta is 2 and the instant math
  // must not drift an hour.
  const r = convertCanvassAppointment(
    { appt_date: '2026-11-01', appt_slot: '10:00 AM' },
    new Date('2026-10-30T19:00:00Z')
  );
  assert.equal(r.status, 'ok');
  assert.equal(r.apptInstant.toISOString(), '2026-11-01T15:00:00.000Z'); // EST offset
});

// ─── Friday exception deadline ──────────────────────────────────

test('fridayExceptionDeadline: Monday 8 PM ET, only on Fridays', () => {
  const deadline = fridayExceptionDeadline(FRI_3PM_ET);
  // Mon Jul 20 20:00 EDT = Tue Jul 21 00:00 UTC
  assert.equal(deadline.toISOString(), '2026-07-21T00:00:00.000Z');
  assert.equal(fridayExceptionDeadline(TUE_10AM_ET), null);
});
