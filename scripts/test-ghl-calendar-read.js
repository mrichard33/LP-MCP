/**
 * Calendar-wide live GHL read — scripts/test-ghl-calendar-read.js
 *
 * GHL's /calendars/events returns events past the endTime we pass, which showed
 * up as false "orphans" in the parity report once the LP side was narrowed.
 * listCalendarEvents must strictly re-bound results to [startMs, endMs).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GHL_API_KEY = 'test-key';

let returnedEvents = [];
function jsonRes(body) {
  return {
    status: 200, ok: true,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
globalThis.fetch = async (url, opts = {}) => {
  const path = String(url).replace('https://services.leadconnectorhq.com', '');
  if ((opts.method || 'GET') === 'GET' && path.startsWith('/calendars/events?')) {
    return jsonRes({ events: returnedEvents });
  }
  return jsonRes({});
};

const { listCalendarEvents, listEstimatePoolEvents, isActiveStatus } = await import('../src/services/ghl-calendar-read.js');

const WE = 'aJj14ONxh1oFyDcQ706O';
const START = Date.parse('2026-07-11T00:00:00-04:00');
const END = START + 24 * 3600 * 1000;
const rawEv = (id, startTime, status = 'new') => ({ id, calendarId: WE, contactId: `c-${id}`, startTime, appointmentStatus: status });

test('listCalendarEvents drops out-of-window (next-day) events GHL leaks in', async () => {
  returnedEvents = [
    rawEv('in', '2026-07-11T10:00:00-04:00'),        // inside 7/11
    rawEv('nextday', '2026-07-12T10:00:00-04:00'),   // GHL leaked a 7/12 event
    rawEv('prevday', '2026-07-10T23:00:00-04:00'),   // day before, also out
  ];
  const events = await listCalendarEvents({ calendarId: WE, startMs: START, endMs: END });
  assert.deepEqual(events.map((e) => e.appointment_id), ['in']);
});

test('listCalendarEvents keeps the half-open start, drops exact endMs', async () => {
  returnedEvents = [
    rawEv('atstart', '2026-07-11T00:00:00-04:00'),   // == startMs, kept
    rawEv('atend', '2026-07-12T00:00:00-04:00'),     // == endMs, excluded (half-open)
  ];
  const events = await listCalendarEvents({ calendarId: WE, startMs: START, endMs: END });
  assert.deepEqual(events.map((e) => e.appointment_id), ['atstart']);
});

test('listEstimatePoolEvents still filters non-active status, within window', async () => {
  returnedEvents = [
    rawEv('active', '2026-07-11T10:00:00-04:00', 'confirmed'),
    rawEv('cxl', '2026-07-11T12:00:00-04:00', 'cancelled'),
  ];
  const events = await listEstimatePoolEvents({ startMs: START, endMs: END });
  // 3 estimate calendars all return the same stub; each contributes the 1 active.
  assert.ok(events.every((e) => isActiveStatus(e.status)));
  assert.ok(events.every((e) => e.appointment_id === 'active'));
});
