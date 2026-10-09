/**
 * Booking truth — scripts/test-booking-truth.js
 *
 * 2026-10-07 (Nicholas Ferraioli, GHL I5x7zltORikAxdEJ6nyD): three texts
 * confirmed a time nobody booked. src/agentic/booking-claim.js
 * checkBookingTruth is the last check before every AI-written send.
 *
 * Run: node --test scripts/test-booking-truth.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  checkBookingTruth, bookingResult, appointmentOnFile, claimMatchesAppointment,
  isClaimSentence, noPromiseHandoffLine, NO_PROMISE_HANDOFF_RX, findUnbackedBookingClaim,
} = await import('../src/agentic/booking-claim.js');

// Wed 2026-10-07 16:44 ET, when the first bad text went out.
const NOW = Date.parse('2026-10-07T20:44:00Z');

const NICHOLAS_TEXTS = [
  'Thursday, October 8 at 10:00 AM ET works.',
  'Thursday at 10 AM is holding for you.',
  "You're all set, Nicholas.",
];

test('all three Nicholas texts are blocked with no booking and nothing on file', () => {
  for (const t of NICHOLAS_TEXTS) {
    const v = checkBookingTruth(t, { result: null, existing: null, nowMs: NOW });
    assert.equal(v.allowed, false, t);
    assert.equal(v.reason, 'no_booking');
  }
});

test('confirm language + no appointment id → blocked; + a real appointment id → allowed', () => {
  const noId = bookingResult({ booked: true, appointment_id: null });
  assert.equal(checkBookingTruth("You're all set for Thursday at 10 AM.", { result: noId, nowMs: NOW }).reason, 'no_appointment_id');
  const real = bookingResult({ booked: true, appointment_id: 'a5Ayy', start_time: '2026-10-08T10:00:00-04:00', source: 'appointment_booked' });
  const v = checkBookingTruth("You're all set for Thursday at 10 AM.", { result: real, nowMs: NOW });
  assert.equal(v.allowed, true);
  assert.equal(v.reason, 'booked');
});

test('an appointment still on the calendar backs a claim only at its own day and time', () => {
  const existing = { appointment_id: 'g1', start_time: '2026-10-09T14:00:00-04:00', source: 'ghl', wall_clock: false };
  assert.equal(checkBookingTruth("You're all set for Friday at 2 PM.", { existing, nowMs: NOW }).allowed, true);
  assert.equal(checkBookingTruth("You're all set.", { existing, nowMs: NOW }).allowed, true, 'a claim naming no time is about the one on file');
  const off = checkBookingTruth('Thursday at 10 AM works.', { existing, nowMs: NOW });
  assert.equal(off.allowed, false);
  assert.equal(off.reason, 'existing_time_mismatch');
});

test('a question, an offer and a call promise are not claims', () => {
  for (const t of [
    'Does Thursday at 10 AM work for you?',
    'Let me know if Thursday works.',
    'I have Thu, Oct 8 at 10:00 AM or Fri, Oct 9 at 2:00 PM. Which works better?',
    'I have Tue at 10 AM or Wed at 2 PM, whichever works.',
    'Our team will call to set up a time that works.',
    noPromiseHandoffLine('Nicholas'),
  ]) {
    assert.equal(checkBookingTruth(t, { nowMs: NOW }).allowed, true, t);
  }
});

test('the wordings the old patterns missed are claims now', () => {
  for (const t of [
    "You're on the calendar for Tue, Oct 13 at 2:00 PM ET.",
    "You're now set for Tuesday at 2 PM.",
    'I have you down for Tuesday at 2 PM.',
    'We put you down for Monday.',
    'Booked you for Monday at 10 AM.',
    'See you Tuesday at 2!',
    'Thursday at 10 AM is holding for you.',
  ]) {
    assert.equal(isClaimSentence(t), true, t);
  }
});

test('a hold that code made this turn stands (the collect flow), a model hold does not', () => {
  const t = "Great, I'm holding Thu, Oct 8 at 10:00 AM for you. What's the street address with zip?";
  assert.equal(checkBookingTruth(t, { held: true, nowMs: NOW }).allowed, true);
  assert.equal(checkBookingTruth(t, { held: false, nowMs: NOW }).allowed, false);
});

test('appointmentOnFile: a cancelled LP visit is not on file, whatever booking:active says', () => {
  // Nicholas: LP CXL, the GHL appointment cancelled; context.lp after the 2026-10-07 fix.
  const lp = { appointment_set: false, appointment_cancelled: true, disposition: 'CXL', appointment_date: null, lead_id: '581863' };
  assert.equal(appointmentOnFile({ upcomingAppointments: [], lp, nowMs: NOW }), null);
  // Even a stale row that still says set is refused on a CXL/CCC disposition.
  assert.equal(appointmentOnFile({ upcomingAppointments: [], lp: { appointment_set: true, disposition: 'CCC', appointment_date: '2026-10-09T15:00:00+00:00' }, nowMs: NOW }), null);
  // A GHL appointment marked cancelled, or one that already ended, is not on file.
  assert.equal(appointmentOnFile({ upcomingAppointments: [{ appointment_id: 'x', status: 'cancelled', start_time: '2026-10-09T15:00:00-04:00' }], nowMs: NOW }), null);
  assert.equal(appointmentOnFile({ upcomingAppointments: [{ appointment_id: 'x', status: 'confirmed', start_time: '2026-10-07T15:00:00-04:00', already_ended: true }], nowMs: NOW }), null);
  // A live future one is.
  const live = appointmentOnFile({ upcomingAppointments: [{ appointment_id: 'g9', status: 'confirmed', start_time: '2026-10-09T15:00:00-04:00' }], nowMs: NOW });
  assert.equal(live.appointment_id, 'g9');
});

test('LP appointment times are Eastern wall clock (the +00:00 is fake)', () => {
  const lpAppt = { appointment_id: 'lp:1', start_time: '2026-10-09T15:00:00+00:00', wall_clock: true };
  assert.equal(claimMatchesAppointment("You're all set for Friday at 3 PM.", lpAppt, { nowMs: NOW }), true);
  assert.equal(claimMatchesAppointment("You're all set for Friday at 11 AM.", lpAppt, { nowMs: NOW }), false);
});

test('the mid-pipeline guard reads the new wordings too', () => {
  assert.ok(findUnbackedBookingClaim('Thursday, October 8 at 10:00 AM ET works.'));
  assert.ok(findUnbackedBookingClaim('Thursday at 10 AM is holding for you.'));
});

test('the no-promise hand-off names no day or time, and only says "shortly" while the team is in', () => {
  const open = noPromiseHandoffLine('Nicholas', { teamOpen: true });
  assert.equal(open, 'Thanks, Nicholas. A team member will call you shortly to confirm a time that works.');
  assert.match(noPromiseHandoffLine('Nicholas', { teamOpen: false }), /as soon as we open/);
  assert.match(noPromiseHandoffLine(null), /^Thanks\. A team member/);
  assert.match(open, NO_PROMISE_HANDOFF_RX);
  assert.doesNotMatch(open, /\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\b|\b\d{1,2}\s*(?:am|pm)\b|tomorrow|today/i);
});
