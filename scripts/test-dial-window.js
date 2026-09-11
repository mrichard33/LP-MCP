/**
 * Tests — Five9 dial window (src/dial-window.js)
 * scripts/test-dial-window.js
 *
 *   node --test scripts/test-dial-window.js
 *
 * This module exists because the callback_request prompt said "if it is
 * business hours" and nothing ever computed them — the model inferred the
 * phone room's hours from whatever else was in its context, and on 2026-09-04
 * promised Robert Pederson (zLDD7V1eosF8vldF5U7i) a call "within the next few
 * minutes" that the dialer was never going to place.
 *
 * What must not regress:
 *   1. The boundary is exact and half-open on top — 20:59 open, 21:00 closed,
 *      matching the Five9 stopTime. An off-by-one here is a promise made in a
 *      minute the dialer is not running.
 *   2. The offset is READ from the zone, never assumed. A hardcoded -4 is
 *      wrong for four months of the year, and 08:00 EST is a real dialing hour.
 *   3. A malformed env value falls back rather than clamping. Clamping a
 *      garbage value to 0 would tell the bot the phone room is open at
 *      midnight, which is worse than ignoring the override.
 *   4. The prompt line states the boundary, not just the verdict. Told only
 *      "closed", a model invents a reopening time, and an invented one
 *      contradicts the SMS the customer just received.
 *
 * Offline and pure: no network, no DB, no Supabase env needed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isWithinDialWindow,
  dialWindowBounds,
  dialWindowPromptLine,
  canPromiseImmediateCall,
  etHourMinute,
} from '../src/dial-window.js';

/** An instant at a given ET wall-clock hour:minute, in EDT (July). */
const edt = (h, m = 0) => Date.UTC(2026, 6, 15, h + 4, m);
/** The same, in EST (January). */
const est = (h, m = 0) => Date.UTC(2026, 0, 15, h + 5, m);

