/**
 * Who a call booking is assigned to — scripts/test-confirmation-call-assignee.js
 *
 * The user, 2026-10-09 (after #1223 sent every Confirmation Call to the Rehash
 * rep): pre-demo leads use Confirmation Call too, so rehash calls get their own
 * "Rehash Call" calendar (REHASH_CALENDAR_ID) and pre-demo Confirmation Calls
 * name nobody, as before. Rehash Call: named → rehash-team owner → Rehash rep.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { callAssigneeFor, confirmationCallAssignee, REHASH_REP_USER_ID_DEFAULT } = await import('../src/config/rehash-assignee.js');
const { isGhlOnlyCalendarId, isRehashCalendarId, rehashCalendarId, BOOKING_CALENDARS } = await import('../src/knowledge/booking-calendar-router.js');

const JOHN = 'TYcZ9DcNkuPCFYsFxRFV';
const team = new Set([JOHN, 'rep2']);

test('the Rehash rep default is John Manieri; env overrides; off turns it off', () => {
  assert.equal(REHASH_REP_USER_ID_DEFAULT, JOHN);
  assert.equal(confirmationCallAssignee({}), JOHN);
  assert.equal(confirmationCallAssignee({ CONFIRMATION_CALL_ASSIGNED_USER_ID: 'OFF' }), null);
});

test('a pre-demo Confirmation Call names nobody — never the Rehash rep, never the owner', () => {
  assert.equal(callAssigneeFor({ isRehashCalendar: false }, {}), null);
  assert.equal(callAssigneeFor({ isRehashCalendar: false, contactOwner: 'owner1', team }, {}), null);
  assert.equal(callAssigneeFor({ isRehashCalendar: false, explicit: 'exp1' }, {}), 'exp1', 'a named assignee still wins');
});

test('a Rehash Call: named → a rehash-team owner → the Rehash rep', () => {
  assert.equal(callAssigneeFor({ isRehashCalendar: true, explicit: 'exp1', contactOwner: 'rep2', team }, {}), 'exp1');
  assert.equal(callAssigneeFor({ isRehashCalendar: true, contactOwner: 'rep2', team }, {}), 'rep2');
  assert.equal(callAssigneeFor({ isRehashCalendar: true, contactOwner: 'salesRep', team }, {}), JOHN, 'an owner off the rehash team does not take a rehash call');
  assert.equal(callAssigneeFor({ isRehashCalendar: true, explicit: '  ' }, {}), JOHN, 'blank values do not count');
});

test('Rehash Call is GHL-only (never LP) once REHASH_CALENDAR_ID is set; unset = no rehash calendar', () => {
  assert.equal(rehashCalendarId({}), null);
  assert.equal(isRehashCalendarId('abc', {}), false);
  assert.equal(isRehashCalendarId('abc', { REHASH_CALENDAR_ID: ' abc ' }), true);
  assert.equal(isGhlOnlyCalendarId(BOOKING_CALENDARS.CONFIRMATION_CALL), true);
  const prev = process.env.REHASH_CALENDAR_ID;
  process.env.REHASH_CALENDAR_ID = 'rehashCal1';
  try {
    assert.equal(isGhlOnlyCalendarId('rehashCal1'), true);
    assert.equal(isGhlOnlyCalendarId(BOOKING_CALENDARS.WINDOW_ESTIMATE), false);
  } finally {
    if (prev === undefined) delete process.env.REHASH_CALENDAR_ID; else process.env.REHASH_CALENDAR_ID = prev;
  }
});
