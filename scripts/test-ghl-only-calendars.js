/**
 * scripts/test-ghl-only-calendars.js
 *
 * Unit tests for the GHL-only calendar exemption set (call-dispatch-integrity
 * 2026-07-07): the Confirmation Call calendar must be flagged GHL-only, all
 * in-home calendars must not be, and the pre-existing in-home set must be
 * unchanged by the addition.
 *
 * Run: node --test scripts/test-ghl-only-calendars.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BOOKING_CALENDARS,
  GHL_ONLY_CALENDAR_KEYS,
  isGhlOnlyCalendarId,
  isInHomeCalendarId,
  requiresInHomeGate,
} from '../src/knowledge/booking-calendar-router.js';

test('Confirmation Call calendar id is GHL-only', () => {
  assert.equal(isGhlOnlyCalendarId('gFWoSQrlKIdfRbAPV842'), true);
  assert.equal(isGhlOnlyCalendarId(BOOKING_CALENDARS.CONFIRMATION_CALL), true);
});

test('GHL_ONLY_CALENDAR_KEYS contains exactly CONFIRMATION_CALL (initial scope)', () => {
  assert.deepEqual([...GHL_ONLY_CALENDAR_KEYS].sort(), ['CONFIRMATION_CALL']);
});

test('no in-home calendar is GHL-only', () => {
  for (const key of ['HOME_PROTECTION_ASSESSMENT', 'WINDOW_ESTIMATE', 'MEASUREMENT_VERIFICATION']) {
    assert.equal(isGhlOnlyCalendarId(BOOKING_CALENDARS[key]), false, `${key} must not be GHL-only`);
    assert.equal(isInHomeCalendarId(BOOKING_CALENDARS[key]), true, `${key} must remain in-home`);
  }
});

test('PPR phone calendar is neither in-home nor GHL-only', () => {
  const ppr = BOOKING_CALENDARS.PROTECTION_PROFILE_REVIEW;
  assert.equal(isGhlOnlyCalendarId(ppr), false, 'PPR still syncs to LP');
  assert.equal(isInHomeCalendarId(ppr), false);
});

test('in-home gate behavior unchanged', () => {
  assert.equal(requiresInHomeGate('CONFIRMATION_CALL'), false);
  assert.equal(requiresInHomeGate('WINDOW_ESTIMATE'), true);
});

test('unknown / empty ids are not GHL-only', () => {
  assert.equal(isGhlOnlyCalendarId('nope'), false);
  assert.equal(isGhlOnlyCalendarId(''), false);
  assert.equal(isGhlOnlyCalendarId(null), false);
  assert.equal(isGhlOnlyCalendarId(undefined), false);
});
