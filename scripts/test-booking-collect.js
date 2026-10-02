/**
 * 2026-10-02 (Mark): "It should book the time right now", ask first, then
 * book, unconfirmed, on the right calendar. The pure helpers behind it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { heldSlot, holdLine, missingItems, parseDecisionMakers, COLLECT_ASK } from '../src/agentic/booking-collect.js';
import { inHomeCalendarFor, BOOKING_CALENDARS } from '../src/knowledge/booking-calendar-router.js';
import { prefersCall, SCHEDULE_ASK_RX } from '../src/agentic/nepq-planner.js';

const OUT = (text) => ({ direction: 'outbound', text });
const IN = (text) => ({ direction: 'inbound', text });
const SLOT = { day: 'Sat, Oct 3', time: '10:00 AM' };

test('the held time and the last thing we asked are read back from the thread', () => {
  const thread = [OUT('I have Sat, Oct 3 at 10:00 AM or Mon, Oct 5 at 6:00 PM. Which works better?'), IN('saturday'), OUT(holdLine(SLOT, 'ET', COLLECT_ASK.address)), IN('12 Main St 33607')];
  assert.deepEqual(heldSlot(thread), { text: 'Sat, Oct 3 at 10:00 AM ET', asked: 'address' });
  const next = [...thread, OUT(`Got it. ${COLLECT_ASK.dm}`)];
  assert.equal(heldSlot(next).asked, 'dm');
});

test('nothing is held once booked or after a new offer', () => {
  const held = OUT(holdLine(SLOT, 'ET', COLLECT_ASK.address));
  assert.equal(heldSlot([held, OUT('Got it. I have you down for Sat, Oct 3 at 10:00 AM ET. A team member will reach out to confirm the details.')]), null);
  assert.equal(heldSlot([held, OUT('I have Tue, Oct 6 at 2:00 PM or Wed, Oct 7 at 6:00 PM. Which works better?')]), null);
  assert.equal(heldSlot([]), null);
});

test('missing items come in order, phone only on chat', () => {
  assert.deepEqual(missingItems({}), ['name', 'phone', 'address', 'dm']);
  assert.deepEqual(missingItems({ channel: 'sms' }), ['name', 'address', 'dm']);
  assert.deepEqual(missingItems({ hasName: true, hasPhone: true, hasAddress: true, dmKnown: true }), []);
});

test('decision-maker answers', () => {
  assert.equal(parseDecisionMakers('no, just me'), 'Solo Owner');
  assert.equal(parseDecisionMakers('Nope'), 'Solo Owner');
  assert.equal(parseDecisionMakers('yes my wife will be there'), 'Yes');
  assert.equal(parseDecisionMakers("my husband works saturdays"), 'conflict');
  assert.equal(parseDecisionMakers('hmm'), null);
});

test('calendar rule: calculator leads → Measurement Verification, everyone else → Window Estimate', () => {
  assert.equal(inHomeCalendarFor(['active-entry:estimate-calculator']).calendar_id, BOOKING_CALENDARS.MEASUREMENT_VERIFICATION);
  assert.equal(inHomeCalendarFor(['Active-Entry:Calculator']).calendar_id, BOOKING_CALENDARS.MEASUREMENT_VERIFICATION);
  assert.equal(inHomeCalendarFor(['source:facebook']).calendar_id, BOOKING_CALENDARS.WINDOW_ESTIMATE);
  assert.equal(inHomeCalendarFor().calendar_id, BOOKING_CALENDARS.WINDOW_ESTIMATE);
  assert.equal(BOOKING_CALENDARS.WINDOW_ESTIMATE, 'aJj14ONxh1oFyDcQ706O');
  assert.equal(BOOKING_CALENDARS.MEASUREMENT_VERIFICATION, 'zEdPmkNccR2ovo3rQAd3');
});

test('a call is the backup: only when the lead asks for one or turns the visit down', () => {
  assert.equal(prefersCall([IN('my windows leak')], 'sounds good'), false);
  assert.equal(prefersCall([], 'can someone just call me instead?'), true);
});

test('"you\'re not able to set up a time now?" is a schedule ask', () => {
  assert.ok(SCHEDULE_ASK_RX.test("My name is Mark, and you're not able to set up a time now?"));
  assert.ok(SCHEDULE_ASK_RX.test('can you book me'));
});