/** Run a body with env overrides, always restoring. */
function withEnv(vars, body) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return body(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

// ─── The boundary ──────────────────────────────────────────────────────────

test('EDT: 07:59 closed, 08:00 open', () => {
  assert.equal(isWithinDialWindow(edt(7, 59)), false);
  assert.equal(isWithinDialWindow(edt(8, 0)), true);
});

test('EDT: 20:59 open, 21:00 closed — the top is exclusive, matching Five9 stopTime', () => {
  assert.equal(isWithinDialWindow(edt(20, 59)), true);
  assert.equal(isWithinDialWindow(edt(21, 0)), false);
});

test('EST: the same wall-clock boundaries hold at a different UTC offset', () => {
  assert.equal(isWithinDialWindow(est(7, 59)), false);
  assert.equal(isWithinDialWindow(est(8, 0)), true);
  assert.equal(isWithinDialWindow(est(20, 59)), true);
  assert.equal(isWithinDialWindow(est(21, 0)), false);
});

test('the offset is read from the zone, not assumed', () => {
  // 12:00Z is 08:00 EDT (open) but 07:00 EST (closed). A hardcoded -4 would
  // call the January instant open.
  assert.equal(isWithinDialWindow(Date.UTC(2026, 6, 15, 12, 0)), true, 'July 12:00Z = 8 AM EDT');
  assert.equal(isWithinDialWindow(Date.UTC(2026, 0, 15, 12, 0)), false, 'January 12:00Z = 7 AM EST');
});

test('the window covers every day, including the weekend', () => {
  // 2026-09-05 is a Saturday, 2026-09-06 a Sunday. The Five9 dialing schedule
  // carries no weekday restriction, so neither does this.
  assert.equal(isWithinDialWindow(Date.UTC(2026, 8, 5, 18, 0)), true, 'Saturday 2 PM ET');
  assert.equal(isWithinDialWindow(Date.UTC(2026, 8, 6, 18, 0)), true, 'Sunday 2 PM ET');
});

test('etHourMinute reports ET, not the server clock', () => {
  // The server runs UTC; getHours() would answer a different question.
  assert.deepEqual(etHourMinute(Date.UTC(2026, 6, 15, 22, 30)), { hour: 18, minute: 30 });
  assert.deepEqual(etHourMinute(Date.UTC(2026, 0, 15, 0, 15)), { hour: 19, minute: 15 });
});

// ─── DST transition days ───────────────────────────────────────────────────

test('spring forward: 2026-03-08 is still 08:00-21:00 in local wall-clock terms', () => {
  // 2026-03-08 07:00Z is 02:00 EST → becomes 03:00 EDT. Well before open.
  assert.equal(isWithinDialWindow(Date.UTC(2026, 2, 8, 7, 0)), false);
  // 12:00Z on that day is 08:00 EDT — open on the hour, despite the lost hour.
  assert.equal(isWithinDialWindow(Date.UTC(2026, 2, 8, 12, 0)), true);
});

test('fall back: 2026-11-01 05:30Z is 01:30 EDT, still closed', () => {
  assert.equal(isWithinDialWindow(Date.UTC(2026, 10, 1, 5, 30)), false);
  // 13:00Z is 08:00 EST that day — open.
  assert.equal(isWithinDialWindow(Date.UTC(2026, 10, 1, 13, 0)), true);
});

// ─── Env overrides ─────────────────────────────────────────────────────────

test('defaults are the live Five9 values, so an unset env is already correct', () => {
  withEnv({ FIVE9_DIAL_WINDOW_START_HOUR_ET: undefined, FIVE9_DIAL_WINDOW_END_HOUR_ET: undefined }, () => {
    assert.deepEqual(dialWindowBounds(), { startHour: 8, endHour: 21, timeZone: 'America/New_York' });
  });
});

test('an override is honoured without a redeploy', () => {
  withEnv({ FIVE9_DIAL_WINDOW_START_HOUR_ET: '9', FIVE9_DIAL_WINDOW_END_HOUR_ET: '20' }, () => {
    assert.equal(isWithinDialWindow(edt(8, 30)), false, '8:30 is outside a 9-20 window');
    assert.equal(isWithinDialWindow(edt(20, 30)), false, '20:30 is outside a 9-20 window');
    assert.equal(isWithinDialWindow(edt(12, 0)), true);
  });
});

test('a malformed override falls back to the default rather than clamping', () => {
  // Clamping "abc" or "-3" to 0 would report the phone room open at midnight.
  for (const bad of ['abc', '-3', '25', '8.5', '']) {
    withEnv({ FIVE9_DIAL_WINDOW_START_HOUR_ET: bad }, () => {
      assert.equal(dialWindowBounds().startHour, 8, `"${bad}" falls back to 8`);
      assert.equal(isWithinDialWindow(edt(0, 30)), false, `"${bad}" does not open midnight`);
    });
  }
});

// ─── The prompt line ───────────────────────────────────────────────────────

// 2026-09-11 — the line is now built on canPromiseImmediateCall, not on
// isWithinDialWindow, and the hours it quotes are the STAFFED hours
// (src/staffed-hours.js), not the dial window. See the header of
// src/dial-window.js for Mark's reversal of the 2026-09-04 ruling, and
// scripts/test-call-promise-hours.js for the staffed-hours cases themselves.

test('the prompt line states the verdict AND the boundary', () => {
  const open = dialWindowPromptLine(edt(12, 0));   // Wed noon — dialing and staffed
  assert.match(open, /OPEN/);
  assert.match(open, /staffed Mon–Fri 8:00 AM–8:00 PM, Sat 9:00 AM–8:00 PM, Sun 9:00 AM–5:00 PM ET/,
    'the model is given the boundary, not left to invent one');
  assert.match(open, /CAN be promised/);

  const closed = dialWindowPromptLine(edt(22, 0)); // Wed 10 PM — neither
  assert.match(closed, /CLOSED/);
  assert.match(closed, /The next call can go out Thursday at 8:00 AM ET\./,
    'a closed line names the reopening rather than leaving the model to invent one');
  assert.match(closed, /CANNOT be promised/);
});

test('a dial-window override still moves the verdict', () => {
  // The quoted hours are the staffed ones, but Five9 not dialing still closes
  // the phone room — canPromiseImmediateCall needs BOTH facts.
  withEnv({ FIVE9_DIAL_WINDOW_END_HOUR_ET: '10' }, () => {
    assert.match(dialWindowPromptLine(edt(12, 0)), /PHONE ROOM: CLOSED/,
      'staffed at noon, but the dialer stopped at 10 — no promise');
  });
  withEnv({ FIVE9_DIAL_WINDOW_END_HOUR_ET: '21' }, () => {
    assert.match(dialWindowPromptLine(edt(12, 0)), /PHONE ROOM: OPEN/);
  });
});

test('the open and closed lines are never both sayable at one instant', () => {
  // Cheap invariant, but the failure it catches is a bot that contradicts
  // itself inside a single reply.
  for (let h = 0; h < 24; h += 1) {
    const line = dialWindowPromptLine(edt(h, 0));
    const isOpen = /PHONE ROOM: OPEN/.test(line);
    const isClosed = /PHONE ROOM: CLOSED/.test(line);
    assert.ok(isOpen !== isClosed, `hour ${h} is unambiguously one or the other`);
    assert.equal(isOpen, canPromiseImmediateCall(edt(h, 0)), `hour ${h} line matches the predicate`);
  }
});

// ─── Dial window vs staffed floor ──────────────────────────────────────────

test('the dial window stayed exactly what it was — every day, 08:00-21:00', () => {
  // Mark's reversal narrowed the PROMISE, not this module. A regression here
  // would mean someone folded staffed hours into the dialer's own question.
  const sunday = Date.UTC(2026, 6, 19, 20 + 4, 0); // Sun 2026-07-19, 8 PM EDT
  assert.equal(isWithinDialWindow(sunday), true, 'Five9 dials on a Sunday evening');
  assert.equal(canPromiseImmediateCall(sunday), false, 'but nobody is there to place the call');
  assert.deepEqual(dialWindowBounds(), { startHour: 8, endHour: 21, timeZone: 'America/New_York' });
});
