/**
 * Time-zone label on clock times — scripts/test-time-zone-label.js
 *
 * 2026-10-16: a Katy, TX live chat was offered "Saturday, October 17 at
 * 9:00 AM" with no "CT" (the bot gate's houston_tz/livechat). Code now adds
 * the label for a non-Eastern lead; an Eastern lead is never touched.
 *
 * Run: node --test scripts/test-time-zone-label.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { labelClockTimes } = await import('../src/agentic/time-zone-label.js');

test('a Central lead gets CT after every clock time that has none', () => {
  const r = labelClockTimes('I have Saturday, October 17 at 9:00 AM or Sunday, October 18 at 1:00 PM. Which works better for you?', 'CT');
  assert.equal(r.text, 'I have Saturday, October 17 at 9:00 AM CT or Sunday, October 18 at 1:00 PM CT. Which works better for you?');
  assert.equal(r.changed, true);
  assert.equal(labelClockTimes("You're on the calendar for Saturday, October 17 at 9:00 AM.", 'CT').text, "You're on the calendar for Saturday, October 17 at 9:00 AM CT.");
  assert.equal(labelClockTimes('How about 6pm or 10 a.m. tomorrow?', 'CT').text, 'How about 6pm CT or 10 a.m. CT tomorrow?');
});

test('a label already right is kept; a wrong one is swapped', () => {
  const kept = labelClockTimes('I have Sat Oct 17 at 9 AM CT or Sun at 1 PM (Central).', 'CT');
  assert.equal(kept.changed, false);
  assert.equal(labelClockTimes('I have 10:00 AM ET or 2:00 PM Eastern.', 'CT').text, 'I have 10:00 AM CT or 2:00 PM CT.');
});

test('an Eastern lead, no label, and text with no clock time are untouched', () => {
  const s = 'I have Saturday at 9:00 AM or Sunday at 1:00 PM.';
  assert.deepEqual(labelClockTimes(s, 'ET'), { text: s, changed: false });
  assert.deepEqual(labelClockTimes(s, null), { text: s, changed: false });
  assert.equal(labelClockTimes('We have 10 windows to quote.', 'CT').changed, false);
  assert.equal(labelClockTimes('Our amazing team', 'CT').changed, false);
});
