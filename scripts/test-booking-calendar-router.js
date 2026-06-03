/**
 * scripts/test-booking-calendar-router.js
 *
 * Unit tests for the booking-calendar router (BUILD HANDOFF §0/§1): funnel
 * position → calendar, the in-home gate flag, per-calendar duration, and the
 * id-based in-home check used by server-side booking guards.
 *
 * Run: node --test scripts/test-booking-calendar-router.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveBookingCalendar,
  requiresInHomeGate,
  durationForCalendar,
  calendarNameForKey,
  isInHomeCalendarId,
  BOOKING_CALENDARS,
} from '../src/knowledge/booking-calendar-router.js';

// resolveBookingCalendar awaits hasPriorCompletedAppointment, which returns
// false when GHL_API_KEY is unset (no network) — so rule 1 (HPA) routes to PPR
// here. That path is exercised separately by mocking would require a fetch stub;
// the tag-only routing below is deterministic without network.

test('risk-report entry (call not completed) → PPR phone calendar', async () => {
  const r = await resolveBookingCalendar({ id: 'c1', tags: ['active-entry:risk-report'] });
  assert.equal(r.calendar_key, 'PROTECTION_PROFILE_REVIEW');
  assert.equal(r.calendar_id, BOOKING_CALENDARS.PROTECTION_PROFILE_REVIEW);
  assert.equal(r.reason, 'risk_report_entry');
  assert.equal(requiresInHomeGate(r.calendar_key), false, 'PPR is phone — not gated');
});

test('estimate-calculator entry → Measurement Verification (in-home, gated)', async () => {
  const r = await resolveBookingCalendar({ id: 'c2', tags: ['active-entry:estimate-calculator'] });
  assert.equal(r.calendar_key, 'MEASUREMENT_VERIFICATION');
  assert.equal(r.calendar_id, BOOKING_CALENDARS.MEASUREMENT_VERIFICATION);
  assert.equal(requiresInHomeGate(r.calendar_key), true);
});

test('default booking → Window Estimate (in-home, gated)', async () => {
  const r = await resolveBookingCalendar({ id: 'c3', tags: [] });
  assert.equal(r.calendar_key, 'WINDOW_ESTIMATE');
  assert.equal(r.reason, 'default_window_estimate');
  assert.equal(requiresInHomeGate(r.calendar_key), true);
});

test('first-match-wins: risk-report beats estimate-calculator', async () => {
  const r = await resolveBookingCalendar({
    id: 'c4',
    tags: ['active-entry:estimate-calculator', 'active-entry:risk-report'],
  });
  assert.equal(r.calendar_key, 'PROTECTION_PROFILE_REVIEW');
});

test('isGenericCallRequest=true → Confirmation Call (checked before default)', async () => {
  const r = await resolveBookingCalendar({ id: 'c5', tags: [] }, { isGenericCallRequest: true });
  assert.equal(r.calendar_key, 'CONFIRMATION_CALL');
  assert.equal(requiresInHomeGate(r.calendar_key), false);
});

test('HPA is gated (in-home), phone calendars are not', () => {
  assert.equal(requiresInHomeGate('HOME_PROTECTION_ASSESSMENT'), true);
  assert.equal(requiresInHomeGate('WINDOW_ESTIMATE'), true);
  assert.equal(requiresInHomeGate('MEASUREMENT_VERIFICATION'), true);
  assert.equal(requiresInHomeGate('PROTECTION_PROFILE_REVIEW'), false);
  assert.equal(requiresInHomeGate('CONFIRMATION_CALL'), false);
});

test('durations: phone calendars are short, in-home are 90', () => {
  assert.equal(durationForCalendar('CONFIRMATION_CALL'), 15);
  assert.equal(durationForCalendar('PROTECTION_PROFILE_REVIEW'), 30);
  assert.equal(durationForCalendar('WINDOW_ESTIMATE'), 90);
  assert.equal(durationForCalendar('MEASUREMENT_VERIFICATION'), 90);
  assert.equal(durationForCalendar('HOME_PROTECTION_ASSESSMENT'), 90);
});

test('calendarNameForKey returns canonical names', () => {
  assert.equal(calendarNameForKey('PROTECTION_PROFILE_REVIEW'), 'Protection Profile Review');
  assert.equal(calendarNameForKey('WINDOW_ESTIMATE'), 'Window Estimate');
});

test('isInHomeCalendarId matches in-home ids only', () => {
  assert.equal(isInHomeCalendarId(BOOKING_CALENDARS.WINDOW_ESTIMATE), true);
  assert.equal(isInHomeCalendarId(BOOKING_CALENDARS.MEASUREMENT_VERIFICATION), true);
  assert.equal(isInHomeCalendarId(BOOKING_CALENDARS.HOME_PROTECTION_ASSESSMENT), true);
  assert.equal(isInHomeCalendarId(BOOKING_CALENDARS.PROTECTION_PROFILE_REVIEW), false);
  assert.equal(isInHomeCalendarId(BOOKING_CALENDARS.CONFIRMATION_CALL), false);
  assert.equal(isInHomeCalendarId('unknown-id'), false);
});
