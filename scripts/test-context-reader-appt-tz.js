/**
 * Tests — hasActiveBooking appointment frame (context-reader.js)
 * scripts/test-context-reader-appt-tz.js
 *
 *   node --test scripts/test-context-reader-appt-tz.js
 *
 * hasActiveBooking() decides whether a contact is treated as holding a live
 * booking, which suppresses them from S4.5 selection. It read
 * lp.appointment_date with a bare new Date(), but that column holds ET
 * wall-clock digits wearing a +00:00 offset (see the banner in
 * src/lp-dates.js), so every appointment parsed 4-5 hours early and the gate
 * released a booked contact that much sooner than APPT_GRACE_DAYS intends.
 *
 * The grace window is measured in DAYS, so on most rows a four-hour error
 * changes nothing — which is exactly why it survived. It bites at the edge:
 * an evening appointment sitting almost exactly APPT_GRACE_DAYS old.
 *
 * Offline and pure — context-reader has no I/O.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { hasActiveBooking } from '../src/agentic/lead-state/signals/context-reader.js';

/** Minimal context envelope with a live LP booking at the given stored value. */
const ctxWithAppt = (stored) => ({
  lp: { appointment_set: true, demo_completed: false, appointment_date: stored },
});

/** Run a body with Date.now pinned. */
function at(nowIso, body) {
  const real = Date.now;
  Date.now = () => Date.parse(nowIso);
  try { return body(); } finally { Date.now = real; }
}

const GRACE_DAYS = Number(process.env.APPT_ACTIVE_GRACE_DAYS || 2);

test('a future appointment is an active booking', () => {
  at('2026-09-04T18:00:00Z', () => {
    // Stored 18:00 = 6:00 PM ET = 22:00Z, four hours ahead of now.
    assert.equal(hasActiveBooking(ctxWithAppt('2026-09-04T18:00:00+00:00')), true);
  });
});

test('the stored value is read as ET, not UTC, at the grace edge', () => {
  // Stored 20:00 = 8:00 PM ET = 2026-09-02T00:00:00Z on the 3rd.
  // Grace cutoff at this now() is exactly 2026-09-02T00:00:00Z.
  //
  // Read as UTC the appointment looks like 2026-09-01T20:00:00Z — four hours
  // BEFORE the cutoff — and the contact is released while still inside grace.
  // Read as ET it lands exactly on the cutoff and is still held.
  const now = '2026-09-04T00:00:00Z';
  const stored = '2026-09-01T20:00:00+00:00';
  at(now, () => {
    assert.equal(GRACE_DAYS, 2, 'this fixture assumes the default 2-day grace');
    assert.equal(hasActiveBooking(ctxWithAppt(stored)), true,
      'an 8 PM ET appointment exactly at the grace cutoff is still an active booking');
  });
});

test('an appointment well past grace is not an active booking', () => {
  at('2026-09-10T18:00:00Z', () => {
    assert.equal(hasActiveBooking(ctxWithAppt('2026-09-01T20:00:00+00:00')), false,
      'the fix must not hold contacts forever — that would starve S4.5');
  });
});

test('EST resolves at five hours, not a hardcoded four', () => {
  // Stored 21:00 on 2026-01-01 = 9 PM EST = 2026-01-02T02:00:00Z.
  // Grace cutoff at this now() is exactly 2026-01-02T02:00:00Z.
  at('2026-01-04T02:00:00Z', () => {
    assert.equal(hasActiveBooking(ctxWithAppt('2026-01-01T21:00:00+00:00')), true);
  });
});

test('a missing or unparseable date falls through instead of throwing', () => {
  at('2026-09-04T18:00:00Z', () => {
    // No date, and no gate tags either → not an active booking, no throw.
    assert.equal(hasActiveBooking({ lp: { appointment_set: true, demo_completed: false } }), false);
    assert.equal(hasActiveBooking(ctxWithAppt('')), false);
    assert.equal(hasActiveBooking(ctxWithAppt('not-a-date')), false);
    assert.equal(hasActiveBooking(ctxWithAppt(null)), false);
  });
});

test('a completed demo is never an active booking, whatever the date says', () => {
  at('2026-09-04T18:00:00Z', () => {
    assert.equal(hasActiveBooking({
      lp: { appointment_set: true, demo_completed: true, appointment_date: '2026-09-04T18:00:00+00:00' },
    }), false, 'post-demo states belong to ACTIVE_BOFU, not the booking gate');
  });
});
