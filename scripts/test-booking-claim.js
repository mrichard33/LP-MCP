/**
 * Booking-claim guard — scripts/test-booking-claim.js
 *
 * 2026-10-02 simulation (Mark Test): "You're all set for a measurement visit"
 * with nothing booked. src/agentic/booking-claim.js.
 *
 * Run: node --test scripts/test-booking-claim.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { findUnbackedBookingClaim, rewriteBookingClaims, bookingClaimNote, BOOKING_CLAIM_REPLACEMENT } = await import('../src/agentic/booking-claim.js');

const MARK_TEST = "Perfect. You're all set for a measurement visit at 16828 Crown Bridge Drive. Our team will call you before then to go over the details and finalize the time.";

test('the Mark Test reply is caught and rewritten', () => {
  assert.match(findUnbackedBookingClaim(MARK_TEST), /all set for a measurement visit/);
  const r = rewriteBookingClaims(MARK_TEST);
  assert.equal(r.changed, true);
  assert.equal(r.text, 'Perfect. Our team will call you before then to go over the details and finalize the time.');
});

test('the replacement is added when nothing else says someone will call', () => {
  assert.equal(rewriteBookingClaims("Great. Your visit is booked.").text, `Great. ${BOOKING_CLAIM_REPLACEMENT}`);
  assert.equal(rewriteBookingClaims("I've booked you in.").text, BOOKING_CLAIM_REPLACEMENT);
});

test('a real booking, a question, and the appointment on file are left alone', () => {
  assert.equal(findUnbackedBookingClaim("You're set for Tue, Oct 6 at 10:00 AM ET, Dana.", { booked: true }), null);
  assert.equal(findUnbackedBookingClaim('Want me to get you on the schedule?'), null);
  assert.equal(findUnbackedBookingClaim("You're all set for Saturday at 6 PM.", { hasAppointment: true }), null);
  assert.ok(findUnbackedBookingClaim("You're all set for a visit.", { hasAppointment: true }), 'no day named: not about the one on file');
  assert.equal(findUnbackedBookingClaim('Our team will call to set up a time that works.'), null);
});

test('the redraft note says what to do instead', () => {
  assert.match(bookingClaimNote("You're all set."), /nothing was booked/);
});
