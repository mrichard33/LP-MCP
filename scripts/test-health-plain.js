/**
 * Tests for src/health/plain.js — the words a person reads on a health result
 * (2026-10-15: Eastern time on a 12-hour clock, durations a person would say,
 * severity as a word).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clock12, clockList, etClock, etWhen, dayWords, duration, count, money,
  plainTimes, windowWords, severityWord, TWENTY_FOUR_HOUR_TIME,
} from '../src/health/plain.js';

test('clock12 is a 12-hour clock', () => {
  assert.equal(clock12('20:45'), '8:45 PM');
  assert.equal(clock12('08:00'), '8:00 AM');
  assert.equal(clock12('12:00'), '12:00 PM');
  assert.equal(clock12('00:30'), '12:30 AM');
  assert.equal(clock12('7:05'), '7:05 AM');
  assert.equal(clockList(['19:30', '20:15']), '7:30 PM and 8:15 PM');
  assert.equal(clockList(['07:00', '09:00', '13:00']), '7:00 AM, 9:00 AM and 1:00 PM');
});

test('instants read in Eastern time', () => {
  // 2026-10-16 00:45 UTC is 8:45 PM EDT on Thu Oct 15.
  const ms = Date.parse('2026-10-16T00:45:00Z');
  assert.equal(etClock(ms), '8:45 PM');
  assert.equal(etWhen(ms), 'Thu, Oct 15, 8:45 PM ET');
  assert.equal(dayWords('2026-10-16'), 'Fri, Oct 16');
});

test('durations read the way people say them', () => {
  assert.equal(duration(0), 'under a minute');
  assert.equal(duration(1), '1 minute');
  assert.equal(duration(45), '45 minutes');
  assert.equal(duration(60), '1 hour');
  assert.equal(duration(75), '1 hour 15 minutes');
  assert.equal(duration(150), '2 hours 30 minutes');
  assert.equal(duration(361), 'about 6 hours');
  assert.equal(duration(1125), 'about 19 hours');
  assert.equal(duration(2344 * 60), '98 days');
  assert.equal(duration(1440), 'about 24 hours');
  assert.equal(duration(2880), '2 days');
});

test('counts, money and severity words', () => {
  assert.equal(count(1, 'lead'), '1 lead');
  assert.equal(count(13, 'lead'), '13 leads');
  assert.equal(count(21442, 'lead'), '21,442 leads');
  assert.equal(count(2, 'phone call'), '2 phone calls');
  assert.equal(money(9141.4), '$9,141');
  assert.equal(severityWord('P1'), 'Urgent');
  assert.equal(severityWord('P4'), 'Low');
});

test('plainTimes turns every 24-hour time into 12-hour, and nothing else', () => {
  assert.equal(plainTimes('19:30 ET'), '7:30 PM ET');
  assert.equal(plainTimes('08:00-20:00 ET'), '8:00 AM to 8:00 PM ET');
  assert.equal(plainTimes('20:15 and 20:45 ET'), '8:15 PM and 8:45 PM ET');
  assert.equal(plainTimes('daily 04:10 ET'), 'daily 4:10 AM ET');
  assert.equal(plainTimes('appointments for 2026-10-16, $9,141, 10 of 28'), 'appointments for 2026-10-16, $9,141, 10 of 28');
  assert.equal(windowWords('08:00-20:00 ET'), '8:00 AM to 8:00 PM Eastern');
  assert.ok(TWENTY_FOUR_HOUR_TIME.test('not issued at 20:45 ET'));
  assert.ok(!TWENTY_FOUR_HOUR_TIME.test('not issued by 8:45 PM'));
});
